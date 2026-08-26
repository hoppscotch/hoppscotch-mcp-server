import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  type CallToolRequest,
  type ListToolsRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config.js';
import { HoppscotchClient } from './client.js';
import { CollectionRepository } from './repositories/collection-repository.js';
import { EnvironmentRepository } from './repositories/environment-repository.js';
import { TeamRepository } from './repositories/team-repository.js';
import { RequestRepository } from './repositories/request-repository.js';
import { ToolHandlers } from './tools/handlers.js';
import { selectProfileTools } from './tools/definitions.js';
import { addAuthProgressReporter } from './auth.js';
import { HoppscotchError } from './types.js';
import { ZodError } from 'zod';
import { VERSION } from './version.js';

/**
 * Flatten a ZodError into a readable "field: message; field: message" string
 * (prefixed "Invalid arguments:") instead of leaking the raw issue-array JSON
 * into the tool result.
 */
export function formatZodError(error: ZodError): string {
  const issues = error.issues
    .map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`)
    .join('; ');
  return `Invalid arguments: ${issues}`;
}

/**
 * Hoppscotch MCP Server
 */
export class HoppscotchMCPServer {
  private server: Server;
  private handlers: ToolHandlers;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.server = new Server(
      { name: 'hoppscotch-mcp-server', version: VERSION },
      { capabilities: { tools: {} } }
    );

    const client = new HoppscotchClient(config);
    const collectionRepo = new CollectionRepository(client);
    const environmentRepo = new EnvironmentRepository(client);
    const teamRepo = new TeamRepository(client);
    const requestRepo = new RequestRepository(client);

    this.handlers = new ToolHandlers(
      collectionRepo,
      environmentRepo,
      teamRepo,
      requestRepo,
      client,
      config.defaultTeamId,
      config.timeout
    );

    this.setupHandlers();

    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    // NOTE: process-level signal handling (SIGINT/SIGTERM) and process.exit are
    // deliberately NOT registered here. A library must not hijack the host
    // process's signals. The CLI entry (src/index.ts) owns that lifecycle;
    // embedders call `close()` from their own shutdown path.
  }

  private setupHandlers() {
    // HOPPSCOTCH_TOOL_PROFILE selects the tool surface: minimal | core (default)
    // | standard | full. The SAME map gates both tools/list (discovery) and
    // tools/call (invocation); listing without call-side gating would let a
    // caller who already knows a tool name invoke a "hidden" tool by naming it
    // directly.
    const selectedTools = selectProfileTools(this.config.toolProfile);
    const validToolNames: Set<string> = new Set(Object.values(selectedTools).map((t) => t.name));

    this.server.setRequestHandler(ListToolsRequestSchema, async (_request: ListToolsRequest) => {
      return { tools: Object.values(selectedTools) };
    });

    // Handle tool execution
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request: CallToolRequest, extra) => {
        const { name, arguments: args } = request.params;

        // Protocol-level error: unknown OR out-of-profile tool. The set is
        // built from the selected profile, so a tool that exists but is hidden
        // by HOPPSCOTCH_TOOL_PROFILE is rejected exactly like a tool that
        // doesn't exist: same wire shape, JSON-RPC -32602 InvalidParams.
        // Thrown outside the try/catch so the SDK serialises it as a JSON-RPC
        // error response, not as a tool-result with isError: true.
        if (!validToolNames.has(name)) {
          throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
        }

        // QoL: relay auth progress (e.g. the device-login URL) as MCP progress
        // notifications when the client supplied a progressToken. Best-effort and
        // fully guarded: notification failures must never affect the tool call.
        // The disposer removes ONLY this request's reporter, so a concurrent
        // request's reporter survives (no cross-request clobber).
        const progressToken = request.params._meta?.progressToken;
        let disposeAuthProgress: (() => void) | undefined;
        if (progressToken !== undefined && typeof extra?.sendNotification === 'function') {
          disposeAuthProgress = addAuthProgressReporter((message) => {
            void Promise.resolve(
              extra.sendNotification({
                method: 'notifications/progress',
                params: { progressToken, progress: 0, message },
              })
            ).catch(() => {
              /* ignore notification failures */
            });
          });
        }

        try {
          switch (name) {
            // Auth utility
            case 'reauth':
              return await this.handlers.reauth(args);

            // User Collection Tools
            case 'list_user_collections':
              return await this.handlers.listUserCollections(args);
            case 'get_user_collection':
              return await this.handlers.getUserCollection(args);
            case 'create_user_collection':
              return await this.handlers.createUserCollection(args);
            case 'update_user_collection':
              return await this.handlers.updateUserCollection(args);
            case 'delete_user_collection':
              return await this.handlers.deleteUserCollection(args);
            case 'export_user_collection':
              return await this.handlers.exportUserCollection(args);
            case 'import_user_collection':
              return await this.handlers.importUserCollection(args);

            // User Environment Tools
            case 'list_user_environments':
              return await this.handlers.listUserEnvironments(args);
            case 'create_user_environment':
              return await this.handlers.createUserEnvironment(args);
            case 'update_user_environment':
              return await this.handlers.updateUserEnvironment(args);
            case 'delete_user_environment':
              return await this.handlers.deleteUserEnvironment(args);

            // Team Collection Tools
            case 'list_team_collections':
              return await this.handlers.listTeamCollections(args);
            case 'get_team_collection':
              return await this.handlers.getTeamCollection(args);
            case 'create_team_collection':
              return await this.handlers.createTeamCollection(args);
            case 'update_team_collection':
              return await this.handlers.updateTeamCollection(args);
            case 'delete_team_collection':
              return await this.handlers.deleteTeamCollection(args);
            case 'export_team_collection':
              return await this.handlers.exportTeamCollection(args);

            // Team Environment Tools
            case 'list_team_environments':
              return await this.handlers.listTeamEnvironments(args);
            case 'create_team_environment':
              return await this.handlers.createTeamEnvironment(args);
            case 'update_team_environment':
              return await this.handlers.updateTeamEnvironment(args);
            case 'delete_team_environment':
              return await this.handlers.deleteTeamEnvironment(args);

            // Advanced Collection Tools (Standard Mode)
            case 'duplicate_user_collection':
              return await this.handlers.duplicateUserCollection(args);
            case 'duplicate_team_collection':
              return await this.handlers.duplicateTeamCollection(args);
            case 'move_user_collection':
              return await this.handlers.moveUserCollection(args);
            case 'move_team_collection':
              return await this.handlers.moveTeamCollection(args);
            case 'search_team_requests':
              return await this.handlers.searchTeamRequests(args);
            case 'import_team_collection':
              return await this.handlers.importTeamCollection(args);

            // Read-only Team Management Tools
            case 'list_teams':
              return await this.handlers.listTeams(args);
            case 'get_team_info':
              return await this.handlers.getTeamInfo(args);

            // Team Management Write Tools
            case 'create_team':
              return await this.handlers.createTeam(args);
            case 'rename_team':
              return await this.handlers.renameTeam(args);
            case 'delete_team':
              return await this.handlers.deleteTeam(args);
            case 'leave_team':
              return await this.handlers.leaveTeam(args);
            case 'invite_team_member':
              return await this.handlers.inviteTeamMember(args);
            case 'revoke_team_invitation':
              return await this.handlers.revokeTeamInvitation(args);
            case 'remove_team_member':
              return await this.handlers.removeTeamMember(args);
            case 'update_team_member_role':
              return await this.handlers.updateTeamMemberRole(args);

            // Request Execution Tools
            case 'execute_request':
              return await this.handlers.executeRequest(args);
            case 'validate_response':
              return await this.handlers.validateResponse(args);

            // Code Generation Tools
            case 'generate_code':
              return await this.handlers.generateCode(args);
            case 'generate_documentation':
              return await this.handlers.generateDocumentation(args);

            // Team Request CRUD Tools
            case 'list_team_requests':
              return await this.handlers.listTeamRequests(args);
            case 'get_team_request':
              return await this.handlers.getTeamRequest(args);
            case 'create_team_request':
              return await this.handlers.createTeamRequest(args);
            case 'update_team_request':
              return await this.handlers.updateTeamRequest(args);
            case 'delete_team_request':
              return await this.handlers.deleteTeamRequest(args);
            case 'move_team_request':
              return await this.handlers.moveTeamRequest(args);

            // User Request CRUD Tools
            case 'list_user_requests':
              return await this.handlers.listUserRequests(args);
            case 'create_user_request':
              return await this.handlers.createUserRequest(args);
            case 'update_user_request':
              return await this.handlers.updateUserRequest(args);
            case 'delete_user_request':
              return await this.handlers.deleteUserRequest(args);
            case 'move_user_request':
              return await this.handlers.moveUserRequest(args);

            default:
              // Unreachable: validToolNames pre-check above guarantees name is
              // in ALL_FULL_TOOLS. If we ever hit this branch it means a tool
              // was added to ALL_FULL_TOOLS without a switch case, so surface as
              // an internal error so it's caught in dev rather than silently
              // returning isError:true to the model.
              throw new McpError(
                ErrorCode.InternalError,
                `Tool "${name}" is registered but has no dispatch case (logic bug, please report)`
              );
          }
        } catch (error) {
          // McpError is a protocol-level error: re-throw so the SDK
          // serialises it as JSON-RPC error rather than wrapping in
          // CallToolResult.isError. This preserves the distinction between
          // "the tool failed at runtime" (isError:true) and "the protocol
          // request was malformed" (JSON-RPC error).
          if (error instanceof McpError) {
            throw error;
          }
          if (error instanceof HoppscotchError) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error: ${error.message}`,
                },
              ],
              isError: true,
            };
          }

          // ZodError (argument validation): flatten the raw issue array into a
          // readable "field: message" list instead of leaking JSON. Must precede
          // the generic Error branch since ZodError extends Error.
          if (error instanceof ZodError) {
            return {
              content: [
                {
                  type: 'text',
                  text: formatZodError(error),
                },
              ],
              isError: true,
            };
          }

          // Log unexpected errors for server-side debugging (stack traces are lost otherwise)
          if (error instanceof Error) {
            process.stderr.write(
              `[MCP] Unexpected error in tool "${name}": ${error.message}\n${error.stack ?? ''}\n`
            );
            return {
              content: [
                {
                  type: 'text',
                  text: `Unexpected error: ${error.message}`,
                },
              ],
              isError: true,
            };
          }

          process.stderr.write(`[MCP] Unexpected error in tool "${name}": ${String(error)}\n`);
          return {
            content: [
              {
                type: 'text',
                text: `An unknown error occurred while executing tool "${name}"`,
              },
            ],
            isError: true,
          };
        } finally {
          // Detach THIS request's auth progress reporter (identity-checked) so it
          // can't leak into a later request, while any concurrent request's
          // reporter stays registered.
          disposeAuthProgress?.();
        }
      }
    );
  }

  /**
   * Connect the server to a transport and start serving.
   *
   * Defaults to stdio (the npm CLI usage). Embedders may pass any MCP
   * `Transport`, e.g. an in-process transport inside a desktop app (Tauri or
   * Electron) or a CLI that hosts the server itself, making the server
   * transport-agnostic without a rewrite.
   */
  async run(transport: Transport = new StdioServerTransport()): Promise<void> {
    await this.server.connect(transport);
    console.error('Hoppscotch MCP Server running');
  }

  /**
   * Close the underlying MCP server and its transport. Embedders call this from
   * their own shutdown path; the CLI wires it to SIGINT/SIGTERM.
   */
  async close(): Promise<void> {
    await this.server.close();
  }
}
