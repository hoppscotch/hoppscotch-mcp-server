import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { CollectionRepository } from './collection-repository';
import { CollectionType } from '../types';
import { ApiType } from '../config';
import type { HoppscotchClient } from '../client';
import * as queries from '../graphql/queries';

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
      // The root queries do not select parent; these rows are roots by contract.
      const rawGql = [{ id: 'col1', title: 'My REST Collection', data: null }];
      vi.mocked(mockClient.graphql).mockResolvedValue({ rootRESTUserCollections: rawGql });

      const result = await repository.getUserCollections(CollectionType.REST);

      expect(result).toEqual([
        { id: 'col1', title: 'My REST Collection', data: null, parentID: null },
      ]);
      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ take: 25 })
      );
    });

    it('should fetch GQL user collections on SH', async () => {
      const rawGql = [{ id: 'col2', title: 'My GQL Collection', data: null }];
      vi.mocked(mockClient.graphql).mockResolvedValue({ rootGQLUserCollections: rawGql });

      const result = await repository.getUserCollections(CollectionType.GQL);
      expect(result).toEqual([
        { id: 'col2', title: 'My GQL Collection', data: null, parentID: null },
      ]);
    });

    it('should report root listings as parentID: null', async () => {
      // The root queries select no `parent`: these rows are roots by contract.
      const rawGql = [{ id: 'col3', title: 'Root Col', data: null }];
      vi.mocked(mockClient.graphql).mockResolvedValue({ rootRESTUserCollections: rawGql });

      const result = await repository.getUserCollections(CollectionType.REST);
      expect(result[0].parentID).toBeNull();
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

    it('should issue the same query on Cloud', async () => {
      const cloudClient = makeMockClient(ApiType.CLOUD);
      vi.mocked(cloudClient.graphql).mockResolvedValue({
        rootRESTUserCollections: [{ id: 'col1', title: 'Root Col', data: null }],
      });

      const result = await new CollectionRepository(cloudClient).getUserCollections(
        CollectionType.REST
      );

      expect(result).toHaveLength(1);
      // Pin the query, not just the call count: a re-introduced isCloud() branch
      // selecting a different query would otherwise still pass.
      expect(cloudClient.graphql).toHaveBeenCalledWith(
        queries.GET_USER_REST_COLLECTIONS,
        expect.anything()
      );
    });
  });

  describe('exportUserCollection', () => {
    it('should export all collections of a type', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        exportUserCollectionsToJSON: { exportedCollection: '[]', collectionType: 'REST' },
      });

      const result = await repository.exportUserCollection(CollectionType.REST);

      expect(result).toBe('[]');
      expect(mockClient.graphql).toHaveBeenCalledWith(queries.EXPORT_USER_COLLECTIONS_JSON, {
        collectionType: CollectionType.REST,
      });
    });

    it('should export a single collection by ID', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({ exportUserCollectionToJSON: '{"a":1}' });

      const result = await repository.exportUserCollection(CollectionType.REST, 'col1');

      expect(result).toBe('{"a":1}');
      // collectionType is ReqType! on this field; omitting it fails the query.
      expect(mockClient.graphql).toHaveBeenCalledWith(queries.EXPORT_USER_COLLECTION_JSON, {
        collectionID: 'col1',
        collectionType: CollectionType.REST,
      });
    });

    it('should issue the same query on Cloud', async () => {
      const cloudClient = makeMockClient(ApiType.CLOUD);
      vi.mocked(cloudClient.graphql).mockResolvedValue({ exportUserCollectionToJSON: '{"a":1}' });

      const result = await new CollectionRepository(cloudClient).exportUserCollection(
        CollectionType.REST,
        'col1'
      );

      expect(result).toBe('{"a":1}');
      expect(cloudClient.graphql).toHaveBeenCalledWith(queries.EXPORT_USER_COLLECTION_JSON, {
        collectionID: 'col1',
        collectionType: CollectionType.REST,
      });
    });

    it('passes the collection-level data blob through create, update and export unchanged', async () => {
      // `data` carries collection-level auth/headers. It is an opaque string to
      // this client: it must survive a round trip byte-for-byte, never reparsed.
      const blob = JSON.stringify({
        v: 12,
        auth: { authActive: true, authType: 'bearer', token: 'tok' },
        headers: [{ key: 'X-Collection-Header', value: 'from-collection', active: true }],
      });

      vi.mocked(mockClient.graphql).mockResolvedValue({
        createRESTRootUserCollection: { id: 'c1', title: 'C', data: blob },
      });
      const created = await repository.createUserCollection(CollectionType.REST, {
        title: 'C',
        data: blob,
      });
      expect(created.data).toBe(blob);
      expect(vi.mocked(mockClient.graphql).mock.calls[0][1]).toMatchObject({ data: blob });

      vi.mocked(mockClient.graphql).mockResolvedValue({
        updateUserCollection: { id: 'c1', title: 'C', data: blob },
      });
      expect(
        (await repository.updateUserCollection('c1', CollectionType.REST, { data: blob })).data
      ).toBe(blob);

      vi.mocked(mockClient.graphql).mockResolvedValue({
        exportUserCollectionToJSON: JSON.stringify({ id: 'c1', name: 'C', data: blob }),
      });
      expect(await repository.exportUserCollection(CollectionType.REST, 'c1')).toContain(
        'X-Collection-Header'
      );
    });

    it('should throw when the backend returns nothing', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({});
      await expect(repository.exportUserCollection(CollectionType.REST)).rejects.toThrow(
        'Failed to export collection'
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
      const rawGql = { id: 'col1', title: 'Root Col', data: null };
      vi.mocked(mockClient.graphql).mockResolvedValue({ userCollection: rawGql });

      const result = await repository.getUserCollection('col1');
      expect(result.parentID).toBeNull();
    });

    it('stays gated on Cloud: the resolver cannot serialize data', async () => {
      vi.mocked(mockClient.getConfig).mockReturnValue({ apiType: ApiType.CLOUD });

      await expect(repository.getUserCollection('c1')).rejects.toThrow(
        'does not work on Hoppscotch Cloud'
      );
      expect(mockClient.graphql).not.toHaveBeenCalled();
    });
  });

  describe('createUserCollection', () => {
    it('should create a REST root collection and normalize parent', async () => {
      // The mutation selects id/title/data only; it cannot return `parent`.
      const rawGql = { id: 'new-col', title: 'New Collection', data: null };
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
      // No `parent` in the response: parentID must come from the input we sent.
      const rawGql = { id: 'child', title: 'Child', data: null };
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
      // The create mutations do not select parent; the caller chose the destination.
      const rawGql = { id: 'gql-col', title: 'GQL Col', data: null };
      vi.mocked(mockClient.graphql).mockResolvedValue({ createGQLRootUserCollection: rawGql });

      const result = await repository.createUserCollection(CollectionType.GQL, {
        title: 'GQL Col',
      });
      expect(result.id).toBe('gql-col');
    });
  });

  describe('updateUserCollection', () => {
    it('should send userCollectionID without reqType on SH', async () => {
      const rawGql = { id: 'col1', title: 'Updated', data: null };
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

    it('must not send reqType on Cloud: the mutation does not accept it', async () => {
      const cloudRepo = new CollectionRepository(makeMockClient(ApiType.CLOUD));
      const cloudMock = cloudRepo['client'] as unknown as { graphql: Mock };
      cloudMock.graphql = vi
        .fn()
        .mockResolvedValue({ updateUserCollection: { id: 'col1', title: 'Updated', data: null } });

      await cloudRepo.updateUserCollection('col1', CollectionType.REST, { title: 'Updated' });
      expect(cloudMock.graphql).toHaveBeenCalledWith(expect.any(String), {
        userCollectionID: 'col1',
        newTitle: 'Updated',
        data: undefined,
      });
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

    it('must not send reqType on Cloud: the mutation does not accept it', async () => {
      const cloudRepo = new CollectionRepository(makeMockClient(ApiType.CLOUD));
      const cloudMock = cloudRepo['client'] as unknown as { graphql: Mock };
      cloudMock.graphql = vi.fn().mockResolvedValue({});

      await cloudRepo.deleteUserCollection('col1', CollectionType.REST);
      expect(cloudMock.graphql).toHaveBeenCalledWith(expect.any(String), {
        userCollectionID: 'col1',
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

  describe('parentID honesty', () => {
    it('omits parentID on update, where the parent is unknowable', async () => {
      // updateUserCollection neither changes nor returns the parent. Reporting
      // null would claim the collection is a root, which may be false.
      vi.mocked(mockClient.graphql).mockResolvedValue({
        updateUserCollection: { id: 'col1', title: 'Updated', data: null },
      });

      const result = await repository.updateUserCollection('col1', CollectionType.REST, {
        title: 'Updated',
      });

      expect('parentID' in result).toBe(false);
    });

    it('reports parentID from the input on child create, not from the response', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        createRESTChildUserCollection: { id: 'child', title: 'Child', data: null },
      });

      const result = await repository.createUserCollection(CollectionType.REST, {
        title: 'Child',
        parentCollectionID: 'parent-col',
      });

      expect(result.parentID).toBe('parent-col');
    });
  });

  describe('moveUserCollection', () => {
    it('should send userCollectionID + destCollectionID and normalize parent', async () => {
      // No `parent` in the response: parentID must come from the destination we chose.
      const rawGql = { id: 'col1', title: 'Moved', data: null };
      vi.mocked(mockClient.graphql).mockResolvedValue({ moveUserCollection: rawGql });

      const result = await repository.moveUserCollection('col1', 'new-parent');
      expect(result.parentID).toBe('new-parent');
      expect(mockClient.graphql).toHaveBeenCalledWith(expect.any(String), {
        userCollectionID: 'col1',
        destCollectionID: 'new-parent',
      });
    });

    it('should send destCollectionID: null when moving to root', async () => {
      const rawGql = { id: 'col1', title: 'Root Col', data: null };
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

    it('should create root team collection and carry the caller-supplied teamID', async () => {
      // The mutation selects parent but never teamID; teamID is an argument.
      const rawGql = { id: 'new-team-col', title: 'New Team Col', data: null, parent: null };
      vi.mocked(mockClient.graphql).mockResolvedValue({ createRootCollection: rawGql });

      expect(await repository.createTeamCollection('team1', { title: 'New Team Col' })).toEqual({
        id: 'new-team-col',
        title: 'New Team Col',
        data: null,
        parentID: null,
        teamID: 'team1',
      });
    });

    it('should omit teamID when creating a child, since the parent owns it', async () => {
      // The child mutation sends only the parent collection; the caller's teamId
      // is never confirmed by the backend, so it must not be reported.
      const rawGql = { id: 'child-col', title: 'Child', data: null, parent: { id: 'parent-col' } };
      vi.mocked(mockClient.graphql).mockResolvedValue({ createChildCollection: rawGql });

      const result = await repository.createTeamCollection('team1', {
        title: 'Child',
        parentCollectionID: 'parent-col',
      });
      expect(result).toEqual({
        id: 'child-col',
        title: 'Child',
        data: null,
        parentID: 'parent-col',
      });
      expect('teamID' in result).toBe(false);
    });

    it('should update team collection, leaving parent and team unknown', async () => {
      // The mutation selects neither parent nor team, and update changes neither,
      // so both are omitted instead of being reported as root / empty string.
      const rawGql = { id: 'team-col1', title: 'Updated', data: null };
      vi.mocked(mockClient.graphql).mockResolvedValue({ updateTeamCollection: rawGql });

      const result = await repository.updateTeamCollection('team-col1', { title: 'Updated' });
      expect(result).toEqual({ id: 'team-col1', title: 'Updated', data: null });
      expect('parentID' in result).toBe(false);
      expect('teamID' in result).toBe(false);
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
      // No team query selects teamID and this one takes only a collection ID,
      // so it is omitted rather than reported as an empty string.
      expect(result).toEqual({
        id: 'team-col1',
        title: 'Team Col',
        parentID: 'parent-col',
        data: null,
      });
      expect('teamID' in result).toBe(false);
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
