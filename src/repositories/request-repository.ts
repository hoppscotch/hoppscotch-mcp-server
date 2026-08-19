import type { HoppscotchClient } from '../client.js';
import type {
  TeamRequest,
  UserRequest,
  CreateRequestInput,
  UpdateRequestInput,
  TeamRequestSearchResult,
} from '../types.js';
import { CollectionType, HoppscotchError } from '../types.js';
import { ApiType } from '../config.js';
import * as queries from '../graphql/queries.js';
import * as mutations from '../graphql/mutations.js';

/**
 * Repository for managing requests inside collections (team and user).
 *
 * Cloud vs Self-Hosted notes:
 *   - Team request CRUD (create/update/delete/move) works on both Cloud and SH.
 *   - Team request READ (`requestsInCollection`, `request`) works on both Cloud and SH.
 *   - User request WRITE (create/update/delete/move) works on self-hosted; on
 *     Cloud the personal (user) workspace is unsupported as of now.
 *   - User request READ (`userCollection { requests }`) is not supported on
 *     Cloud as of now — the MCP gates it client-side.
 */
export class RequestRepository {
  constructor(private client: HoppscotchClient) {}

  private isCloud(): boolean {
    return this.client.getConfig().apiType === ApiType.CLOUD;
  }

  private assertNotCloud(operation: string): void {
    if (this.isCloud()) {
      throw new Error(
        `"${operation}" is not supported on Hoppscotch Cloud as of now. ` +
          'Use team requests instead, or switch to a self-hosted instance.'
      );
    }
  }

  // ─── Team Requests ──────────────────────────────────────────────────────────

  /**
   * List requests in a team collection.
   * Both Cloud and Self-Hosted.
   */
  async getTeamRequests(collectionId: string, cursor?: string): Promise<TeamRequest[]> {
    const result = await this.client.graphql<{
      requestsInCollection: TeamRequest[];
    }>(queries.GET_TEAM_REQUESTS, { collectionID: collectionId, cursor });

    return result.requestsInCollection || [];
  }

  /**
   * Get a single team request by ID.
   * Both Cloud and Self-Hosted.
   */
  async getTeamRequest(requestId: string): Promise<TeamRequest> {
    const result = await this.client.graphql<{
      request: TeamRequest;
    }>(queries.GET_TEAM_REQUEST, { requestID: requestId });

    return result.request;
  }

  /**
   * Create a request in a team collection.
   * Both Cloud and Self-Hosted.
   * Requires the teamID of the collection's parent team.
   */
  async createTeamRequest(
    collectionId: string,
    teamId: string,
    data: CreateRequestInput
  ): Promise<TeamRequest> {
    const result = await this.client.graphql<{
      createRequestInCollection: TeamRequest;
    }>(mutations.CREATE_TEAM_REQUEST, {
      collectionID: collectionId,
      teamID: teamId,
      title: data.title,
      request: data.request,
    });

    return result.createRequestInCollection;
  }

  /**
   * Update a team request's title and/or request data.
   * Both Cloud and Self-Hosted.
   * Fetches the current request first to preserve fields not being updated
   * (the GQL mutation requires both title and request as non-null strings).
   */
  async updateTeamRequest(requestId: string, data: UpdateRequestInput): Promise<TeamRequest> {
    // Fetch current state so omitted fields aren't blanked
    const current = await this.getTeamRequest(requestId);

    const result = await this.client.graphql<{
      updateRequest: TeamRequest;
    }>(mutations.UPDATE_TEAM_REQUEST, {
      requestID: requestId,
      title: data.title ?? current.title,
      request: data.request ?? current.request,
    });

    return result.updateRequest;
  }

  /**
   * Delete a team request.
   * Both Cloud and Self-Hosted.
   */
  async deleteTeamRequest(requestId: string): Promise<boolean> {
    await this.client.graphql(mutations.DELETE_TEAM_REQUEST, { requestID: requestId });
    return true;
  }

  /**
   * Move a team request to a different collection.
   * Both Cloud and Self-Hosted.
   */
  async moveTeamRequest(requestId: string, destCollectionId: string): Promise<TeamRequest> {
    const result = await this.client.graphql<{
      moveRequest: TeamRequest;
    }>(mutations.MOVE_TEAM_REQUEST, {
      requestID: requestId,
      destCollID: destCollectionId,
    });

    return result.moveRequest;
  }

  // ─── User Requests ──────────────────────────────────────────────────────────

  /**
   * List requests in a user collection.
   * Not supported on Cloud as of now — gated client-side.
   */
  async getUserRequests(collectionId: string): Promise<UserRequest[]> {
    this.assertNotCloud('list_user_requests');

    const result = await this.client.graphql<{
      userCollection: { requests: UserRequest[] } | null;
    }>(queries.GET_USER_REQUESTS, { userCollectionID: collectionId });

    if (!result.userCollection) {
      throw new HoppscotchError(
        `User collection "${collectionId}" not found or not accessible.`,
        'COLLECTION_NOT_FOUND'
      );
    }

    return result.userCollection.requests ?? [];
  }

  /**
   * Create a user request.
   * Both Cloud and Self-Hosted.
   */
  async createUserRequest(
    collectionId: string,
    type: CollectionType,
    data: CreateRequestInput
  ): Promise<UserRequest> {
    const mutation =
      type === CollectionType.REST
        ? mutations.CREATE_REST_USER_REQUEST
        : mutations.CREATE_GQL_USER_REQUEST;

    const key =
      type === CollectionType.REST ? 'createRESTUserRequest' : 'createGQLUserRequest';

    const result = await this.client.graphql<Record<string, UserRequest>>(mutation, {
      collectionID: collectionId,
      title: data.title,
      request: data.request,
    });

    const created = result[key];
    if (!created) throw new Error('Failed to create user request');
    return created;
  }

  /**
   * Update a user request's title and/or request data.
   * Both Cloud and Self-Hosted.
   */
  async updateUserRequest(
    requestId: string,
    type: CollectionType,
    data: UpdateRequestInput
  ): Promise<UserRequest> {
    const mutation =
      type === CollectionType.REST
        ? mutations.UPDATE_REST_USER_REQUEST
        : mutations.UPDATE_GQL_USER_REQUEST;

    const key =
      type === CollectionType.REST ? 'updateRESTUserRequest' : 'updateGQLUserRequest';

    const result = await this.client.graphql<Record<string, UserRequest>>(mutation, {
      id: requestId,
      title: data.title,
      request: data.request,
    });

    const updated = result[key];
    if (!updated) throw new Error('Failed to update user request');
    return updated;
  }

  /**
   * Delete a user request.
   * Both Cloud and Self-Hosted.
   */
  async deleteUserRequest(requestId: string): Promise<boolean> {
    await this.client.graphql(mutations.DELETE_USER_REQUEST, { id: requestId });
    return true;
  }

  /**
   * Move a user request to a different collection.
   * Both Cloud and Self-Hosted.
   */
  async moveUserRequest(
    requestId: string,
    sourceCollectionId: string,
    destCollectionId: string
  ): Promise<UserRequest> {
    const result = await this.client.graphql<{
      moveUserRequest: UserRequest;
    }>(mutations.MOVE_USER_REQUEST, {
      requestID: requestId,
      sourceCollectionID: sourceCollectionId,
      destinationCollectionID: destCollectionId,
    });

    return result.moveUserRequest;
  }

  /**
   * Search team requests by title via the `searchForRequest` GQL field.
   * Returns request rows (with parent collection metadata), not collection rows —
   * the field is named "search…request" upstream and there is no team-collection
   * title search.
   */
  async searchTeamRequests(
    teamId: string,
    query: string
  ): Promise<TeamRequestSearchResult[]> {
    const result = await this.client.graphql<{
      searchForRequest: TeamRequestSearchResult[];
    }>(queries.SEARCH_TEAM_REQUESTS, {
      teamID: teamId,
      searchQuery: query,
    });

    return result.searchForRequest || [];
  }
}
