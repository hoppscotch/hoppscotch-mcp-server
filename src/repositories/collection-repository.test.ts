import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { CollectionRepository } from './collection-repository';
import { CollectionType } from '../types';
import { ApiType } from '../config';
import type { HoppscotchClient } from '../client';

function makeMockClient(apiType: ApiType = ApiType.SELFHOST): HoppscotchClient {
  return {
    graphql: vi.fn(),
    getConfig: vi.fn().mockReturnValue({ maxResults: 25, apiType }),
  } as unknown as HoppscotchClient;
}

describe('CollectionRepository', () => {
  let repository: CollectionRepository;
  let mockClient: HoppscotchClient;

  beforeEach(() => {
    mockClient = makeMockClient();
    repository = new CollectionRepository(mockClient);
  });

  describe('getUserCollections', () => {
    it('should fetch REST user collections on SH', async () => {
      // SH GQL returns parent { id } nested object, not a parentID scalar
      const rawGql = [{ id: 'col1', title: 'My REST Collection', data: null, parent: null }];
      vi.mocked(mockClient.graphql).mockResolvedValue({ rootRESTUserCollections: rawGql });

      const result = await repository.getUserCollections(CollectionType.REST);

      // Normalizer maps parent?.id → parentID
      expect(result).toEqual([
        { id: 'col1', title: 'My REST Collection', data: null, parentID: null },
      ]);
      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ take: 25 })
      );
    });

    it('should fetch GQL user collections on SH', async () => {
      const rawGql = [{ id: 'col2', title: 'My GQL Collection', data: null, parent: null }];
      vi.mocked(mockClient.graphql).mockResolvedValue({ rootGQLUserCollections: rawGql });

      const result = await repository.getUserCollections(CollectionType.GQL);
      expect(result).toEqual([
        { id: 'col2', title: 'My GQL Collection', data: null, parentID: null },
      ]);
    });

    it('should normalize parent { id } to parentID', async () => {
      const rawGql = [{ id: 'col3', title: 'Child Col', data: null, parent: { id: 'parent-1' } }];
      vi.mocked(mockClient.graphql).mockResolvedValue({ rootRESTUserCollections: rawGql });

      const result = await repository.getUserCollections(CollectionType.REST);
      expect(result[0].parentID).toBe('parent-1');
    });

    it('should return empty array when no collections', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({ rootRESTUserCollections: null });
      expect(await repository.getUserCollections(CollectionType.REST)).toEqual([]);
    });

    it('should pass pagination options', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({ rootRESTUserCollections: [] });
      await repository.getUserCollections(CollectionType.REST, { cursor: 'cursor-123', limit: 50 });
      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ cursor: 'cursor-123', take: 50 })
      );
    });

    it('should throw on Cloud', async () => {
      const cloudRepo = new CollectionRepository(makeMockClient(ApiType.CLOUD));
      await expect(cloudRepo.getUserCollections(CollectionType.REST)).rejects.toThrow(
        'not supported on Hoppscotch Cloud'
      );
    });
  });

  describe('getUserCollection', () => {
    it('should fetch single user collection by ID on SH and normalize parent', async () => {
      const rawGql = { id: 'col1', title: 'My Collection', data: null, parent: { id: 'parent-1' } };
      vi.mocked(mockClient.graphql).mockResolvedValue({ userCollection: rawGql });

      const result = await repository.getUserCollection('col1');
      expect(result).toEqual({
        id: 'col1',
        title: 'My Collection',
        data: null,
        parentID: 'parent-1',
      });
      expect(mockClient.graphql).toHaveBeenCalledWith(expect.any(String), { collectionID: 'col1' });
    });

    it('should normalize null parent to parentID: null', async () => {
      const rawGql = { id: 'col1', title: 'Root Col', data: null, parent: null };
      vi.mocked(mockClient.graphql).mockResolvedValue({ userCollection: rawGql });

      const result = await repository.getUserCollection('col1');
      expect(result.parentID).toBeNull();
    });

    it('should throw on Cloud', async () => {
      const cloudRepo = new CollectionRepository(makeMockClient(ApiType.CLOUD));
      await expect(cloudRepo.getUserCollection('col1')).rejects.toThrow(
        'not supported on Hoppscotch Cloud'
      );
    });
  });

  describe('createUserCollection', () => {
    it('should create a REST root collection and normalize parent', async () => {
      const rawGql = { id: 'new-col', title: 'New Collection', data: null, parent: null };
      vi.mocked(mockClient.graphql).mockResolvedValue({ createRESTRootUserCollection: rawGql });

      const result = await repository.createUserCollection(CollectionType.REST, {
        title: 'New Collection',
      });
      expect(result).toEqual({
        id: 'new-col',
        title: 'New Collection',
        data: null,
        parentID: null,
      });
    });

    it('should create a REST child collection with parentUserCollectionID arg', async () => {
      const rawGql = { id: 'child', title: 'Child', data: null, parent: { id: 'parent-col' } };
      vi.mocked(mockClient.graphql).mockResolvedValue({ createRESTChildUserCollection: rawGql });

      const result = await repository.createUserCollection(CollectionType.REST, {
        title: 'Child',
        parentCollectionID: 'parent-col',
      });
      expect(result.parentID).toBe('parent-col');
      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ parentUserCollectionID: 'parent-col' })
      );
    });

    it('should create a GQL root collection', async () => {
      const rawGql = { id: 'gql-col', title: 'GQL Col', data: null, parent: null };
      vi.mocked(mockClient.graphql).mockResolvedValue({ createGQLRootUserCollection: rawGql });

      const result = await repository.createUserCollection(CollectionType.GQL, {
        title: 'GQL Col',
      });
      expect(result.id).toBe('gql-col');
    });
  });

  describe('updateUserCollection', () => {
    it('should send userCollectionID without reqType on SH', async () => {
      const rawGql = { id: 'col1', title: 'Updated', data: null, parent: null };
      vi.mocked(mockClient.graphql).mockResolvedValue({ updateUserCollection: rawGql });

      const result = await repository.updateUserCollection('col1', CollectionType.REST, {
        title: 'Updated',
      });
      expect(result.title).toBe('Updated');
      // SH variant, no reqType
      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ userCollectionID: 'col1', newTitle: 'Updated' })
      );
      const calledArgs = vi.mocked(mockClient.graphql).mock.calls[0][1] as Record<string, unknown>;
      expect(calledArgs['reqType']).toBeUndefined();
    });

    it('should send reqType on Cloud', async () => {
      const cloudRepo = new CollectionRepository(makeMockClient(ApiType.CLOUD));
      const rawGql = { id: 'col1', title: 'Updated', data: null, parent: null };
      vi.mocked(mockClient.graphql).mockResolvedValue({ updateUserCollection: rawGql });
      // Cloud client has its own mock
      const cloudMock = cloudRepo['client'] as unknown as { graphql: Mock };
      cloudMock.graphql = vi.fn().mockResolvedValue({ updateUserCollection: rawGql });

      await cloudRepo.updateUserCollection('col1', CollectionType.REST, { title: 'Updated' });
      expect(cloudMock.graphql).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ userCollectionID: 'col1', reqType: CollectionType.REST })
      );
    });
  });

  describe('deleteUserCollection', () => {
    it('should send userCollectionID without reqType on SH', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({});
      await repository.deleteUserCollection('col1', CollectionType.REST);
      expect(mockClient.graphql).toHaveBeenCalledWith(expect.any(String), {
        userCollectionID: 'col1',
      });
    });

    it('should send reqType on Cloud', async () => {
      const cloudRepo = new CollectionRepository(makeMockClient(ApiType.CLOUD));
      const cloudMock = cloudRepo['client'] as unknown as { graphql: Mock };
      cloudMock.graphql = vi.fn().mockResolvedValue({});

      await cloudRepo.deleteUserCollection('col1', CollectionType.REST);
      expect(cloudMock.graphql).toHaveBeenCalledWith(expect.any(String), {
        userCollectionID: 'col1',
        reqType: CollectionType.REST,
      });
    });
  });

  describe('duplicateUserCollection', () => {
    it('should send collectionID (String) + reqType, returns void', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({});
      await repository.duplicateUserCollection('col1', CollectionType.REST);
      expect(mockClient.graphql).toHaveBeenCalledWith(expect.any(String), {
        collectionID: 'col1',
        reqType: CollectionType.REST,
      });
    });
  });

  describe('moveUserCollection', () => {
    it('should send userCollectionID + destCollectionID and normalize parent', async () => {
      const rawGql = { id: 'col1', title: 'Moved', data: null, parent: { id: 'new-parent' } };
      vi.mocked(mockClient.graphql).mockResolvedValue({ moveUserCollection: rawGql });

      const result = await repository.moveUserCollection('col1', 'new-parent');
      expect(result.parentID).toBe('new-parent');
      expect(mockClient.graphql).toHaveBeenCalledWith(expect.any(String), {
        userCollectionID: 'col1',
        destCollectionID: 'new-parent',
      });
    });

    it('should send destCollectionID: null when moving to root', async () => {
      const rawGql = { id: 'col1', title: 'Root Col', data: null, parent: null };
      vi.mocked(mockClient.graphql).mockResolvedValue({ moveUserCollection: rawGql });

      await repository.moveUserCollection('col1');
      expect(mockClient.graphql).toHaveBeenCalledWith(expect.any(String), {
        userCollectionID: 'col1',
        destCollectionID: null,
      });
    });
  });

  describe('Team Collections', () => {
    it('should fetch team collections', async () => {
      const mockCollections = [
        { id: 'team-col1', title: 'Team Col', data: null, parentID: null, teamID: 'team1' },
      ];
      vi.mocked(mockClient.graphql).mockResolvedValue({ rootCollectionsOfTeam: mockCollections });
      expect(await repository.getTeamCollections('team1')).toEqual(mockCollections);
    });

    it('should create root team collection', async () => {
      const mockResult = {
        id: 'new-team-col',
        title: 'New Team Col',
        data: null,
        parentID: null,
        teamID: 'team1',
      };
      vi.mocked(mockClient.graphql).mockResolvedValue({ createRootCollection: mockResult });
      expect(await repository.createTeamCollection('team1', { title: 'New Team Col' })).toEqual(
        mockResult
      );
    });

    it('should update team collection', async () => {
      const mockResult = {
        id: 'team-col1',
        title: 'Updated',
        data: null,
        parentID: null,
        teamID: 'team1',
      };
      vi.mocked(mockClient.graphql).mockResolvedValue({ updateTeamCollection: mockResult });
      expect((await repository.updateTeamCollection('team-col1', { title: 'Updated' })).title).toBe(
        'Updated'
      );
    });

    it('should delete team collection', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({});
      expect(await repository.deleteTeamCollection('team-col1')).toBe(true);
    });

    it('should duplicate team collection', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({ duplicateTeamCollection: true });
      expect(await repository.duplicateTeamCollection('team-col1')).toBe(true);
    });
  });

  describe('getTeamCollection (GQL)', () => {
    it('should fetch team collection via collection(collectionID) and normalise parent.id → parentID', async () => {
      // GQL returns parent as a nested object, not a parentID scalar
      const rawGql = {
        id: 'team-col1',
        title: 'Team Col',
        parent: { id: 'parent-col' },
        data: null,
      };
      vi.mocked(mockClient.graphql).mockResolvedValue({ collection: rawGql });

      const result = await repository.getTeamCollection('team-col1');
      expect(result).toEqual({
        id: 'team-col1',
        title: 'Team Col',
        parentID: 'parent-col',
        data: null,
        teamID: '',
      });
      expect(mockClient.graphql).toHaveBeenCalledWith(expect.any(String), {
        collectionID: 'team-col1',
      });
    });

    it('should normalise null parent to parentID: null', async () => {
      const rawGql = { id: 'root-col', title: 'Root Col', parent: null, data: null };
      vi.mocked(mockClient.graphql).mockResolvedValue({ collection: rawGql });

      const result = await repository.getTeamCollection('root-col');
      expect(result.parentID).toBeNull();
    });
  });

  // Note: team request search moved to request-repository (it returns request
  // rows from the searchForRequest GQL field, not collections). See
  // request-repository.test.ts for the corresponding cases.
});
