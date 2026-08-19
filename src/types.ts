/**
 * Type definitions for Hoppscotch data models
 */

/**
 * Collection types
 */
export enum CollectionType {
  REST = 'REST',
  GQL = 'GQL',
}

/**
 * User collection structure
 */
export interface UserCollection {
  id: string;
  title: string;
  parentID: string | null;
  data: string | null; // JSON-stringified request data
}

/**
 * Team collection structure
 */
export interface TeamCollectionChild {
  id: string;
  title: string;
}

export interface TeamCollection {
  id: string;
  title: string;
  parentID: string | null;
  data: string | null; // JSON-stringified request data
  teamID: string;
  children?: TeamCollectionChild[];
}

/**
 * Team request within a collection (GQL shape)
 */
export interface TeamRequest {
  id: string;
  title: string;
  request: string; // JSON-stringified request data (opaque)
  collectionID: string;
  teamID: string;
}

/**
 * Shape returned by searchForRequest GQL — request id+title plus parent collection
 * id+title. Distinct from TeamRequest because the search field does not return the
 * opaque `request` body.
 */
export interface TeamRequestSearchResult {
  id: string;
  title: string;
  collection: {
    id: string;
    title: string;
  };
}

/**
 * User (personal) request within a collection (GQL shape — reads gated on Cloud as of now)
 */
export interface UserRequest {
  id: string;
  title: string;
  request: string; // JSON-stringified request data (opaque)
  collectionID: string;
  type: 'REST' | 'GQL';
}

/**
 * Input for creating a request
 */
export interface CreateRequestInput {
  title: string;
  request: string; // JSON-stringified request data
}

/**
 * Input for updating a request
 */
export interface UpdateRequestInput {
  title?: string;
  request?: string;
}

/**
 * Environment variable
 */
export interface EnvironmentVariable {
  key: string;
  value: string;
  secret?: boolean;
}

/**
 * User environment structure
 */
export interface UserEnvironment {
  id: string;
  name: string;
  variables: string; // JSON-stringified array of EnvironmentVariable
}

/**
 * Team environment structure
 */
export interface TeamEnvironment {
  id: string;
  name: string;
  variables: string; // JSON-stringified array of EnvironmentVariable
  teamID: string;
}

/**
 * Input for creating a collection
 */
export interface CreateCollectionInput {
  title: string;
  parentCollectionID?: string;
  data?: string;
}

/**
 * Input for updating a collection
 */
export interface UpdateCollectionInput {
  title?: string;
  data?: string;
}

/**
 * Input for creating an environment
 */
export interface CreateEnvironmentInput {
  name: string;
  variables: EnvironmentVariable[];
}

/**
 * Input for updating an environment
 */
export interface UpdateEnvironmentInput {
  name?: string;
  variables?: EnvironmentVariable[];
}

/**
 * Pagination cursor
 */
export interface PaginationOptions {
  cursor?: string;
  limit?: number;
}

/**
 * Team member role — matches GQL enum TeamMemberRole.
 */
export type TeamMemberRole = 'OWNER' | 'EDITOR' | 'VIEWER';

/**
 * Team information
 */
export interface Team {
  id: string;
  name: string;
  myRole: TeamMemberRole;
  /**
   * Populated by GET_TEAM (team detail); absent on list results. Used by the
   * client-side last-owner guard in TeamRepository.
   */
  teamMembers?: TeamMember[];
}

/**
 * Team invitation
 */
export interface TeamInvitation {
  id: string;
  teamID: string;
  inviteeEmail: string;
  inviteeRole: TeamMemberRole;
}

/**
 * Team member
 */
export interface TeamMember {
  membershipID: string;
  role: TeamMemberRole;
  user: {
    uid: string;
    displayName: string;
    email: string;
  };
}

/**
 * MCP Tool error
 */
export class HoppscotchError extends Error {
  constructor(
    message: string,
    public code?: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'HoppscotchError';
  }
}
