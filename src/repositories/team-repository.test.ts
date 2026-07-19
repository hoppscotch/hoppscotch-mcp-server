import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TeamRepository } from './team-repository';
import type { HoppscotchClient } from '../client';

describe('TeamRepository', () => {
  let repository: TeamRepository;
  let mockClient: HoppscotchClient;

  beforeEach(() => {
    mockClient = {
      graphql: vi.fn(),
    } as unknown as HoppscotchClient;
    repository = new TeamRepository(mockClient);
  });

  describe('listTeams', () => {
    it('should fetch all user teams', async () => {
      const mockTeams = [
        {
          id: 'team1',
          name: 'Engineering Team',
          myRole: 'OWNER',
          teamMembers: [
            {
              membershipID: 'member1',
              role: 'OWNER',
              user: {
                uid: 'user1',
                displayName: 'John Doe',
                email: 'john@example.com',
              },
            },
            {
              membershipID: 'member2',
              role: 'EDITOR',
              user: {
                uid: 'user2',
                displayName: 'Jane Smith',
                email: 'jane@example.com',
              },
            },
          ],
        },
        {
          id: 'team2',
          name: 'Product Team',
          myRole: 'EDITOR',
          teamMembers: [
            {
              membershipID: 'member3',
              role: 'OWNER',
              user: {
                uid: 'user3',
                displayName: 'Bob Johnson',
                email: 'bob@example.com',
              },
            },
          ],
        },
      ];

      vi.mocked(mockClient.graphql).mockResolvedValue({
        myTeams: mockTeams,
      });

      const result = await repository.listTeams();

      expect(result).toEqual(mockTeams);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Engineering Team');
      expect(result[0].myRole).toBe('OWNER');
      expect(result[0].teamMembers).toHaveLength(2);
      expect(mockClient.graphql).toHaveBeenCalledWith(expect.any(String));
    });

    it('should return empty array when user has no teams', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        myTeams: null,
      });

      const result = await repository.listTeams();

      expect(result).toEqual([]);
    });

    it('should handle teams with no members', async () => {
      const mockTeams = [
        {
          id: 'team1',
          name: 'Empty Team',
          myRole: 'OWNER',
          teamMembers: [],
        },
      ];

      vi.mocked(mockClient.graphql).mockResolvedValue({
        myTeams: mockTeams,
      });

      const result = await repository.listTeams();

      expect(result[0].teamMembers).toEqual([]);
    });

    it('should correctly parse different team roles', async () => {
      const mockTeams = [
        { id: 'team1', name: 'Team 1', myRole: 'OWNER', teamMembers: [] },
        { id: 'team2', name: 'Team 2', myRole: 'EDITOR', teamMembers: [] },
        { id: 'team3', name: 'Team 3', myRole: 'VIEWER', teamMembers: [] },
      ];

      vi.mocked(mockClient.graphql).mockResolvedValue({
        myTeams: mockTeams,
      });

      const result = await repository.listTeams();

      expect(result[0].myRole).toBe('OWNER');
      expect(result[1].myRole).toBe('EDITOR');
      expect(result[2].myRole).toBe('VIEWER');
    });
  });

  describe('getTeam', () => {
    it('should fetch single team by ID', async () => {
      const mockTeam = {
        id: 'team1',
        name: 'Engineering Team',
        myRole: 'OWNER',
        teamMembers: [
          {
            membershipID: 'member1',
            role: 'OWNER',
            user: {
              uid: 'user1',
              displayName: 'John Doe',
              email: 'john@example.com',
            },
          },
          {
            membershipID: 'member2',
            role: 'EDITOR',
            user: {
              uid: 'user2',
              displayName: 'Jane Smith',
              email: 'jane@example.com',
            },
          },
        ],
      };

      vi.mocked(mockClient.graphql).mockResolvedValue({
        team: mockTeam,
      });

      const result = await repository.getTeam('team1');

      expect(result).toEqual(mockTeam);
      expect(result.id).toBe('team1');
      expect(result.name).toBe('Engineering Team');
      expect(result.teamMembers).toHaveLength(2);
      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.stringContaining('team'),
        { teamID: 'team1' }
      );
    });

    it('should throw error when team not found', async () => {
      vi.mocked(mockClient.graphql).mockRejectedValue(
        new Error('Team not found')
      );

      await expect(repository.getTeam('invalid')).rejects.toThrow('Team not found');
    });

    it('should handle team with full member details', async () => {
      const mockTeam = {
        id: 'team1',
        name: 'Test Team',
        myRole: 'OWNER',
        teamMembers: [
          {
            membershipID: 'member1',
            role: 'OWNER',
            user: {
              uid: 'user1',
              displayName: 'Alice Cooper',
              email: 'alice@example.com',
              photoURL: 'https://example.com/photo.jpg',
            },
          },
        ],
      };

      vi.mocked(mockClient.graphql).mockResolvedValue({
        team: mockTeam,
      });

      const result = await repository.getTeam('team1');

      expect(result.teamMembers[0].user.displayName).toBe('Alice Cooper');
      expect(result.teamMembers[0].user.email).toBe('alice@example.com');
    });

    it('should handle team with multiple role types', async () => {
      const mockTeam = {
        id: 'team1',
        name: 'Mixed Roles Team',
        myRole: 'OWNER',
        teamMembers: [
          {
            membershipID: 'member1',
            role: 'OWNER',
            user: { uid: 'user1', displayName: 'Owner User', email: 'owner@example.com' },
          },
          {
            membershipID: 'member2',
            role: 'EDITOR',
            user: { uid: 'user2', displayName: 'Editor User', email: 'editor@example.com' },
          },
          {
            membershipID: 'member3',
            role: 'VIEWER',
            user: { uid: 'user3', displayName: 'Viewer User', email: 'viewer@example.com' },
          },
        ],
      };

      vi.mocked(mockClient.graphql).mockResolvedValue({
        team: mockTeam,
      });

      const result = await repository.getTeam('team1');

      expect(result.teamMembers).toHaveLength(3);
      expect(result.teamMembers[0].role).toBe('OWNER');
      expect(result.teamMembers[1].role).toBe('EDITOR');
      expect(result.teamMembers[2].role).toBe('VIEWER');
    });
  });

  describe('Error Handling', () => {
    it('should propagate GraphQL errors', async () => {
      vi.mocked(mockClient.graphql).mockRejectedValue(
        new Error('GraphQL execution error: Field "team" not found')
      );

      await expect(repository.getTeam('team1')).rejects.toThrow(
        'GraphQL execution error'
      );
    });

    it('should handle network errors when listing teams', async () => {
      vi.mocked(mockClient.graphql).mockRejectedValue(
        new Error('Network error: ETIMEDOUT')
      );

      await expect(repository.listTeams()).rejects.toThrow('Network error');
    });

    it('should handle authentication errors', async () => {
      vi.mocked(mockClient.graphql).mockRejectedValue(
        new Error('Unauthorized: Invalid access token')
      );

      await expect(repository.listTeams()).rejects.toThrow('Unauthorized');
    });

    it('should handle permission errors', async () => {
      vi.mocked(mockClient.graphql).mockRejectedValue(
        new Error('Forbidden: You do not have access to this team')
      );

      await expect(repository.getTeam('restricted-team')).rejects.toThrow(
        'Forbidden'
      );
    });
  });

  describe('Data Validation', () => {
    it('should handle teams with minimal data', async () => {
      const mockTeams = [
        {
          id: 'team1',
          name: 'Minimal Team',
          myRole: 'VIEWER',
          teamMembers: [],
        },
      ];

      vi.mocked(mockClient.graphql).mockResolvedValue({
        myTeams: mockTeams,
      });

      const result = await repository.listTeams();

      expect(result[0]).toHaveProperty('id');
      expect(result[0]).toHaveProperty('name');
      expect(result[0]).toHaveProperty('myRole');
      expect(result[0]).toHaveProperty('teamMembers');
    });

    it('should handle team members with missing optional fields', async () => {
      const mockTeam = {
        id: 'team1',
        name: 'Test Team',
        myRole: 'OWNER',
        teamMembers: [
          {
            membershipID: 'member1',
            role: 'EDITOR',
            user: {
              uid: 'user1',
              displayName: null,
              email: 'user@example.com',
            },
          },
        ],
      };

      vi.mocked(mockClient.graphql).mockResolvedValue({
        team: mockTeam,
      });

      const result = await repository.getTeam('team1');

      expect(result.teamMembers[0].user.displayName).toBeNull();
      expect(result.teamMembers[0].user.email).toBe('user@example.com');
    });
  });

  describe('Edge Cases', () => {
    it('should handle large number of teams', async () => {
      const mockTeams = Array.from({ length: 100 }, (_, i) => ({
        id: `team${i}`,
        name: `Team ${i}`,
        myRole: i % 3 === 0 ? 'OWNER' : i % 3 === 1 ? 'EDITOR' : 'VIEWER',
        teamMembers: [],
      }));

      vi.mocked(mockClient.graphql).mockResolvedValue({
        myTeams: mockTeams,
      });

      const result = await repository.listTeams();

      expect(result).toHaveLength(100);
      expect(result[0].id).toBe('team0');
      expect(result[99].id).toBe('team99');
    });

    it('should handle team with large number of members', async () => {
      const mockTeam = {
        id: 'team1',
        name: 'Large Team',
        myRole: 'OWNER',
        teamMembers: Array.from({ length: 50 }, (_, i) => ({
          membershipID: `member${i}`,
          role: 'VIEWER',
          user: {
            uid: `user${i}`,
            displayName: `User ${i}`,
            email: `user${i}@example.com`,
          },
        })),
      };

      vi.mocked(mockClient.graphql).mockResolvedValue({
        team: mockTeam,
      });

      const result = await repository.getTeam('team1');

      expect(result.teamMembers).toHaveLength(50);
    });

    it('should handle special characters in team names', async () => {
      const mockTeams = [
        {
          id: 'team1',
          name: "Team with 'quotes' and \"double quotes\"",
          myRole: 'OWNER',
          teamMembers: [],
        },
        {
          id: 'team2',
          name: 'Team with émojis 🚀 and ünïcödé',
          myRole: 'EDITOR',
          teamMembers: [],
        },
      ];

      vi.mocked(mockClient.graphql).mockResolvedValue({
        myTeams: mockTeams,
      });

      const result = await repository.listTeams();

      expect(result[0].name).toBe("Team with 'quotes' and \"double quotes\"");
      expect(result[1].name).toBe('Team with émojis 🚀 and ünïcödé');
    });
  });

  describe('Integration Scenarios', () => {
    it('should successfully fetch and then get specific team', async () => {
      const mockTeams = [
        { id: 'team1', name: 'Team 1', myRole: 'OWNER', teamMembers: [] },
        { id: 'team2', name: 'Team 2', myRole: 'EDITOR', teamMembers: [] },
      ];

      const mockTeamDetail = {
        id: 'team1',
        name: 'Team 1',
        myRole: 'OWNER',
        teamMembers: [
          {
            membershipID: 'member1',
            role: 'OWNER',
            user: {
              uid: 'user1',
              displayName: 'Owner',
              email: 'owner@example.com',
            },
          },
        ],
      };

      vi.mocked(mockClient.graphql)
        .mockResolvedValueOnce({ myTeams: mockTeams })
        .mockResolvedValueOnce({ team: mockTeamDetail });

      const teams = await repository.listTeams();
      expect(teams).toHaveLength(2);

      const teamDetail = await repository.getTeam(teams[0].id);
      expect(teamDetail.id).toBe('team1');
      expect(teamDetail.teamMembers).toHaveLength(1);
    });
  });

  describe('createTeam', () => {
    it('should create a team and return it', async () => {
      const mockTeam = { id: 'new-team', name: 'New Team', myRole: 'OWNER' };

      vi.mocked(mockClient.graphql).mockResolvedValue({
        createTeam: mockTeam,
      });

      const result = await repository.createTeam('New Team');

      expect(result).toEqual(mockTeam);
      expect(result.name).toBe('New Team');
      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.any(String),
        { name: 'New Team' }
      );
    });

    it('should propagate errors on failure', async () => {
      vi.mocked(mockClient.graphql).mockRejectedValue(
        new Error('team/name_invalid')
      );

      await expect(repository.createTeam('')).rejects.toThrow('team/name_invalid');
    });
  });

  describe('renameTeam', () => {
    it('should rename a team and return updated team', async () => {
      const mockTeam = { id: 'team1', name: 'Renamed Team', myRole: 'OWNER' };

      vi.mocked(mockClient.graphql).mockResolvedValue({
        renameTeam: mockTeam,
      });

      const result = await repository.renameTeam('team1', 'Renamed Team');

      expect(result).toEqual(mockTeam);
      expect(result.name).toBe('Renamed Team');
      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.any(String),
        { teamID: 'team1', newName: 'Renamed Team' }
      );
    });

    it('should throw when team not found', async () => {
      vi.mocked(mockClient.graphql).mockRejectedValue(
        new Error('team/not_found')
      );

      await expect(repository.renameTeam('bad-id', 'Name')).rejects.toThrow('team/not_found');
    });
  });

  describe('deleteTeam', () => {
    it('should delete a team and return true', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        deleteTeam: true,
      });

      const result = await repository.deleteTeam('team1');

      expect(result).toBe(true);
      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.any(String),
        { teamID: 'team1' }
      );
    });

    it('should throw when team not found', async () => {
      vi.mocked(mockClient.graphql).mockRejectedValue(
        new Error('team/not_found')
      );

      await expect(repository.deleteTeam('bad-id')).rejects.toThrow('team/not_found');
    });
  });

  describe('leaveTeam', () => {
    it('should leave a team and return true', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        leaveTeam: true,
      });

      const result = await repository.leaveTeam('team1');

      expect(result).toBe(true);
      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.any(String),
        { teamID: 'team1' }
      );
    });

    it('should throw when user is sole owner', async () => {
      vi.mocked(mockClient.graphql).mockRejectedValue(
        new Error('team/only_one_owner')
      );

      await expect(repository.leaveTeam('team1')).rejects.toThrow('team/only_one_owner');
    });
  });

  describe('inviteTeamMember', () => {
    it('should create an invitation and return it', async () => {
      const mockInvitation = {
        id: 'invite1',
        teamID: 'team1',
        inviteeEmail: 'new@example.com',
        inviteeRole: 'EDITOR',
      };

      vi.mocked(mockClient.graphql).mockResolvedValue({
        createTeamInvitation: mockInvitation,
      });

      const result = await repository.inviteTeamMember('team1', 'new@example.com', 'EDITOR');

      expect(result).toEqual(mockInvitation);
      expect(result.inviteeEmail).toBe('new@example.com');
      expect(result.inviteeRole).toBe('EDITOR');
      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.any(String),
        { teamID: 'team1', inviteeEmail: 'new@example.com', inviteeRole: 'EDITOR' }
      );
    });

    it('should throw on duplicate invite', async () => {
      vi.mocked(mockClient.graphql).mockRejectedValue(
        new Error('team_invite/member_has_invite')
      );

      await expect(
        repository.inviteTeamMember('team1', 'existing@example.com', 'VIEWER')
      ).rejects.toThrow('team_invite/member_has_invite');
    });
  });

  describe('revokeTeamInvitation', () => {
    it('should revoke an invitation and return true', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        revokeTeamInvitation: true,
      });

      const result = await repository.revokeTeamInvitation('invite1');

      expect(result).toBe(true);
      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.any(String),
        { inviteID: 'invite1' }
      );
    });

    it('should throw when invitation not found', async () => {
      vi.mocked(mockClient.graphql).mockRejectedValue(
        new Error('team_invite/not_found')
      );

      await expect(repository.revokeTeamInvitation('bad-id')).rejects.toThrow('team_invite/not_found');
    });
  });

  describe('removeTeamMember', () => {
    it('should remove a member and return true', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        removeTeamMember: true,
      });

      const result = await repository.removeTeamMember('team1', 'user1');

      expect(result).toBe(true);
      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.any(String),
        { teamID: 'team1', userUid: 'user1' }
      );
    });

    it('should throw when member not found', async () => {
      vi.mocked(mockClient.graphql).mockRejectedValue(
        new Error('team/member_not_found')
      );

      await expect(repository.removeTeamMember('team1', 'bad-uid')).rejects.toThrow('team/member_not_found');
    });
  });

  describe('updateTeamMemberRole', () => {
    it('should update a member role and return the member', async () => {
      const mockMember = {
        membershipID: 'member1',
        role: 'EDITOR',
        user: {
          uid: 'user1',
          displayName: 'John Doe',
          email: 'john@example.com',
        },
      };

      vi.mocked(mockClient.graphql).mockResolvedValue({
        updateTeamMemberRole: mockMember,
      });

      const result = await repository.updateTeamMemberRole('team1', 'user1', 'EDITOR');

      expect(result).toEqual(mockMember);
      expect(result.role).toBe('EDITOR');
      expect(result.user.uid).toBe('user1');
      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.any(String),
        { teamID: 'team1', userUid: 'user1', newRole: 'EDITOR' }
      );
    });

    it('should throw on invalid role', async () => {
      vi.mocked(mockClient.graphql).mockRejectedValue(
        new Error('team/invalid_role')
      );

      await expect(
        repository.updateTeamMemberRole('team1', 'user1', 'INVALID')
      ).rejects.toThrow('team/invalid_role');
    });
  });

  describe('last-owner guard (client-side defense-in-depth)', () => {
    const owner = (uid: string) => ({
      membershipID: `m-${uid}`,
      role: 'OWNER' as const,
      user: { uid, displayName: uid, email: `${uid}@x.com` },
    });
    const editor = (uid: string) => ({
      membershipID: `m-${uid}`,
      role: 'EDITOR' as const,
      user: { uid, displayName: uid, email: `${uid}@x.com` },
    });
    const soleOwnerTeam = { id: 'team1', name: 'T', myRole: 'OWNER', teamMembers: [owner('owner1'), editor('ed1')] };
    const twoOwnerTeam = { id: 'team1', name: 'T', myRole: 'OWNER', teamMembers: [owner('owner1'), owner('owner2')] };

    it('refuses to leave when the caller is the sole OWNER (mutation not sent)', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValueOnce({ team: soleOwnerTeam });
      await expect(repository.leaveTeam('team1')).rejects.toThrow(/only OWNER/);
      expect(mockClient.graphql).toHaveBeenCalledTimes(1); // getTeam only
    });

    it('refuses to remove the sole OWNER (mutation not sent)', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValueOnce({ team: soleOwnerTeam });
      await expect(repository.removeTeamMember('team1', 'owner1')).rejects.toThrow(/only OWNER/);
      expect(mockClient.graphql).toHaveBeenCalledTimes(1);
    });

    it('refuses to demote the sole OWNER (mutation not sent)', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValueOnce({ team: soleOwnerTeam });
      await expect(repository.updateTeamMemberRole('team1', 'owner1', 'EDITOR')).rejects.toThrow(/only OWNER/);
      expect(mockClient.graphql).toHaveBeenCalledTimes(1);
    });

    it('allows removing an OWNER when another OWNER remains', async () => {
      vi.mocked(mockClient.graphql)
        .mockResolvedValueOnce({ team: twoOwnerTeam })
        .mockResolvedValueOnce({ removeTeamMember: true });
      await expect(repository.removeTeamMember('team1', 'owner1')).resolves.toBe(true);
      expect(mockClient.graphql).toHaveBeenCalledTimes(2);
    });

    it('promoting a member to OWNER skips the guard read', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValueOnce({ updateTeamMemberRole: editor('ed1') });
      await expect(repository.updateTeamMemberRole('team1', 'ed1', 'OWNER')).resolves.toBeDefined();
      expect(mockClient.graphql).toHaveBeenCalledTimes(1); // mutation only — no getTeam
    });
  });
});
