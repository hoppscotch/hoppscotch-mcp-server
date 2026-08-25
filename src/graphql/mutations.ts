/**
 * GraphQL mutations for Hoppscotch API
 *
 * Arg names verified against:
 *   Cloud:  live schema introspection (api.hoppscotch.io/graphql)
 *   SH OSS: packages/hoppscotch-backend/src/user-collection/input-type.args.ts
 *
 * IMPORTANT: TeamCollection and UserCollection schema facts (verified live):
 *   • Cloud TeamCollection fields: id, title, data, parent { id }, team { ... }, children
 *     No parentID scalar; parent is a nested object.
 *   • Cloud UserCollection fields: id, title, data
 *     No parentID scalar and no parent field at all.
 *   • Repositories normalize parent?.id → parentID after every GQL response.
 */

// ─── User Collections (Cloud + SH) ──────────────────────────────────────────

export const CREATE_REST_ROOT_USER_COLLECTION = `
  mutation CreateRESTRootUserCollection($title: String!, $data: String) {
    createRESTRootUserCollection(title: $title, data: $data) {
      id
      title
      data
    }
  }
`;

export const CREATE_GQL_ROOT_USER_COLLECTION = `
  mutation CreateGQLRootUserCollection($title: String!, $data: String) {
    createGQLRootUserCollection(title: $title, data: $data) {
      id
      title
      data
    }
  }
`;

export const CREATE_REST_CHILD_USER_COLLECTION = `
  mutation CreateRESTChildUserCollection($title: String!, $parentUserCollectionID: ID!, $data: String) {
    createRESTChildUserCollection(title: $title, parentUserCollectionID: $parentUserCollectionID, data: $data) {
      id
      title
      data
    }
  }
`;

export const CREATE_GQL_CHILD_USER_COLLECTION = `
  mutation CreateGQLChildUserCollection($title: String!, $parentUserCollectionID: ID!, $data: String) {
    createGQLChildUserCollection(title: $title, parentUserCollectionID: $parentUserCollectionID, data: $data) {
      id
      title
      data
    }
  }
`;

/**
 * Update user collection title/data, Cloud variant.
 * Cloud requires reqType: ReqType! as an additional argument.
 */
export const UPDATE_USER_COLLECTION_CLOUD = `
  mutation UpdateUserCollection($userCollectionID: ID!, $newTitle: String, $data: String, $reqType: ReqType!) {
    updateUserCollection(userCollectionID: $userCollectionID, newTitle: $newTitle, data: $data, reqType: $reqType) {
      id
      title
      data
    }
  }
`;

/**
 * Update user collection title/data, SH variant.
 * SH does not have reqType on updateUserCollection.
 */
export const UPDATE_USER_COLLECTION_SH = `
  mutation UpdateUserCollection($userCollectionID: ID!, $newTitle: String, $data: String) {
    updateUserCollection(userCollectionID: $userCollectionID, newTitle: $newTitle, data: $data) {
      id
      title
      data
    }
  }
`;

/**
 * Delete user collection, Cloud variant.
 * Cloud requires reqType: ReqType!.
 */
export const DELETE_USER_COLLECTION_CLOUD = `
  mutation DeleteUserCollection($userCollectionID: ID!, $reqType: ReqType!) {
    deleteUserCollection(userCollectionID: $userCollectionID, reqType: $reqType)
  }
`;

/**
 * Delete user collection, SH variant.
 * SH does not have reqType on deleteUserCollection.
 */
export const DELETE_USER_COLLECTION_SH = `
  mutation DeleteUserCollection($userCollectionID: ID!) {
    deleteUserCollection(userCollectionID: $userCollectionID)
  }
`;

/**
 * Move user collection to a new parent (or to root if destCollectionID is null).
 */
export const MOVE_USER_COLLECTION = `
  mutation MoveUserCollection($userCollectionID: ID!, $destCollectionID: ID) {
    moveUserCollection(userCollectionID: $userCollectionID, destCollectionID: $destCollectionID) {
      id
      title
      data
    }
  }
`;

/**
 * Import user collections from a JSON string.
 * Returns UserCollectionExportJSONData with exportedCollection and collectionType fields.
 */
export const IMPORT_USER_COLLECTIONS_JSON = `
  mutation ImportUserCollectionsJSON($jsonString: String!, $reqType: ReqType!, $parentCollectionID: ID) {
    importUserCollectionsFromJSON(
      jsonString: $jsonString
      reqType: $reqType
      parentCollectionID: $parentCollectionID
    ) {
      exportedCollection
      collectionType
    }
  }
`;

/**
 * Duplicate a user collection.
 * Args: collectionID (String, not ID!), reqType
 */
export const DUPLICATE_USER_COLLECTION = `
  mutation DuplicateUserCollection($collectionID: String!, $reqType: ReqType!) {
    duplicateUserCollection(collectionID: $collectionID, reqType: $reqType)
  }
`;

// ─── Team Collections (Cloud + SH) ──────────────────────────────────────────

/**
 * Create root team collection.
 * Both: createRootCollection(teamID, title, data)
 */
export const CREATE_ROOT_TEAM_COLLECTION = `
  mutation CreateRootTeamCollection($teamID: ID!, $title: String!, $data: String) {
    createRootCollection(teamID: $teamID, title: $title, data: $data) {
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
 * Create child team collection.
 * Both: createChildCollection(collectionID, childTitle, data)
 */
export const CREATE_CHILD_TEAM_COLLECTION = `
  mutation CreateChildTeamCollection($collectionID: ID!, $title: String!, $data: String) {
    createChildCollection(collectionID: $collectionID, childTitle: $title, data: $data) {
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
 * Update team collection title/data.
 * Both: updateTeamCollection(collectionID, newTitle, data)
 */
export const UPDATE_TEAM_COLLECTION = `
  mutation UpdateTeamCollection($collectionID: ID!, $newTitle: String, $data: String) {
    updateTeamCollection(collectionID: $collectionID, newTitle: $newTitle, data: $data) {
      id
      title
      data
    }
  }
`;

/**
 * Delete team collection.
 * Both: deleteCollection(collectionID)
 */
export const DELETE_TEAM_COLLECTION = `
  mutation DeleteTeamCollection($collectionID: ID!) {
    deleteCollection(collectionID: $collectionID)
  }
`;

/**
 * Move team collection.
 * Both: moveCollection(collectionID, parentCollectionID)
 */
export const MOVE_TEAM_COLLECTION = `
  mutation MoveTeamCollection($collectionID: ID!, $parentCollectionID: ID) {
    moveCollection(collectionID: $collectionID, parentCollectionID: $parentCollectionID) {
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
 * Import team collections from JSON.
 * Both: importCollectionsFromJSON(teamID, jsonString, parentCollectionID)
 */
export const IMPORT_TEAM_COLLECTIONS_JSON = `
  mutation ImportTeamCollectionsJSON($teamID: ID!, $jsonString: String!, $parentCollectionID: ID) {
    importCollectionsFromJSON(
      teamID: $teamID
      jsonString: $jsonString
      parentCollectionID: $parentCollectionID
    )
  }
`;

/**
 * Duplicate team collection.
 * Returns Boolean! (not an object), so no subfields.
 */
export const DUPLICATE_TEAM_COLLECTION = `
  mutation DuplicateTeamCollection($collectionID: String!) {
    duplicateTeamCollection(collectionID: $collectionID)
  }
`;

// ─── User Environments (Cloud + SH) ─────────────────────────────────────────

/**
 * Both: createUserEnvironment(name, variables)
 */
export const CREATE_USER_ENVIRONMENT = `
  mutation CreateUserEnvironment($name: String!, $variables: String!) {
    createUserEnvironment(name: $name, variables: $variables) {
      id
      name
      variables
      isGlobal
    }
  }
`;

/**
 * Both: updateUserEnvironment(id, name, variables)
 */
export const UPDATE_USER_ENVIRONMENT = `
  mutation UpdateUserEnvironment($id: ID!, $name: String!, $variables: String!) {
    updateUserEnvironment(id: $id, name: $name, variables: $variables) {
      id
      name
      variables
      isGlobal
    }
  }
`;

/**
 * Both: deleteUserEnvironment(id)
 */
export const DELETE_USER_ENVIRONMENT = `
  mutation DeleteUserEnvironment($id: ID!) {
    deleteUserEnvironment(id: $id)
  }
`;

// ─── Team Environments (Cloud + SH) ─────────────────────────────────────────

/**
 * Both: createTeamEnvironment(name, teamID, variables)
 */
export const CREATE_TEAM_ENVIRONMENT = `
  mutation CreateTeamEnvironment($teamID: ID!, $name: String!, $variables: String!) {
    createTeamEnvironment(teamID: $teamID, name: $name, variables: $variables) {
      id
      name
      variables
      teamID
    }
  }
`;

/**
 * Both: updateTeamEnvironment(id, name!, variables!)
 * name and variables are NON_NULL on Cloud.
 */
export const UPDATE_TEAM_ENVIRONMENT = `
  mutation UpdateTeamEnvironment($id: ID!, $name: String!, $variables: String!) {
    updateTeamEnvironment(id: $id, name: $name, variables: $variables) {
      id
      name
      variables
      teamID
    }
  }
`;

/**
 * Both: deleteTeamEnvironment(id)
 */
export const DELETE_TEAM_ENVIRONMENT = `
  mutation DeleteTeamEnvironment($id: ID!) {
    deleteTeamEnvironment(id: $id)
  }
`;

// ─── Team Requests (Cloud + SH) ─────────────────────────────────────────────

/**
 * Create a request in a team collection.
 * Both: createRequestInCollection(collectionID, data: CreateTeamRequestInput!)
 * CreateTeamRequestInput: { teamID, request, title }
 */
export const CREATE_TEAM_REQUEST = `
  mutation CreateTeamRequest($collectionID: ID!, $teamID: ID!, $title: String!, $request: String!) {
    createRequestInCollection(
      collectionID: $collectionID
      data: { teamID: $teamID, title: $title, request: $request }
    ) {
      id
      title
      request
      collectionID
      teamID
    }
  }
`;

/**
 * Update a team request's title and/or request data.
 * Both: updateRequest(requestID, data: UpdateTeamRequestInput!)
 */
export const UPDATE_TEAM_REQUEST = `
  mutation UpdateTeamRequest($requestID: ID!, $title: String!, $request: String!) {
    updateRequest(requestID: $requestID, data: { title: $title, request: $request }) {
      id
      title
      request
      collectionID
      teamID
    }
  }
`;

/**
 * Delete a team request.
 * Both: deleteRequest(requestID)
 */
export const DELETE_TEAM_REQUEST = `
  mutation DeleteTeamRequest($requestID: ID!) {
    deleteRequest(requestID: $requestID)
  }
`;

/**
 * Move a team request to a different collection.
 * Both: moveRequest(requestID, destCollID)
 */
export const MOVE_TEAM_REQUEST = `
  mutation MoveTeamRequest($requestID: ID!, $destCollID: ID!) {
    moveRequest(requestID: $requestID, destCollID: $destCollID) {
      id
      title
      request
      collectionID
      teamID
    }
  }
`;

// ─── User Requests (personal workspace, not supported on Cloud as of now) ──

/**
 * Create a REST user request.
 * Both: createRESTUserRequest(collectionID, title, request)
 */
export const CREATE_REST_USER_REQUEST = `
  mutation CreateRESTUserRequest($collectionID: ID!, $title: String!, $request: String!) {
    createRESTUserRequest(collectionID: $collectionID, title: $title, request: $request) {
      id
      title
      request
      collectionID
      type
    }
  }
`;

/**
 * Create a GQL user request.
 * Both: createGQLUserRequest(collectionID, title, request)
 */
export const CREATE_GQL_USER_REQUEST = `
  mutation CreateGQLUserRequest($collectionID: ID!, $title: String!, $request: String!) {
    createGQLUserRequest(collectionID: $collectionID, title: $title, request: $request) {
      id
      title
      request
      collectionID
      type
    }
  }
`;

/**
 * Update a REST user request.
 * Both: updateRESTUserRequest(id, title?, request?)
 */
export const UPDATE_REST_USER_REQUEST = `
  mutation UpdateRESTUserRequest($id: ID!, $title: String, $request: String) {
    updateRESTUserRequest(id: $id, title: $title, request: $request) {
      id
      title
      request
      collectionID
      type
    }
  }
`;

/**
 * Update a GQL user request.
 * Both: updateGQLUserRequest(id, title?, request?)
 */
export const UPDATE_GQL_USER_REQUEST = `
  mutation UpdateGQLUserRequest($id: ID!, $title: String, $request: String) {
    updateGQLUserRequest(id: $id, title: $title, request: $request) {
      id
      title
      request
      collectionID
      type
    }
  }
`;

/**
 * Delete a user request.
 * Both: deleteUserRequest(id)
 */
export const DELETE_USER_REQUEST = `
  mutation DeleteUserRequest($id: ID!) {
    deleteUserRequest(id: $id)
  }
`;

/**
 * Move a user request to a different collection.
 * Both: moveUserRequest(sourceCollectionID, requestID, destinationCollectionID, nextRequestID?)
 */
export const MOVE_USER_REQUEST = `
  mutation MoveUserRequest($sourceCollectionID: ID!, $requestID: ID!, $destinationCollectionID: ID!) {
    moveUserRequest(
      sourceCollectionID: $sourceCollectionID
      requestID: $requestID
      destinationCollectionID: $destinationCollectionID
    ) {
      id
      title
      request
      collectionID
      type
    }
  }
`;

// ─── Team Management (Cloud + SH) ─────────────────────────────────────────

/**
 * Create a new team.
 * Both: createTeam(name: String!)
 * Cloud also accepts orgID (optional).
 */
export const CREATE_TEAM = `
  mutation CreateTeam($name: String!) {
    createTeam(name: $name) {
      id
      name
      myRole
    }
  }
`;

/**
 * Rename a team.
 * Both: renameTeam(teamID: ID!, newName: String!)
 */
export const RENAME_TEAM = `
  mutation RenameTeam($teamID: ID!, $newName: String!) {
    renameTeam(teamID: $teamID, newName: $newName) {
      id
      name
      myRole
    }
  }
`;

/**
 * Delete a team.
 * Both: deleteTeam(teamID: ID!)
 */
export const DELETE_TEAM = `
  mutation DeleteTeam($teamID: ID!) {
    deleteTeam(teamID: $teamID)
  }
`;

/**
 * Leave a team (current user).
 * Both: leaveTeam(teamID: ID!)
 */
export const LEAVE_TEAM = `
  mutation LeaveTeam($teamID: ID!) {
    leaveTeam(teamID: $teamID)
  }
`;

/**
 * Invite a member to a team.
 * Both: createTeamInvitation(teamID, inviteeEmail, inviteeRole)
 * Cloud also accepts orgID (optional).
 */
export const CREATE_TEAM_INVITATION = `
  mutation CreateTeamInvitation($teamID: ID!, $inviteeEmail: String!, $inviteeRole: TeamMemberRole!) {
    createTeamInvitation(teamID: $teamID, inviteeEmail: $inviteeEmail, inviteeRole: $inviteeRole) {
      id
      teamID
      inviteeEmail
      inviteeRole
    }
  }
`;

/**
 * Revoke a pending team invitation.
 * Both: revokeTeamInvitation(inviteID: ID!)
 */
export const REVOKE_TEAM_INVITATION = `
  mutation RevokeTeamInvitation($inviteID: ID!) {
    revokeTeamInvitation(inviteID: $inviteID)
  }
`;

/**
 * Remove a member from a team.
 * Both: removeTeamMember(teamID, userUid)
 */
export const REMOVE_TEAM_MEMBER = `
  mutation RemoveTeamMember($teamID: ID!, $userUid: ID!) {
    removeTeamMember(teamID: $teamID, userUid: $userUid)
  }
`;

/**
 * Update a team member's role.
 * Both: updateTeamMemberRole(teamID, userUid, newRole)
 */
export const UPDATE_TEAM_MEMBER_ROLE = `
  mutation UpdateTeamMemberRole($teamID: ID!, $userUid: ID!, $newRole: TeamMemberRole!) {
    updateTeamMemberRole(teamID: $teamID, userUid: $userUid, newRole: $newRole) {
      membershipID
      role
      user {
        uid
        displayName
        email
      }
    }
  }
`;
