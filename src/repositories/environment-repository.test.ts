import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EnvironmentRepository, redactEnvSecrets, assertNoRedactionPlaceholder, SECRET_PLACEHOLDER } from './environment-repository';
import { ApiType, type Config } from '../config';
import type { UserEnvironment } from '../types';
import type { HoppscotchClient } from '../client';

describe('redactEnvSecrets — secret values never cross the MCP boundary', () => {
  it('masks value/currentValue/initialValue on secret entries, keeps non-secret', () => {
    const env = {
      id: 'e1',
      name: 'prod',
      variables: JSON.stringify([
        { key: 'API_KEY', value: 'live-secret', currentValue: 'live-secret', initialValue: 'live-secret', secret: true },
        { key: 'BASE_URL', value: 'https://api.example.com', secret: false },
      ]),
    };

    const out = redactEnvSecrets(env);
    const vars = JSON.parse(out.variables);

    expect(out.variables).not.toContain('live-secret');
    expect(vars[0]).toMatchObject({ key: 'API_KEY', value: '<secret hidden>', currentValue: '<secret hidden>', initialValue: '<secret hidden>', secret: true });
    expect(vars[1]).toMatchObject({ key: 'BASE_URL', value: 'https://api.example.com' });
  });

  it('returns the input unchanged when there are no secret vars', () => {
    const env = { variables: JSON.stringify([{ key: 'X', value: 'y', secret: false }]) };
    expect(redactEnvSecrets(env)).toBe(env);
  });

  it('returns the input unchanged when variables is not parseable', () => {
    const env = { variables: 'not-json' };
    expect(redactEnvSecrets(env)).toBe(env);
  });
});

describe('assertNoRedactionPlaceholder — the placeholder can never be persisted', () => {
  it('throws when a variable value is the redaction placeholder', () => {
    expect(() =>
      assertNoRedactionPlaceholder([{ key: 'API_KEY', value: SECRET_PLACEHOLDER, secret: true }])
    ).toThrow(/placeholder/i);
  });
});

function makeMockClient(apiType: ApiType = ApiType.SELFHOST): HoppscotchClient {
  return {
    graphql: vi.fn(),
    getConfig: vi.fn().mockReturnValue({ apiType }),
  } as unknown as HoppscotchClient;
}

describe('EnvironmentRepository', () => {
  let repository: EnvironmentRepository;
  let mockClient: HoppscotchClient;

  beforeEach(() => {
    mockClient = makeMockClient();
    repository = new EnvironmentRepository(mockClient);
  });

  describe('write-guard — every create/update write path rejects the redaction placeholder', () => {
    const placeholderVars = [{ key: 'API_KEY', value: SECRET_PLACEHOLDER, secret: true }];

    it('createUserEnvironment rejects and never calls graphql', async () => {
      await expect(
        repository.createUserEnvironment({ name: 'e', variables: placeholderVars })
      ).rejects.toThrow(/placeholder/i);
      expect(mockClient.graphql).not.toHaveBeenCalled();
    });

    it('updateUserEnvironment rejects and never calls graphql', async () => {
      await expect(
        repository.updateUserEnvironment('env1', { variables: placeholderVars })
      ).rejects.toThrow(/placeholder/i);
      expect(mockClient.graphql).not.toHaveBeenCalled();
    });

    it('createTeamEnvironment rejects and never calls graphql', async () => {
      await expect(
        repository.createTeamEnvironment('team1', { name: 'e', variables: placeholderVars })
      ).rejects.toThrow(/placeholder/i);
      expect(mockClient.graphql).not.toHaveBeenCalled();
    });

    it('updateTeamEnvironment rejects and never calls graphql', async () => {
      await expect(
        repository.updateTeamEnvironment('env1', { variables: placeholderVars })
      ).rejects.toThrow(/placeholder/i);
      expect(mockClient.graphql).not.toHaveBeenCalled();
    });

    it('team partial update (name only) preserves the real stored secret, never the placeholder', async () => {
      const client = makeMockClient(ApiType.SELFHOST);
      vi.mocked(client.getConfig).mockReturnValue({ apiType: ApiType.SELFHOST, defaultTeamId: 't1' } as unknown as Config);
      const stored = JSON.stringify([{ key: 'API_KEY', value: 'real-secret', secret: true }]);
      vi.mocked(client.graphql)
        .mockResolvedValueOnce({ team: { teamEnvironments: [{ id: 'env1', name: 'old', variables: stored, teamID: 't1' }] } })
        .mockResolvedValueOnce({ updateTeamEnvironment: { id: 'env1', name: 'Renamed', variables: stored, teamID: 't1' } });
      const repo = new EnvironmentRepository(client);

      await repo.updateTeamEnvironment('env1', { name: 'Renamed' });

      const updateArgs = vi.mocked(client.graphql).mock.calls[1][1] as { variables: string };
      expect(updateArgs.variables).toContain('real-secret');
      expect(updateArgs.variables).not.toContain(SECRET_PLACEHOLDER);
    });
  });

  describe('User Environments', () => {
    describe('getUserEnvironments', () => {
      it('should fetch via me { environments } on SH', async () => {
        const mockEnvironments = [
          { id: 'env1', name: 'Development', variables: JSON.stringify([{ key: 'API_URL', value: 'https://dev.example.com', secret: false }]), isGlobal: false },
        ];
        vi.mocked(mockClient.graphql).mockResolvedValue({ me: { environments: mockEnvironments } });

        const result = await repository.getUserEnvironments();

        expect(result).toEqual(mockEnvironments);
        expect(mockClient.graphql).toHaveBeenCalledWith(expect.any(String));
      });

      it('should return empty array on Cloud (no GQL user-environment field)', async () => {
        const cloudRepo = new EnvironmentRepository(makeMockClient(ApiType.CLOUD));
        const result = await cloudRepo.getUserEnvironments();
        expect(result).toEqual([]);
        // graphql should NOT be called on Cloud
        expect(mockClient.graphql).not.toHaveBeenCalled();
      });

      it('should propagate errors from GQL call on SH', async () => {
        vi.mocked(mockClient.graphql).mockRejectedValue(new Error('Network error'));
        await expect(repository.getUserEnvironments()).rejects.toThrow('Network error');
      });

      it('should return empty array when me.environments is empty', async () => {
        vi.mocked(mockClient.graphql).mockResolvedValue({ me: { environments: [] } });
        expect(await repository.getUserEnvironments()).toEqual([]);
      });
    });

    describe('createUserEnvironment', () => {
      it('should create new user environment', async () => {
        const input = {
          name: 'Staging',
          variables: [{ key: 'API_URL', value: 'https://staging.example.com' }],
        };
        const mockResult = { id: 'new-env', name: 'Staging', variables: JSON.stringify(input.variables), isGlobal: false };
        vi.mocked(mockClient.graphql).mockResolvedValue({ createUserEnvironment: mockResult });

        const result = await repository.createUserEnvironment(input);

        expect(result).toEqual(mockResult);
        expect(mockClient.graphql).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ name: 'Staging', variables: JSON.stringify(input.variables) })
        );
      });

      it('should create environment with empty variables', async () => {
        const mockResult = { id: 'empty-env', name: 'Empty', variables: '[]', isGlobal: false };
        vi.mocked(mockClient.graphql).mockResolvedValue({ createUserEnvironment: mockResult });

        const result = await repository.createUserEnvironment({ name: 'Empty', variables: [] });
        expect(result.variables).toBe('[]');
      });
    });

    describe('updateUserEnvironment', () => {
      it('should fetch current variables when only name is provided (avoid wiping data)', async () => {
        // Regression test: previously, omitting variables sent '[]' to the
        // mutation, silently erasing the user's existing variables. Now we
        // list user environments, find the target, and pass its current
        // variables through unchanged.
        const existing = [{ key: 'API_KEY', value: 'preserved', secret: true }];
        const existingVarsStr = JSON.stringify(existing);
        const mockResult = { id: 'env1', name: 'New Name', variables: existingVarsStr, isGlobal: false };

        vi.mocked(mockClient.graphql)
          .mockResolvedValueOnce({ me: { environments: [{ id: 'env1', name: 'Old Name', variables: existingVarsStr, isGlobal: false }] } })
          .mockResolvedValueOnce({ updateUserEnvironment: mockResult });

        const result = await repository.updateUserEnvironment('env1', { name: 'New Name' });
        expect(result.name).toBe('New Name');
        expect(mockClient.graphql).toHaveBeenLastCalledWith(
          expect.any(String),
          expect.objectContaining({ id: 'env1', name: 'New Name', variables: existingVarsStr })
        );
      });

      it('should fetch current name when only variables are provided', async () => {
        const newVariables = [{ key: 'NEW_VAR', value: 'new-value', secret: false }];
        const newVarsStr = JSON.stringify(newVariables);
        const mockResult = { id: 'env1', name: 'Development', variables: newVarsStr, isGlobal: false };

        vi.mocked(mockClient.graphql)
          .mockResolvedValueOnce({ me: { environments: [{ id: 'env1', name: 'Development', variables: '[]', isGlobal: false }] } })
          .mockResolvedValueOnce({ updateUserEnvironment: mockResult });

        const result = await repository.updateUserEnvironment('env1', { variables: newVariables });
        expect(result.variables).toEqual(newVarsStr);
        expect(mockClient.graphql).toHaveBeenLastCalledWith(
          expect.any(String),
          expect.objectContaining({ id: 'env1', name: 'Development', variables: newVarsStr })
        );
      });

      it('should pass both fields straight through without a fetch when both are provided', async () => {
        const newVariables = [{ key: 'NEW_VAR', value: 'new-value', secret: false }];
        const newVarsStr = JSON.stringify(newVariables);
        const mockResult = { id: 'env1', name: 'New Name', variables: newVarsStr, isGlobal: false };
        vi.mocked(mockClient.graphql).mockResolvedValueOnce({ updateUserEnvironment: mockResult });

        const result = await repository.updateUserEnvironment('env1', { name: 'New Name', variables: newVariables });
        expect(result.name).toBe('New Name');
        expect(mockClient.graphql).toHaveBeenCalledTimes(1);
      });

      it('should throw when the target environment does not exist', async () => {
        vi.mocked(mockClient.graphql).mockResolvedValueOnce({ me: { environments: [] } });
        await expect(
          repository.updateUserEnvironment('missing', { name: 'X' })
        ).rejects.toThrow(/not found/);
      });
    });

    describe('deleteUserEnvironment', () => {
      it('should delete user environment', async () => {
        vi.mocked(mockClient.graphql).mockResolvedValue({});
        const result = await repository.deleteUserEnvironment('env1');
        expect(result).toBe(true);
        expect(mockClient.graphql).toHaveBeenCalledWith(expect.any(String), { id: 'env1' });
      });
    });
  });

  describe('Team Environments', () => {
    describe('getTeamEnvironments', () => {
      it('should fetch team environments via team { teamEnvironments } GQL', async () => {
        const mockEnvs = [
          { id: 'team-env1', name: 'Team Dev', teamID: 'team1', variables: '[]' },
          { id: 'team-env2', name: 'Team Prod', teamID: 'team1', variables: '[]' },
        ];
        vi.mocked(mockClient.graphql).mockResolvedValue({ team: { teamEnvironments: mockEnvs } });

        const result = await repository.getTeamEnvironments('team1');
        expect(result).toEqual(mockEnvs);
        expect(mockClient.graphql).toHaveBeenCalledWith(
          expect.any(String),
          { teamID: 'team1' }
        );
      });

      it('should return empty array when team has no environments', async () => {
        vi.mocked(mockClient.graphql).mockResolvedValue({ team: { teamEnvironments: [] } });
        expect(await repository.getTeamEnvironments('team1')).toEqual([]);
      });

      it('should propagate errors from GQL call', async () => {
        vi.mocked(mockClient.graphql).mockRejectedValue(new Error('Network error'));
        await expect(repository.getTeamEnvironments('team1')).rejects.toThrow('Network error');
      });
    });

    describe('getTeamEnvironment (GQL)', () => {
      it('should find a specific environment by ID within the team list', async () => {
        const mockEnvs = [
          { id: 'team-env1', name: 'Team Dev', teamID: 'team1', variables: '[]' },
          { id: 'team-env2', name: 'Team Prod', teamID: 'team1', variables: '[]' },
        ];
        vi.mocked(mockClient.graphql).mockResolvedValue({ team: { teamEnvironments: mockEnvs } });

        const result = await repository.getTeamEnvironment('team-env1', 'team1');
        expect(result).toEqual(mockEnvs[0]);
      });

      it('should throw when environment ID not found in team list', async () => {
        vi.mocked(mockClient.graphql).mockResolvedValue({ team: { teamEnvironments: [] } });
        await expect(repository.getTeamEnvironment('missing-id', 'team1')).rejects.toThrow(
          'Team environment missing-id not found'
        );
      });
    });

    describe('createTeamEnvironment', () => {
      it('should create team environment', async () => {
        const input = { name: 'Team Staging', variables: [{ key: 'TEAM_API', value: 'https://team.example.com' }] };
        const mockResult = { id: 'new-team-env', name: 'Team Staging', teamID: 'team1', variables: JSON.stringify(input.variables) };
        vi.mocked(mockClient.graphql).mockResolvedValue({ createTeamEnvironment: mockResult });

        const result = await repository.createTeamEnvironment('team1', input);
        expect(result).toEqual(mockResult);
        expect(mockClient.graphql).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ teamID: 'team1', name: 'Team Staging' })
        );
      });
    });

    describe('updateTeamEnvironment', () => {
      it('should pass both fields straight through when both are provided', async () => {
        const newVariables = [{ key: 'V', value: '1', secret: false }];
        const mockResult = { id: 'team-env1', name: 'Updated', teamID: 'team1', variables: JSON.stringify(newVariables) };
        vi.mocked(mockClient.graphql).mockResolvedValue({ updateTeamEnvironment: mockResult });

        const result = await repository.updateTeamEnvironment('team-env1', { name: 'Updated', variables: newVariables });
        expect(result.name).toBe('Updated');
        expect(mockClient.graphql).toHaveBeenCalledTimes(1);
      });

      it('should fetch current values when only one field is provided and defaultTeamId is set', async () => {
        // Regression test: previously, omitting a field could send '' / '[]'
        // as a default and wipe the unspecified field. Now we fetch and merge.
        vi.mocked(mockClient.getConfig).mockReturnValue({ apiType: 'selfhost', defaultTeamId: 'team1' } as unknown as Config);
        const existing = { id: 'team-env1', name: 'Existing', teamID: 'team1', variables: JSON.stringify([{ key: 'KEEP', value: 'me', secret: false }]) };
        const mockResult = { id: 'team-env1', name: 'Renamed', teamID: 'team1', variables: existing.variables };

        vi.mocked(mockClient.graphql)
          .mockResolvedValueOnce({ team: { teamEnvironments: [existing] } })
          .mockResolvedValueOnce({ updateTeamEnvironment: mockResult });

        const result = await repository.updateTeamEnvironment('team-env1', { name: 'Renamed' });
        expect(result.name).toBe('Renamed');
        expect(mockClient.graphql).toHaveBeenLastCalledWith(
          expect.any(String),
          expect.objectContaining({ id: 'team-env1', name: 'Renamed', variables: existing.variables })
        );
      });

      it('should refuse partial update when defaultTeamId is not configured', async () => {
        // Without defaultTeamId we cannot fetch the current env to merge,
        // and silently defaulting would wipe data. Refuse instead.
        vi.mocked(mockClient.getConfig).mockReturnValue({ apiType: 'selfhost' } as unknown as Config);
        await expect(
          repository.updateTeamEnvironment('team-env1', { name: 'Renamed' })
        ).rejects.toThrow(/HOPPSCOTCH_DEFAULT_TEAM_ID/);
      });
    });

    describe('deleteTeamEnvironment', () => {
      it('should delete team environment', async () => {
        vi.mocked(mockClient.graphql).mockResolvedValue({});
        expect(await repository.deleteTeamEnvironment('team-env1')).toBe(true);
      });
    });
  });

  describe('Variable Serialization', () => {
    it('should correctly serialize and parse variables round-trip', async () => {
      const variables = [
        { key: 'PUBLIC', value: 'visible', secret: false },
        { key: 'SECRET', value: 'hidden', secret: true },
      ];
      const mockEnv = { id: 'env1', name: 'Test', variables: JSON.stringify(variables), isGlobal: false };
      vi.mocked(mockClient.graphql).mockResolvedValue({ createUserEnvironment: mockEnv });

      const result = await repository.createUserEnvironment({ name: 'Test', variables });
      expect(repository.getEnvironmentVariables(result)).toEqual(variables);
    });

    it('should handle invalid JSON in variables', () => {
      const mockEnv = { id: 'env1', name: 'Invalid', variables: 'not-valid-json{' };
      expect(repository.getEnvironmentVariables(mockEnv as unknown as UserEnvironment)).toEqual([]);
    });

    it('should parse empty variables string', () => {
      const mockEnv = { id: 'env1', name: 'Empty', variables: '[]' };
      expect(repository.getEnvironmentVariables(mockEnv as unknown as UserEnvironment)).toEqual([]);
    });
  });
});
