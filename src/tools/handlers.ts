import type { HoppscotchClient } from '../client.js';
import type { CollectionRepository } from '../repositories/collection-repository.js';
import type { EnvironmentRepository } from '../repositories/environment-repository.js';
import { redactEnvSecrets } from '../repositories/environment-repository.js';
import type { TeamRepository } from '../repositories/team-repository.js';
import type { RequestRepository } from '../repositories/request-repository.js';
import { CollectionType, HoppscotchError, type EnvironmentVariable } from '../types.js';
import * as schemas from './schemas.js';

/**
 * Tool handlers for MCP server
 * Each handler validates input and delegates to repository
 */
export class ToolHandlers {
  constructor(
    private collectionRepo: CollectionRepository,
    private environmentRepo: EnvironmentRepository,
    private teamRepo: TeamRepository,
    private requestRepo: RequestRepository,
    private client: HoppscotchClient,
    private defaultTeamId?: string,
    private timeout: number = 30000
  ) {}

  /**
   * Force a fresh device-login (QoL). Clears caches + abandons any in-flight
   * flow, then re-authenticates. The "login still pending" case rejects with an
   * actionable, URL-bearing message, surfaced as normal content (not isError)
   * so the agent shows the URL and retries. The token itself is never echoed.
   */
  async reauth(args: unknown) {
    schemas.ReauthSchema.parse(args);
    try {
      await this.client.reauthenticate();
      return {
        content: [
          {
            type: 'text',
            text: 'Re-authenticated successfully — a fresh Hoppscotch session is now active.',
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: message }] };
    }
  }

  /**
   * Helper to get team ID (from param or default)
   */
  private getTeamId(teamId?: string): string {
    const id = teamId || this.defaultTeamId;
    if (!id) {
      throw new HoppscotchError(
        'Team ID is required. Either provide teamId parameter or set HOPPSCOTCH_DEFAULT_TEAM_ID',
        'MISSING_TEAM_ID'
      );
    }
    return id;
  }

  /**
   * User Collection Handlers
   */
  async listUserCollections(args: unknown) {
    const { type, cursor, limit } = schemas.ListUserCollectionsSchema.parse(args);
    const collections = await this.collectionRepo.getUserCollections(type as CollectionType, {
      cursor,
      limit,
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(collections, null, 2),
        },
      ],
    };
  }

  async getUserCollection(args: unknown) {
    const { collectionId } = schemas.GetUserCollectionSchema.parse(args);
    const collection = await this.collectionRepo.getUserCollection(collectionId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(collection, null, 2),
        },
      ],
    };
  }

  async createUserCollection(args: unknown) {
    const { title, type, parentCollectionId, data } =
      schemas.CreateUserCollectionSchema.parse(args);

    const collection = await this.collectionRepo.createUserCollection(type as CollectionType, {
      title,
      parentCollectionID: parentCollectionId,
      data,
    });

    return {
      content: [
        {
          type: 'text',
          text: `Successfully created user collection "${collection.title}" (ID: ${collection.id})`,
        },
        {
          type: 'text',
          text: JSON.stringify(collection, null, 2),
        },
      ],
    };
  }

  async updateUserCollection(args: unknown) {
    const { collectionId, type, title, data } = schemas.UpdateUserCollectionSchema.parse(args);

    const collection = await this.collectionRepo.updateUserCollection(
      collectionId,
      type as CollectionType,
      { title, data }
    );

    return {
      content: [
        {
          type: 'text',
          text: `Successfully updated user collection "${collection.title}" (ID: ${collection.id})`,
        },
        {
          type: 'text',
          text: JSON.stringify(collection, null, 2),
        },
      ],
    };
  }

  async deleteUserCollection(args: unknown) {
    const { collectionId, type } = schemas.DeleteUserCollectionSchema.parse(args);
    await this.collectionRepo.deleteUserCollection(collectionId, type as CollectionType);

    return {
      content: [
        {
          type: 'text',
          text: `Successfully deleted user collection (ID: ${collectionId})`,
        },
      ],
    };
  }

  async exportUserCollection(args: unknown) {
    const { type, collectionId } = schemas.ExportUserCollectionSchema.parse(args);
    const jsonData = await this.collectionRepo.exportUserCollection(
      type as CollectionType,
      collectionId
    );

    return {
      content: [
        {
          type: 'text',
          text: collectionId
            ? `Exported user collection (ID: ${collectionId})`
            : `Exported all ${type} user collections`,
        },
        {
          type: 'text',
          text: jsonData,
        },
      ],
    };
  }

  async importUserCollection(args: unknown) {
    const { jsonString, type, parentCollectionId } = schemas.ImportUserCollectionSchema.parse(args);

    await this.collectionRepo.importUserCollections(
      type as CollectionType,
      jsonString,
      parentCollectionId
    );

    return {
      content: [
        {
          type: 'text',
          text: `Successfully imported ${type} user collection(s)`,
        },
      ],
    };
  }

  /**
   * User Environment Handlers
   */
  async listUserEnvironments(args: unknown) {
    schemas.ListUserEnvironmentsSchema.parse(args);
    const environments = await this.environmentRepo.getUserEnvironments();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            environments.map((e) => redactEnvSecrets(e)),
            null,
            2
          ),
        },
      ],
    };
  }

  async createUserEnvironment(args: unknown) {
    const { name, variables } = schemas.CreateUserEnvironmentSchema.parse(args);
    const environment = await this.environmentRepo.createUserEnvironment({ name, variables });

    return {
      content: [
        {
          type: 'text',
          text: `Successfully created user environment "${environment.name}" (ID: ${environment.id})`,
        },
        {
          type: 'text',
          text: JSON.stringify(redactEnvSecrets(environment), null, 2),
        },
      ],
    };
  }

  async updateUserEnvironment(args: unknown) {
    const { environmentId, name, variables } = schemas.UpdateUserEnvironmentSchema.parse(args);
    const environment = await this.environmentRepo.updateUserEnvironment(environmentId, {
      name,
      variables,
    });

    return {
      content: [
        {
          type: 'text',
          text: `Successfully updated user environment "${environment.name}" (ID: ${environment.id})`,
        },
        {
          type: 'text',
          text: JSON.stringify(redactEnvSecrets(environment), null, 2),
        },
      ],
    };
  }

  async deleteUserEnvironment(args: unknown) {
    const { environmentId } = schemas.DeleteUserEnvironmentSchema.parse(args);
    await this.environmentRepo.deleteUserEnvironment(environmentId);

    return {
      content: [
        {
          type: 'text',
          text: `Successfully deleted user environment (ID: ${environmentId})`,
        },
      ],
    };
  }

  /**
   * Team Collection Handlers
   */
  async listTeamCollections(args: unknown) {
    const { teamId, cursor } = schemas.ListTeamCollectionsSchema.parse(args);
    const resolvedTeamId = this.getTeamId(teamId);

    const collections = await this.collectionRepo.getTeamCollections(resolvedTeamId, {
      cursor,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(collections, null, 2),
        },
      ],
    };
  }

  async getTeamCollection(args: unknown) {
    const { collectionId } = schemas.GetTeamCollectionSchema.parse(args);
    const collection = await this.collectionRepo.getTeamCollection(collectionId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(collection, null, 2),
        },
      ],
    };
  }

  async createTeamCollection(args: unknown) {
    const { teamId, title, parentCollectionId, data } =
      schemas.CreateTeamCollectionSchema.parse(args);
    const resolvedTeamId = this.getTeamId(teamId);

    const collection = await this.collectionRepo.createTeamCollection(resolvedTeamId, {
      title,
      parentCollectionID: parentCollectionId,
      data,
    });

    return {
      content: [
        {
          type: 'text',
          text: `Successfully created team collection "${collection.title}" (ID: ${collection.id})`,
        },
        {
          type: 'text',
          text: JSON.stringify(collection, null, 2),
        },
      ],
    };
  }

  async updateTeamCollection(args: unknown) {
    const { collectionId, title, data } = schemas.UpdateTeamCollectionSchema.parse(args);

    const collection = await this.collectionRepo.updateTeamCollection(collectionId, {
      title,
      data,
    });

    return {
      content: [
        {
          type: 'text',
          text: `Successfully updated team collection "${collection.title}" (ID: ${collection.id})`,
        },
        {
          type: 'text',
          text: JSON.stringify(collection, null, 2),
        },
      ],
    };
  }

  async deleteTeamCollection(args: unknown) {
    const { collectionId } = schemas.DeleteTeamCollectionSchema.parse(args);
    await this.collectionRepo.deleteTeamCollection(collectionId);

    return {
      content: [
        {
          type: 'text',
          text: `Successfully deleted team collection (ID: ${collectionId})`,
        },
      ],
    };
  }

  async exportTeamCollection(args: unknown) {
    const { teamId, collectionId } = schemas.ExportTeamCollectionSchema.parse(args);
    const resolvedTeamId = this.getTeamId(teamId);

    const jsonData = await this.collectionRepo.exportTeamCollection(resolvedTeamId, collectionId);

    return {
      content: [
        {
          type: 'text',
          text: collectionId
            ? `Exported team collection (ID: ${collectionId})`
            : 'Exported all team collections',
        },
        {
          type: 'text',
          text: jsonData,
        },
      ],
    };
  }

  /**
   * Team Environment Handlers
   */
  async listTeamEnvironments(args: unknown) {
    const { teamId } = schemas.ListTeamEnvironmentsSchema.parse(args);
    const resolvedTeamId = this.getTeamId(teamId);

    const environments = await this.environmentRepo.getTeamEnvironments(resolvedTeamId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            environments.map((e) => redactEnvSecrets(e)),
            null,
            2
          ),
        },
      ],
    };
  }

  async createTeamEnvironment(args: unknown) {
    const { teamId, name, variables } = schemas.CreateTeamEnvironmentSchema.parse(args);
    const resolvedTeamId = this.getTeamId(teamId);

    const environment = await this.environmentRepo.createTeamEnvironment(resolvedTeamId, {
      name,
      variables,
    });

    return {
      content: [
        {
          type: 'text',
          text: `Successfully created team environment "${environment.name}" (ID: ${environment.id})`,
        },
        {
          type: 'text',
          text: JSON.stringify(redactEnvSecrets(environment), null, 2),
        },
      ],
    };
  }

  async updateTeamEnvironment(args: unknown) {
    const { environmentId, name, variables } = schemas.UpdateTeamEnvironmentSchema.parse(args);

    const environment = await this.environmentRepo.updateTeamEnvironment(environmentId, {
      name,
      variables,
    });

    return {
      content: [
        {
          type: 'text',
          text: `Successfully updated team environment "${environment.name}" (ID: ${environment.id})`,
        },
        {
          type: 'text',
          text: JSON.stringify(redactEnvSecrets(environment), null, 2),
        },
      ],
    };
  }

  async deleteTeamEnvironment(args: unknown) {
    const { environmentId } = schemas.DeleteTeamEnvironmentSchema.parse(args);

    await this.environmentRepo.deleteTeamEnvironment(environmentId);

    return {
      content: [
        {
          type: 'text',
          text: `Successfully deleted team environment (ID: ${environmentId})`,
        },
      ],
    };
  }

  /**
   * Advanced Collection Handlers
   */
  async duplicateUserCollection(args: unknown) {
    const { collectionId, type } = schemas.DuplicateUserCollectionSchema.parse(args);

    await this.collectionRepo.duplicateUserCollection(collectionId, type as CollectionType);

    return {
      content: [
        {
          type: 'text',
          text: `Successfully duplicated user collection (ID: ${collectionId})`,
        },
      ],
    };
  }

  async duplicateTeamCollection(args: unknown) {
    const { collectionId } = schemas.DuplicateTeamCollectionSchema.parse(args);

    await this.collectionRepo.duplicateTeamCollection(collectionId);

    return {
      content: [
        {
          type: 'text',
          text: `Successfully duplicated team collection (ID: ${collectionId})`,
        },
      ],
    };
  }

  async moveUserCollection(args: unknown) {
    const { collectionId, parentCollectionId, newParentId } =
      schemas.MoveUserCollectionSchema.parse(args);
    const targetParentId = parentCollectionId ?? newParentId;

    const collection = await this.collectionRepo.moveUserCollection(collectionId, targetParentId);

    return {
      content: [
        {
          type: 'text',
          text: targetParentId
            ? `Successfully moved user collection "${collection.title}" to parent (ID: ${targetParentId})`
            : `Successfully moved user collection "${collection.title}" to root`,
        },
        {
          type: 'text',
          text: JSON.stringify(collection, null, 2),
        },
      ],
    };
  }

  async moveTeamCollection(args: unknown) {
    const { collectionId, parentCollectionId } = schemas.MoveTeamCollectionSchema.parse(args);

    const collection = await this.collectionRepo.moveTeamCollection(
      collectionId,
      parentCollectionId
    );

    return {
      content: [
        {
          type: 'text',
          text: parentCollectionId
            ? `Successfully moved team collection "${collection.title}" to parent (ID: ${parentCollectionId})`
            : `Successfully moved team collection "${collection.title}" to root`,
        },
        {
          type: 'text',
          text: JSON.stringify(collection, null, 2),
        },
      ],
    };
  }

  async searchTeamRequests(args: unknown) {
    const { query, teamId } = schemas.SearchTeamRequestsSchema.parse(args);
    const resolvedTeamId = this.getTeamId(teamId);

    const results = await this.requestRepo.searchTeamRequests(resolvedTeamId, query);

    return {
      content: [
        {
          type: 'text',
          text: `Found ${results.length} request(s) matching "${query}"`,
        },
        {
          type: 'text',
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  }

  async importTeamCollection(args: unknown) {
    const { teamId, jsonString, parentCollectionId } =
      schemas.ImportTeamCollectionSchema.parse(args);
    const resolvedTeamId = this.getTeamId(teamId);

    await this.collectionRepo.importTeamCollections(resolvedTeamId, jsonString, parentCollectionId);

    return {
      content: [
        {
          type: 'text',
          text: 'Successfully imported team collection(s)',
        },
      ],
    };
  }

  /**
   * Team Management Handlers
   */
  async listTeams(args: unknown) {
    schemas.ListTeamsSchema.parse(args);

    const teams = await this.teamRepo.listTeams();

    return {
      content: [
        {
          type: 'text',
          text: `Found ${teams.length} team(s)`,
        },
        {
          type: 'text',
          text: JSON.stringify(teams, null, 2),
        },
      ],
    };
  }

  async getTeamInfo(args: unknown) {
    const { teamId } = schemas.GetTeamInfoSchema.parse(args);

    const team = await this.teamRepo.getTeam(teamId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(team, null, 2),
        },
      ],
    };
  }

  // Team Management Write Tools

  async createTeam(args: unknown) {
    const { name } = schemas.CreateTeamSchema.parse(args);
    const team = await this.teamRepo.createTeam(name);

    return {
      content: [
        {
          type: 'text',
          text: `Successfully created team "${team.name}" (ID: ${team.id})`,
        },
        {
          type: 'text',
          text: JSON.stringify(team, null, 2),
        },
      ],
    };
  }

  async renameTeam(args: unknown) {
    const { teamId, newName } = schemas.RenameTeamSchema.parse(args);
    const team = await this.teamRepo.renameTeam(teamId, newName);

    return {
      content: [
        {
          type: 'text',
          text: `Successfully renamed team to "${team.name}" (ID: ${team.id})`,
        },
        {
          type: 'text',
          text: JSON.stringify(team, null, 2),
        },
      ],
    };
  }

  async deleteTeam(args: unknown) {
    const { teamId } = schemas.DeleteTeamSchema.parse(args);
    await this.teamRepo.deleteTeam(teamId);

    return {
      content: [
        {
          type: 'text',
          text: `Successfully deleted team (ID: ${teamId})`,
        },
      ],
    };
  }

  async leaveTeam(args: unknown) {
    const { teamId } = schemas.LeaveTeamSchema.parse(args);
    await this.teamRepo.leaveTeam(teamId);

    return {
      content: [
        {
          type: 'text',
          text: `Successfully left team (ID: ${teamId})`,
        },
      ],
    };
  }

  async inviteTeamMember(args: unknown) {
    const { teamId, email, role } = schemas.InviteTeamMemberSchema.parse(args);
    const invitation = await this.teamRepo.inviteTeamMember(teamId, email, role);

    return {
      content: [
        {
          type: 'text',
          text: `Successfully invited ${email} as ${role} (Invitation ID: ${invitation.id})`,
        },
        {
          type: 'text',
          text: JSON.stringify(invitation, null, 2),
        },
      ],
    };
  }

  async revokeTeamInvitation(args: unknown) {
    const { inviteId } = schemas.RevokeTeamInvitationSchema.parse(args);
    await this.teamRepo.revokeTeamInvitation(inviteId);

    return {
      content: [
        {
          type: 'text',
          text: `Successfully revoked invitation (ID: ${inviteId})`,
        },
      ],
    };
  }

  async removeTeamMember(args: unknown) {
    const { teamId, userUid } = schemas.RemoveTeamMemberSchema.parse(args);
    await this.teamRepo.removeTeamMember(teamId, userUid);

    return {
      content: [
        {
          type: 'text',
          text: `Successfully removed member (UID: ${userUid}) from team (ID: ${teamId})`,
        },
      ],
    };
  }

  async updateTeamMemberRole(args: unknown) {
    const { teamId, userUid, newRole } = schemas.UpdateTeamMemberRoleSchema.parse(args);
    const member = await this.teamRepo.updateTeamMemberRole(teamId, userUid, newRole);

    return {
      content: [
        {
          type: 'text',
          text: `Successfully updated member role to ${member.role}`,
        },
        {
          type: 'text',
          text: JSON.stringify(member, null, 2),
        },
      ],
    };
  }

  // Request Execution Tools
  async executeRequest(args: unknown) {
    const params = schemas.ExecuteRequestSchema.parse(args);

    const variables = await this.resolveEnvironmentVariables(params.environmentId);

    // Executor is dynamically imported to keep it off the startup path; it also
    // owns secret-egress control (opt-in via HOPPSCOTCH_SECRET_ALLOWED_ORIGINS;
    // unresolved placeholders rejected when an environment was requested).
    const {
      executeRequest: execReq,
      formatResponse,
      substituteRequestVariables,
    } = await import('../utils/request-executor.js');

    const { url, headers, body, substitutedSecretValues } = substituteRequestVariables(
      { url: params.url, headers: { ...params.headers }, body: params.body },
      variables,
      { requireResolved: params.environmentId !== undefined }
    );

    const result = await execReq(
      {
        method: params.method,
        url,
        headers,
        body,
        auth: params.auth,
      },
      params.timeout || this.timeout,
      substitutedSecretValues
    );

    return {
      content: [
        {
          type: 'text',
          text: formatResponse(result),
        },
      ],
    };
  }

  /**
   * Resolve variables for a personal environment. If an environmentId is given it
   * MUST exist: a missing or unknown one is a hard error, not a silent no-op that
   * would send unresolved `{{placeholder}}`s. Team environments and Cloud user
   * environments are not available here.
   */
  private async resolveEnvironmentVariables(
    environmentId?: string
  ): Promise<EnvironmentVariable[]> {
    if (!environmentId) return [];
    const env = await this.environmentRepo.getUserEnvironments();
    const found = env.find((e) => e.id === environmentId);
    if (!found) {
      throw new HoppscotchError(
        `Environment '${environmentId}' not found for this account. Only personal ` +
          `environments are available here (team environments and Cloud user ` +
          `environments are not).`,
        'ENVIRONMENT_NOT_FOUND'
      );
    }
    return this.environmentRepo.getEnvironmentVariables(found);
  }

  async validateResponse(args: unknown) {
    const params = schemas.ValidateResponseSchema.parse(args);

    const variables = await this.resolveEnvironmentVariables(params.environmentId);

    const {
      executeRequest: execReq,
      validateResponse: validateResp,
      formatResponse,
      substituteRequestVariables,
    } = await import('../utils/request-executor.js');

    // Secret-egress control is opt-in via HOPPSCOTCH_SECRET_ALLOWED_ORIGINS;
    // unresolved placeholders rejected when an environment was requested.
    const { url, headers, body, substitutedSecretValues } = substituteRequestVariables(
      { url: params.url, headers: { ...params.headers }, body: params.body },
      variables,
      { requireResolved: params.environmentId !== undefined }
    );

    const result = await execReq(
      {
        method: params.method,
        url,
        headers,
        body,
        auth: params.auth,
      },
      params.timeout || this.timeout,
      substitutedSecretValues
    );

    // Validate response
    const validation = validateResp(result, params.criteria);

    const output: string[] = [];
    output.push('## Validation Result');
    output.push('');
    output.push(`Status: ${validation.valid ? '✅ PASS' : '❌ FAIL'}`);
    output.push('');

    if (!validation.valid) {
      output.push('## Errors:');
      for (const error of validation.errors) {
        output.push(`- ${error}`);
      }
      output.push('');
    }

    output.push('## Response Details');
    output.push('');
    output.push(formatResponse(result));

    return {
      content: [
        {
          type: 'text',
          text: output.join('\n'),
        },
      ],
    };
  }

  // Code Generation Tools
  async generateCode(args: unknown) {
    const params = schemas.GenerateCodeSchema.parse(args);

    const { generateCode: genCode } = await import('../utils/code-generator.js');
    const code = genCode(
      {
        method: params.method,
        url: params.url,
        headers: params.headers,
        body: params.body,
        auth: params.auth,
      },
      params.language,
      { redactCredentials: params.redactCredentials }
    );

    return {
      content: [
        {
          type: 'text',
          text: `\`\`\`${params.language === 'curl' ? 'bash' : params.language}\n${code}\n\`\`\``,
        },
      ],
    };
  }

  async generateDocumentation(args: unknown) {
    const params = schemas.GenerateDocumentationSchema.parse(args);

    const { generateDocumentation: genDocs } = await import('../utils/code-generator.js');
    const documentation = genDocs(
      {
        method: params.method,
        url: params.url,
        headers: params.headers,
        body: params.body,
        auth: params.auth,
      },
      {
        title: params.title,
        description: params.description,
        includeExamples: params.includeExamples,
        redactCredentials: params.redactCredentials,
      }
    );

    return {
      content: [
        {
          type: 'text',
          text: documentation,
        },
      ],
    };
  }

  // ─── Team Request Handlers ──────────────────────────────────────────────────

  async listTeamRequests(args: unknown) {
    const { collectionId, cursor } = schemas.ListTeamRequestsSchema.parse(args);
    const requests = await this.requestRepo.getTeamRequests(collectionId, cursor);
    return {
      content: [{ type: 'text', text: JSON.stringify(requests, null, 2) }],
    };
  }

  async getTeamRequest(args: unknown) {
    const { requestId } = schemas.GetTeamRequestSchema.parse(args);
    const request = await this.requestRepo.getTeamRequest(requestId);
    return {
      content: [{ type: 'text', text: JSON.stringify(request, null, 2) }],
    };
  }

  async createTeamRequest(args: unknown) {
    const { collectionId, teamId, title, request } = schemas.CreateTeamRequestSchema.parse(args);
    const resolvedTeamId = this.getTeamId(teamId);
    const created = await this.requestRepo.createTeamRequest(collectionId, resolvedTeamId, {
      title,
      request,
    });
    return {
      content: [
        {
          type: 'text',
          text: `Successfully created team request "${created.title}" (ID: ${created.id})`,
        },
        { type: 'text', text: JSON.stringify(created, null, 2) },
      ],
    };
  }

  async updateTeamRequest(args: unknown) {
    const { requestId, title, request } = schemas.UpdateTeamRequestSchema.parse(args);
    const updated = await this.requestRepo.updateTeamRequest(requestId, { title, request });
    return {
      content: [
        {
          type: 'text',
          text: `Successfully updated team request "${updated.title}" (ID: ${updated.id})`,
        },
        { type: 'text', text: JSON.stringify(updated, null, 2) },
      ],
    };
  }

  async deleteTeamRequest(args: unknown) {
    const { requestId } = schemas.DeleteTeamRequestSchema.parse(args);
    await this.requestRepo.deleteTeamRequest(requestId);
    return {
      content: [{ type: 'text', text: `Successfully deleted team request (ID: ${requestId})` }],
    };
  }

  async moveTeamRequest(args: unknown) {
    const { requestId, destCollectionId } = schemas.MoveTeamRequestSchema.parse(args);
    const moved = await this.requestRepo.moveTeamRequest(requestId, destCollectionId);
    return {
      content: [
        {
          type: 'text',
          text: `Successfully moved team request "${moved.title}" to collection (ID: ${destCollectionId})`,
        },
        { type: 'text', text: JSON.stringify(moved, null, 2) },
      ],
    };
  }

  // ─── User Request Handlers ──────────────────────────────────────────────────

  async listUserRequests(args: unknown) {
    const { collectionId } = schemas.ListUserRequestsSchema.parse(args);
    const requests = await this.requestRepo.getUserRequests(collectionId);
    return {
      content: [{ type: 'text', text: JSON.stringify(requests, null, 2) }],
    };
  }

  async createUserRequest(args: unknown) {
    const { collectionId, type, title, request } = schemas.CreateUserRequestSchema.parse(args);
    const created = await this.requestRepo.createUserRequest(collectionId, type as CollectionType, {
      title,
      request,
    });
    return {
      content: [
        {
          type: 'text',
          text: `Successfully created user request "${created.title}" (ID: ${created.id})`,
        },
        { type: 'text', text: JSON.stringify(created, null, 2) },
      ],
    };
  }

  async updateUserRequest(args: unknown) {
    const { requestId, type, title, request } = schemas.UpdateUserRequestSchema.parse(args);
    const updated = await this.requestRepo.updateUserRequest(requestId, type as CollectionType, {
      title,
      request,
    });
    return {
      content: [
        {
          type: 'text',
          text: `Successfully updated user request "${updated.title}" (ID: ${updated.id})`,
        },
        { type: 'text', text: JSON.stringify(updated, null, 2) },
      ],
    };
  }

  async deleteUserRequest(args: unknown) {
    const { requestId } = schemas.DeleteUserRequestSchema.parse(args);
    await this.requestRepo.deleteUserRequest(requestId);
    return {
      content: [{ type: 'text', text: `Successfully deleted user request (ID: ${requestId})` }],
    };
  }

  async moveUserRequest(args: unknown) {
    const { requestId, sourceCollectionId, destCollectionId } =
      schemas.MoveUserRequestSchema.parse(args);
    const moved = await this.requestRepo.moveUserRequest(
      requestId,
      sourceCollectionId,
      destCollectionId
    );
    return {
      content: [
        {
          type: 'text',
          text: `Successfully moved user request "${moved.title}" to collection (ID: ${destCollectionId})`,
        },
        { type: 'text', text: JSON.stringify(moved, null, 2) },
      ],
    };
  }
}
