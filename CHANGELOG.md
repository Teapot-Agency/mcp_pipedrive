# Changelog

All notable changes to the Pipedrive MCP Server will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2024-12-04

### Added
- **20 Write Operation Tools** - Full CRUD support for Pipedrive entities:

  **Deal Operations:**
  - `create-deal` - Create new deals with full field support
  - `update-deal` - Update existing deals
  - `delete-deal` - Soft delete deals (30-day recovery period)

  **Person Operations:**
  - `create-person` - Create new contacts with email and phone support
  - `update-person` - Update existing contacts
  - `delete-person` - Soft delete persons (30-day recovery)

  **Organization Operations:**
  - `create-organization` - Create new organizations with address support
  - `update-organization` - Update existing organizations
  - `delete-organization` - Soft delete organizations (30-day recovery)

  **Activity Operations:**
  - `create-activity` - Create tasks, calls, meetings, etc.
  - `update-activity` - Update existing activities
  - `delete-activity` - Soft delete activities (30-day recovery)

  **Note Operations:**
  - `create-note` - Create notes attached to deals, persons, orgs, or leads
  - `update-note` - Update note content
  - `delete-note` - Delete notes

  **Lead Operations:**
  - `create-lead` - Create new leads
  - `update-lead` - Update existing leads
  - `delete-lead` - Delete leads
  - `convert-lead-to-deal` - Convert leads to deals with conversion tracking

### Changed
- Version bumped from 1.0.4 to 2.0.0 (major version for write capability addition)
- Server version identifier updated to 2.0.0

### Security
- **Mandatory Confirmation for Deletes** - All delete operations require `confirm: true` parameter to prevent accidental deletions
- Input validation on all write operations using Zod schemas
- Pre-operation existence checks for update and delete operations
- Soft delete with 30-day recovery period for most entities
- Recovery instructions included in all delete operation responses

## [1.0.4] - Previous

### Features
- 16 read-only tools for querying Pipedrive data
- 8 analytical prompts for common workflows
- Rate limiting support
- JWT authentication support
- Both stdio and SSE transport modes
- Custom field support

[2.0.0]: https://github.com/WillDent/pipedrive-mcp-server/compare/v1.0.4...v2.0.0
