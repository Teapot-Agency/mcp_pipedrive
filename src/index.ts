import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import * as pipedrive from "pipedrive";
import * as dotenv from 'dotenv';
import Bottleneck from 'bottleneck';
import jwt from 'jsonwebtoken';
import http from 'http';

// Type for error handling
interface ErrorWithMessage {
  message: string;
}

function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  return String(error);
}

// Load environment variables
dotenv.config();

// Check for required environment variables
if (!process.env.PIPEDRIVE_API_TOKEN) {
  console.error("ERROR: PIPEDRIVE_API_TOKEN environment variable is required");
  process.exit(1);
}

if (!process.env.PIPEDRIVE_DOMAIN) {
  console.error("ERROR: PIPEDRIVE_DOMAIN environment variable is required (e.g., 'ukkofi.pipedrive.com')");
  process.exit(1);
}

const jwtSecret = process.env.MCP_JWT_SECRET;
const jwtAlgorithm = (process.env.MCP_JWT_ALGORITHM || 'HS256') as jwt.Algorithm;
const jwtVerifyOptions = {
  algorithms: [jwtAlgorithm],
  audience: process.env.MCP_JWT_AUDIENCE,
  issuer: process.env.MCP_JWT_ISSUER,
};

if (jwtSecret) {
  const bootToken = process.env.MCP_JWT_TOKEN;
  if (!bootToken) {
    console.error("ERROR: MCP_JWT_TOKEN environment variable is required when MCP_JWT_SECRET is set");
    process.exit(1);
  }

  try {
    jwt.verify(bootToken, jwtSecret, jwtVerifyOptions);
  } catch (error) {
    console.error("ERROR: Failed to verify MCP_JWT_TOKEN", error);
    process.exit(1);
  }
}

const verifyRequestAuthentication = (req: http.IncomingMessage) => {
  if (!jwtSecret) {
    return { ok: true } as const;
  }

  const header = req.headers['authorization'];
  if (!header) {
    return { ok: false, status: 401, message: 'Missing Authorization header' } as const;
  }

  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return { ok: false, status: 401, message: 'Invalid Authorization header format' } as const;
  }

  try {
    jwt.verify(token, jwtSecret, jwtVerifyOptions);
    return { ok: true } as const;
  } catch (error) {
    return { ok: false, status: 401, message: 'Invalid or expired token' } as const;
  }
};

const limiter = new Bottleneck({
  minTime: Number(process.env.PIPEDRIVE_RATE_LIMIT_MIN_TIME_MS || 250),
  maxConcurrent: Number(process.env.PIPEDRIVE_RATE_LIMIT_MAX_CONCURRENT || 2),
});

const withRateLimit = <T extends object>(client: T): T => {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return (...args: unknown[]) => limiter.schedule(() => (value as Function).apply(target, args));
      }
      return value;
    },
  });
};

// Initialize Pipedrive API client with API token and custom domain
const apiClient = new pipedrive.ApiClient();
apiClient.basePath = `https://${process.env.PIPEDRIVE_DOMAIN}/api/v1`;
apiClient.authentications = apiClient.authentications || {};
apiClient.authentications['api_key'] = {
  type: 'apiKey',
  'in': 'query',
  name: 'api_token',
  apiKey: process.env.PIPEDRIVE_API_TOKEN
};

// Initialize Pipedrive API clients
const dealsApi = withRateLimit(new pipedrive.DealsApi(apiClient));
const personsApi = withRateLimit(new pipedrive.PersonsApi(apiClient));
const organizationsApi = withRateLimit(new pipedrive.OrganizationsApi(apiClient));
const pipelinesApi = withRateLimit(new pipedrive.PipelinesApi(apiClient));
const itemSearchApi = withRateLimit(new pipedrive.ItemSearchApi(apiClient));
const leadsApi = withRateLimit(new pipedrive.LeadsApi(apiClient));
// @ts-ignore - ActivitiesApi exists but may not be in type definitions
const activitiesApi = withRateLimit(new pipedrive.ActivitiesApi(apiClient));
// @ts-ignore - NotesApi exists but may not be in type definitions
const notesApi = withRateLimit(new pipedrive.NotesApi(apiClient));
// @ts-ignore - UsersApi exists but may not be in type definitions
const usersApi = withRateLimit(new pipedrive.UsersApi(apiClient));

// Create MCP server
const server = new McpServer({
  name: "pipedrive-mcp-server",
  version: "2.0.0",
  capabilities: {
    resources: {},
    tools: {},
    prompts: {}
  }
});

// === TOOLS ===

// Get all users (for finding owner IDs)
server.tool(
  "get-users",
  "Get all users/owners from Pipedrive to identify owner IDs for filtering deals",
  {},
  async () => {
    try {
      const response = await usersApi.getUsers();
      const users = response.data?.map((user: any) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        active_flag: user.active_flag,
        role_name: user.role_name
      })) || [];

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: `Found ${users.length} users in your Pipedrive account`,
            users: users
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching users:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching users: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get deals with flexible filtering options
server.tool(
  "get-deals",
  "Get deals from Pipedrive with flexible filtering options including search by title, date range, owner, stage, status, and more. Use 'get-users' tool first to find owner IDs.",
  {
    searchTitle: z.string().optional().describe("Search deals by title/name (partial matches supported)"),
    daysBack: z.number().optional().describe("Number of days back to fetch deals based on last activity date (default: 365)"),
    ownerId: z.number().optional().describe("Filter deals by owner/user ID (use get-users tool to find IDs)"),
    stageId: z.number().optional().describe("Filter deals by stage ID"),
    status: z.enum(['open', 'won', 'lost', 'deleted']).optional().describe("Filter deals by status (default: open)"),
    pipelineId: z.number().optional().describe("Filter deals by pipeline ID"),
    minValue: z.number().optional().describe("Minimum deal value filter"),
    maxValue: z.number().optional().describe("Maximum deal value filter"),
    limit: z.number().optional().describe("Maximum number of deals to return (default: 500)")
  },
  async ({
    searchTitle,
    daysBack = 365,
    ownerId,
    stageId,
    status = 'open',
    pipelineId,
    minValue,
    maxValue,
    limit = 500
  }) => {
    try {
      let filteredDeals: any[] = [];

      // If searching by title, use the search API first
      if (searchTitle) {
        // @ts-ignore - Bypass incorrect TypeScript definition
        const searchResponse = await dealsApi.searchDeals(searchTitle);
        filteredDeals = searchResponse.data || [];
      } else {
        // Calculate the date filter (daysBack days ago)
        const filterDate = new Date();
        filterDate.setDate(filterDate.getDate() - daysBack);
        const startDate = filterDate.toISOString().split('T')[0]; // Format as YYYY-MM-DD

        // Build API parameters (using actual Pipedrive API parameter names)
        const params: any = {
          sort: 'last_activity_date DESC',
          status: status,
          limit: limit
        };

        // Add optional filters
        if (ownerId) params.user_id = ownerId;
        if (stageId) params.stage_id = stageId;
        if (pipelineId) params.pipeline_id = pipelineId;

        // Fetch deals with filters
        // @ts-ignore - getDeals accepts parameters but types may be incomplete
        const response = await dealsApi.getDeals(params);
        filteredDeals = response.data || [];
      }

      // Apply additional client-side filtering

      // Filter by date if not searching by title
      if (!searchTitle) {
        const filterDate = new Date();
        filterDate.setDate(filterDate.getDate() - daysBack);

        filteredDeals = filteredDeals.filter((deal: any) => {
          if (!deal.last_activity_date) return false;
          const dealActivityDate = new Date(deal.last_activity_date);
          return dealActivityDate >= filterDate;
        });
      }

      // Filter by owner if specified and not already applied in API call
      if (ownerId && searchTitle) {
        filteredDeals = filteredDeals.filter((deal: any) => deal.owner_id === ownerId);
      }

      // Filter by status if specified and searching by title
      if (status && searchTitle) {
        filteredDeals = filteredDeals.filter((deal: any) => deal.status === status);
      }

      // Filter by stage if specified and not already applied in API call
      if (stageId && (searchTitle || !stageId)) {
        filteredDeals = filteredDeals.filter((deal: any) => deal.stage_id === stageId);
      }

      // Filter by pipeline if specified and not already applied in API call
      if (pipelineId && (searchTitle || !pipelineId)) {
        filteredDeals = filteredDeals.filter((deal: any) => deal.pipeline_id === pipelineId);
      }

      // Filter by value range if specified
      if (minValue !== undefined || maxValue !== undefined) {
        filteredDeals = filteredDeals.filter((deal: any) => {
          const value = parseFloat(deal.value) || 0;
          if (minValue !== undefined && value < minValue) return false;
          if (maxValue !== undefined && value > maxValue) return false;
          return true;
        });
      }

      // Apply limit
      if (filteredDeals.length > limit) {
        filteredDeals = filteredDeals.slice(0, limit);
      }

      // Build filter summary for response
      const filterSummary = {
        ...(searchTitle && { search_title: searchTitle }),
        ...(!searchTitle && { days_back: daysBack }),
        ...(!searchTitle && { filter_date: new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().split('T')[0] }),
        status: status,
        ...(ownerId && { owner_id: ownerId }),
        ...(stageId && { stage_id: stageId }),
        ...(pipelineId && { pipeline_id: pipelineId }),
        ...(minValue !== undefined && { min_value: minValue }),
        ...(maxValue !== undefined && { max_value: maxValue }),
        total_deals_found: filteredDeals.length,
        limit_applied: limit
      };

      // Summarize deals to avoid massive responses but include notes and booking details
      const bookingFieldKey = "8f4b27fbd9dfc70d2296f23ce76987051ad7324e";
      const summarizedDeals = filteredDeals.map((deal: any) => ({
        id: deal.id,
        title: deal.title,
        value: deal.value,
        currency: deal.currency,
        status: deal.status,
        stage_name: deal.stage?.name || 'Unknown',
        pipeline_name: deal.pipeline?.name || 'Unknown',
        owner_name: deal.owner?.name || 'Unknown',
        organization_name: deal.org?.name || null,
        person_name: deal.person?.name || null,
        add_time: deal.add_time,
        last_activity_date: deal.last_activity_date,
        close_time: deal.close_time,
        won_time: deal.won_time,
        lost_time: deal.lost_time,
        notes_count: deal.notes_count || 0,
        // Include recent notes if available
        notes: deal.notes || [],
        // Include custom booking details field
        booking_details: deal[bookingFieldKey] || null
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: searchTitle
              ? `Found ${filteredDeals.length} deals matching title search "${searchTitle}"`
              : `Found ${filteredDeals.length} deals matching the specified filters`,
            filters_applied: filterSummary,
            total_found: filteredDeals.length,
            deals: summarizedDeals.slice(0, 30) // Limit to 30 deals max to prevent huge responses
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching deals:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching deals: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get deal by ID
server.tool(
  "get-deal",
  "Get a specific deal by ID including custom fields",
  {
    dealId: z.number().describe("Pipedrive deal ID")
  },
  async ({ dealId }) => {
    try {
      // @ts-ignore - Bypass incorrect TypeScript definition, API expects just the ID
      const response = await dealsApi.getDeal(dealId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching deal ${dealId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching deal ${dealId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get deal notes and custom booking details
server.tool(
  "get-deal-notes",
  "Get detailed notes and custom booking details for a specific deal",
  {
    dealId: z.number().describe("Pipedrive deal ID"),
    limit: z.number().optional().describe("Maximum number of notes to return (default: 20)")
  },
  async ({ dealId, limit = 20 }) => {
    try {
      const result: any = {
        deal_id: dealId,
        notes: [],
        booking_details: null
      };

      // Get deal details including custom fields
      try {
        // @ts-ignore - Bypass incorrect TypeScript definition
        const dealResponse = await dealsApi.getDeal(dealId);
        const deal = dealResponse.data;

        // Extract custom booking field
        const bookingFieldKey = "8f4b27fbd9dfc70d2296f23ce76987051ad7324e";
        if (deal && deal[bookingFieldKey]) {
          result.booking_details = deal[bookingFieldKey];
        }
      } catch (dealError) {
        console.error(`Error fetching deal details for ${dealId}:`, dealError);
        result.deal_error = getErrorMessage(dealError);
      }

      // Get deal notes
      try {
        // @ts-ignore - API parameters may not be fully typed
        // @ts-ignore - Bypass incorrect TypeScript definition
        const notesResponse = await notesApi.getNotes({
          deal_id: dealId,
          limit: limit
        });
        result.notes = notesResponse.data || [];
      } catch (noteError) {
        console.error(`Error fetching notes for deal ${dealId}:`, noteError);
        result.notes_error = getErrorMessage(noteError);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: `Retrieved ${result.notes.length} notes and booking details for deal ${dealId}`,
            ...result
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching deal notes ${dealId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching deal notes ${dealId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Search deals
server.tool(
  "search-deals",
  "Search deals by term",
  {
    term: z.string().describe("Search term for deals")
  },
  async ({ term }) => {
    try {
      // @ts-ignore - Bypass incorrect TypeScript definition
      const response = await dealsApi.searchDeals(term);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error searching deals with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: `Error searching deals: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get all persons
server.tool(
  "get-persons",
  "Get all persons from Pipedrive with optional filtering by name, email, organization, or phone",
  {
    filterName: z.string().optional().describe("Filter persons by name (case-insensitive partial match)"),
    filterEmail: z.string().optional().describe("Filter persons by email (case-insensitive partial match)"),
    filterPhone: z.string().optional().describe("Filter persons by phone (partial match)"),
    organizationId: z.number().optional().describe("Filter persons by organization ID"),
    organizationName: z.string().optional().describe("Filter persons by organization name (case-insensitive partial match)"),
    limit: z.number().optional().describe("Maximum number of persons to return (default: 100)")
  },
  async ({ filterName, filterEmail, filterPhone, organizationId, organizationName, limit = 100 }) => {
    try {
      // Fetch all persons
      // @ts-ignore - getPersons parameters may not be fully typed
      const response = await personsApi.getPersons({ limit: limit > 500 ? 500 : limit });
      let persons = response.data || [];

      // Apply client-side filters
      if (filterName) {
        const nameLower = filterName.toLowerCase();
        persons = persons.filter((person: any) =>
          person.name && person.name.toLowerCase().includes(nameLower)
        );
      }

      if (filterEmail) {
        const emailLower = filterEmail.toLowerCase();
        persons = persons.filter((person: any) => {
          if (!person.email) return false;
          // Handle email as array of objects or string
          if (Array.isArray(person.email)) {
            return person.email.some((e: any) =>
              e.value && e.value.toLowerCase().includes(emailLower)
            );
          }
          return String(person.email).toLowerCase().includes(emailLower);
        });
      }

      if (filterPhone) {
        const phoneLower = filterPhone.toLowerCase();
        persons = persons.filter((person: any) => {
          if (!person.phone) return false;
          // Handle phone as array of objects or string
          if (Array.isArray(person.phone)) {
            return person.phone.some((p: any) =>
              p.value && String(p.value).toLowerCase().includes(phoneLower)
            );
          }
          return String(person.phone).toLowerCase().includes(phoneLower);
        });
      }

      if (organizationId) {
        persons = persons.filter((person: any) =>
          person.org_id && person.org_id.value === organizationId
        );
      }

      if (organizationName) {
        const orgNameLower = organizationName.toLowerCase();
        persons = persons.filter((person: any) =>
          person.org_name && person.org_name.toLowerCase().includes(orgNameLower)
        );
      }

      // Build filter summary
      const filtersApplied: string[] = [];
      if (filterName) filtersApplied.push(`name contains "${filterName}"`);
      if (filterEmail) filtersApplied.push(`email contains "${filterEmail}"`);
      if (filterPhone) filtersApplied.push(`phone contains "${filterPhone}"`);
      if (organizationId) filtersApplied.push(`org_id = ${organizationId}`);
      if (organizationName) filtersApplied.push(`org_name contains "${organizationName}"`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: filtersApplied.length > 0
              ? `Found ${persons.length} persons matching filters: ${filtersApplied.join(', ')}`
              : `Found ${persons.length} persons`,
            total_found: persons.length,
            filters_applied: filtersApplied,
            persons: persons.slice(0, limit) // Apply limit
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching persons:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching persons: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get person by ID
server.tool(
  "get-person",
  "Get a specific person by ID including custom fields",
  {
    personId: z.number().describe("Pipedrive person ID")
  },
  async ({ personId }) => {
    try {
      // @ts-ignore - Bypass incorrect TypeScript definition
      const response = await personsApi.getPerson(personId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching person ${personId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching person ${personId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Search persons
server.tool(
  "search-persons",
  "⚠️ FALLBACK TOOL - Use 'find-person' instead for most searches. This uses Pipedrive's native search which often returns empty results. Only use this for: (1) searching within notes content with fields='notes', (2) searching custom fields, (3) when exact matching is required.",
  {
    term: z.string().describe("Search term for persons (minimum 2 characters recommended)"),
    fields: z.string().optional().describe("Comma-separated fields to search: name, email, phone, notes, custom_fields. Defaults to all fields. Use 'notes' to search within person notes."),
    exactMatch: z.boolean().optional().describe("If true, only exact matches are returned (not case sensitive)"),
    organizationId: z.number().optional().describe("Filter persons by organization ID"),
    limit: z.number().optional().describe("Limit of entries to return (max 500, default 100)")
  },
  async ({ term, fields, exactMatch, organizationId, limit }) => {
    try {
      // Build search options
      const searchOptions: Record<string, unknown> = { term };
      if (fields) searchOptions.fields = fields;
      if (exactMatch !== undefined) searchOptions.exact_match = exactMatch;
      if (organizationId) searchOptions.organization_id = organizationId;
      if (limit) searchOptions.limit = limit;

      // @ts-ignore - Bypass incorrect TypeScript definition
      const response = await personsApi.searchPersons(searchOptions);
      const results = response.data?.items || response.data || [];

      // Provide helpful feedback if no results
      if (!results || results.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              items: [],
              warning: "No results found using Pipedrive's search API",
              suggestion: "The search API may require specific conditions. Try using the 'find-person' tool for more flexible fuzzy matching, or use 'get-persons' with filter parameters.",
              search_term: term,
              possible_reasons: [
                "Search term may be too short (try 3+ characters)",
                "Pipedrive search may require exact word matches",
                "Search index may not be fully populated",
                "Try searching by different fields (name, email, organization)"
              ]
            }, null, 2)
          }]
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: `Found ${results.length} persons`,
            items: results
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error searching persons with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: `Error searching persons: ${getErrorMessage(error)}`,
            suggestion: "Try using 'find-person' or 'get-persons' with filters instead"
          }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Get notes for a specific person
server.tool(
  "get-person-notes",
  "Get all notes attached to a specific person",
  {
    personId: z.number().describe("Pipedrive person ID"),
    limit: z.number().optional().describe("Maximum number of notes to return (default: 100)")
  },
  async ({ personId, limit = 100 }) => {
    try {
      // @ts-ignore - Bypass incorrect TypeScript definition
      const notesResponse = await notesApi.getNotes({
        person_id: personId,
        limit: limit
      });

      const notes = notesResponse.data || [];
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: `Retrieved ${notes.length} notes for person ${personId}`,
            person_id: personId,
            notes: notes
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching notes for person ${personId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching notes for person ${personId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Search persons by attached notes content
server.tool(
  "search-persons-by-notes",
  "Search for persons who have attached notes containing a specific keyword. This searches the content of notes linked to persons.",
  {
    keyword: z.string().describe("Keyword to search for in note content (case-insensitive)"),
    limit: z.number().optional().describe("Maximum number of notes to fetch (default: 500)")
  },
  async ({ keyword, limit = 500 }) => {
    try {
      // Get all notes with pagination to ensure we search through all of them
      const allNotes: any[] = [];
      let start = 0;
      const pageSize = 100; // Fetch in batches of 100
      let hasMore = true;

      while (hasMore && allNotes.length < limit) {
        // @ts-ignore - Bypass incorrect TypeScript definition
        const notesResponse = await notesApi.getNotes({ start, limit: pageSize });
        const notes = notesResponse.data || [];
        allNotes.push(...notes);

        // Check if there are more items to fetch
        const pagination = notesResponse.additional_data?.pagination;
        hasMore = pagination?.more_items_in_collection === true;
        start += notes.length;

        // Safety: stop if no notes returned (shouldn't happen, but prevents infinite loop)
        if (notes.length === 0) break;
      }

      // Helper to extract person ID (handles various API response formats)
      const getPersonId = (note: any): number | null => {
        // Try person_id first (can be object with .value or direct number)
        if (note.person_id) {
          return typeof note.person_id === 'object' ? note.person_id.value : note.person_id;
        }
        // Some API versions use person.id instead
        if (note.person?.id) {
          return note.person.id;
        }
        return null;
      };

      // Filter notes that contain the keyword and are linked to a person
      const keywordLower = keyword.toLowerCase();
      const matchingNotes = allNotes.filter((note: any) => {
        const content = note.content || '';
        const personId = getPersonId(note);
        return personId && content.toLowerCase().includes(keywordLower);
      });

      // Get unique person IDs
      const personIds = [...new Set(matchingNotes.map((note: any) => getPersonId(note)))];

      // Fetch person details for each match
      const personsWithNotes: any[] = [];
      for (const personId of personIds) {
        try {
          // @ts-ignore - Bypass incorrect TypeScript definition
          const personResponse = await personsApi.getPerson(personId);
          const person = personResponse.data;

          // Get the matching notes for this person
          const personNotes = matchingNotes
            .filter((note: any) => getPersonId(note) === personId)
            .map((note: any) => ({
              id: note.id,
              content: note.content,
              add_time: note.add_time,
              update_time: note.update_time
            }));

          personsWithNotes.push({
            person: {
              id: person.id,
              name: person.name,
              email: person.email,
              phone: person.phone,
              org_id: person.org_id,
              org_name: person.org_name
            },
            matching_notes: personNotes
          });
        } catch (personError) {
          console.error(`Error fetching person ${personId}:`, personError);
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: `Found ${personsWithNotes.length} persons with notes containing "${keyword}"`,
            keyword: keyword,
            results: personsWithNotes
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error searching persons by notes with keyword "${keyword}":`, error);
      return {
        content: [{
          type: "text",
          text: `Error searching persons by notes: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Find person with fuzzy matching - PRIMARY SEARCH TOOL
server.tool(
  "find-person",
  "⭐ PRIMARY TOOL for finding persons - USE THIS BY DEFAULT. Reliable fuzzy matching across name, email, phone, and company. Returns scored results ranked by relevance. Preferred over search-persons for most lookups.",
  {
    name: z.string().optional().describe("Person name to search for (fuzzy match)"),
    company: z.string().optional().describe("Company/organization name to search for (fuzzy match)"),
    email: z.string().optional().describe("Email to search for (partial match)"),
    phone: z.string().optional().describe("Phone number to search for (partial match)"),
    limit: z.number().optional().describe("Maximum number of results to return (default: 20)")
  },
  async ({ name, company, email, phone, limit = 20 }) => {
    try {
      if (!name && !company && !email && !phone) {
        return {
          content: [{
            type: "text",
            text: "Error: At least one search parameter (name, company, email, or phone) is required"
          }],
          isError: true
        };
      }

      // Fetch all persons (with a reasonable limit)
      // @ts-ignore - getPersons parameters may not be fully typed
      const response = await personsApi.getPersons({ limit: 500 });
      let persons = response.data || [];

      // Simple fuzzy matching function
      const fuzzyMatch = (text: string, pattern: string): boolean => {
        const textLower = text.toLowerCase();
        const patternLower = pattern.toLowerCase();

        // Exact substring match
        if (textLower.includes(patternLower)) return true;

        // Word boundary match (matches if any word starts with pattern)
        const words = textLower.split(/\s+/);
        if (words.some(word => word.startsWith(patternLower))) return true;

        return false;
      };

      // Score each person based on matches
      const scoredPersons = persons.map((person: any) => {
        let score = 0;
        const matches: string[] = [];

        // Name matching
        if (name && person.name) {
          if (fuzzyMatch(person.name, name)) {
            score += 10;
            matches.push(`name matches "${name}"`);
          }
        }

        // Company/organization matching
        if (company && person.org_name) {
          if (fuzzyMatch(person.org_name, company)) {
            score += 8;
            matches.push(`company matches "${company}"`);
          }
        }

        // Email matching
        if (email && person.email) {
          const emailStr = Array.isArray(person.email)
            ? person.email.map((e: any) => e.value).join(' ')
            : String(person.email);
          if (emailStr.toLowerCase().includes(email.toLowerCase())) {
            score += 7;
            matches.push(`email matches "${email}"`);
          }
        }

        // Phone matching
        if (phone && person.phone) {
          const phoneStr = Array.isArray(person.phone)
            ? person.phone.map((p: any) => p.value).join(' ')
            : String(person.phone);
          if (phoneStr.includes(phone)) {
            score += 6;
            matches.push(`phone matches "${phone}"`);
          }
        }

        return { person, score, matches };
      });

      // Filter persons with score > 0 and sort by score (highest first)
      const matchedPersons = scoredPersons
        .filter((item: any) => item.score > 0)
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, limit);

      // Format results
      const results = matchedPersons.map((item: any) => ({
        id: item.person.id,
        name: item.person.name,
        email: item.person.email,
        phone: item.person.phone,
        org_id: item.person.org_id,
        org_name: item.person.org_name,
        match_score: item.score,
        match_reasons: item.matches
      }));

      const searchCriteria = [];
      if (name) searchCriteria.push(`name: "${name}"`);
      if (company) searchCriteria.push(`company: "${company}"`);
      if (email) searchCriteria.push(`email: "${email}"`);
      if (phone) searchCriteria.push(`phone: "${phone}"`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: `Found ${results.length} persons matching search criteria`,
            search_criteria: searchCriteria,
            total_found: results.length,
            results: results
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error finding persons:", error);
      return {
        content: [{
          type: "text",
          text: `Error finding persons: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get persons by organization
server.tool(
  "get-persons-by-organization",
  "Get all persons belonging to a specific organization",
  {
    organizationId: z.number().describe("Organization ID"),
    limit: z.number().optional().describe("Maximum number of persons to return (default: 100)")
  },
  async ({ organizationId, limit = 100 }) => {
    try {
      // Fetch persons and filter by organization
      // @ts-ignore - getPersons parameters may not be fully typed
      const response = await personsApi.getPersons({ limit: 500 });
      let persons = response.data || [];

      // Filter by organization ID
      persons = persons.filter((person: any) => {
        // Handle org_id as object or number
        const orgId = person.org_id?.value || person.org_id;
        return orgId === organizationId;
      });

      // Apply limit
      persons = persons.slice(0, limit);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: `Found ${persons.length} persons in organization ${organizationId}`,
            organization_id: organizationId,
            total_found: persons.length,
            persons: persons
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching persons for organization ${organizationId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching persons for organization: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get all organizations
server.tool(
  "get-organizations",
  "Get all organizations from Pipedrive with optional filtering by name",
  {
    filterName: z.string().optional().describe("Filter organizations by name (case-insensitive partial match)"),
    limit: z.number().optional().describe("Maximum number of organizations to return (default: 100)")
  },
  async ({ filterName, limit = 100 }) => {
    try {
      // @ts-ignore - getOrganizations parameters may not be fully typed
      const response = await organizationsApi.getOrganizations({ limit: limit > 500 ? 500 : limit });
      let organizations = response.data || [];

      // Apply client-side name filter
      if (filterName) {
        const nameLower = filterName.toLowerCase();
        organizations = organizations.filter((org: any) =>
          org.name && org.name.toLowerCase().includes(nameLower)
        );
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: filterName
              ? `Found ${organizations.length} organizations matching name "${filterName}"`
              : `Found ${organizations.length} organizations`,
            total_found: organizations.length,
            ...(filterName && { filter_applied: `name contains "${filterName}"` }),
            organizations: organizations.slice(0, limit)
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching organizations:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching organizations: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get organization by ID
server.tool(
  "get-organization",
  "Get a specific organization by ID including custom fields",
  {
    organizationId: z.number().describe("Pipedrive organization ID")
  },
  async ({ organizationId }) => {
    try {
      // @ts-ignore - Bypass incorrect TypeScript definition
      const response = await organizationsApi.getOrganization(organizationId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching organization ${organizationId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching organization ${organizationId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Search organizations
server.tool(
  "search-organizations",
  "Search organizations using Pipedrive's search API. NOTE: If this returns empty results, try using 'get-organizations' with filterName parameter instead.",
  {
    term: z.string().describe("Search term for organizations (minimum 2 characters recommended)")
  },
  async ({ term }) => {
    try {
      // @ts-ignore - API method exists but TypeScript definition is wrong
      const response = await (organizationsApi as any).searchOrganization({ term });
      const results = response.data?.items || response.data || [];

      // Provide helpful feedback if no results
      if (!results || results.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              items: [],
              warning: "No results found using Pipedrive's search API",
              suggestion: "Try using 'get-organizations' with filterName parameter for client-side filtering, which is more reliable.",
              search_term: term,
              possible_reasons: [
                "Search term may be too short (try 3+ characters)",
                "Pipedrive search may require exact word matches",
                "Search index may not be fully populated"
              ],
              alternative: `Use: get-organizations with filterName="${term}"`
            }, null, 2)
          }]
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: `Found ${results.length} organizations`,
            items: results
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error searching organizations with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: `Error searching organizations: ${getErrorMessage(error)}`,
            suggestion: "Try using 'get-organizations' with filterName parameter instead"
          }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Get all pipelines
server.tool(
  "get-pipelines",
  "Get all pipelines from Pipedrive",
  {},
  async () => {
    try {
      const response = await pipelinesApi.getPipelines();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching pipelines:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching pipelines: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get pipeline by ID
server.tool(
  "get-pipeline",
  "Get a specific pipeline by ID",
  {
    pipelineId: z.number().describe("Pipedrive pipeline ID")
  },
  async ({ pipelineId }) => {
    try {
      // @ts-ignore - Bypass incorrect TypeScript definition
      const response = await pipelinesApi.getPipeline(pipelineId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error fetching pipeline ${pipelineId}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error fetching pipeline ${pipelineId}: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Get all stages
server.tool(
  "get-stages",
  "Get all stages from Pipedrive",
  {},
  async () => {
    try {
      // Since the stages are related to pipelines, we'll get all pipelines first
      const pipelinesResponse = await pipelinesApi.getPipelines();
      const pipelines = pipelinesResponse.data || [];
      
      // For each pipeline, fetch its stages
      const allStages = [];
      for (const pipeline of pipelines) {
        try {
          // @ts-ignore - Type definitions for getPipelineStages are incomplete
          const stagesResponse = await pipelinesApi.getPipelineStages(pipeline.id);
          const stagesData = Array.isArray(stagesResponse?.data)
            ? stagesResponse.data
            : [];

          if (stagesData.length > 0) {
            const pipelineStages = stagesData.map((stage: any) => ({
              ...stage,
              pipeline_name: pipeline.name
            }));
            allStages.push(...pipelineStages);
          }
        } catch (e) {
          console.error(`Error fetching stages for pipeline ${pipeline.id}:`, e);
        }
      }
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(allStages, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error fetching stages:", error);
      return {
        content: [{
          type: "text",
          text: `Error fetching stages: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Search leads
server.tool(
  "search-leads",
  "Search leads by term",
  {
    term: z.string().describe("Search term for leads")
  },
  async ({ term }) => {
    try {
      // @ts-ignore - Bypass incorrect TypeScript definition
      const response = await leadsApi.searchLeads(term);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(response.data, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error searching leads with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: `Error searching leads: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// Generic search across item types
server.tool(
  "search-all",
  "Search across all item types using Pipedrive's search API. NOTE: If this returns empty results, try using specific tools like 'find-person', 'get-persons', 'get-organizations', or 'get-deals' with filter parameters.",
  {
    term: z.string().describe("Search term (minimum 2 characters recommended)"),
    itemTypes: z.string().optional().describe("Comma-separated list of item types to search (deal,person,organization,product,file,activity,lead)")
  },
  async ({ term, itemTypes }) => {
    try {
      const itemType = itemTypes; // Just rename the parameter
      const response = await itemSearchApi.searchItem({
        term,
        itemType
      });
      const results = response.data?.items || response.data || [];

      // Provide helpful feedback if no results
      if (!results || results.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              items: [],
              warning: "No results found using Pipedrive's search API",
              suggestion: "Pipedrive's search API may require specific conditions. Try using specific tools with filter parameters instead:",
              search_term: term,
              item_types: itemTypes || "all",
              alternatives: {
                for_persons: `find-person with name="${term}" or get-persons with filterName="${term}"`,
                for_organizations: `get-organizations with filterName="${term}"`,
                for_deals: `get-deals with searchTitle="${term}"`
              },
              possible_reasons: [
                "Search term may be too short (try 3+ characters)",
                "Pipedrive search may require exact word matches",
                "Search index may not be fully populated for this item type"
              ]
            }, null, 2)
          }]
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: `Found ${results.length} items`,
            search_term: term,
            item_types: itemTypes || "all",
            items: results
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error performing search with term "${term}":`, error);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: `Error performing search: ${getErrorMessage(error)}`,
            suggestion: "Try using specific tools: find-person, get-persons, get-organizations, or get-deals with filter parameters"
          }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// === WRITE OPERATIONS ===

// --- Deal Write Operations ---

server.tool(
  "create-deal",
  "Create a new deal in Pipedrive. All deals created through the API have origin='API'.",
  {
    title: z.string().describe("Deal title (required)"),
    value: z.number().optional().describe("Deal value (monetary amount)"),
    currency: z.string().optional().describe("Currency code (e.g., 'USD', 'EUR'). Must match account's allowed currencies."),
    personId: z.number().optional().describe("ID of the person this deal is associated with"),
    orgId: z.number().optional().describe("ID of the organization this deal is associated with"),
    stageId: z.number().optional().describe("ID of the pipeline stage (use get-stages to find IDs)"),
    pipelineId: z.number().optional().describe("ID of the pipeline (use get-pipelines to find IDs)"),
    status: z.enum(['open', 'won', 'lost']).optional().describe("Deal status (default: open)"),
    expectedCloseDate: z.string().optional().describe("Expected close date in YYYY-MM-DD format"),
    probability: z.number().optional().describe("Success probability percentage (0-100)"),
    lostReason: z.string().optional().describe("Reason for lost deal (only used if status=lost)"),
    visibleTo: z.enum(['1', '3', '5', '7']).optional().describe("Visibility: 1=Owner only, 3=Owner+followers, 5=All users, 7=Entire company"),
    ownerId: z.number().optional().describe("Owner user ID (use get-users to find IDs)")
  },
  async ({
    title,
    value,
    currency,
    personId,
    orgId,
    stageId,
    pipelineId,
    status,
    expectedCloseDate,
    probability,
    lostReason,
    visibleTo,
    ownerId
  }) => {
    try {
      // Validate required fields
      if (!title || title.trim() === '') {
        return {
          content: [{
            type: "text",
            text: "Error: 'title' is required and cannot be empty"
          }],
          isError: true
        };
      }

      // Build request object with snake_case field names
      const newDeal: any = {
        title: title.trim(),
      };

      // Add optional fields only if provided
      if (value !== undefined) newDeal.value = value;
      if (currency) newDeal.currency = currency;
      if (personId) newDeal.person_id = personId;
      if (orgId) newDeal.org_id = orgId;
      if (stageId) newDeal.stage_id = stageId;
      if (pipelineId) newDeal.pipeline_id = pipelineId;
      if (status) newDeal.status = status;
      if (expectedCloseDate) newDeal.expected_close_date = expectedCloseDate;
      if (probability !== undefined) newDeal.probability = probability;
      if (lostReason) newDeal.lost_reason = lostReason;
      if (visibleTo) newDeal.visible_to = parseInt(visibleTo);
      if (ownerId) newDeal.user_id = ownerId;

      // Call API - Old SDK pattern: pass object directly
      // @ts-ignore - SDK types may be incomplete
      const response = await dealsApi.addDeal(newDeal);

      if (!response.data) {
        return {
          content: [{
            type: "text",
            text: "Error: API returned no data"
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Deal "${response.data.title}" created successfully`,
            deal_id: response.data.id,
            deal: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error creating deal:", error);
      return {
        content: [{
          type: "text",
          text: `Error creating deal: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "update-deal",
  "Update an existing deal in Pipedrive",
  {
    id: z.number().describe("Deal ID (required)"),
    title: z.string().optional().describe("Deal title"),
    value: z.number().optional().describe("Deal value"),
    currency: z.string().optional().describe("Currency code"),
    personId: z.number().optional().describe("ID of the person"),
    orgId: z.number().optional().describe("ID of the organization"),
    stageId: z.number().optional().describe("ID of the pipeline stage"),
    pipelineId: z.number().optional().describe("ID of the pipeline"),
    status: z.enum(['open', 'won', 'lost']).optional().describe("Deal status"),
    expectedCloseDate: z.string().optional().describe("Expected close date (YYYY-MM-DD)"),
    probability: z.number().optional().describe("Success probability (0-100)"),
    lostReason: z.string().optional().describe("Reason for lost deal"),
    visibleTo: z.enum(['1', '3', '5', '7']).optional().describe("Visibility setting"),
    ownerId: z.number().optional().describe("Owner user ID")
  },
  async ({
    id,
    title,
    value,
    currency,
    personId,
    orgId,
    stageId,
    pipelineId,
    status,
    expectedCloseDate,
    probability,
    lostReason,
    visibleTo,
    ownerId
  }) => {
    try {
      // Verify deal exists
      // @ts-ignore
      const existing = await dealsApi.getDeal({ id });
      if (!existing.data) {
        return {
          content: [{
            type: "text",
            text: `Error: Deal ${id} not found`
          }],
          isError: true
        };
      }

      // Build update object
      const updateDeal: any = {};

      if (title) updateDeal.title = title;
      if (value !== undefined) updateDeal.value = value;
      if (currency) updateDeal.currency = currency;
      if (personId) updateDeal.person_id = personId;
      if (orgId) updateDeal.org_id = orgId;
      if (stageId) updateDeal.stage_id = stageId;
      if (pipelineId) updateDeal.pipeline_id = pipelineId;
      if (status) updateDeal.status = status;
      if (expectedCloseDate) updateDeal.expected_close_date = expectedCloseDate;
      if (probability !== undefined) updateDeal.probability = probability;
      if (lostReason) updateDeal.lost_reason = lostReason;
      if (visibleTo) updateDeal.visible_to = parseInt(visibleTo);
      if (ownerId) updateDeal.user_id = ownerId;

      // Call API - Old SDK pattern: (id, updateObject)
      // @ts-ignore
      const response = await dealsApi.updateDeal(id, updateDeal);

      if (!response.data) {
        return {
          content: [{
            type: "text",
            text: "Error: API returned no data"
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Deal ${id} updated successfully`,
            deal: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error updating deal ${id}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error updating deal: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "delete-deal",
  "Delete a deal (soft delete with 30-day recovery). CAUTION: This is a destructive operation.",
  {
    id: z.number().describe("ID of the deal to delete"),
    confirm: z.literal(true).describe("Must be set to true to confirm deletion")
  },
  async ({ id, confirm }) => {
    try {
      // Verify deal exists and get title for response
      // @ts-ignore
      const existing = await dealsApi.getDeal({ id });
      if (!existing.data) {
        return {
          content: [{
            type: "text",
            text: `Error: Deal ${id} not found`
          }],
          isError: true
        };
      }

      const dealTitle = existing.data.title;

      // Perform deletion
      // @ts-ignore
      await dealsApi.deleteDeal({ id });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Deal "${dealTitle}" (ID: ${id}) has been deleted`,
            note: "This is a soft delete. The deal can be recovered within 30 days via Pipedrive UI: Settings > Data fields > Deleted items",
            deleted_deal_id: id
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error deleting deal ${id}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error deleting deal: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// --- Person Write Operations ---

server.tool(
  "create-person",
  "Create a new person (contact) in Pipedrive",
  {
    name: z.string().describe("Person's name (required)"),
    email: z.string().email().optional().describe("Email address"),
    phone: z.string().optional().describe("Phone number"),
    orgId: z.number().optional().describe("ID of the organization this person belongs to"),
    ownerId: z.number().optional().describe("Owner user ID"),
    visibleTo: z.enum(['1', '3', '5', '7']).optional().describe("Visibility: 1=Owner only, 3=Owner+followers, 5=All users, 7=Entire company")
  },
  async ({ name, email, phone, orgId, ownerId, visibleTo }) => {
    try {
      if (!name || name.trim() === '') {
        return {
          content: [{
            type: "text",
            text: "Error: 'name' is required and cannot be empty"
          }],
          isError: true
        };
      }

      const newPerson: any = {
        name: name.trim()
      };

      // Build email array if provided
      if (email) {
        newPerson.email = [{
          value: email,
          primary: true,
          label: 'work'
        }];
      }

      // Build phone array if provided
      if (phone) {
        newPerson.phone = [{
          value: phone,
          primary: true,
          label: 'work'
        }];
      }

      if (orgId) newPerson.org_id = orgId;
      if (ownerId) newPerson.owner_id = ownerId;
      if (visibleTo) newPerson.visible_to = parseInt(visibleTo);

      // @ts-ignore - Old SDK pattern: pass object directly
      const response = await personsApi.addPerson(newPerson);

      if (!response.data) {
        return {
          content: [{
            type: "text",
            text: "Error: API returned no data"
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Person "${response.data.name}" created successfully`,
            person_id: response.data.id,
            person: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error creating person:", error);
      return {
        content: [{
          type: "text",
          text: `Error creating person: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "update-person",
  "Update an existing person in Pipedrive",
  {
    id: z.number().describe("Person ID (required)"),
    name: z.string().optional().describe("Person's name"),
    email: z.string().email().optional().describe("Email address"),
    phone: z.string().optional().describe("Phone number"),
    orgId: z.number().optional().describe("Organization ID"),
    ownerId: z.number().optional().describe("Owner user ID"),
    visibleTo: z.enum(['1', '3', '5', '7']).optional().describe("Visibility setting")
  },
  async ({ id, name, email, phone, orgId, ownerId, visibleTo }) => {
    try {
      // Verify person exists
      // @ts-ignore
      const existing = await personsApi.getPerson({ id });
      if (!existing.data) {
        return {
          content: [{
            type: "text",
            text: `Error: Person ${id} not found`
          }],
          isError: true
        };
      }

      const updatePerson: any = {};

      if (name) updatePerson.name = name;

      if (email) {
        updatePerson.email = [{
          value: email,
          primary: true,
          label: 'work'
        }];
      }

      if (phone) {
        updatePerson.phone = [{
          value: phone,
          primary: true,
          label: 'work'
        }];
      }

      if (orgId) updatePerson.org_id = orgId;
      if (ownerId) updatePerson.owner_id = ownerId;
      if (visibleTo) updatePerson.visible_to = parseInt(visibleTo);

      // @ts-ignore - Old SDK pattern: (id, updateObject)
      const response = await personsApi.updatePerson(id, updatePerson);

      if (!response.data) {
        return {
          content: [{
            type: "text",
            text: "Error: API returned no data"
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Person ${id} updated successfully`,
            person: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error updating person ${id}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error updating person: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "delete-person",
  "Delete a person (soft delete with 30-day recovery). CAUTION: This is a destructive operation.",
  {
    id: z.number().describe("ID of the person to delete"),
    confirm: z.literal(true).describe("Must be set to true to confirm deletion")
  },
  async ({ id, confirm }) => {
    try {
      // Verify person exists
      // @ts-ignore
      const existing = await personsApi.getPerson({ id });
      if (!existing.data) {
        return {
          content: [{
            type: "text",
            text: `Error: Person ${id} not found`
          }],
          isError: true
        };
      }

      const personName = existing.data.name;

      // @ts-ignore
      await personsApi.deletePerson({ id });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Person "${personName}" (ID: ${id}) has been deleted`,
            note: "This is a soft delete. The person can be recovered within 30 days via Pipedrive UI: Settings > Data fields > Deleted items",
            deleted_person_id: id
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error deleting person ${id}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error deleting person: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// --- Organization Write Operations ---

server.tool(
  "create-organization",
  "Create a new organization in Pipedrive",
  {
    name: z.string().describe("Organization name (required)"),
    ownerId: z.number().optional().describe("Owner user ID"),
    visibleTo: z.enum(['1', '3', '5', '7']).optional().describe("Visibility: 1=Owner only, 3=Owner+followers, 5=All users, 7=Entire company"),
    address: z.string().optional().describe("Full organization address")
  },
  async ({ name, ownerId, visibleTo, address }) => {
    try {
      if (!name || name.trim() === '') {
        return {
          content: [{
            type: "text",
            text: "Error: 'name' is required and cannot be empty"
          }],
          isError: true
        };
      }

      const newOrganization: any = {
        name: name.trim()
      };

      if (ownerId) newOrganization.owner_id = ownerId;
      if (visibleTo) newOrganization.visible_to = parseInt(visibleTo);

      if (address) {
        newOrganization.address = address;
      }

      // @ts-ignore - Old SDK pattern: pass object directly
      const response = await organizationsApi.addOrganization(newOrganization);

      if (!response.data) {
        return {
          content: [{
            type: "text",
            text: "Error: API returned no data"
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Organization "${response.data.name}" created successfully`,
            organization_id: response.data.id,
            organization: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error creating organization:", error);
      return {
        content: [{
          type: "text",
          text: `Error creating organization: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "update-organization",
  "Update an existing organization in Pipedrive",
  {
    id: z.number().describe("Organization ID (required)"),
    name: z.string().optional().describe("Organization name"),
    ownerId: z.number().optional().describe("Owner user ID"),
    visibleTo: z.enum(['1', '3', '5', '7']).optional().describe("Visibility setting"),
    address: z.string().optional().describe("Full organization address")
  },
  async ({ id, name, ownerId, visibleTo, address }) => {
    try {
      // Verify organization exists
      // @ts-ignore
      const existing = await organizationsApi.getOrganization({ id });
      if (!existing.data) {
        return {
          content: [{
            type: "text",
            text: `Error: Organization ${id} not found`
          }],
          isError: true
        };
      }

      const updateOrganization: any = {};

      if (name) updateOrganization.name = name;
      if (ownerId) updateOrganization.owner_id = ownerId;
      if (visibleTo) updateOrganization.visible_to = parseInt(visibleTo);
      if (address) updateOrganization.address = address;

      // @ts-ignore - Old SDK pattern: (id, updateObject)
      const response = await organizationsApi.updateOrganization(id, updateOrganization);

      if (!response.data) {
        return {
          content: [{
            type: "text",
            text: "Error: API returned no data"
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Organization ${id} updated successfully`,
            organization: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error updating organization ${id}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error updating organization: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "delete-organization",
  "Delete an organization (soft delete with 30-day recovery). CAUTION: This is a destructive operation.",
  {
    id: z.number().describe("ID of the organization to delete"),
    confirm: z.literal(true).describe("Must be set to true to confirm deletion")
  },
  async ({ id, confirm }) => {
    try {
      // Verify organization exists
      // @ts-ignore
      const existing = await organizationsApi.getOrganization({ id });
      if (!existing.data) {
        return {
          content: [{
            type: "text",
            text: `Error: Organization ${id} not found`
          }],
          isError: true
        };
      }

      const orgName = existing.data.name;

      // @ts-ignore
      await organizationsApi.deleteOrganization({ id });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Organization "${orgName}" (ID: ${id}) has been deleted`,
            note: "This is a soft delete. The organization can be recovered within 30 days via Pipedrive UI: Settings > Data fields > Deleted items",
            deleted_organization_id: id
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error deleting organization ${id}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error deleting organization: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// --- Activity Write Operations ---

server.tool(
  "create-activity",
  "Create a new activity (task, call, meeting, etc.) in Pipedrive",
  {
    subject: z.string().describe("Activity subject/title (required)"),
    type: z.string().describe("Activity type (required): e.g., 'call', 'meeting', 'task', 'deadline', 'email', 'lunch'"),
    dueDate: z.string().optional().describe("Due date in YYYY-MM-DD format"),
    dueTime: z.string().optional().describe("Due time in HH:MM format"),
    duration: z.string().optional().describe("Duration in HH:MM format"),
    dealId: z.number().optional().describe("ID of the deal this activity is associated with"),
    personId: z.number().optional().describe("ID of the person this activity is associated with"),
    orgId: z.number().optional().describe("ID of the organization this activity is associated with"),
    note: z.string().optional().describe("Note content for the activity"),
    done: z.boolean().optional().describe("Whether the activity is marked as done (default: false)")
  },
  async ({ subject, type, dueDate, dueTime, duration, dealId, personId, orgId, note, done }) => {
    try {
      if (!subject || subject.trim() === '') {
        return {
          content: [{
            type: "text",
            text: "Error: 'subject' is required and cannot be empty"
          }],
          isError: true
        };
      }

      if (!type || type.trim() === '') {
        return {
          content: [{
            type: "text",
            text: "Error: 'type' is required and cannot be empty"
          }],
          isError: true
        };
      }

      const newActivity: any = {
        subject: subject.trim(),
        type: type.trim()
      };

      if (dueDate) newActivity.due_date = dueDate;
      if (dueTime) newActivity.due_time = dueTime;
      if (duration) newActivity.duration = duration;
      if (dealId) newActivity.deal_id = dealId;
      if (personId) newActivity.person_id = personId;
      if (orgId) newActivity.org_id = orgId;
      if (note) newActivity.note = note;
      if (done !== undefined) newActivity.done = done ? 1 : 0;

      // @ts-ignore - Old SDK pattern: pass object directly
      const response = await activitiesApi.addActivity(newActivity);

      if (!response.data) {
        return {
          content: [{
            type: "text",
            text: "Error: API returned no data"
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Activity "${response.data.subject}" created successfully`,
            activity_id: response.data.id,
            activity: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error creating activity:", error);
      return {
        content: [{
          type: "text",
          text: `Error creating activity: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "update-activity",
  "Update an existing activity in Pipedrive",
  {
    id: z.number().describe("Activity ID (required)"),
    subject: z.string().optional().describe("Activity subject/title"),
    type: z.string().optional().describe("Activity type"),
    dueDate: z.string().optional().describe("Due date (YYYY-MM-DD)"),
    dueTime: z.string().optional().describe("Due time (HH:MM)"),
    duration: z.string().optional().describe("Duration (HH:MM)"),
    dealId: z.number().optional().describe("Deal ID"),
    personId: z.number().optional().describe("Person ID"),
    orgId: z.number().optional().describe("Organization ID"),
    note: z.string().optional().describe("Note content"),
    done: z.boolean().optional().describe("Mark as done/undone")
  },
  async ({ id, subject, type, dueDate, dueTime, duration, dealId, personId, orgId, note, done }) => {
    try {
      // Verify activity exists
      // @ts-ignore
      const existing = await activitiesApi.getActivity({ id });
      if (!existing.data) {
        return {
          content: [{
            type: "text",
            text: `Error: Activity ${id} not found`
          }],
          isError: true
        };
      }

      const updateActivity: any = {};

      if (subject) updateActivity.subject = subject;
      if (type) updateActivity.type = type;
      if (dueDate) updateActivity.due_date = dueDate;
      if (dueTime) updateActivity.due_time = dueTime;
      if (duration) updateActivity.duration = duration;
      if (dealId) updateActivity.deal_id = dealId;
      if (personId) updateActivity.person_id = personId;
      if (orgId) updateActivity.org_id = orgId;
      if (note) updateActivity.note = note;
      if (done !== undefined) updateActivity.done = done ? 1 : 0;

      // @ts-ignore - Old SDK pattern: (id, updateObject)
      const response = await activitiesApi.updateActivity(id, updateActivity);

      if (!response.data) {
        return {
          content: [{
            type: "text",
            text: "Error: API returned no data"
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Activity ${id} updated successfully`,
            activity: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error updating activity ${id}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error updating activity: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "delete-activity",
  "Delete an activity (soft delete with 30-day recovery). CAUTION: This is a destructive operation.",
  {
    id: z.number().describe("ID of the activity to delete"),
    confirm: z.literal(true).describe("Must be set to true to confirm deletion")
  },
  async ({ id, confirm }) => {
    try {
      // Verify activity exists
      // @ts-ignore
      const existing = await activitiesApi.getActivity({ id });
      if (!existing.data) {
        return {
          content: [{
            type: "text",
            text: `Error: Activity ${id} not found`
          }],
          isError: true
        };
      }

      const activitySubject = existing.data.subject;

      // @ts-ignore
      await activitiesApi.deleteActivity({ id });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Activity "${activitySubject}" (ID: ${id}) has been deleted`,
            note: "This is a soft delete. The activity can be recovered within 30 days via Pipedrive UI: Settings > Data fields > Deleted items",
            deleted_activity_id: id
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error deleting activity ${id}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error deleting activity: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// --- Note Write Operations ---

server.tool(
  "create-note",
  "Create a new note in Pipedrive and attach it to a deal, person, organization, or lead",
  {
    content: z.string().describe("Note content (required)"),
    dealId: z.number().optional().describe("ID of the deal to attach the note to"),
    personId: z.number().optional().describe("ID of the person to attach the note to"),
    orgId: z.number().optional().describe("ID of the organization to attach the note to"),
    leadId: z.string().optional().describe("ID of the lead to attach the note to")
  },
  async ({ content, dealId, personId, orgId, leadId }) => {
    try {
      if (!content || content.trim() === '') {
        return {
          content: [{
            type: "text",
            text: "Error: 'content' is required and cannot be empty"
          }],
          isError: true
        };
      }

      const newNote: any = {
        content: content.trim()
      };

      if (dealId) newNote.deal_id = dealId;
      if (personId) newNote.person_id = personId;
      if (orgId) newNote.org_id = orgId;
      if (leadId) newNote.lead_id = leadId;

      // @ts-ignore - Old SDK pattern: pass object directly
      const response = await notesApi.addNote(newNote);

      if (!response.data) {
        return {
          content: [{
            type: "text",
            text: "Error: API returned no data"
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: "Note created successfully",
            note_id: response.data.id,
            note: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error creating note:", error);
      return {
        content: [{
          type: "text",
          text: `Error creating note: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "update-note",
  "Update an existing note in Pipedrive",
  {
    id: z.number().describe("Note ID (required)"),
    content: z.string().describe("Updated note content (required)")
  },
  async ({ id, content }) => {
    try {
      if (!content || content.trim() === '') {
        return {
          content: [{
            type: "text",
            text: "Error: 'content' is required and cannot be empty"
          }],
          isError: true
        };
      }

      // Verify note exists
      // @ts-ignore
      const existing = await notesApi.getNote({ id });
      if (!existing.data) {
        return {
          content: [{
            type: "text",
            text: `Error: Note ${id} not found`
          }],
          isError: true
        };
      }

      const updateNote: any = {
        content: content.trim()
      };

      // @ts-ignore - Old SDK pattern: (id, updateObject)
      const response = await notesApi.updateNote(id, updateNote);

      if (!response.data) {
        return {
          content: [{
            type: "text",
            text: "Error: API returned no data"
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Note ${id} updated successfully`,
            note: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error updating note ${id}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error updating note: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "delete-note",
  "Delete a note. CAUTION: This is a destructive operation.",
  {
    id: z.number().describe("ID of the note to delete"),
    confirm: z.literal(true).describe("Must be set to true to confirm deletion")
  },
  async ({ id, confirm }) => {
    try {
      // Verify note exists
      // @ts-ignore
      const existing = await notesApi.getNote({ id });
      if (!existing.data) {
        return {
          content: [{
            type: "text",
            text: `Error: Note ${id} not found`
          }],
          isError: true
        };
      }

      // @ts-ignore
      await notesApi.deleteNote({ id });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Note ${id} has been deleted`,
            deleted_note_id: id
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error deleting note ${id}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error deleting note: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// --- Lead Write Operations ---

server.tool(
  "create-lead",
  "Create a new lead in Pipedrive. Must be linked to a person or organization (or both).",
  {
    title: z.string().describe("Lead title (required)"),
    personId: z.number().optional().describe("ID of the person associated with this lead"),
    organizationId: z.number().optional().describe("ID of the organization associated with this lead"),
    value: z.number().optional().describe("Potential value of the lead"),
    ownerId: z.number().optional().describe("Owner user ID"),
    expectedCloseDate: z.string().optional().describe("Expected close date (YYYY-MM-DD)")
  },
  async ({ title, personId, organizationId, value, ownerId, expectedCloseDate }) => {
    try {
      if (!title || title.trim() === '') {
        return {
          content: [{
            type: "text",
            text: "Error: 'title' is required and cannot be empty"
          }],
          isError: true
        };
      }

      if (!personId && !organizationId) {
        return {
          content: [{
            type: "text",
            text: "Error: Lead must be linked to at least one person (personId) or organization (organizationId)"
          }],
          isError: true
        };
      }

      const newLead: any = {
        title: title.trim()
      };

      if (personId) newLead.person_id = personId;
      if (organizationId) newLead.organization_id = organizationId;
      if (value !== undefined) newLead.value = { amount: value, currency: 'USD' };
      if (ownerId) newLead.owner_id = ownerId;
      if (expectedCloseDate) newLead.expected_close_date = expectedCloseDate;

      // @ts-ignore - Old SDK pattern: pass object directly
      const response = await leadsApi.addLead(newLead);

      if (!response.data) {
        return {
          content: [{
            type: "text",
            text: "Error: API returned no data"
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Lead "${response.data.title}" created successfully`,
            lead_id: response.data.id,
            lead: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error("Error creating lead:", error);
      return {
        content: [{
          type: "text",
          text: `Error creating lead: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "update-lead",
  "Update an existing lead in Pipedrive",
  {
    id: z.string().describe("Lead ID (UUID format, required)"),
    title: z.string().optional().describe("Lead title"),
    personId: z.number().optional().describe("Person ID"),
    organizationId: z.number().optional().describe("Organization ID"),
    value: z.number().optional().describe("Lead value"),
    ownerId: z.number().optional().describe("Owner user ID"),
    expectedCloseDate: z.string().optional().describe("Expected close date (YYYY-MM-DD)")
  },
  async ({ id, title, personId, organizationId, value, ownerId, expectedCloseDate }) => {
    try {
      // Verify lead exists
      // @ts-ignore
      const existing = await leadsApi.getLead({ id });
      if (!existing.data) {
        return {
          content: [{
            type: "text",
            text: `Error: Lead ${id} not found`
          }],
          isError: true
        };
      }

      const updateLead: any = {};

      if (title) updateLead.title = title;
      if (personId) updateLead.person_id = personId;
      if (organizationId) updateLead.organization_id = organizationId;
      if (value !== undefined) updateLead.value = { amount: value, currency: 'USD' };
      if (ownerId) updateLead.owner_id = ownerId;
      if (expectedCloseDate) updateLead.expected_close_date = expectedCloseDate;

      // @ts-ignore - Old SDK pattern: (id, updateObject)
      const response = await leadsApi.updateLead(id, updateLead);

      if (!response.data) {
        return {
          content: [{
            type: "text",
            text: "Error: API returned no data"
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Lead ${id} updated successfully`,
            lead: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error updating lead ${id}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error updating lead: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "delete-lead",
  "Delete a lead. CAUTION: This is a destructive operation.",
  {
    id: z.string().describe("Lead ID (UUID format) to delete"),
    confirm: z.literal(true).describe("Must be set to true to confirm deletion")
  },
  async ({ id, confirm }) => {
    try {
      // Verify lead exists
      // @ts-ignore
      const existing = await leadsApi.getLead({ id });
      if (!existing.data) {
        return {
          content: [{
            type: "text",
            text: `Error: Lead ${id} not found`
          }],
          isError: true
        };
      }

      const leadTitle = existing.data.title;

      // @ts-ignore
      await leadsApi.deleteLead({ id });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Lead "${leadTitle}" (ID: ${id}) has been deleted`,
            deleted_lead_id: id
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error deleting lead ${id}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error deleting lead: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "convert-lead-to-deal",
  "Convert a lead to a deal. Returns a conversion job ID for tracking status.",
  {
    id: z.string().describe("Lead ID (UUID format) to convert"),
    stageId: z.number().optional().describe("Pipeline stage ID for the new deal"),
    dealTitle: z.string().optional().describe("Title for the new deal (defaults to lead title)"),
    personId: z.number().optional().describe("Person ID (if different from lead's person)"),
    organizationId: z.number().optional().describe("Organization ID (if different from lead's org)")
  },
  async ({ id, stageId, dealTitle, personId, organizationId }) => {
    try {
      const convertRequest: any = {};

      if (stageId) convertRequest.stage_id = stageId;
      if (dealTitle) convertRequest.deal_title = dealTitle;
      if (personId) convertRequest.person_id = personId;
      if (organizationId) convertRequest.organization_id = organizationId;

      // @ts-ignore
      const response = await leadsApi.convertLeadToDeal({ id, convertRequest });

      if (!response.data) {
        return {
          content: [{
            type: "text",
            text: "Error: API returned no data"
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Lead conversion initiated successfully`,
            conversion_id: response.data.conversion_id,
            note: "Conversion is processing. Use the conversion_id to check status via Pipedrive API if needed.",
            data: response.data
          }, null, 2)
        }]
      };
    } catch (error) {
      console.error(`Error converting lead ${id}:`, error);
      return {
        content: [{
          type: "text",
          text: `Error converting lead: ${getErrorMessage(error)}`
        }],
        isError: true
      };
    }
  }
);

// === PROMPTS ===

// Prompt for getting all deals
server.prompt(
  "list-all-deals",
  "List all deals in Pipedrive",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please list all deals in my Pipedrive account, showing their title, value, status, and stage."
      }
    }]
  })
);

// Prompt for getting all persons
server.prompt(
  "list-all-persons",
  "List all persons in Pipedrive",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please list all persons in my Pipedrive account, showing their name, email, phone, and organization."
      }
    }]
  })
);

// Prompt for getting all pipelines
server.prompt(
  "list-all-pipelines",
  "List all pipelines in Pipedrive",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please list all pipelines in my Pipedrive account, showing their name and stages."
      }
    }]
  })
);

// Prompt for analyzing deals
server.prompt(
  "analyze-deals",
  "Analyze deals by stage",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please analyze the deals in my Pipedrive account, grouping them by stage and providing total value for each stage."
      }
    }]
  })
);

// Prompt for analyzing contacts
server.prompt(
  "analyze-contacts",
  "Analyze contacts by organization",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please analyze the persons in my Pipedrive account, grouping them by organization and providing a count for each organization."
      }
    }]
  })
);

// Prompt for analyzing leads
server.prompt(
  "analyze-leads",
  "Analyze leads by status",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please search for all leads in my Pipedrive account and group them by status."
      }
    }]
  })
);

// Prompt for pipeline comparison
server.prompt(
  "compare-pipelines",
  "Compare different pipelines and their stages",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please list all pipelines in my Pipedrive account and compare them by showing the stages in each pipeline."
      }
    }]
  })
);

// Prompt for finding high-value deals
server.prompt(
  "find-high-value-deals",
  "Find high-value deals",
  {},
  () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Please identify the highest value deals in my Pipedrive account and provide information about which stage they're in and which person or organization they're associated with."
      }
    }]
  })
);

// Get transport type from environment variable (default to stdio)
const transportType = process.env.MCP_TRANSPORT || 'stdio';

if (transportType === 'sse') {
  // SSE transport - create HTTP server
  const port = parseInt(process.env.MCP_PORT || '3000', 10);
  const endpoint = process.env.MCP_ENDPOINT || '/message';

  // Store active transports by session ID
  const transports = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/sse') {
      const authResult = verifyRequestAuthentication(req);
      if (!authResult.ok) {
        res.writeHead(authResult.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: authResult.message }));
        return;
      }

      // Establish SSE connection
      console.error('New SSE connection request');
      const transport = new SSEServerTransport(endpoint, res);

      // Store transport by session ID
      transports.set(transport.sessionId, transport);

      transport.onclose = () => {
        console.error(`SSE connection closed: ${transport.sessionId}`);
        transports.delete(transport.sessionId);
      };

      try {
        await server.connect(transport);
        console.error(`SSE connection established: ${transport.sessionId}`);
      } catch (err) {
        console.error('Failed to establish SSE connection:', err);
        transports.delete(transport.sessionId);
      }
    } else if (req.method === 'POST' && url.pathname === endpoint) {
      const authResult = verifyRequestAuthentication(req);
      if (!authResult.ok) {
        res.writeHead(authResult.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: authResult.message }));
        return;
      }

      // Handle incoming message
      const sessionId = url.searchParams.get('sessionId') || req.headers['x-session-id'] as string;

      if (!sessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing sessionId' }));
        return;
      }

      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      req.on('error', err => {
        console.error('Error receiving POST message body:', err);
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request body' }));
        }
      });

      try {
        await transport.handlePostMessage(req, res);
      } catch (err) {
        console.error('Error handling POST message:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
    } else {
      // Health check endpoint
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', transport: 'sse' }));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    }
  });

  httpServer.listen(port, () => {
    console.error(`Pipedrive MCP Server (SSE) listening on port ${port}`);
    console.error(`SSE endpoint: http://localhost:${port}/sse`);
    console.error(`Message endpoint: http://localhost:${port}${endpoint}`);
  });
} else {
  // Default: stdio transport
  const transport = new StdioServerTransport();
  server.connect(transport).catch(err => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
  });

  console.error("Pipedrive MCP Server started (stdio transport)");
}
