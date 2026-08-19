import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RequestRepository } from './request-repository';
import type { HoppscotchClient } from '../client';
import { CollectionType } from '../types';
import { ApiType } from '../config';

describe('RequestRepository', () => {
  let repository: RequestRepository;
  let mockClient: HoppscotchClient;

  beforeEach(() => {
    mockClient = {
      graphql: vi.fn(),
      getConfig: vi.fn().mockReturnValue({ apiType: ApiType.SELFHOST }),
    } as unknown as HoppscotchClient;
    repository = new RequestRepository(mockClient);
  });

  const teamRequest = {
    id: 'tr1',
    title: 'Get Users',
    request: '{"method":"GET","endpoint":"https://api.example.com/users"}',
    collectionID: 'col1',
    teamID: 'team1',
  };

  const userRequest = {
    id: 'ur1',
    title: 'Post Item',
    request: '{"method":"POST","endpoint":"https://api.example.com/items"}',
    collectionID: 'ucol1',
    type: 'REST' as const,
  };

  // ─── Team Requests ──────────────────────────────────────────────────────────

  describe('getTeamRequests', () => {
    it('should return requests in a collection', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        requestsInCollection: [teamRequest],
      });

      const result = await repository.getTeamRequests('col1');

      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.anything(),
        { collectionID: 'col1', cursor: undefined }
      );
      expect(result).toEqual([teamRequest]);
    });

    it('should pass cursor when provided', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        requestsInCollection: [],
      });

      await repository.getTeamRequests('col1', 'cursor123');

      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.anything(),
        { collectionID: 'col1', cursor: 'cursor123' }
      );
    });

    it('should return empty array when requestsInCollection is null', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        requestsInCollection: null,
      });

      const result = await repository.getTeamRequests('col1');
      expect(result).toEqual([]);
    });
  });

  describe('getTeamRequest', () => {
    it('should return a single team request', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({ request: teamRequest });

      const result = await repository.getTeamRequest('tr1');

      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.anything(),
        { requestID: 'tr1' }
      );
      expect(result).toEqual(teamRequest);
    });
  });

  describe('createTeamRequest', () => {
    it('should create a request in a team collection', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        createRequestInCollection: teamRequest,
      });

      const result = await repository.createTeamRequest('col1', 'team1', {
        title: 'Get Users',
        request: '{"method":"GET","endpoint":"https://api.example.com/users"}',
      });

      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.anything(),
        {
          collectionID: 'col1',
          teamID: 'team1',
          title: 'Get Users',
          request: '{"method":"GET","endpoint":"https://api.example.com/users"}',
        }
      );
      expect(result).toEqual(teamRequest);
    });
  });

  describe('updateTeamRequest', () => {
    it('should update with full data (fetches current state first)', async () => {
      vi.mocked(mockClient.graphql)
        .mockResolvedValueOnce({ request: teamRequest }) // getTeamRequest fetch
        .mockResolvedValueOnce({ updateRequest: teamRequest }); // update mutation

      const result = await repository.updateTeamRequest('tr1', {
        title: 'Get Users',
        request: '{"method":"GET"}',
      });

      expect(mockClient.graphql).toHaveBeenCalledTimes(2);
      expect(mockClient.graphql).toHaveBeenNthCalledWith(2,
        expect.anything(),
        { requestID: 'tr1', title: 'Get Users', request: '{"method":"GET"}' }
      );
      expect(result).toEqual(teamRequest);
    });

    it('should preserve current title when only request is provided', async () => {
      vi.mocked(mockClient.graphql)
        .mockResolvedValueOnce({ request: teamRequest }) // getTeamRequest fetch
        .mockResolvedValueOnce({ updateRequest: teamRequest }); // update mutation

      await repository.updateTeamRequest('tr1', { request: '{"method":"GET"}' });

      expect(mockClient.graphql).toHaveBeenNthCalledWith(2,
        expect.anything(),
        { requestID: 'tr1', title: 'Get Users', request: '{"method":"GET"}' }
      );
    });

    it('should preserve current request when only title is provided', async () => {
      vi.mocked(mockClient.graphql)
        .mockResolvedValueOnce({ request: teamRequest }) // getTeamRequest fetch
        .mockResolvedValueOnce({ updateRequest: teamRequest }); // update mutation

      await repository.updateTeamRequest('tr1', { title: 'Updated' });

      expect(mockClient.graphql).toHaveBeenNthCalledWith(2,
        expect.anything(),
        { requestID: 'tr1', title: 'Updated', request: teamRequest.request }
      );
    });
  });

  describe('deleteTeamRequest', () => {
    it('should delete and return true', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({});

      const result = await repository.deleteTeamRequest('tr1');

      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.anything(),
        { requestID: 'tr1' }
      );
      expect(result).toBe(true);
    });
  });

  describe('moveTeamRequest', () => {
    it('should move a request to a different collection', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        moveRequest: { ...teamRequest, collectionID: 'col2' },
      });

      const result = await repository.moveTeamRequest('tr1', 'col2');

      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.anything(),
        { requestID: 'tr1', destCollID: 'col2' }
      );
      expect(result.collectionID).toBe('col2');
    });
  });

  // ─── User Requests ──────────────────────────────────────────────────────────

  describe('getUserRequests', () => {
    it('should return user requests on self-hosted', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        userCollection: { requests: [userRequest] },
      });

      const result = await repository.getUserRequests('ucol1');

      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.anything(),
        { userCollectionID: 'ucol1' }
      );
      expect(result).toEqual([userRequest]);
    });

    it('should throw on Cloud', async () => {
      vi.mocked(mockClient.getConfig).mockReturnValue({ apiType: ApiType.CLOUD });

      await expect(repository.getUserRequests('ucol1')).rejects.toThrow(
        'not supported on Hoppscotch Cloud'
      );
    });

    it('should return empty array when requests is null but collection exists', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        userCollection: { requests: null },
      });

      const result = await repository.getUserRequests('ucol1');
      expect(result).toEqual([]);
    });

    it('should throw when collection is not found (null)', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        userCollection: null,
      });

      await expect(repository.getUserRequests('bad-id')).rejects.toThrow(
        'User collection "bad-id" not found or not accessible.'
      );
    });
  });

  describe('createUserRequest', () => {
    it('should create a REST user request', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        createRESTUserRequest: userRequest,
      });

      const result = await repository.createUserRequest('ucol1', CollectionType.REST, {
        title: 'Post Item',
        request: '{"method":"POST"}',
      });

      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.anything(),
        { collectionID: 'ucol1', title: 'Post Item', request: '{"method":"POST"}' }
      );
      expect(result).toEqual(userRequest);
    });

    it('should create a GQL user request', async () => {
      const gqlRequest = { ...userRequest, type: 'GQL' as const };
      vi.mocked(mockClient.graphql).mockResolvedValue({
        createGQLUserRequest: gqlRequest,
      });

      const result = await repository.createUserRequest('ucol1', CollectionType.GQL, {
        title: 'Post Item',
        request: '{"query":"{ users }"}',
      });

      expect(result).toEqual(gqlRequest);
    });

    it('should throw when response key is missing', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({});

      await expect(
        repository.createUserRequest('ucol1', CollectionType.REST, {
          title: 'X',
          request: '{}',
        })
      ).rejects.toThrow('Failed to create user request');
    });
  });

  describe('updateUserRequest', () => {
    it('should update a REST user request', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        updateRESTUserRequest: userRequest,
      });

      const result = await repository.updateUserRequest('ur1', CollectionType.REST, {
        title: 'Updated',
      });

      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.anything(),
        { id: 'ur1', title: 'Updated', request: undefined }
      );
      expect(result).toEqual(userRequest);
    });

    it('should update a GQL user request', async () => {
      const gqlRequest = { ...userRequest, type: 'GQL' as const };
      vi.mocked(mockClient.graphql).mockResolvedValue({
        updateGQLUserRequest: gqlRequest,
      });

      const result = await repository.updateUserRequest('ur1', CollectionType.GQL, {
        request: '{"query":"{ items }"}',
      });

      expect(result).toEqual(gqlRequest);
    });

    it('should throw when response key is missing', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({});

      await expect(
        repository.updateUserRequest('ur1', CollectionType.REST, { title: 'X' })
      ).rejects.toThrow('Failed to update user request');
    });
  });

  describe('deleteUserRequest', () => {
    it('should delete and return true', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({});

      const result = await repository.deleteUserRequest('ur1');

      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.anything(),
        { id: 'ur1' }
      );
      expect(result).toBe(true);
    });
  });

  describe('moveUserRequest', () => {
    it('should move a user request between collections', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        moveUserRequest: { ...userRequest, collectionID: 'ucol2' },
      });

      const result = await repository.moveUserRequest('ur1', 'ucol1', 'ucol2');

      expect(mockClient.graphql).toHaveBeenCalledWith(
        expect.anything(),
        {
          requestID: 'ur1',
          sourceCollectionID: 'ucol1',
          destinationCollectionID: 'ucol2',
        }
      );
      expect(result.collectionID).toBe('ucol2');
    });
  });

  describe('searchTeamRequests', () => {
    it('returns the raw searchForRequest rows (request id+title with parent collection)', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({
        searchForRequest: [
          { id: 'req1', title: 'Get Users', collection: { id: 'col1', title: 'User API' } },
        ],
      });
      expect(await repository.searchTeamRequests('team1', 'user')).toEqual([
        { id: 'req1', title: 'Get Users', collection: { id: 'col1', title: 'User API' } },
      ]);
    });

    it('returns an empty array when no matches', async () => {
      vi.mocked(mockClient.graphql).mockResolvedValue({ searchForRequest: [] });
      expect(await repository.searchTeamRequests('team1', 'noop')).toEqual([]);
    });
  });
});
