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

/** Raw GQL TeamCollection shape: parent is a nested object, not a scalar parentID. */
interface RawTeamCollection {
  id: string;
  title: string;
  data?: string | null;
  parent?: { id: string } | null;
  parentID?: string | null; // defensive: no current selection returns this scalar
  teamID?: string;
  children?: Array<{ id: string; title: string }>;
}

/** Raw GQL UserCollection shape: SH returns parent { id }, not a parentID scalar. */
interface RawUserCollection {
  id: string;
  title: string;
  data?: string | null;
  parent?: { id: string } | null;
}

/**
 * Repository for managing collections (user and team).
 *
 * Everything here works on both backends. User collection writes branch on
 * isCloud(), which takes a different mutation shape, not a different capability.
 */
export class CollectionRepository {
  constructor(private client: HoppscotchClient) {}

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private assertNotCloud(operation: string): void {
    if (this.isCloud()) {
      throw new Error(
        `"${operation}" does not work on Hoppscotch Cloud as of now: the backend ` +
          "fails to serialize the collection's `data` field, which errors the whole " +
          'query. This is server-side, so the tool is expected to start working ' +
          'without an update here. Use "list_user_collections" meanwhile, which ' +
          'returns the same collections on Cloud.'
      );
    }
  }

  private isCloud(): boolean {
    return this.client.getConfig().apiType === ApiType.CLOUD;
  }

  /**
   * Normalize a raw GQL TeamCollection response into our internal shape.
   * Maps parent?.id → parentID; omits parentID/teamID the response can't tell us.
   */
  private normalizeTeamCollection(raw: RawTeamCollection, teamID?: string): TeamCollection {
    const out: TeamCollection = {
      id: raw.id,
      title: raw.title,
      data: raw.data ?? null,
      children: raw.children,
    };

    // Distinguish "selected and null" (a root) from "not selected" (unknown).
    if (raw.parentID !== undefined) out.parentID = raw.parentID;
    else if ('parent' in raw) out.parentID = raw.parent?.id ?? null;

    // Nothing selects teamID; it is known only when the caller passed it in.
    const known = raw.teamID ?? teamID;
    if (known !== undefined) out.teamID = known;

    return out;
  }

  /**
   * Normalize a raw GQL UserCollection response into our internal shape.
   *
   * `parentID` comes from the caller, not `raw`: most responses omit `parent`,
   * and absence is not null. Pass null only for a known root.
   */
  private normalizeUserCollection(
    raw: RawUserCollection,
    parentID: string | null | undefined
  ): UserCollection {
    const out: UserCollection = {
      id: raw.id,
      title: raw.title,
      data: raw.data ?? null,
    };
    if (parentID !== undefined) out.parentID = parentID;
    return out;
  }

  // ─── User Collections ─────────────────────────────────────────────────────

  /**
   * List root user collections (REST or GQL type).
   */
  async getUserCollections(
    type: CollectionType,
    options?: PaginationOptions
  ): Promise<UserCollection[]> {
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

    // Root queries: these rows are roots by contract.
    return raw.map((c) => this.normalizeUserCollection(c, null));
  }

  /**
   * Get a specific user collection by ID.
   * Self-hosted only. Cloud's userCollection resolver fails to serialize `data`
   * ("String cannot represent value"), though rootRESTUserCollections returns
   * the same field fine, so the whole query errors. Verified 2026-08-26.
   */
  async getUserCollection(collectionId: string): Promise<UserCollection> {
    this.assertNotCloud('get_user_collection');

    const result = await this.client.graphql<{
      userCollection: RawUserCollection;
    }>(queries.GET_USER_COLLECTION, { collectionID: collectionId });

    // SH-only path; this query does select `parent`.
    return this.normalizeUserCollection(
      result.userCollection,
      result.userCollection.parent?.id ?? null
    );
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

    // The mutation omits `parent`, but we chose the destination ourselves.
    return this.normalizeUserCollection(raw, data.parentCollectionID ?? null);
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

    // Update neither changes nor returns the parent: leave it unknown.
    return this.normalizeUserCollection(result.updateUserCollection, undefined);
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
   */
  async exportUserCollection(type: CollectionType, collectionId?: string): Promise<string> {
    // Absence, not falsiness, selects the export-everything query: the schema
    // rejects "", so anything that arrives here is a real ID.
    const one = collectionId !== undefined;

    const query = one ? queries.EXPORT_USER_COLLECTION_JSON : queries.EXPORT_USER_COLLECTIONS_JSON;

    const variables = one ? { collectionID: collectionId } : { collectionType: type };

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
      // Pass as-is; the server will return an invalid_json error
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

    // We chose the destination, so the new parent is known.
    return this.normalizeUserCollection(result.moveUserCollection, newParentId ?? null);
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

    return (result.rootCollectionsOfTeam || []).map((c) => this.normalizeTeamCollection(c, teamId));
  }

  /**
   * Get a specific team collection by ID.
   * Both: collection(collectionID: ID!) GQL query.
   */
  async getTeamCollection(collectionId: string): Promise<TeamCollection> {
    const result = await this.client.graphql<{
      collection: RawTeamCollection;
    }>(queries.GET_TEAM_COLLECTION, { collectionID: collectionId });

    // Takes only a collection ID, so the owning team stays unknown.
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

    // Root creation sends teamID, so it is authoritative. Child creation sends
    // only the parent, which is what determines ownership: stamping the caller's
    // teamId here would claim a team the backend never confirmed.
    return this.normalizeTeamCollection(raw, data.parentCollectionID ? undefined : teamId);
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
      updateTeamCollection: RawTeamCollection;
    }>(mutations.UPDATE_TEAM_COLLECTION, {
      collectionID: collectionId,
      newTitle: data.title,
      data: data.data,
    });

    // Selects neither parent nor team, and update changes neither.
    return this.normalizeTeamCollection(result.updateTeamCollection);
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
    const query =
      collectionId !== undefined
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
      // Pass as-is; the server will return an invalid_json error
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
