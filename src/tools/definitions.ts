/**
 * MCP Tool definitions for Hoppscotch
 * This file defines all available tools in minimal mode
 */

const USER_COLLECTION_TOOLS = {
  list_user_collections: {
    name: 'list_user_collections',
    description: 'List all user collections (personal collections). Returns root-level collections of the specified type (REST or GraphQL). Self-hosted only — Cloud does not expose user-collection reads.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['REST', 'GQL'],
          description: 'Type of collections to list (REST or GQL for GraphQL). Optional — defaults to REST when omitted.',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor for loading more results',
        },
        limit: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100,
        },
      },
      required: [],
    },
  },

  get_user_collection: {
    name: 'get_user_collection',
    description: 'Get the envelope of a specific user collection — id, title, parent id, and the opaque data JSON string. Does NOT include nested requests or child collections in the response; use list_user_requests or list_user_collections (with a cursor) to read those explicitly. Self-hosted only — Cloud does not expose user-collection reads.',
    inputSchema: {
      type: 'object',
      properties: {
        collectionId: {
          type: 'string',
          description: 'ID of the collection to retrieve',
        },
      },
      required: ['collectionId'],
    },
  },

  create_user_collection: {
    name: 'create_user_collection',
    description: 'Create a new user collection (folder or request). Can be created at root level or as a child of another collection.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Name of the collection',
        },
        type: {
          type: 'string',
          enum: ['REST', 'GQL'],
          description: 'Type of collection (REST, or GQL for GraphQL). Optional — defaults to REST when omitted.',
        },
        parentCollectionId: {
          type: 'string',
          description: 'ID of parent collection (omit for root-level collection)',
        },
        data: {
          type: 'string',
          description: 'JSON string of request data (for request collections, not folders)',
        },
      },
      required: ['title'],
    },
  },

  update_user_collection: {
    name: 'update_user_collection',
    description: 'Update a user collection (rename, modify request data, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        collectionId: {
          type: 'string',
          description: 'ID of the collection to update',
        },
        title: {
          type: 'string',
          description: 'New title for the collection',
        },
        data: {
          type: 'string',
          description: 'Updated JSON request data',
        },
      },
      required: ['collectionId'],
    },
  },

  delete_user_collection: {
    name: 'delete_user_collection',
    description: 'Delete a user collection and all its children. This action cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        collectionId: {
          type: 'string',
          description: 'ID of the collection to delete',
        },
      },
      required: ['collectionId'],
    },
  },

  export_user_collection: {
    name: 'export_user_collection',
    description: 'Export user collection(s) as JSON. Can export a specific collection or all collections of a type. Self-hosted only — Cloud does not expose user-collection reads.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['REST', 'GQL'],
          description: 'Type of collections to export. Optional — defaults to REST when omitted.',
        },
        collectionId: {
          type: 'string',
          description: 'ID of specific collection to export (omit to export all collections)',
        },
      },
      required: [],
    },
  },

  import_user_collection: {
    name: 'import_user_collection',
    description: 'Import collection(s) from JSON string. The JSON should be in Hoppscotch export format.',
    inputSchema: {
      type: 'object',
      properties: {
        jsonString: {
          type: 'string',
          description: 'JSON string of the collection to import (Hoppscotch format)',
        },
        type: {
          type: 'string',
          enum: ['REST', 'GQL'],
          description: 'Type of collection being imported. Optional — defaults to REST when omitted.',
        },
        parentCollectionId: {
          type: 'string',
          description: 'ID of parent collection (omit to import at root level)',
        },
      },
      required: ['jsonString'],
    },
  },
} as const;

const USER_ENVIRONMENT_TOOLS = {
  list_user_environments: {
    name: 'list_user_environments',
    description: 'List all user environments with their variables. Self-hosted only — on Cloud this returns an empty list (Cloud has no user-environment reads).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  create_user_environment: {
    name: 'create_user_environment',
    description: 'Create a new user environment with variables.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the environment (e.g., "Development", "Staging", "Production")',
        },
        variables: {
          type: 'array',
          description: 'Array of environment variables',
          items: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description: 'Variable name',
              },
              value: {
                type: 'string',
                description: 'Variable value',
              },
              secret: {
                type: 'boolean',
                description: 'Whether this is a secret variable (will be masked)',
              },
            },
            required: ['key', 'value'],
          },
        },
      },
      required: ['name', 'variables'],
    },
  },

  update_user_environment: {
    name: 'update_user_environment',
    description: 'Update an existing user environment (rename or modify variables). Providing variables REPLACES the entire list (not a per-variable merge) — include every variable you want to keep; an omitted field is left unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        environmentId: {
          type: 'string',
          description: 'ID of the environment to update',
        },
        name: {
          type: 'string',
          description: 'New name for the environment',
        },
        variables: {
          type: 'array',
          description: 'Updated array of environment variables',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
              secret: { type: 'boolean' },
            },
            required: ['key', 'value'],
          },
        },
      },
      required: ['environmentId'],
    },
  },

  delete_user_environment: {
    name: 'delete_user_environment',
    description: 'Delete a user environment. This action cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        environmentId: {
          type: 'string',
          description: 'ID of the environment to delete',
        },
      },
      required: ['environmentId'],
    },
  },
} as const;

const TEAM_COLLECTION_TOOLS = {
  list_team_collections: {
    name: 'list_team_collections',
    description: 'List root-level collections in a team workspace. Returns only top-level collections; use get_team_collection to browse into sub-collections. The backend GQL field accepts cursor-only pagination — there is no per-call limit knob.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: {
          type: 'string',
          description: 'ID of the team (optional if default team is configured)',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor',
        },
      },
      required: [],
    },
  },

  get_team_collection: {
    name: 'get_team_collection',
    description: 'Get a team collection by ID, including its direct children (sub-collections). Works at any nesting depth. Use to browse the collection hierarchy one level at a time, or jump directly to any collection by ID. Note: the backend caps direct children at about 10 per response, so a collection with more sub-collections is truncated here.',
    inputSchema: {
      type: 'object',
      properties: {
        collectionId: {
          type: 'string',
          description: 'ID of the team collection',
        },
      },
      required: ['collectionId'],
    },
  },

  create_team_collection: {
    name: 'create_team_collection',
    description: 'Create a new team collection.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: {
          type: 'string',
          description: 'ID of the team (optional if default team is configured)',
        },
        title: {
          type: 'string',
          description: 'Name of the collection',
        },
        parentCollectionId: {
          type: 'string',
          description: 'ID of parent collection (omit for root)',
        },
        data: {
          type: 'string',
          description: 'JSON request data',
        },
      },
      required: ['title'],
    },
  },

  update_team_collection: {
    name: 'update_team_collection',
    description: 'Update a team collection (rename or modify data).',
    inputSchema: {
      type: 'object',
      properties: {
        collectionId: {
          type: 'string',
          description: 'ID of the team collection to update',
        },
        title: {
          type: 'string',
          description: 'New title for the collection',
        },
        data: {
          type: 'string',
          description: 'Updated JSON request data',
        },
      },
      required: ['collectionId'],
    },
  },

  export_team_collection: {
    name: 'export_team_collection',
    description: 'Export a team collection as a complete JSON tree with all nested sub-collections and requests. Use for full data export; prefer get_team_collection for browsing. Omit collectionId to export the entire team workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: {
          type: 'string',
          description: 'ID of the team (optional if default team is configured)',
        },
        collectionId: {
          type: 'string',
          description: 'ID of specific collection (omit to export all)',
        },
      },
      required: [],
    },
  },

  delete_team_collection: {
    name: 'delete_team_collection',
    description: 'Delete a team collection and all its children. This action cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        collectionId: {
          type: 'string',
          description: 'ID of the collection to delete',
        },
      },
      required: ['collectionId'],
    },
  },
} as const;

const TEAM_ENVIRONMENT_TOOLS = {
  list_team_environments: {
    name: 'list_team_environments',
    description: 'List all environments in a team workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: {
          type: 'string',
          description: 'ID of the team (optional if default team is configured)',
        },
      },
      required: [],
    },
  },

  create_team_environment: {
    name: 'create_team_environment',
    description: 'Create a new team environment.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: {
          type: 'string',
          description: 'ID of the team (optional if default team is configured)',
        },
        name: {
          type: 'string',
          description: 'Name of the environment',
        },
        variables: {
          type: 'array',
          description: 'Array of environment variables',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
              secret: { type: 'boolean' },
            },
            required: ['key', 'value'],
          },
        },
      },
      required: ['name', 'variables'],
    },
  },

  update_team_environment: {
    name: 'update_team_environment',
    description: 'Update an existing team environment (rename or modify variables). Providing variables REPLACES the entire list (not a per-variable merge) — include every variable you want to keep; an omitted field is left unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        environmentId: {
          type: 'string',
          description: 'ID of the environment to update',
        },
        name: {
          type: 'string',
          description: 'New name for the environment',
        },
        variables: {
          type: 'array',
          description: 'Updated array of environment variables',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
              secret: { type: 'boolean' },
            },
            required: ['key', 'value'],
          },
        },
      },
      required: ['environmentId'],
    },
  },

  delete_team_environment: {
    name: 'delete_team_environment',
    description: 'Delete a team environment. This action cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        environmentId: {
          type: 'string',
          description: 'ID of the environment to delete',
        },
      },
      required: ['environmentId'],
    },
  },
} as const;

// Additional Advanced Tools (Standard Mode)
const ADVANCED_COLLECTION_TOOLS = {
  duplicate_user_collection: {
    name: 'duplicate_user_collection',
    description: 'Duplicate a user collection with all its contents.',
    inputSchema: {
      type: 'object',
      properties: {
        collectionId: {
          type: 'string',
          description: 'ID of the collection to duplicate',
        },
      },
      required: ['collectionId'],
    },
  },

  duplicate_team_collection: {
    name: 'duplicate_team_collection',
    description: 'Duplicate a team collection with all its contents.',
    inputSchema: {
      type: 'object',
      properties: {
        collectionId: {
          type: 'string',
          description: 'ID of the team collection to duplicate',
        },
      },
      required: ['collectionId'],
    },
  },

  move_user_collection: {
    name: 'move_user_collection',
    description: 'Move a user collection to a different parent collection, or to root (omit parentCollectionId).',
    inputSchema: {
      type: 'object',
      properties: {
        collectionId: {
          type: 'string',
          description: 'ID of the collection to move',
        },
        parentCollectionId: {
          type: 'string',
          description: 'ID of the new parent collection. Omit to move the collection to the root.',
        },
        newParentId: {
          type: 'string',
          description: 'Deprecated alias of parentCollectionId — prefer parentCollectionId. Accepted for backward compatibility; must not differ from parentCollectionId if both are given.',
        },
      },
      required: ['collectionId'],
    },
  },

  move_team_collection: {
    name: 'move_team_collection',
    description: 'Move a team collection to a different parent collection or to root.',
    inputSchema: {
      type: 'object',
      properties: {
        collectionId: {
          type: 'string',
          description: 'ID of the team collection to move',
        },
        parentCollectionId: {
          type: 'string',
          description: 'ID of the new parent collection (omit to move to root)',
        },
      },
      required: ['collectionId'],
    },
  },

  search_team_requests: {
    name: 'search_team_requests',
    description: 'Search team requests by title. Self-hosted only — on Hoppscotch Cloud the backend rejects this query (bug/team/no_require_team_role), which surfaces as an error from upstream rather than a client-side check. Returns matching requests with their parent collection id and title. Backed by the searchForRequest GQL field — searches requests, not collections. Returns only the first page (~10 matches) and exposes no cursor, so narrow the query if you expect more.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (matched against request titles)',
        },
        teamId: {
          type: 'string',
          description: 'Optional team ID (defaults to HOPPSCOTCH_DEFAULT_TEAM_ID if configured)',
        },
      },
      required: ['query'],
    },
  },

  import_team_collection: {
    name: 'import_team_collection',
    description: 'Import collection(s) from JSON into team workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: {
          type: 'string',
          description: 'ID of the team (optional if default team configured)',
        },
        jsonString: {
          type: 'string',
          description: 'JSON string of the collection to import',
        },
        parentCollectionId: {
          type: 'string',
          description: 'ID of parent collection (omit for root)',
        },
      },
      required: ['jsonString'],
    },
  },
} as const;

const TEAM_MANAGEMENT_TOOLS = {
  list_teams: {
    name: 'list_teams',
    description: 'List all teams the user has access to. Each team includes its members with their email address and role.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  get_team_info: {
    name: 'get_team_info',
    description: 'Get detailed information about a specific team, including its members with their email address and role.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: {
          type: 'string',
          description: 'ID of the team',
        },
      },
      required: ['teamId'],
    },
  },

  create_team: {
    name: 'create_team',
    description: 'Create a new team.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name for the new team',
        },
      },
      required: ['name'],
    },
  },

  rename_team: {
    name: 'rename_team',
    description: 'Rename an existing team.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: {
          type: 'string',
          description: 'ID of the team to rename',
        },
        newName: {
          type: 'string',
          description: 'New name for the team',
        },
      },
      required: ['teamId', 'newName'],
    },
  },

  delete_team: {
    name: 'delete_team',
    description: 'Delete a team permanently. This action is irreversible.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: {
          type: 'string',
          description: 'ID of the team to delete',
        },
      },
      required: ['teamId'],
    },
  },

  leave_team: {
    name: 'leave_team',
    description: 'Leave a team (remove the current user from the team).',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: {
          type: 'string',
          description: 'ID of the team to leave',
        },
      },
      required: ['teamId'],
    },
  },

  invite_team_member: {
    name: 'invite_team_member',
    description: 'Invite a user to join a team by email.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: {
          type: 'string',
          description: 'ID of the team',
        },
        email: {
          type: 'string',
          description: 'Email address of the user to invite',
        },
        role: {
          type: 'string',
          enum: ['OWNER', 'EDITOR', 'VIEWER'],
          description: 'Role to assign to the invited user',
        },
      },
      required: ['teamId', 'email', 'role'],
    },
  },

  revoke_team_invitation: {
    name: 'revoke_team_invitation',
    description: 'Revoke a pending team invitation.',
    inputSchema: {
      type: 'object',
      properties: {
        inviteId: {
          type: 'string',
          description: 'ID of the invitation to revoke',
        },
      },
      required: ['inviteId'],
    },
  },

  remove_team_member: {
    name: 'remove_team_member',
    description: 'Remove a member from a team.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: {
          type: 'string',
          description: 'ID of the team',
        },
        userUid: {
          type: 'string',
          description: 'UID of the user to remove',
        },
      },
      required: ['teamId', 'userUid'],
    },
  },

  update_team_member_role: {
    name: 'update_team_member_role',
    description: 'Update a team member\'s role.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: {
          type: 'string',
          description: 'ID of the team',
        },
        userUid: {
          type: 'string',
          description: 'UID of the user whose role to update',
        },
        newRole: {
          type: 'string',
          enum: ['OWNER', 'EDITOR', 'VIEWER'],
          description: 'New role for the team member',
        },
      },
      required: ['teamId', 'userUid', 'newRole'],
    },
  },
} as const;

// Request Execution Tools
const REQUEST_EXECUTION_TOOLS = {
  execute_request: {
    name: 'execute_request',
    description: 'Execute an HTTP request with the specified method, URL, headers, and body. Supports authentication and environment variable substitution. Built-in auth types are bearer, basic, and api-key — for OAuth2 / AWS-Signature / Digest / HAWK, set the Authorization header directly.',
    inputSchema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
          description: 'HTTP method',
        },
        url: {
          type: 'string',
          description: 'Target URL for the request',
        },
        headers: {
          type: 'object',
          description: 'Request headers (key-value pairs)',
          additionalProperties: { type: 'string' },
        },
        body: {
          type: 'string',
          description: 'Request body (for POST, PUT, PATCH)',
        },
        auth: {
          type: 'object',
          description: 'Authentication configuration',
          properties: {
            type: {
              type: 'string',
              enum: ['bearer', 'basic', 'api-key'],
              description: 'Authentication type',
            },
            token: {
              type: 'string',
              description: 'Bearer token (for bearer auth)',
            },
            username: {
              type: 'string',
              description: 'Username (for basic auth)',
            },
            password: {
              type: 'string',
              description: 'Password (for basic auth)',
            },
            key: {
              type: 'string',
              description: 'API key name (for api-key auth)',
            },
            value: {
              type: 'string',
              description: 'API key value (for api-key auth)',
            },
            addTo: {
              type: 'string',
              enum: ['header', 'query'],
              description: 'Where to add API key (header or query param)',
            },
          },
        },
        environmentId: {
          type: 'string',
          description: 'Environment ID for variable substitution',
        },
        timeout: {
          type: 'number',
          description: 'Request timeout in milliseconds (1000-120000)',
        },
      },
      required: ['method', 'url'],
    },
  },
  validate_response: {
    name: 'validate_response',
    description: 'Execute an HTTP request and validate the response against expected criteria (status code, headers, body content, response time, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
          description: 'HTTP method',
        },
        url: {
          type: 'string',
          description: 'Target URL for the request',
        },
        headers: {
          type: 'object',
          description: 'Request headers',
          additionalProperties: { type: 'string' },
        },
        body: {
          type: 'string',
          description: 'Request body',
        },
        auth: {
          type: 'object',
          description: 'Authentication configuration',
        },
        criteria: {
          type: 'object',
          description: 'Validation criteria',
          properties: {
            expectedStatus: {
              type: 'number',
              description: 'Expected HTTP status code',
            },
            expectedStatusRange: {
              type: 'object',
              properties: {
                min: { type: 'number' },
                max: { type: 'number' },
              },
              description: 'Expected status code range',
            },
            expectedHeaders: {
              type: 'object',
              description: 'Expected response headers. Header NAMES are matched case-insensitively; VALUES are compared exactly.',
              additionalProperties: { type: 'string' },
            },
            expectedBodyContains: {
              type: 'array',
              items: { type: 'string' },
              description: 'Strings that must be present in response body',
            },
            jsonObject: {
              type: 'boolean',
              description: 'If true, assert the response body parses as a JSON object/array. This is NOT full JSON Schema validation.',
            },
            jsonSchema: {
              type: 'object',
              description: 'Deprecated alias of jsonObject: any value here triggers the same is-a-JSON-object check — it does NOT validate the body against the schema. Prefer jsonObject: true.',
            },
            maxResponseTime: {
              type: 'number',
              description: 'Maximum acceptable response time in milliseconds',
            },
          },
        },
        timeout: {
          type: 'number',
          description: 'Per-request network timeout in milliseconds (1000–120000). Falls back to the server default when omitted.',
        },
        environmentId: {
          type: 'string',
          description: 'Environment ID for variable substitution',
        },
      },
      required: ['method', 'url', 'criteria'],
    },
  },
} as const;

// Code Generation Tools
const CODE_GENERATION_TOOLS = {
  generate_code: {
    name: 'generate_code',
    description: 'Generate a code snippet for an HTTP request in various programming languages (curl, JavaScript, Python, Go, Rust). Returns a runnable snippet with live credentials by default; set redactCredentials=true to mask them when sharing the snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
          description: 'HTTP method',
        },
        url: {
          type: 'string',
          description: 'Target URL',
        },
        headers: {
          type: 'object',
          description: 'Request headers',
          additionalProperties: { type: 'string' },
        },
        body: {
          type: 'string',
          description: 'Request body',
        },
        auth: {
          type: 'object',
          description: 'Authentication configuration',
        },
        language: {
          type: 'string',
          enum: ['curl', 'javascript', 'python', 'go', 'rust'],
          description: 'Target programming language',
        },
        redactCredentials: {
          type: 'boolean',
          description: 'Mask bearer/basic/api-key values, sensitive headers, and secret URL query/body fields in the generated snippet (default false). Set true to produce a shareable snippet with credentials masked.',
        },
      },
      required: ['method', 'url', 'language'],
    },
  },
  generate_documentation: {
    name: 'generate_documentation',
    description: 'Generate markdown documentation for an HTTP request, including examples in multiple languages. Credential values in the examples are masked by default (set redactCredentials=false for runnable snippets with live secrets).',
    inputSchema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
          description: 'HTTP method',
        },
        url: {
          type: 'string',
          description: 'Target URL',
        },
        headers: {
          type: 'object',
          description: 'Request headers',
          additionalProperties: { type: 'string' },
        },
        body: {
          type: 'string',
          description: 'Request body',
        },
        auth: {
          type: 'object',
          description: 'Authentication configuration',
        },
        title: {
          type: 'string',
          description: 'Documentation title',
        },
        description: {
          type: 'string',
          description: 'Request description',
        },
        includeExamples: {
          type: 'boolean',
          description: 'Include code examples in multiple languages',
        },
        redactCredentials: {
          type: 'boolean',
          description: 'Mask bearer/basic/api-key credential values in the generated examples (default true). Docs are share-oriented; set false only when you want copy-paste-runnable snippets with live credentials.',
        },
      },
      required: ['method', 'url'],
    },
  },
} as const;

// ─── Request CRUD Tools ───────────────────────────────────────────────────────
// Team request reads/writes work on both Cloud and SH.
// User request reads (list_user_requests) are SH only.
// User request writes (create/update/delete/move) work on both.
const REQUEST_CRUD_TOOLS = {
  list_team_requests: {
    name: 'list_team_requests',
    description: 'List requests in a team collection (id, title, full request JSON). Paginated — returns up to ~10 per call; pass the cursor to page through the rest.',
    inputSchema: {
      type: 'object',
      properties: {
        collectionId: {
          type: 'string',
          description: 'ID of the team collection',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor for loading more results',
        },
      },
      required: ['collectionId'],
    },
  },

  get_team_request: {
    name: 'get_team_request',
    description: 'Get a specific team request by ID, including its full request JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          description: 'ID of the request to retrieve',
        },
      },
      required: ['requestId'],
    },
  },

  create_team_request: {
    name: 'create_team_request',
    description: 'Create a new request in a team collection. The request field is a JSON string following the Hoppscotch request schema.',
    inputSchema: {
      type: 'object',
      properties: {
        collectionId: {
          type: 'string',
          description: 'ID of the team collection to add the request to',
        },
        teamId: {
          type: 'string',
          description: 'ID of the team (uses default team if omitted)',
        },
        title: {
          type: 'string',
          description: 'Name of the request',
        },
        request: {
          type: 'string',
          description: 'JSON string of the Hoppscotch request object. Use the Hoppscotch request schema: "endpoint" (the URL — NOT "url"), "method", "headers" (array of {key,value,active}), "body" ({contentType, body}), "auth", "params". Example: {"v":"11","endpoint":"https://api.example.com/orders","method":"POST","headers":[{"key":"Content-Type","value":"application/json","active":true}],"body":{"contentType":"application/json","body":"{}"}}',
        },
      },
      required: ['collectionId', 'title', 'request'],
    },
  },

  update_team_request: {
    name: 'update_team_request',
    description: 'Update a team request\'s title and/or request data.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          description: 'ID of the request to update',
        },
        title: {
          type: 'string',
          description: 'New title for the request',
        },
        request: {
          type: 'string',
          description: 'Updated JSON string of the Hoppscotch request object (use "endpoint" for the URL, not "url").',
        },
      },
      required: ['requestId'],
    },
  },

  delete_team_request: {
    name: 'delete_team_request',
    description: 'Delete a team request. This action cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          description: 'ID of the request to delete',
        },
      },
      required: ['requestId'],
    },
  },

  move_team_request: {
    name: 'move_team_request',
    description: 'Move a team request to a different collection.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          description: 'ID of the request to move',
        },
        destCollectionId: {
          type: 'string',
          description: 'ID of the destination collection',
        },
      },
      required: ['requestId', 'destCollectionId'],
    },
  },

  list_user_requests: {
    name: 'list_user_requests',
    description: 'List all requests in a personal (user) collection. Self-hosted only — not available on Hoppscotch Cloud.',
    inputSchema: {
      type: 'object',
      properties: {
        collectionId: {
          type: 'string',
          description: 'ID of the user collection',
        },
      },
      required: ['collectionId'],
    },
  },

  create_user_request: {
    name: 'create_user_request',
    description: 'Create a new request in a personal (user) collection.',
    inputSchema: {
      type: 'object',
      properties: {
        collectionId: {
          type: 'string',
          description: 'ID of the user collection',
        },
        type: {
          type: 'string',
          enum: ['REST', 'GQL'],
          description: 'Request type (REST or GQL)',
        },
        title: {
          type: 'string',
          description: 'Name of the request',
        },
        request: {
          type: 'string',
          description: 'JSON string of the Hoppscotch request object (use "endpoint" for the URL, not "url").',
        },
      },
      required: ['collectionId', 'title', 'request'],
    },
  },

  update_user_request: {
    name: 'update_user_request',
    description: 'Update a personal (user) request\'s title and/or request data.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          description: 'ID of the request to update',
        },
        type: {
          type: 'string',
          enum: ['REST', 'GQL'],
          description: 'Request type (REST or GQL)',
        },
        title: {
          type: 'string',
          description: 'New title for the request',
        },
        request: {
          type: 'string',
          description: 'Updated JSON string of the Hoppscotch request object (use "endpoint" for the URL, not "url").',
        },
      },
      required: ['requestId'],
    },
  },

  delete_user_request: {
    name: 'delete_user_request',
    description: 'Delete a personal (user) request. This action cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          description: 'ID of the request to delete',
        },
      },
      required: ['requestId'],
    },
  },

  move_user_request: {
    name: 'move_user_request',
    description: 'Move a personal (user) request to a different collection.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          description: 'ID of the request to move',
        },
        sourceCollectionId: {
          type: 'string',
          description: 'ID of the source collection',
        },
        destCollectionId: {
          type: 'string',
          description: 'ID of the destination collection',
        },
      },
      required: ['requestId', 'sourceCollectionId', 'destCollectionId'],
    },
  },
} as const;

// Combine all tools
// Auth utility — available in EVERY profile (folded into minimal), since
// re-authenticating is fundamental regardless of which tool surface is exposed.
const AUTH_TOOLS = {
  reauth: {
    name: 'reauth',
    description:
      'Force a fresh Hoppscotch sign-in: clears the cached token and starts a new browser device-login flow, ' +
      'instead of waiting for the current token to expire. Use when the session is wrong/expired or to switch accounts. ' +
      'Returns the new session on success, or — if the browser login is still pending — the URL to open plus instructions to retry. ' +
      'No effect when HOPPSCOTCH_ACCESS_TOKEN is set (that token is used as-is).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
} as const;

const ALL_MINIMAL_TOOLS = {
  ...AUTH_TOOLS,
  ...USER_COLLECTION_TOOLS,
  ...USER_ENVIRONMENT_TOOLS,
  ...TEAM_COLLECTION_TOOLS,
  ...TEAM_ENVIRONMENT_TOOLS,
} as const;

const ALL_STANDARD_TOOLS = {
  ...ALL_MINIMAL_TOOLS,
  ...ADVANCED_COLLECTION_TOOLS,
  ...TEAM_MANAGEMENT_TOOLS,
} as const;

const RAW_ALL_FULL_TOOLS = {
  ...ALL_STANDARD_TOOLS,
  ...REQUEST_EXECUTION_TOOLS,
  ...CODE_GENERATION_TOOLS,
  ...REQUEST_CRUD_TOOLS,
} as const;

// MCP tool annotations (spec 2025-11-25). Hints for hosts when deciding whether
// to surface confirmation UI before invoking a tool. Derived from tool-name
// prefix — every tool here falls cleanly into one of six operation classes.
type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

function annotationsFor(name: string): ToolAnnotations {
  // execute_request and validate_response both invoke the request executor
  // against an arbitrary user-supplied URL, so they share an annotation
  // profile: open-world (target host unknown), potentially destructive (the
  // target server may perform any write the bearer token permits), and
  // non-idempotent (the target chooses the semantics).
  if (name === 'execute_request' || name === 'validate_response') {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  }
  // Reads that DON'T hit arbitrary URLs: list/get/search/export (our GQL
  // schema) + generate (pure code-gen, no network).
  if (/^(list|get|search|export|generate)_/.test(name)) {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  }
  // Destructive: remove entities or irreversible membership changes.
  if (/^(delete|remove|revoke|leave)_/.test(name)) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  }
  // Creation / addition: not destructive (creates a new entity), not idempotent
  // (second call yields a second entity or a duplicate error).
  if (/^(create|import|invite|duplicate)_/.test(name)) {
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  }
  // In-place updates: not destructive (same entity kept), not idempotent
  // (repeat writes may still change timestamps / revisions).
  if (/^(update|rename)_/.test(name)) {
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  }
  // Structural moves within our hierarchy: not destructive, idempotent
  // (second call with same source+dest is a no-op).
  if (/^move_/.test(name)) {
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  }
  // reauth: triggers an external browser sign-in (open-world), not destructive
  // to user data, not idempotent (each call restarts the flow).
  if (name === 'reauth') {
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  }
  // Fallback: treat as non-idempotent write. Unreachable for the current tool set.
  return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
}

export const ALL_FULL_TOOLS = Object.fromEntries(
  Object.entries(RAW_ALL_FULL_TOOLS).map(([key, tool]) => [
    key,
    { ...tool, annotations: annotationsFor(tool.name) },
  ])
) as { [K in keyof typeof RAW_ALL_FULL_TOOLS]: (typeof RAW_ALL_FULL_TOOLS)[K] & { annotations: ToolAnnotations } };

type AnnotatedTool = (typeof ALL_FULL_TOOLS)[keyof typeof ALL_FULL_TOOLS];

const ALL_MINIMAL_TOOL_NAMES = new Set(
  Object.values(ALL_MINIMAL_TOOLS).map((t) => t.name)
);
const ALL_STANDARD_TOOL_NAMES = new Set(
  Object.values(ALL_STANDARD_TOOLS).map((t) => t.name)
);

// `core` (the DEFAULT surface): the API-testing essentials — collection + env
// CRUD, request CRUD, request execution, and code generation, plus read-only
// team discovery (list_teams / get_team_info). Deliberately EXCLUDES the
// destructive team-admin writes (create/rename/delete/leave/invite/revoke/
// remove/role) and the advanced collection ops (duplicate/move/search/import),
// keeping the default lean and free of footguns. NOTE: `core` is NOT a superset
// of `standard` — it trades team-admin for execute/codegen. Both are subsets of
// `full`. Opt to `standard`/`full` via HOPPSCOTCH_TOOL_PROFILE.
const ALL_CORE_TOOL_NAMES = new Set<string>([
  ...Object.values(ALL_MINIMAL_TOOLS).map((t) => t.name),
  ...Object.values(REQUEST_CRUD_TOOLS).map((t) => t.name),
  ...Object.values(REQUEST_EXECUTION_TOOLS).map((t) => t.name),
  ...Object.values(CODE_GENERATION_TOOLS).map((t) => t.name),
  'list_teams',
  'get_team_info',
]);

const PROFILE_NAMES = ['minimal', 'core', 'standard', 'full'] as const;
export type ToolProfile = (typeof PROFILE_NAMES)[number];

function pickByNames(names: Set<string>): Record<string, AnnotatedTool> {
  return Object.fromEntries(
    Object.entries(ALL_FULL_TOOLS).filter(([, tool]) => names.has(tool.name))
  );
}

/**
 * Select the annotated tool map for a given profile.
 *
 * Profile gates BOTH `tools/list` and `tools/call` — a tool absent from the
 * selected profile is invisible to discovery AND rejected at call-time. This
 * matters because a model that has seen tool names from prior sessions (or a
 * prompt that names them directly) must not be able to invoke "hidden" tools.
 *
 * Unknown profile values fall back to the DEFAULT (`core`) with a stderr
 * warning — a typo then yields the same surface as not setting the var at all,
 * rather than silently EXPANDING to `full` (which would hand a one-character
 * typo the entire destructive team-admin surface).
 */
export function selectProfileTools(
  profile: string | undefined
): Record<string, AnnotatedTool> {
  if (profile === undefined || profile === '') {
    // Default surface is `core`: lean but functional for API work. Opt up to
    // `standard` (adds team admin + advanced collection) or `full` (everything)
    // via HOPPSCOTCH_TOOL_PROFILE.
    return pickByNames(ALL_CORE_TOOL_NAMES);
  }
  const normalized = profile.toLowerCase() as ToolProfile;
  if (!(PROFILE_NAMES as readonly string[]).includes(normalized)) {
    process.stderr.write(
      `[hoppscotch-mcp] Unknown HOPPSCOTCH_TOOL_PROFILE "${profile}" — falling back to the default (core). ` +
        `Valid values: ${PROFILE_NAMES.join(', ')}\n`
    );
    return pickByNames(ALL_CORE_TOOL_NAMES);
  }
  switch (normalized) {
    case 'minimal':
      return pickByNames(ALL_MINIMAL_TOOL_NAMES);
    case 'core':
      return pickByNames(ALL_CORE_TOOL_NAMES);
    case 'standard':
      return pickByNames(ALL_STANDARD_TOOL_NAMES);
    case 'full':
      return ALL_FULL_TOOLS;
  }
}
