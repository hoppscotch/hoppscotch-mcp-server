/**
 * GraphQL queries for Hoppscotch API
 *
 * Field-name reference (verified against live schemas):
 *   Cloud  — https://api.hoppscotch.io/graphql  (introspected 2025-03)
 *   SH OSS — packages/hoppscotch-backend/src/user-collection/user-collection.resolver.ts
 *
 * Key divergences
 * ───────────────
 * • rootRESTUserCollections / rootGQLUserCollections — present on SH, absent on Cloud.
 *   Cloud has NO query for listing user (personal) collections.
 * • userCollection(userCollectionID) — SH only.
 * • exportUserCollectionsToJSON / exportUserCollectionToJSON — SH only.
 * • Team queries (rootCollectionsOfTeam, collection, exportCollectionsToJSON,
 *   exportCollectionToJSON) — present on BOTH.
 * • me.environments — resolveField on SH; Cloud has no user-environment GQL.
 */

// ─── User Collections (SH only) ─────────────────────────────────────────────

/**
 * Get root REST user collections.
 * SH field: rootRESTUserCollections(cursor, take)
 * Cloud:    NOT available — Cloud has no personal-collection read query.
 */
export const GET_USER_REST_COLLECTIONS = `
  query GetUserRESTCollections($cursor: ID, $take: Int) {
    rootRESTUserCollections(cursor: $cursor, take: $take) {
      id
      title
      parent {
        id
      }
      data
    }
  }
`;

/**
 * Get root GraphQL user collections.
 * SH field: rootGQLUserCollections(cursor, take)
 * Cloud:    NOT available.
 */
export const GET_USER_GQL_COLLECTIONS = `
  query GetUserGQLCollections($cursor: ID, $take: Int) {
    rootGQLUserCollections(cursor: $cursor, take: $take) {
      id
      title
      parent {
        id
      }
      data
    }
  }
`;

/**
 * Get a specific user collection by ID.
 * SH field: userCollection(userCollectionID: ID!)
 * Cloud:    NOT available.
 */
export const GET_USER_COLLECTION = `
  query GetUserCollection($collectionID: ID!) {
    userCollection(userCollectionID: $collectionID) {
      id
      title
      parent {
        id
      }
      data
    }
  }
`;

/**
 * Export all user collections of a given type to JSON.
 * SH field: exportUserCollectionsToJSON(collectionID: ID, collectionType: ReqType!)
 * Cloud:    NOT available.
 */
export const EXPORT_USER_COLLECTIONS_JSON = `
  query ExportUserCollectionsJSON($collectionType: ReqType!) {
    exportUserCollectionsToJSON(collectionType: $collectionType) {
      exportedCollection
      collectionType
    }
  }
`;

/**
 * Export a specific user collection to JSON.
 * SH field: exportUserCollectionToJSON(collectionID: ID!)
 * Cloud:    NOT available.
 */
export const EXPORT_USER_COLLECTION_JSON = `
  query ExportUserCollectionJSON($collectionID: ID!) {
    exportUserCollectionToJSON(collectionID: $collectionID)
  }
`;

// ─── User Environments (SH only, via me resolver-field) ─────────────────────

/**
 * List all personal environments for the authenticated user.
 * SH: resolved via me { environments { ... } }
 * Cloud: NOT available — no user-environment GQL field.
 */
export const GET_USER_ENVIRONMENTS = `
  query GetUserEnvironments {
    me {
      environments {
        id
        name
        variables
        isGlobal
      }
    }
  }
`;

// ─── Team Collections (Cloud + SH) ──────────────────────────────────────────

/**
 * Get root collections for a team.
 * Both: rootCollectionsOfTeam(teamID: ID!, cursor: ID)
 */
export const GET_TEAM_COLLECTIONS = `
  query GetTeamCollections($teamID: ID!, $cursor: ID) {
    rootCollectionsOfTeam(teamID: $teamID, cursor: $cursor) {
      id
      title
      data
      parent {
        id
      }
    }
  }
`;

/**
 * Get a specific team collection by ID.
 * Both: collection(collectionID: ID!)
 *
 * TeamCollection has no parentID scalar — parent is a nested object.
 */
export const GET_TEAM_COLLECTION = `
  query GetTeamCollection($collectionID: ID!) {
    collection(collectionID: $collectionID) {
      id
      title
      data
      parent {
        id
      }
      children {
        id
        title
      }
    }
  }
`;

/**
 * Export all team collections to JSON.
 * Both: exportCollectionsToJSON(teamID: ID!)
 */
export const EXPORT_TEAM_COLLECTIONS_JSON = `
  query ExportTeamCollectionsJSON($teamID: ID!) {
    exportCollectionsToJSON(teamID: $teamID)
  }
`;

/**
 * Export a specific team collection to JSON.
 * Both: exportCollectionToJSON(teamID: ID!, collectionID: ID!)
 */
export const EXPORT_TEAM_COLLECTION_JSON = `
  query ExportTeamCollectionJSON($teamID: ID!, $collectionID: ID!) {
    exportCollectionToJSON(teamID: $teamID, collectionID: $collectionID)
  }
`;

// ─── Search (Cloud + SH) ────────────────────────────────────────────────────

/**
 * Search team requests by title.
 * Cloud: searchForRequest(teamID, searchTerm, cursor)
 * SH:    same field name.
 * Returns request rows (with their parent collection metadata), NOT collections.
 */
export const SEARCH_TEAM_REQUESTS = `
  query SearchTeamRequests($teamID: ID!, $searchQuery: String!) {
    searchForRequest(teamID: $teamID, searchTerm: $searchQuery) {
      id
      title
      collection {
        id
        title
      }
    }
  }
`;

// ─── Team Requests (Cloud + SH) ─────────────────────────────────────────────

/**
 * List requests in a team collection (paginated).
 * Both: requestsInCollection(collectionID, cursor)
 */
export const GET_TEAM_REQUESTS = `
  query GetTeamRequests($collectionID: ID!, $cursor: ID) {
    requestsInCollection(collectionID: $collectionID, cursor: $cursor) {
      id
      title
      request
      collectionID
      teamID
    }
  }
`;

/**
 * Get a single team request by ID.
 * Both: request(requestID)
 */
export const GET_TEAM_REQUEST = `
  query GetTeamRequest($requestID: ID!) {
    request(requestID: $requestID) {
      id
      title
      request
      collectionID
      teamID
    }
  }
`;

// ─── User Requests (SH only — user request read queries not available on Cloud) ──

/**
 * List requests in a user collection.
 * SH only: userCollection(userCollectionID: ID!) { requests { ... } }
 * Note: arg is userCollectionID (not collectionID) — same as GET_USER_COLLECTION.
 * Cloud UserCollection has no requests field.
 */
export const GET_USER_REQUESTS = `
  query GetUserRequests($userCollectionID: ID!) {
    userCollection(userCollectionID: $userCollectionID) {
      requests {
        id
        title
        request
        collectionID
        type
      }
    }
  }
`;

// ─── Team Environments (Cloud + SH, via team resolver-field) ────────────────

/**
 * List all environments for a team.
 * Both: team(teamID) { teamEnvironments { ... } }
 * (No standalone teamEnvironment(id) query exists — use this and filter by ID.)
 */
export const GET_TEAM_ENVIRONMENTS = `
  query GetTeamEnvironments($teamID: ID!) {
    team(teamID: $teamID) {
      teamEnvironments {
        id
        teamID
        name
        variables
      }
    }
  }
`;

// ─── Teams (Cloud + SH) ─────────────────────────────────────────────────────

/**
 * List all teams the authenticated user belongs to.
 * Both: myTeams
 */
export const LIST_TEAMS = `
  query ListTeams {
    myTeams {
      id
      name
      myRole
      teamMembers {
        membershipID
        role
        user {
          uid
          displayName
          email
        }
      }
    }
  }
`;

/**
 * Get a specific team by ID.
 * Both: team(teamID: ID!)
 */
export const GET_TEAM = `
  query GetTeam($teamID: ID!) {
    team(teamID: $teamID) {
      id
      name
      myRole
      teamMembers {
        membershipID
        role
        user {
          uid
          displayName
          email
        }
      }
    }
  }
`;
