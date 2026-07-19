import type { HoppscotchClient } from '../client.js';
import type {
  UserCollection,
  TeamCollection,
  CreateCollectionInput,
  UpdateCollectionInput,
  PaginationOptions,
} from '../types.js';
import { CollectionType } from '../types.js';
import { ApiType, DEFAULT_MAX_RESULTS } from '../config.js';
import * as queries from '../graphql/queries.js';
import * as mutations from '../graphql/mutations.js';

/** Raw GQL TeamCollection shape — parent is a nested object, not a scalar parentID. */
interface RawTeamCollection {
  id: string;
  title: string;
  data?: string | null;
  parent?: { id: string } | null;
  parentID?: string | null; // SH may return this directly
  teamID?: string;
  children?: Array<{ id: string; title: string }>;
}

/** Raw GQL UserCollection shape — SH returns parent { id }, not a parentID scalar. */
interface RawUserCollection {
  id: string;
  title: string;
  data?: string | null;
  parent?: { id: string } | null;
}

/**
 * Repository for managing collections (user and team).
 *
 * User collection READS (list, get, export) are only available on Self-Hosted
 * backends. The Cloud backend (api.hoppscotch.io) does not expose a GraphQL
 * query for personal collections. Calling these methods against Cloud will
 * throw a clear error rather than a confusing GraphQL "unknown field" response.
 *
 * User collection WRITES (create, update, delete, move, duplicate, import) and
 * ALL team collection operations work on both Cloud and Self-Hosted.
 */
export class CollectionRepository {
  constructor(private client: HoppscotchClient) {}

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private isCloud(): boolean {
    return this.client.getConfig().apiType === ApiType.CLOUD;
  }

  private assertNotCloud(operation: string): void {
    if (this.isCloud()) {
      throw new Error(
        `"${operation}" is not available on Hoppscotch Cloud. ` +
          'The Cloud backend does not expose a GraphQL query for personal (user) collections. ' +
          'Use team collections instead, or switch to a self-hosted instance.'
      );
    }
  }

  /**
   * Normalize a raw GQL TeamCollection response into our internal shape.
   * Maps parent?.id → parentID (Cloud/SH both use nested parent object).
   */
  private normalizeTeamCollection(raw: RawTeamCollection): TeamCollection {
    return {
      id: raw.id,
      title: raw.title,
      data: raw.data ?? null,
      parentID: raw.parentID ?? raw.parent?.id ?? null,
      teamID: raw.teamID ?? '',
      children: raw.children,
    };
  }

  /**
   * Normalize a raw GQL UserCollection response into our internal shape.
   * SH returns parent { id } (nested object), not a parentID scalar.
   */
  private normalizeUserCollection(raw: RawUserCollection): UserCollection {
    return {
      id: raw.id,
      title: raw.title,
      data: raw.data ?? null,
      parentID: raw.parent?.id ?? null,
    };
  }

  // ─── User Collections ─────────────────────────────────────────────────────

  /**
   * List root user collections (REST or GQL type).
   * Self-Hosted only — Cloud does not expose this query.
   */
  async getUserCollections(
    type: CollectionType,
    options?: PaginationOptions
  ): Promise<UserCollection[]> {
    this.assertNotCloud('list_user_collections');

    const query =
      type === CollectionType.REST
        ? queries.GET_USER_REST_COLLECTIONS
        : queries.GET_USER_GQL_COLLECTIONS;

    const variables = {
      cursor: options?.cursor,
      take: options?.limit || DEFAULT_MAX_RESULTS,
    };

    const result = await this.client.graphql<{
      rootRESTUserCollections?: RawUserCollection[];
      rootGQLUserCollections?: RawUserCollection[];
    }>(query, variables);

    const raw =
      (type === CollectionType.REST
        ? result.rootRESTUserCollections
        : result.rootGQLUserCollections) || [];

    return raw.map((c) => this.normalizeUserCollection(c));
  }

  /**
   * Get a specific user collection by ID.
   * Self-Hosted only.
   */
  async getUserCollection(collectionId: string): Promise<UserCollection> {
    this.assertNotCloud('get_user_collection');

    const result = await this.client.graphql<{
      userCollection: RawUserCollection;
    }>(queries.GET_USER_COLLECTION, { collectionID: collectionId });

    return this.normalizeUserCollection(result.userCollection);
  }

  /**
   * Create a user collection (root or nested).
   * Both Cloud and Self-Hosted.
   */
  async createUserCollection(
    type: CollectionType,
    data: CreateCollectionInput
  ): Promise<UserCollection> {
    let mutation: string;

    if (data.parentCollectionID) {
      mutation =
        type === CollectionType.REST
          ? mutations.CREATE_REST_CHILD_USER_COLLECTION
          : mutations.CREATE_GQL_CHILD_USER_COLLECTION;
    } else {
      mutation =
        type === CollectionType.REST
          ? mutations.CREATE_REST_ROOT_USER_COLLECTION
          : mutations.CREATE_GQL_ROOT_USER_COLLECTION;
    }

    const variables = {
      title: data.title,
      data: data.data,
      parentUserCollectionID: data.parentCollectionID,
    };

    const result = await this.client.graphql<{
      createRESTRootUserCollection?: RawUserCollection;
      createGQLRootUserCollection?: RawUserCollection;
      createRESTChildUserCollection?: RawUserCollection;
      createGQLChildUserCollection?: RawUserCollection;
    }>(mutation, variables);

    const raw =
      result.createRESTRootUserCollection ||
      result.createGQLRootUserCollection ||
      result.createRESTChildUserCollection ||
      result.createGQLChildUserCollection;

    if (!raw) {
      throw new Error('Failed to create user collection');
    }

    return this.normalizeUserCollection(raw);
  }

  /**
   * Update a user collection's title and/or data.
   * Both Cloud and Self-Hosted.
   * Arg name: userCollectionID (not collectionID); reqType required on Cloud.
   */
  async updateUserCollection(
    collectionId: string,
    type: CollectionType,
    data: UpdateCollectionInput
  ): Promise<UserCollection> {
    const mutation = this.isCloud()
      ? mutations.UPDATE_USER_COLLECTION_CLOUD
      : mutations.UPDATE_USER_COLLECTION_SH;

    const variables = this.isCloud()
      ? { userCollectionID: collectionId, newTitle: data.title, data: data.data, reqType: type }
      : { userCollectionID: collectionId, newTitle: data.title, data: data.data };

    const result = await this.client.graphql<{
      updateUserCollection: RawUserCollection;
    }>(mutation, variables);

    return this.normalizeUserCollection(result.updateUserCollection);
  }

  /**
   * Delete a user collection.
   * Both Cloud and Self-Hosted.
   * Args: userCollectionID + reqType (required on Cloud).
   */
  async deleteUserCollection(collectionId: string, type: CollectionType): Promise<boolean> {
    const mutation = this.isCloud()
      ? mutations.DELETE_USER_COLLECTION_CLOUD
      : mutations.DELETE_USER_COLLECTION_SH;

    const variables = this.isCloud()
      ? { userCollectionID: collectionId, reqType: type }
      : { userCollectionID: collectionId };

    await this.client.graphql(mutation, variables);

    return true;
  }

  /**
   * Export user collections to JSON.
   * Self-Hosted only.
   */
  async exportUserCollection(type: CollectionType, collectionId?: string): Promise<string> {
    this.assertNotCloud('export_user_collection');

    const query = collectionId
      ? queries.EXPORT_USER_COLLECTION_JSON
      : queries.EXPORT_USER_COLLECTIONS_JSON;

    const variables = collectionId
      ? { collectionID: collectionId }
      : { collectionType: type };

    const result = await this.client.graphql<{
      exportUserCollectionsToJSON?: { exportedCollection: string; collectionType: string };
      exportUserCollectionToJSON?: string;
    }>(query, variables);

    // exportUserCollectionsToJSON returns an object; exportUserCollectionToJSON returns a scalar
    const exportData =
      result.exportUserCollectionsToJSON?.exportedCollection || result.exportUserCollectionToJSON;

    if (!exportData) {
      throw new Error('Failed to export collection');
    }

    return exportData;
  }

  /**
   * Import user collections from a JSON string.
   * Both Cloud and Self-Hosted.
   */
  async importUserCollections(
    type: CollectionType,
    jsonString: string,
    parentCollectionId?: string
  ): Promise<void> {
    // Normalize: wrap a single object into an array if needed
    let normalizedJson = jsonString;
    try {
      const parsed = JSON.parse(jsonString);
      if (!Array.isArray(parsed)) {
        normalizedJson = JSON.stringify([parsed]);
      }
    } catch {
      // Pass as-is — server will return invalid_json error
    }

    await this.client.graphql(mutations.IMPORT_USER_COLLECTIONS_JSON, {
      jsonString: normalizedJson,
      reqType: type,
      parentCollectionID: parentCollectionId,
    });
  }

  /**
   * Duplicate a user collection.
   * Both Cloud and Self-Hosted.
   * collectionID is String (not ID!) and reqType is required.
   */
  async duplicateUserCollection(collectionId: string, type: CollectionType): Promise<void> {
    await this.client.graphql(mutations.DUPLICATE_USER_COLLECTION, {
      collectionID: collectionId,
      reqType: type,
    });
  }

  /**
   * Move a user collection to a new parent (pass null/undefined to move to root).
   * Both Cloud and Self-Hosted.
   * Args: userCollectionID + destCollectionID.
   */
  async moveUserCollection(collectionId: string, newParentId?: string): Promise<UserCollection> {
    const result = await this.client.graphql<{
      moveUserCollection: RawUserCollection;
    }>(mutations.MOVE_USER_COLLECTION, {
      userCollectionID: collectionId,
      destCollectionID: newParentId ?? null,
    });

    return this.normalizeUserCollection(result.moveUserCollection);
  }

  // ─── Team Collections ─────────────────────────────────────────────────────

  /**
   * List root team collections.
   * Both Cloud and Self-Hosted.
   */
  async getTeamCollections(teamId: string, options?: PaginationOptions): Promise<TeamCollection[]> {
    const result = await this.client.graphql<{
      rootCollectionsOfTeam: RawTeamCollection[];
    }>(queries.GET_TEAM_COLLECTIONS, {
      teamID: teamId,
      cursor: options?.cursor,
    });

    return (result.rootCollectionsOfTeam || []).map((c) => this.normalizeTeamCollection(c));
  }

  /**
   * Get a specific team collection by ID.
   * Both: collection(collectionID: ID!) GQL query.
   */
  async getTeamCollection(collectionId: string): Promise<TeamCollection> {
    const result = await this.client.graphql<{
      collection: RawTeamCollection;
    }>(queries.GET_TEAM_COLLECTION, { collectionID: collectionId });

    return this.normalizeTeamCollection(result.collection);
  }

  /**
   * Create a team collection (root or nested).
   * Both Cloud and Self-Hosted.
   */
  async createTeamCollection(teamId: string, data: CreateCollectionInput): Promise<TeamCollection> {
    const mutation = data.parentCollectionID
      ? mutations.CREATE_CHILD_TEAM_COLLECTION
      : mutations.CREATE_ROOT_TEAM_COLLECTION;

    const variables = data.parentCollectionID
      ? { collectionID: data.parentCollectionID, title: data.title, data: data.data }
      : { teamID: teamId, title: data.title, data: data.data };

    const result = await this.client.graphql<{
      createRootCollection?: RawTeamCollection;
      createChildCollection?: RawTeamCollection;
    }>(mutation, variables);

    const raw = result.createRootCollection || result.createChildCollection;

    if (!raw) {
      throw new Error('Failed to create team collection');
    }

    return this.normalizeTeamCollection(raw);
  }

  /**
   * Update a team collection.
   * Both Cloud and Self-Hosted.
   */
  async updateTeamCollection(
    collectionId: string,
    data: UpdateCollectionInput
  ): Promise<TeamCollection> {
    const result = await this.client.graphql<{
      updateTeamCollection: TeamCollection;
    }>(mutations.UPDATE_TEAM_COLLECTION, {
      collectionID: collectionId,
      newTitle: data.title,
      data: data.data,
    });

    return result.updateTeamCollection;
  }

  /**
   * Delete a team collection.
   * Both Cloud and Self-Hosted.
   * Field: deleteCollection(collectionID)
   */
  async deleteTeamCollection(collectionId: string): Promise<boolean> {
    await this.client.graphql(mutations.DELETE_TEAM_COLLECTION, {
      collectionID: collectionId,
    });

    return true;
  }

  /**
   * Export team collections to JSON.
   * Both Cloud and Self-Hosted.
   */
  async exportTeamCollection(teamId: string, collectionId?: string): Promise<string> {
    const query = collectionId
      ? queries.EXPORT_TEAM_COLLECTION_JSON
      : queries.EXPORT_TEAM_COLLECTIONS_JSON;

    const variables = { teamID: teamId, collectionID: collectionId };

    const result = await this.client.graphql<{
      exportCollectionsToJSON?: string;
      exportCollectionToJSON?: string;
    }>(query, variables);

    const exportData = result.exportCollectionsToJSON || result.exportCollectionToJSON;

    if (!exportData) {
      throw new Error('Failed to export team collection');
    }

    return exportData;
  }

  /**
   * Import team collections from JSON.
   * Both Cloud and Self-Hosted.
   * The backend expects a JSON array of collection objects.
   * If a single object is passed, it is wrapped in an array automatically.
   */
  async importTeamCollections(
    teamId: string,
    jsonString: string,
    parentCollectionId?: string
  ): Promise<void> {
    // Normalize: wrap a single object into an array if needed
    let normalizedJson = jsonString;
    try {
      const parsed = JSON.parse(jsonString);
      if (!Array.isArray(parsed)) {
        normalizedJson = JSON.stringify([parsed]);
      }
    } catch {
      // Pass as-is — server will return invalid_json error
    }

    await this.client.graphql(mutations.IMPORT_TEAM_COLLECTIONS_JSON, {
      teamID: teamId,
      jsonString: normalizedJson,
      parentCollectionID: parentCollectionId,
    });
  }

  /**
   * Duplicate a team collection.
   * Both Cloud and Self-Hosted.
   * collectionID is String (not ID!).
   */
  async duplicateTeamCollection(collectionId: string): Promise<boolean> {
    await this.client.graphql<{
      duplicateTeamCollection: boolean;
    }>(mutations.DUPLICATE_TEAM_COLLECTION, {
      collectionID: collectionId,
    });

    return true;
  }

  /**
   * Move a team collection.
   * Both Cloud and Self-Hosted.
   * Field: moveCollection(collectionID, parentCollectionID)
   */
  async moveTeamCollection(collectionId: string, newParentId?: string): Promise<TeamCollection> {
    const result = await this.client.graphql<{
      moveCollection: RawTeamCollection;
    }>(mutations.MOVE_TEAM_COLLECTION, {
      collectionID: collectionId,
      parentCollectionID: newParentId ?? null,
    });

    return this.normalizeTeamCollection(result.moveCollection);
  }

}
