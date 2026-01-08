# Pipedrive MCP Server - Search Improvements

## Summary of Changes

This update fixes the search functionality issues and adds powerful new filtering capabilities to the Pipedrive MCP server.

## Problems Fixed

1. **Empty Search Results**: The existing `search-persons`, `search-organizations`, and `search-all` tools were returning empty arrays because Pipedrive's search API requires specific conditions that weren't being met.

2. **No Filtering on List Endpoints**: The `get-persons` and `get-organizations` tools had no way to filter results, forcing retrieval of all data even when looking for specific items.

3. **No Organization-Based Person Lookup**: There was no way to get all persons belonging to a specific organization.

4. **Poor Error Messages**: When searches failed, the tools just returned empty arrays with no explanation or alternative suggestions.

## New Features

### 1. Enhanced `get-persons` Tool

**New Parameters:**
- `filterName`: Filter by person name (case-insensitive, partial match)
- `filterEmail`: Filter by email (case-insensitive, partial match)
- `filterPhone`: Filter by phone number (partial match)
- `organizationId`: Filter by organization ID
- `organizationName`: Filter by organization name (case-insensitive, partial match)
- `limit`: Maximum results to return (default: 100, max: 500)

**Example Usage:**
```javascript
// Find persons named "Piotr"
get-persons({ filterName: "Piotr" })

// Find persons from Haleon organization
get-persons({ organizationName: "Haleon" })

// Find persons with haleon.com email
get-persons({ filterEmail: "haleon.com" })
```

### 2. New `find-person` Tool (Fuzzy Matching)

A powerful new tool that uses fuzzy matching across multiple fields and scores results by relevance.

**Parameters:**
- `name`: Person name (fuzzy match - matches partial words and word beginnings)
- `company`: Company/organization name (fuzzy match)
- `email`: Email address (partial match)
- `phone`: Phone number (partial match)
- `limit`: Maximum results (default: 20)

**Features:**
- **Scoring System**: Results are ranked by match quality
- **Multiple Criteria**: Search across name, company, email, and phone simultaneously
- **Match Explanations**: Each result includes why it matched

**Example Usage:**
```javascript
// Find Piotr at Haleon
find-person({ name: "Piotr", company: "Haleon" })

// Find anyone at Haleon with partial name
find-person({ name: "Pi", company: "Haleon" })
```

**How Scoring Works:**
- Name match: +10 points
- Company match: +8 points
- Email match: +7 points
- Phone match: +6 points

Results are sorted by score (highest first).

### 3. New `get-persons-by-organization` Tool

Get all persons belonging to a specific organization in one call.

**Parameters:**
- `organizationId`: Organization ID (required)
- `limit`: Maximum results (default: 100)

**Example Usage:**
```javascript
// Get all persons in organization 96
get-persons-by-organization({ organizationId: 96 })
```

### 4. Enhanced `get-organizations` Tool

**New Parameters:**
- `filterName`: Filter by organization name (case-insensitive, partial match)
- `limit`: Maximum results (default: 100, max: 500)

**Example Usage:**
```javascript
// Find organizations with "Haleon" in name
get-organizations({ filterName: "Haleon" })
```

### 5. Improved Error Messages

All search tools now provide helpful feedback when they return no results:

**Before:**
```json
{ "items": [] }
```

**After:**
```json
{
  "items": [],
  "warning": "No results found using Pipedrive's search API",
  "suggestion": "Try using 'find-person' tool for more flexible fuzzy matching",
  "search_term": "Piotr",
  "possible_reasons": [
    "Search term may be too short (try 3+ characters)",
    "Pipedrive search may require exact word matches",
    "Search index may not be fully populated"
  ],
  "alternative": "Use: find-person with name=\"Piotr\""
}
```

## Updated Tools

### `search-persons`
- Now includes warning and suggestions when returning empty results
- Recommends using `find-person` as alternative

### `search-organizations`
- Now includes warning and suggestions when returning empty results
- Recommends using `get-organizations` with `filterName` parameter

### `search-all`
- Now includes warning and suggestions when returning empty results
- Provides specific alternatives for each item type

## Recommended Workflow

### Finding a Person

1. **First Try**: Use `find-person` with fuzzy matching
   ```javascript
   find-person({ name: "Piotr", company: "Haleon" })
   ```

2. **Fallback**: Use `get-persons` with filters
   ```javascript
   get-persons({ filterName: "Piotr", organizationName: "Haleon" })
   ```

3. **Last Resort**: Use `search-persons` (Pipedrive's API)
   ```javascript
   search-persons({ term: "Piotr" })
   ```

### Finding an Organization

1. **Recommended**: Use `get-organizations` with filter
   ```javascript
   get-organizations({ filterName: "Haleon" })
   ```

2. **Fallback**: Use `search-organizations` (Pipedrive's API)
   ```javascript
   search-organizations({ term: "Haleon" })
   ```

### Getting Persons by Organization

Once you have the organization ID:
```javascript
get-persons-by-organization({ organizationId: 96 })
```

## Technical Implementation

### Client-Side Filtering
All new filtering is done client-side after fetching data from Pipedrive. This is more reliable than Pipedrive's search API and provides consistent results.

### Fuzzy Matching Algorithm
The `find-person` tool uses a simple but effective fuzzy matching algorithm:
- Exact substring matching (case-insensitive)
- Word boundary matching (matches if any word starts with the pattern)
- Scoring system to rank results by relevance

### Performance Considerations
- All tools cap results at 500 to prevent excessive data transfer
- Default limits are set to reasonable values (100 for most tools, 20 for find-person)
- Rate limiting is already in place via Bottleneck

## Migration Guide

If you were using the old search tools:

**Old Way:**
```javascript
// This often returned empty arrays
search-persons({ term: "Piotr" })
```

**New Way:**
```javascript
// This works reliably with fuzzy matching
find-person({ name: "Piotr" })

// Or with more specificity
find-person({ name: "Piotr", company: "Haleon" })

// Or with filters on get-persons
get-persons({ filterName: "Piotr", organizationName: "Haleon" })
```

## Examples

### Example 1: Find Piotr at Haleon
```javascript
// Using find-person (recommended)
find-person({ name: "Piotr", company: "Haleon" })

// Response:
{
  "summary": "Found 1 persons matching search criteria",
  "search_criteria": ["name: \"Piotr\"", "company: \"Haleon\""],
  "total_found": 1,
  "results": [
    {
      "id": 123,
      "name": "Piotr Kowalski",
      "email": [{"value": "piotr@haleon.com", "primary": true}],
      "org_name": "Haleon",
      "match_score": 18,
      "match_reasons": ["name matches \"Piotr\"", "company matches \"Haleon\""]
    }
  ]
}
```

### Example 2: Get All Persons at Haleon
```javascript
// First, find the organization
get-organizations({ filterName: "Haleon" })
// Get org_id from response (e.g., 96)

// Then get all persons
get-persons-by-organization({ organizationId: 96 })
```

### Example 3: Find Anyone with haleon.com Email
```javascript
get-persons({ filterEmail: "haleon.com" })
```

## Testing the Changes

To test the improvements:

1. Build the project:
   ```bash
   npm run build
   ```

2. Start the server:
   ```bash
   npm start
   ```

3. Test the new tools via your MCP client

## Backward Compatibility

All existing tools remain functional. The changes are:
- **Non-breaking additions**: New parameters are optional
- **Enhanced responses**: More information but same structure
- **Preserved behavior**: Original search tools still work (with better errors)

## Next Steps

Consider these future improvements:
1. Add pagination support for large datasets (>500 items)
2. Implement caching to improve performance for repeated queries
3. Add support for custom fields in filtering
4. Add support for date-based filtering on persons/organizations
5. Add a `find-organization` tool with fuzzy matching similar to `find-person`
