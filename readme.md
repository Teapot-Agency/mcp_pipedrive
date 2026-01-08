# Pipedrive MCP Server

A Model Context Protocol (MCP) server that provides full CRUD access to Pipedrive CRM API v1. Enable Claude and other LLM applications to read and write Pipedrive data seamlessly.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](https://github.com/Teapot-Agency/mcp_pipedrive)

## 🚀 Features

- **Full CRUD Operations** - Create, Read, Update, and Delete support for all major Pipedrive entities
- **40 Total Tools** - 20 read operations + 20 write operations
- **Complete Data Access** - Deals, persons, organizations, activities, notes, and leads
- **Custom Fields Support** - Full access to custom fields and configurations
- **Built-in Safety** - Mandatory confirmation for delete operations, soft delete with 30-day recovery
- **Rate Limiting** - Automatic request throttling to respect API limits
- **Advanced Filtering** - Filter deals by owner, status, date range, value, and more. Filter persons by name, email, organization, or phone
- **Fuzzy Search** - New `find-person` tool with intelligent fuzzy matching and scoring
- **Smart Error Messages** - Helpful suggestions when searches return no results
- **JWT Authentication** - Optional JWT security for SSE transport
- **Docker Support** - Multi-stage builds and container deployment
- **Dual Transport** - stdio (local) and SSE (HTTP) modes

## Setup

### Standard Setup

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Create a `.env` file in the root directory with your configuration:
   ```
   PIPEDRIVE_API_TOKEN=your_api_token_here
   PIPEDRIVE_DOMAIN=your-company.pipedrive.com
   ```
4. Build the project:
   ```
   npm run build
   ```
5. Start the server:
   ```
   npm start
   ```

### Docker Setup

#### Option 1: Using Docker Compose (standalone)

1. Copy `.env.example` to `.env` and configure your settings:
   ```bash
   PIPEDRIVE_API_TOKEN=your_api_token_here
   PIPEDRIVE_DOMAIN=your-company.pipedrive.com
   MCP_TRANSPORT=sse  # Use SSE transport for Docker
   MCP_PORT=3000
   ```
2. Build and run with Docker Compose:
   ```bash
   docker-compose up -d
   ```
3. The server will be available at `http://localhost:3000`
   - SSE endpoint: `http://localhost:3000/sse`
   - Health check: `http://localhost:3000/health`

#### Option 2: Using Pre-built Docker Image

Pull and run the pre-built image from GitHub Container Registry:

**For SSE transport (HTTP access):**
```bash
docker run -d \
  -p 3000:3000 \
  -e PIPEDRIVE_API_TOKEN=your_api_token_here \
  -e PIPEDRIVE_DOMAIN=your-company.pipedrive.com \
  -e MCP_TRANSPORT=sse \
  -e MCP_PORT=3000 \
  ghcr.io/juhokoskela/pipedrive-mcp-server:main
```

**For stdio transport (local use):**
```bash
docker run -i \
  -e PIPEDRIVE_API_TOKEN=your_api_token_here \
  -e PIPEDRIVE_DOMAIN=your-company.pipedrive.com \
  ghcr.io/juhokoskela/pipedrive-mcp-server:main
```

#### Option 3: Integrating into Existing Project

Add the MCP server to your existing application's `docker-compose.yml`:

```yaml
services:
  # Your existing services...

  pipedrive-mcp-server:
    image: ghcr.io/juhokoskela/pipedrive-mcp-server:main
    container_name: pipedrive-mcp-server
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PIPEDRIVE_API_TOKEN=${PIPEDRIVE_API_TOKEN}
      - PIPEDRIVE_DOMAIN=${PIPEDRIVE_DOMAIN}
      - MCP_TRANSPORT=sse
      - MCP_PORT=3000
      - PIPEDRIVE_RATE_LIMIT_MIN_TIME_MS=${PIPEDRIVE_RATE_LIMIT_MIN_TIME_MS:-250}
      - PIPEDRIVE_RATE_LIMIT_MAX_CONCURRENT=${PIPEDRIVE_RATE_LIMIT_MAX_CONCURRENT:-2}
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3000/health", "||", "exit", "1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

Then add the required environment variables to your `.env` file.

### Environment Variables

Required:
- `PIPEDRIVE_API_TOKEN` - Your Pipedrive API token
- `PIPEDRIVE_DOMAIN` - Your Pipedrive domain (e.g., `your-company.pipedrive.com`)

Optional (JWT Authentication):
- `MCP_JWT_SECRET` - JWT secret for authentication
- `MCP_JWT_TOKEN` - JWT token for authentication
- `MCP_JWT_ALGORITHM` - JWT algorithm (default: HS256)
- `MCP_JWT_AUDIENCE` - JWT audience
- `MCP_JWT_ISSUER` - JWT issuer

When JWT authentication is enabled, all SSE requests (`/sse` and the message endpoint) must include an `Authorization: Bearer <token>` header signed with the configured secret.

Optional (Rate Limiting):
- `PIPEDRIVE_RATE_LIMIT_MIN_TIME_MS` - Minimum time between requests in milliseconds (default: 250)
- `PIPEDRIVE_RATE_LIMIT_MAX_CONCURRENT` - Maximum concurrent requests (default: 2)

Optional (Transport Configuration):
- `MCP_TRANSPORT` - Transport type: `stdio` (default, for local use) or `sse` (for Docker/HTTP access)
- `MCP_PORT` - Port for SSE transport (default: 3000, only used when `MCP_TRANSPORT=sse`)
- `MCP_ENDPOINT` - Message endpoint path for SSE (default: /message, only used when `MCP_TRANSPORT=sse`)

## Using with Claude

To use this server with Claude for Desktop:

1. Configure Claude for Desktop by editing your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pipedrive": {
      "command": "node",
      "args": ["/path/to/pipedrive-mcp-server/build/index.js"],
      "env": {
        "PIPEDRIVE_API_TOKEN": "your_api_token_here",
        "PIPEDRIVE_DOMAIN": "your-company.pipedrive.com"
      }
    }
  }
}
```

2. Restart Claude for Desktop
3. In the Claude application, you should now see the Pipedrive tools available

## Available Tools

### Read Operations (20 tools)

**Users & Search:**
- `get-users`: Get all users/owners from Pipedrive to identify owner IDs for filtering
- `search-all`: Search across all item types (deals, persons, organizations, etc.) with improved error messages

**Deals:**
- `get-deals`: Get deals with flexible filtering options (search by title, date range, owner, stage, status, value range, etc.)
- `get-deal`: Get a specific deal by ID (including custom fields)
- `get-deal-notes`: Get detailed notes and custom booking details for a specific deal
- `search-deals`: Search deals by term

**Persons (NEW & IMPROVED):**
- `get-persons`: 🆕 **Enhanced** - Get all persons with optional filtering by name, email, phone, organization ID, or organization name
- `find-person`: ✨ **NEW** - Find persons using fuzzy matching across name, email, phone, and company with intelligent scoring
- `get-persons-by-organization`: ✨ **NEW** - Get all persons belonging to a specific organization
- `get-person`: Get a specific person by ID (including custom fields)
- `get-person-notes`: Get all notes attached to a specific person
- `search-persons`: 🆕 **Enhanced** - Search persons with improved error messages and suggestions
- `search-persons-by-notes`: Search for persons who have attached notes containing a specific keyword

**Organizations (NEW & IMPROVED):**
- `get-organizations`: 🆕 **Enhanced** - Get all organizations with optional filtering by name
- `get-organization`: Get a specific organization by ID (including custom fields)
- `search-organizations`: 🆕 **Enhanced** - Search organizations with improved error messages and suggestions

**Pipelines & Stages:**
- `get-pipelines`: Get all pipelines from Pipedrive
- `get-pipeline`: Get a specific pipeline by ID
- `get-stages`: Get all stages from all pipelines

**Leads:**
- `search-leads`: Search leads by term

### Write Operations (20 tools)

**Deal Operations:**
- `create-deal`: Create a new deal with custom fields support
- `update-deal`: Update an existing deal
- `delete-deal`: Delete a deal (soft delete with 30-day recovery, requires confirmation)

**Person Operations:**
- `create-person`: Create a new contact with email and phone support
- `update-person`: Update an existing contact
- `delete-person`: Delete a person (soft delete with 30-day recovery, requires confirmation)

**Organization Operations:**
- `create-organization`: Create a new organization with address support
- `update-organization`: Update an existing organization
- `delete-organization`: Delete an organization (soft delete with 30-day recovery, requires confirmation)

**Activity Operations:**
- `create-activity`: Create tasks, calls, meetings, deadlines, etc.
- `update-activity`: Update an existing activity
- `delete-activity`: Delete an activity (soft delete with 30-day recovery, requires confirmation)

**Note Operations:**
- `create-note`: Create notes attached to deals, persons, organizations, or leads
- `update-note`: Update note content
- `delete-note`: Delete a note (requires confirmation)

**Lead Operations:**
- `create-lead`: Create a new lead
- `update-lead`: Update an existing lead
- `delete-lead`: Delete a lead (requires confirmation)
- `convert-lead-to-deal`: Convert a lead to a deal with conversion tracking

## Safety Guidelines

**Delete Operations:**
All delete operations require a `confirm: true` parameter to prevent accidental deletions. Most deletions in Pipedrive are soft deletes with a 30-day recovery period.

**Recovery:**
Deleted items can be recovered within 30 days via Pipedrive UI:
- Navigate to: Settings > Data fields > Deleted items
- Select the item type (deals, persons, organizations, activities)
- Click "Restore" on the item you want to recover

**Best Practices:**
- Always verify the entity ID before deleting
- Use search/get operations first to confirm you're targeting the correct item
- Document important deletions for audit purposes
- Consider archiving or status changes instead of deletion when appropriate

## Available Prompts

- `list-all-deals`: List all deals in Pipedrive
- `list-all-persons`: List all persons in Pipedrive
- `list-all-pipelines`: List all pipelines in Pipedrive
- `analyze-deals`: Analyze deals by stage
- `analyze-contacts`: Analyze contacts by organization
- `analyze-leads`: Analyze leads by status
- `compare-pipelines`: Compare different pipelines and their stages
- `find-high-value-deals`: Find high-value deals

## 🔍 Search Improvements (v2.1)

The server now includes powerful new search and filtering capabilities to address common issues with Pipedrive's search API.

### Key Improvements

**Problem:** Pipedrive's native search API often returns empty results due to strict matching requirements.

**Solution:** We've added client-side filtering and fuzzy matching tools that are more reliable and flexible.

### Recommended Search Strategy

#### Finding a Person

1. **Best:** Use `find-person` with fuzzy matching
   ```javascript
   find-person({ name: "Piotr", company: "Haleon" })
   ```

2. **Good:** Use `get-persons` with filters
   ```javascript
   get-persons({ filterName: "Piotr", organizationName: "Haleon" })
   ```

3. **Fallback:** Use `search-persons` (Pipedrive's API)
   ```javascript
   search-persons({ term: "Piotr" })
   ```

#### Finding an Organization

1. **Recommended:** Use `get-organizations` with filter
   ```javascript
   get-organizations({ filterName: "Haleon" })
   ```

2. **Fallback:** Use `search-organizations` (Pipedrive's API)
   ```javascript
   search-organizations({ term: "Haleon" })
   ```

### New Tools

- **`find-person`**: Fuzzy matching with scoring across multiple fields
- **`get-persons-by-organization`**: Get all persons in a specific organization
- **Enhanced `get-persons`**: Filter by name, email, phone, organization
- **Enhanced `get-organizations`**: Filter by name

### Smart Error Messages

When searches return no results, you'll now get helpful feedback:

```json
{
  "items": [],
  "warning": "No results found using Pipedrive's search API",
  "suggestion": "Try using 'find-person' for fuzzy matching",
  "possible_reasons": [
    "Search term may be too short",
    "Pipedrive search requires exact matches",
    "Try alternative tools"
  ]
}
```

For detailed documentation of all improvements, see [IMPROVEMENTS.md](./IMPROVEMENTS.md)

## License

MIT
