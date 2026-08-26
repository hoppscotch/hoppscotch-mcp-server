import { describe, it, expect } from 'vitest';
import {
  ListUserCollectionsSchema,
  CreateUserCollectionSchema,
  UpdateUserCollectionSchema,
  DeleteUserCollectionSchema,
  ExportUserCollectionSchema,
  ImportUserCollectionSchema,
  DuplicateUserCollectionSchema,
  MoveUserCollectionSchema,
  ValidateResponseSchema,
  CollectionTypeSchema,
  CreateTeamCollectionSchema,
  MoveTeamCollectionSchema,
  ImportTeamCollectionSchema,
  ExportTeamCollectionSchema,
} from './schemas';

describe('CollectionTypeSchema coercion', () => {
  describe('ListUserCollectionsSchema', () => {
    it('defaults type to REST when omitted', () => {
      expect(ListUserCollectionsSchema.parse({}).type).toBe('REST');
    });

    it('coerces empty string to REST', () => {
      expect(ListUserCollectionsSchema.parse({ type: '' }).type).toBe('REST');
    });

    it('accepts REST explicitly', () => {
      expect(ListUserCollectionsSchema.parse({ type: 'REST' }).type).toBe('REST');
    });

    it('accepts GQL', () => {
      expect(ListUserCollectionsSchema.parse({ type: 'GQL' }).type).toBe('GQL');
    });

    it('rejects invalid values', () => {
      expect(() => ListUserCollectionsSchema.parse({ type: 'INVALID' })).toThrow();
    });
  });

  describe('CreateUserCollectionSchema', () => {
    it('defaults type to REST when omitted', () => {
      expect(CreateUserCollectionSchema.parse({ title: 'My Col' }).type).toBe('REST');
    });

    it('coerces empty string to REST', () => {
      expect(CreateUserCollectionSchema.parse({ title: 'My Col', type: '' }).type).toBe('REST');
    });
  });

  describe('UpdateUserCollectionSchema', () => {
    it('defaults type to REST', () => {
      expect(UpdateUserCollectionSchema.parse({ collectionId: 'abc' }).type).toBe('REST');
    });
  });

  describe('DeleteUserCollectionSchema', () => {
    it('defaults type to REST', () => {
      expect(DeleteUserCollectionSchema.parse({ collectionId: 'abc' }).type).toBe('REST');
    });
  });

  describe('ExportUserCollectionSchema', () => {
    it('defaults type to REST when omitted', () => {
      expect(ExportUserCollectionSchema.parse({}).type).toBe('REST');
    });

    it('coerces empty string to REST', () => {
      expect(ExportUserCollectionSchema.parse({ type: '' }).type).toBe('REST');
    });
  });

  describe('ImportUserCollectionSchema', () => {
    it('defaults type to REST when omitted', () => {
      expect(ImportUserCollectionSchema.parse({ jsonString: '[]' }).type).toBe('REST');
    });
  });

  describe('DuplicateUserCollectionSchema', () => {
    it('defaults type to REST', () => {
      expect(DuplicateUserCollectionSchema.parse({ collectionId: 'abc' }).type).toBe('REST');
    });
  });
});

describe('MoveUserCollectionSchema — parentCollectionId rename + alias', () => {
  it('accepts parentCollectionId (the primary, consistent name)', () => {
    const v = MoveUserCollectionSchema.parse({ collectionId: 'c1', parentCollectionId: 'p1' });
    expect(v.parentCollectionId).toBe('p1');
  });

  it('still accepts the deprecated newParentId alias (backward compatibility)', () => {
    const v = MoveUserCollectionSchema.parse({ collectionId: 'c1', newParentId: 'p1' });
    expect(v.newParentId).toBe('p1');
  });

  it('accepts both when they agree', () => {
    const v = MoveUserCollectionSchema.parse({
      collectionId: 'c1',
      parentCollectionId: 'p1',
      newParentId: 'p1',
    });
    expect(v.parentCollectionId).toBe('p1');
  });

  it('rejects parentCollectionId and newParentId when they differ (ambiguous target)', () => {
    expect(() =>
      MoveUserCollectionSchema.parse({
        collectionId: 'c1',
        parentCollectionId: 'p1',
        newParentId: 'p2',
      })
    ).toThrow();
  });

  it('rejects a mistyped target key instead of silently moving to root (strict)', () => {
    // `parentId` is dropped by a non-strict schema, leaving the move targeting
    // root: silent data movement. Strict surfaces it as an error.
    expect(() => MoveUserCollectionSchema.parse({ collectionId: 'c1', parentId: 'p1' })).toThrow();
  });

  it('allows omitting the parent entirely (intentional move-to-root)', () => {
    const v = MoveUserCollectionSchema.parse({ collectionId: 'c1' });
    expect(v.parentCollectionId).toBeUndefined();
    expect(v.newParentId).toBeUndefined();
  });
});

describe('ValidateResponseSchema — optional timeout', () => {
  const base = { method: 'GET' as const, url: 'https://api.example.com/x', criteria: {} };

  it('accepts an in-range timeout and surfaces it for the handler to thread', () => {
    const v = ValidateResponseSchema.parse({ ...base, timeout: 5000 });
    expect(v.timeout).toBe(5000);
  });

  it('omits timeout when not provided (handler falls back to the server default)', () => {
    expect(ValidateResponseSchema.parse(base).timeout).toBeUndefined();
  });

  it('rejects an out-of-range timeout (mirrors execute_request bounds)', () => {
    expect(() => ValidateResponseSchema.parse({ ...base, timeout: 500 })).toThrow();
    expect(() => ValidateResponseSchema.parse({ ...base, timeout: 999999 })).toThrow();
  });
});

describe('identifier and type coercion guards', () => {
  it('rejects empty-string parent identifiers rather than treating them as root', () => {
    const cases = [
      ['create user', CreateUserCollectionSchema, { title: 'x', type: 'REST' }],
      ['import user', ImportUserCollectionSchema, { jsonString: '{}', type: 'REST' }],
      ['create team', CreateTeamCollectionSchema, { title: 'x' }],
      ['move team', MoveTeamCollectionSchema, { collectionId: 'c1' }],
      ['import team', ImportTeamCollectionSchema, { jsonString: '{}' }],
      ['move user', MoveUserCollectionSchema, { collectionId: 'c1' }],
    ] as const;

    for (const [label, schema, base] of cases) {
      expect(schema.safeParse({ ...base, parentCollectionId: '' }).success, label).toBe(false);
    }
    expect(
      MoveUserCollectionSchema.safeParse({ collectionId: 'c1', newParentId: '' }).success
    ).toBe(false);
  });

  it('rejects an empty export collectionId, which would silently widen to export-all', () => {
    expect(ExportUserCollectionSchema.safeParse({ type: 'REST', collectionId: '' }).success).toBe(
      false
    );
    expect(ExportTeamCollectionSchema.safeParse({ collectionId: '' }).success).toBe(false);
    // Omitting it is still the documented way to ask for everything.
    expect(ExportUserCollectionSchema.safeParse({ type: 'REST' }).success).toBe(true);
  });

  it('defaults only blank collection types, rejecting other falsy values', () => {
    for (const blank of ['', null, undefined]) {
      expect(CollectionTypeSchema.parse(blank)).toBe('REST');
    }
    for (const falsy of [false, 0]) {
      expect(CollectionTypeSchema.safeParse(falsy).success).toBe(false);
    }
  });
});
