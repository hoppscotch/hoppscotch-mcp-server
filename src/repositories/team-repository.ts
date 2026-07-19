import type { HoppscotchClient } from '../client.js';
import type { Team, TeamInvitation, TeamMember, TeamMemberRole } from '../types.js';
import * as queries from '../graphql/queries.js';
import * as mutations from '../graphql/mutations.js';

/**
 * Repository for managing teams
 */
export class TeamRepository {
  constructor(private client: HoppscotchClient) {}

  /**
   * List all teams user has access to
   */
  async listTeams(): Promise<Team[]> {
    const result = await this.client.graphql<{
      myTeams: Team[];
    }>(queries.LIST_TEAMS);

    return result.myTeams || [];
  }

  /**
   * Get specific team information
   */
  async getTeam(teamId: string): Promise<Team> {
    const result = await this.client.graphql<{
      team: Team;
    }>(queries.GET_TEAM, {
      teamID: teamId,
    });

    return result.team;
  }

  /**
   * Create a new team
   */
  async createTeam(name: string): Promise<Team> {
    const result = await this.client.graphql<{
      createTeam: Team;
    }>(mutations.CREATE_TEAM, { name });

    return result.createTeam;
  }

  /**
   * Rename a team
   */
  async renameTeam(teamId: string, newName: string): Promise<Team> {
    const result = await this.client.graphql<{
      renameTeam: Team;
    }>(mutations.RENAME_TEAM, { teamID: teamId, newName });

    return result.renameTeam;
  }

  /**
   * Delete a team
   */
  async deleteTeam(teamId: string): Promise<boolean> {
    await this.client.graphql<{
      deleteTeam: boolean;
    }>(mutations.DELETE_TEAM, { teamID: teamId });

    return true;
  }

  /**
   * Client-side defense-in-depth guard: refuse an operation that would strip a
   * team of its last OWNER (orphaning it). The backend is authoritative — it
   * rejects with `team/only_one_owner` — so this is best-effort and
   * non-authoritative: it surfaces a clear error earlier (esp. for remove/demote,
   * which have no obvious client-visible backend error here), and a concurrent
   * change between this read and the mutation is still caught by the backend. If
   * the team can't be read or its membership is unknown, the guard defers to the
   * backend rather than blocking.
   */
  private async assertWontOrphanTeam(
    teamId: string,
    intent:
      | { kind: 'leave' }
      | { kind: 'remove'; userUid: string }
      | { kind: 'demote'; userUid: string }
  ): Promise<void> {
    let team: Team;
    try {
      team = await this.getTeam(teamId);
    } catch {
      return; // can't verify ownership → let the backend enforce
    }
    const owners = (team?.teamMembers ?? []).filter((m) => m.role === 'OWNER');
    if (owners.length !== 1) return; // 0 (unknown) or >1 owners → not a last-owner case
    const soleOwnerUid = owners[0]?.user.uid;
    const wouldOrphan =
      (intent.kind === 'leave' && team.myRole === 'OWNER') ||
      (intent.kind === 'remove' && intent.userUid === soleOwnerUid) ||
      (intent.kind === 'demote' && intent.userUid === soleOwnerUid);
    if (wouldOrphan) {
      throw new Error(
        "This would remove the team's only OWNER, leaving it with no owner. " +
          'Promote another member to OWNER first.'
      );
    }
  }

  /**
   * Leave a team (current user removes themselves)
   */
  async leaveTeam(teamId: string): Promise<boolean> {
    await this.assertWontOrphanTeam(teamId, { kind: 'leave' });
    await this.client.graphql<{
      leaveTeam: boolean;
    }>(mutations.LEAVE_TEAM, { teamID: teamId });

    return true;
  }

  /**
   * Invite a member to a team
   */
  async inviteTeamMember(
    teamId: string,
    email: string,
    role: TeamMemberRole
  ): Promise<TeamInvitation> {
    const result = await this.client.graphql<{
      createTeamInvitation: TeamInvitation;
    }>(mutations.CREATE_TEAM_INVITATION, {
      teamID: teamId,
      inviteeEmail: email,
      inviteeRole: role,
    });

    return result.createTeamInvitation;
  }

  /**
   * Revoke a pending team invitation
   */
  async revokeTeamInvitation(inviteId: string): Promise<boolean> {
    await this.client.graphql<{
      revokeTeamInvitation: boolean;
    }>(mutations.REVOKE_TEAM_INVITATION, { inviteID: inviteId });

    return true;
  }

  /**
   * Remove a member from a team
   */
  async removeTeamMember(teamId: string, userUid: string): Promise<boolean> {
    await this.assertWontOrphanTeam(teamId, { kind: 'remove', userUid });
    await this.client.graphql<{
      removeTeamMember: boolean;
    }>(mutations.REMOVE_TEAM_MEMBER, { teamID: teamId, userUid });

    return true;
  }

  /**
   * Update a team member's role
   */
  async updateTeamMemberRole(
    teamId: string,
    userUid: string,
    newRole: TeamMemberRole
  ): Promise<TeamMember> {
    // Demoting the sole OWNER would orphan the team; promoting TO owner is fine.
    if (newRole !== 'OWNER') {
      await this.assertWontOrphanTeam(teamId, { kind: 'demote', userUid });
    }
    const result = await this.client.graphql<{
      updateTeamMemberRole: TeamMember;
    }>(mutations.UPDATE_TEAM_MEMBER_ROLE, {
      teamID: teamId,
      userUid,
      newRole,
    });

    return result.updateTeamMemberRole;
  }
}
