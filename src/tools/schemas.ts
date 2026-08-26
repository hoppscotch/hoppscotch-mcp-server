import { z } from 'zod';

/**
 * Tool input schemas for validation
 */

// Collection Type
// Blank input defaults to REST so MCP Inspector, which sends "" for an untouched
// field, does not fail validation. Only blank: `!v` would also swallow false and
// 0 into REST instead of rejecting them.
export const CollectionTypeSchema = z.preprocess(
  (v) => (v === '' || v == null ? 'REST' : v),
  z.enum(['REST', 'GQL'])
);

// User Collection Tools
export const ListUserCollectionsSchema = z.object({
  type: CollectionTypeSchema,
  cursor: z.string().optional(),
  limit: z.number().min(1).max(100).optional(),
});

export const GetUserCollectionSchema = z.object({
  collectionId: z.string(),
});

export const CreateUserCollectionSchema = z.object({
  title: z.string().min(1),
  type: CollectionTypeSchema,
  parentCollectionId: z.string().min(1).optional(),
  data: z.string().optional(),
});

export const UpdateUserCollectionSchema = z.object({
  collectionId: z.string(),
  type: CollectionTypeSchema.default('REST'),
  title: z.string().min(1).optional(),
  data: z.string().optional(),
});

export const DeleteUserCollectionSchema = z.object({
  collectionId: z.string(),
  type: CollectionTypeSchema.default('REST'),
});

// collectionId omitted = export everything; "" must not silently mean the same.
export const ExportUserCollectionSchema = z.object({
  type: CollectionTypeSchema,
  collectionId: z.string().min(1).optional(),
});

export const ImportUserCollectionSchema = z.object({
  jsonString: z.string().min(1),
  type: CollectionTypeSchema,
  parentCollectionId: z.string().min(1).optional(),
});

// Team Collection Tools
export const ListTeamCollectionsSchema = z.object({
  teamId: z.string().optional(),
  cursor: z.string().optional(),
});

export const GetTeamCollectionSchema = z.object({
  collectionId: z.string(),
});

export const CreateTeamCollectionSchema = z.object({
  teamId: z.string().optional(),
  title: z.string().min(1),
  parentCollectionId: z.string().min(1).optional(),
  data: z.string().optional(),
});

export const UpdateTeamCollectionSchema = z.object({
  collectionId: z.string(),
  title: z.string().min(1).optional(),
  data: z.string().optional(),
});

export const DeleteTeamCollectionSchema = z.object({
  collectionId: z.string(),
});

export const MoveTeamCollectionSchema = z.object({
  collectionId: z.string(),
  parentCollectionId: z.string().min(1).optional(),
});

// collectionId omitted = export the whole team; "" must not silently mean the same.
export const ExportTeamCollectionSchema = z.object({
  teamId: z.string().optional(),
  collectionId: z.string().min(1).optional(),
});

export const ImportTeamCollectionSchema = z.object({
  teamId: z.string().optional(),
  jsonString: z.string().min(1),
  parentCollectionId: z.string().min(1).optional(),
});

// Environment Variables
export const EnvironmentVariableSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  secret: z.boolean().optional(),
});

// User Environment Tools
export const ListUserEnvironmentsSchema = z.object({});

export const CreateUserEnvironmentSchema = z.object({
  name: z.string().min(1),
  variables: z.array(EnvironmentVariableSchema),
});

export const UpdateUserEnvironmentSchema = z.object({
  environmentId: z.string(),
  name: z.string().min(1).optional(),
  variables: z.array(EnvironmentVariableSchema).optional(),
});

export const DeleteUserEnvironmentSchema = z.object({
  environmentId: z.string(),
});

// Team Environment Tools
export const ListTeamEnvironmentsSchema = z.object({
  teamId: z.string().optional(),
});

export const CreateTeamEnvironmentSchema = z.object({
  teamId: z.string().optional(),
  name: z.string().min(1),
  variables: z.array(EnvironmentVariableSchema),
});

export const UpdateTeamEnvironmentSchema = z.object({
  environmentId: z.string(),
  name: z.string().min(1).optional(),
  variables: z.array(EnvironmentVariableSchema).optional(),
});

export const DeleteTeamEnvironmentSchema = z.object({
  environmentId: z.string(),
});

// Advanced Collection Tools
export const DuplicateUserCollectionSchema = z.object({
  collectionId: z.string(),
  type: CollectionTypeSchema.default('REST'),
});

export const DuplicateTeamCollectionSchema = z.object({
  collectionId: z.string(),
});

export const MoveUserCollectionSchema = z
  .object({
    collectionId: z.string(),
    parentCollectionId: z.string().min(1).optional(),
    /** @deprecated alias of parentCollectionId, kept for backward compatibility. */
    newParentId: z.string().min(1).optional(),
  })
  // Reject unknown keys: a mistyped target field (e.g. `parentId`) would
  // otherwise be silently dropped and the collection moved to root: silent
  // data movement. Strict surfaces the typo as an error instead.
  .strict()
  .refine(
    (v) =>
      v.parentCollectionId === undefined ||
      v.newParentId === undefined ||
      v.parentCollectionId === v.newParentId,
    {
      message:
        'Pass only parentCollectionId — newParentId is a deprecated alias and must not differ from it.',
    }
  );

export const SearchTeamRequestsSchema = z.object({
  query: z.string().min(1),
  teamId: z.string().optional(),
});

// Team Management Tools
export const ListTeamsSchema = z.object({});

export const GetTeamInfoSchema = z.object({
  teamId: z.string(),
});

// Request Execution Tools
export const ExecuteRequestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  auth: z
    .object({
      type: z.enum(['bearer', 'basic', 'api-key']),
      token: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
      key: z.string().optional(),
      value: z.string().optional(),
      addTo: z.enum(['header', 'query']).optional(),
    })
    .optional(),
  environmentId: z.string().optional(),
  timeout: z.number().min(1000).max(120000).optional(),
});

export const ValidateResponseSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  auth: z
    .object({
      type: z.enum(['bearer', 'basic', 'api-key']),
      token: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
      key: z.string().optional(),
      value: z.string().optional(),
      addTo: z.enum(['header', 'query']).optional(),
    })
    .optional(),
  criteria: z.object({
    expectedStatus: z.number().optional(),
    expectedStatusRange: z
      .object({
        min: z.number(),
        max: z.number(),
      })
      .optional(),
    expectedHeaders: z.record(z.string()).optional(),
    expectedBodyContains: z.array(z.string()).optional(),
    // `jsonObject: true` asserts the response body parses as a JSON object/array
    // (not a primitive). This is NOT full JSON Schema validation.
    jsonObject: z.boolean().optional(),
    // Deprecated alias of `jsonObject`: any value here triggers the same
    // is-a-JSON-object check (it does NOT validate against the schema). Kept for
    // backward compatibility; prefer `jsonObject: true`.
    jsonSchema: z.object({}).passthrough().optional(),
    maxResponseTime: z.number().optional(),
  }),
  // Per-request network timeout (ms), mirroring execute_request. Falls back to
  // the server default when omitted.
  timeout: z.number().min(1000).max(120000).optional(),
  environmentId: z.string().optional(),
});

// Code Generation Tools
export const GenerateCodeSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  auth: z
    .object({
      type: z.enum(['bearer', 'basic', 'api-key']),
      token: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
      key: z.string().optional(),
      value: z.string().optional(),
      addTo: z.enum(['header', 'query']).optional(),
    })
    .optional(),
  language: z.enum(['curl', 'javascript', 'python', 'go', 'rust']),
  redactCredentials: z.boolean().optional(),
});

export const GenerateDocumentationSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  auth: z
    .object({
      type: z.enum(['bearer', 'basic', 'api-key']),
      token: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
      key: z.string().optional(),
      value: z.string().optional(),
      addTo: z.enum(['header', 'query']).optional(),
    })
    .optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  includeExamples: z.boolean().optional(),
  redactCredentials: z.boolean().optional(),
});

// ─── Auth Tools ───────────────────────────────────────────────────────────────

export const ReauthSchema = z.object({});

// ─── Request CRUD Schemas ─────────────────────────────────────────────────────

export const ListTeamRequestsSchema = z.object({
  collectionId: z.string(),
  cursor: z.string().optional(),
});

export const GetTeamRequestSchema = z.object({
  requestId: z.string(),
});

export const CreateTeamRequestSchema = z.object({
  collectionId: z.string(),
  teamId: z.string().optional(),
  title: z.string().min(1),
  request: z.string().min(1),
});

export const UpdateTeamRequestSchema = z.object({
  requestId: z.string(),
  title: z.string().min(1).optional(),
  request: z.string().optional(),
});

export const DeleteTeamRequestSchema = z.object({
  requestId: z.string(),
});

export const MoveTeamRequestSchema = z.object({
  requestId: z.string(),
  destCollectionId: z.string(),
});

export const ListUserRequestsSchema = z.object({
  collectionId: z.string(),
});

export const CreateUserRequestSchema = z.object({
  collectionId: z.string(),
  type: CollectionTypeSchema,
  title: z.string().min(1),
  request: z.string().min(1),
});

export const UpdateUserRequestSchema = z.object({
  requestId: z.string(),
  type: CollectionTypeSchema,
  title: z.string().min(1).optional(),
  request: z.string().optional(),
});

export const DeleteUserRequestSchema = z.object({
  requestId: z.string(),
});

export const MoveUserRequestSchema = z.object({
  requestId: z.string(),
  sourceCollectionId: z.string(),
  destCollectionId: z.string(),
});

// ─── Team Management Schemas ────────────────────────────────────────────────

export const CreateTeamSchema = z.object({
  name: z.string().min(1),
});

export const RenameTeamSchema = z.object({
  teamId: z.string(),
  newName: z.string().min(1),
});

export const DeleteTeamSchema = z.object({
  teamId: z.string(),
});

export const LeaveTeamSchema = z.object({
  teamId: z.string(),
});

export const InviteTeamMemberSchema = z.object({
  teamId: z.string(),
  email: z.string().email(),
  role: z.enum(['OWNER', 'EDITOR', 'VIEWER']),
});

export const RevokeTeamInvitationSchema = z.object({
  inviteId: z.string(),
});

export const RemoveTeamMemberSchema = z.object({
  teamId: z.string(),
  userUid: z.string(),
});

export const UpdateTeamMemberRoleSchema = z.object({
  teamId: z.string(),
  userUid: z.string(),
  newRole: z.enum(['OWNER', 'EDITOR', 'VIEWER']),
});
