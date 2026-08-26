/**
 * End-to-end integration tests for the Hoppscotch MCP server.
 *
 * Spawns the built MCP server (dist/index.js) via stdio and calls tools
 * through the MCP SDK client, the exact same transport Claude uses.
 *
 * Usage:
 *   npm run build
 *   HOPPSCOTCH_E2E=1 npx vitest run src/e2e/e2e.test.ts
 *
 * Only HOPPSCOTCH_TEAM_ID is required from .env; all other resources
 * (team collections, team environments, personal collections) are
 * self-provisioned in beforeAll and cleaned up in afterAll.
 * Auth token must already be stored (~/.config/hoppscotch-mcp/auth.json)
 * OR HOPPSCOTCH_ACCESS_TOKEN must be set.
 *
 * Cloud behavior as of now (not bugs):
 * - get_user_collection, list_user_requests: not supported on Cloud
 * - all four user_environment tools: not supported on Cloud
 * - search_team_requests: returns bug/team/no_require_team_role on Cloud (backend rejection)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { config as loadDotenv } from 'dotenv';

// Load .env so IDs are available even when running from CLI
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });

const ENABLED = process.env.HOPPSCOTCH_E2E === '1';
const SERVER_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/index.js');

// Only TEAM_ID is required from .env; everything else is self-provisioned
const TEAM_ID = process.env.HOPPSCOTCH_TEAM_ID ?? '';
// Mirror isCloudUrl() in src/config.ts: an explicitly configured
// https://hoppscotch.io is Cloud too, not self-hosted.
const IS_CLOUD = (() => {
  const raw = process.env.HOPPSCOTCH_SERVER_URL;
  if (!raw) return true; // default target is Cloud
  try {
    const h = new URL(raw).hostname;
    return h === 'hoppscotch.io' || h === 'www.hoppscotch.io';
  } catch {
    return false;
  }
})();

// Self-provisioned in beforeAll, cleaned up in afterAll
let TEAM_COLLECTION_ID = '';
let TEAM_ENVIRONMENT_ID = '';
let PERSONAL_REST_COLLECTION_ID = '';
let PERSONAL_GQL_COLLECTION_ID = '';

// Track provisioned resources for guaranteed cleanup
const provisioned = {
  teamCollectionId: '',
  teamEnvironmentId: '',
  personalRestCollectionId: '',
  personalGqlCollectionId: '',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: string; text: string }> };

function textOf(result: unknown): string {
  const r = result as ToolResult;
  return (r?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

function jsonOf<T = unknown>(text: string): T {
  // Extract first JSON block from the text (may have a prose header line)
  const match = text.match(/(\[|\{)[\s\S]*/);
  if (!match) throw new Error(`No JSON found in: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]) as T;
}

function log(label: string, text: string) {
  const preview = text.length > 800 ? text.slice(0, 800) + '…' : text;
  console.log(`\n[e2e] ${label}:\n${preview}\n`);
}

// List team collection IDs (for cleanup-by-diff after import/duplicate operations).
async function teamCollections(): Promise<Array<{ id: string; title: string }> | null> {
  try {
    const text = textOf(
      await client.callTool({
        name: 'list_team_collections',
        arguments: { teamId: TEAM_ID },
      })
    );
    return jsonOf<Array<{ id: string; title: string }>>(text);
  } catch {
    console.log('[e2e] could not list team collections; skipping diff cleanup');
    return null;
  }
}

// List user collection IDs. Works on both backends.
// Returns null when the listing could not be read. That is NOT the same as an
// empty workspace: cleanup-by-diff treats every id in `after` that is missing
// from `before` as an orphan, so a failed `before` collapsing to [] would make
// the whole listing look new and delete real collections.
async function userCollections(): Promise<Array<{ id: string; title: string }> | null> {
  try {
    const text = textOf(
      await client.callTool({
        name: 'list_user_collections',
        arguments: {},
      })
    );
    return jsonOf<Array<{ id: string; title: string }>>(text);
  } catch {
    console.log('[e2e] could not list user collections; skipping diff cleanup');
    return null;
  }
}

// Delete collections that appear in `after` but not in `before` (orphan cleanup).
// Cleanup deletes only rows that (a) are new since the baseline AND (b) carry
// ORPHAN_TAG. Deleting on "new since baseline" alone would also remove rows a
// real user created concurrently, and the listing is capped at one page, so a
// row scrolling into view reads as new.
//
// The nonce is random, not pid+time: two runs on different hosts can share a
// pid and a millisecond, and a collision means one run deletes the other's rows.
const E2E_PREFIX = 'e2e-';
const RUN_TAG = `${E2E_PREFIX}${randomUUID().slice(0, 8)}-`;
// Long-lived fixtures other tests depend on. Never cleanup-eligible: a fixture
// churning into a later page would otherwise read as an orphan and be deleted
// out from under the tests still using it.
const FIXTURE_TAG = `${RUN_TAG}fixture-`;
// Rows a single test creates and may fail to delete by ID.
const ORPHAN_TAG = `${RUN_TAG}tmp-`;

type Coll = { id: string; title: string };

function newlyOwned(before: Coll[] | null, after: Coll[] | null): Coll[] {
  if (before === null || after === null) {
    console.log('[e2e] skipping orphan cleanup: baseline unknown');
    return [];
  }
  const beforeIds = new Set(before.map((c) => c.id));
  return after.filter((c) => !beforeIds.has(c.id) && (c.title ?? '').startsWith(ORPHAN_TAG));
}

async function cleanupOrphanTeamCollections(before: Coll[] | null, after: Coll[] | null) {
  for (const c of newlyOwned(before, after)) {
    try {
      await client.callTool({ name: 'delete_team_collection', arguments: { collectionId: c.id } });
    } catch (e) {
      console.error('[e2e] cleanup failed:', e);
    }
  }
}

async function cleanupOrphanUserCollections(before: Coll[] | null, after: Coll[] | null) {
  for (const c of newlyOwned(before, after)) {
    try {
      await client.callTool({
        name: 'delete_user_collection',
        arguments: { collectionId: c.id, type: 'REST' },
      });
    } catch (e) {
      console.error('[e2e] cleanup failed:', e);
    }
  }
}

// Assert that `obj` has exactly the specified keys with the right value types.
// Pass `'any'` to accept any type without checking the value itself.
function assertShape(
  obj: Record<string, unknown>,
  shape: Record<
    string,
    'string' | 'number' | 'boolean' | 'object' | 'any' | 'string|null' | 'object|null'
  >
) {
  for (const [key, expected] of Object.entries(shape)) {
    expect(obj, `expected key "${key}" to exist`).toHaveProperty(key);
    if (expected === 'any') continue;
    const actual = typeof obj[key];
    if (expected === 'string|null') {
      expect(
        obj[key] === null || actual === 'string',
        `expected "${key}" to be string|null, got ${actual} (${JSON.stringify(obj[key])})`
      ).toBe(true);
    } else if (expected === 'object|null') {
      expect(
        obj[key] === null || (actual === 'object' && !Array.isArray(obj[key])),
        `expected "${key}" to be object|null, got ${actual} (${JSON.stringify(obj[key])})`
      ).toBe(true);
    } else {
      expect(actual, `expected "${key}" to be ${expected}, got ${actual}`).toBe(expected);
    }
  }
}

// ---------------------------------------------------------------------------
// Client setup
// ---------------------------------------------------------------------------

let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  if (!ENABLED) return;

  transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_ENTRY],
    env: Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined)
    ) as Record<string, string>,
  });

  client = new Client({ name: 'e2e-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  // Self-provision resources
  if (TEAM_ID) {
    const colText = textOf(
      await client.callTool({
        name: 'create_team_collection',
        arguments: { teamId: TEAM_ID, title: `${FIXTURE_TAG}collection` },
      })
    );
    const col = jsonOf<{ id: string }>(colText);
    TEAM_COLLECTION_ID = col.id;
    provisioned.teamCollectionId = col.id;

    const envText = textOf(
      await client.callTool({
        name: 'create_team_environment',
        arguments: {
          teamId: TEAM_ID,
          name: `${FIXTURE_TAG}env`,
          variables: [{ key: 'BASE_URL', value: 'https://example.com' }],
        },
      })
    );
    const env = jsonOf<{ id: string }>(envText);
    TEAM_ENVIRONMENT_ID = env.id;
    provisioned.teamEnvironmentId = env.id;
  }

  // Personal collections. create_user_collection is ungated on BOTH backends, so
  // a failure here is a real defect, not an unsupported-on-Cloud condition.
  // It must fail the suite: swallowing it leaves the IDs unset, every dependent
  // test early-returns, and the run reports green while proving nothing.
  {
    const restText = textOf(
      await client.callTool({
        name: 'create_user_collection',
        arguments: { title: `${FIXTURE_TAG}rest`, type: 'REST' },
      })
    );
    const restCol = jsonOf<{ id: string }>(restText);
    PERSONAL_REST_COLLECTION_ID = restCol.id;
    provisioned.personalRestCollectionId = restCol.id;

    const gqlText = textOf(
      await client.callTool({
        name: 'create_user_collection',
        arguments: { title: `${FIXTURE_TAG}gql`, type: 'GQL' },
      })
    );
    const gqlCol = jsonOf<{ id: string }>(gqlText);
    PERSONAL_GQL_COLLECTION_ID = gqlCol.id;
    provisioned.personalGqlCollectionId = gqlCol.id;
  }

  console.log(
    `[e2e] Connected. TEAM_ID=${TEAM_ID} COL=${TEAM_COLLECTION_ID} ENV=${TEAM_ENVIRONMENT_ID} REST=${PERSONAL_REST_COLLECTION_ID} GQL=${PERSONAL_GQL_COLLECTION_ID}`
  );
}, 120_000);

afterAll(async () => {
  if (!ENABLED) return;

  // Guaranteed cleanup: delete provisioned resources in reverse order
  const cleanup = async (name: string, args: Record<string, unknown>) => {
    try {
      await client.callTool({ name, arguments: args });
    } catch {
      /* best-effort */
    }
  };

  if (provisioned.personalGqlCollectionId) {
    await cleanup('delete_user_collection', {
      collectionId: provisioned.personalGqlCollectionId,
      type: 'GQL',
    });
  }
  if (provisioned.personalRestCollectionId) {
    await cleanup('delete_user_collection', {
      collectionId: provisioned.personalRestCollectionId,
      type: 'REST',
    });
  }
  if (provisioned.teamEnvironmentId) {
    await cleanup('delete_team_environment', { environmentId: provisioned.teamEnvironmentId });
  }
  if (provisioned.teamCollectionId) {
    await cleanup('delete_team_collection', { collectionId: provisioned.teamCollectionId });
  }

  await client?.close();
}, 60_000);

// ---------------------------------------------------------------------------
// e2e() helper, skips when HOPPSCOTCH_E2E is not set
// ---------------------------------------------------------------------------

function e2e(name: string, fn: () => Promise<void>, timeout = 30_000) {
  it(
    name,
    async () => {
      if (!ENABLED) {
        console.log(`[e2e] Skipped (set HOPPSCOTCH_E2E=1 to run): ${name}`);
        return;
      }
      await fn();
    },
    timeout
  );
}

// ---------------------------------------------------------------------------
// Server metadata
// ---------------------------------------------------------------------------

describe('server metadata', () => {
  e2e('lists all registered tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    log('available tools', names.join(', '));

    // Exact set of registered tools; adding or removing a tool will surface here
    expect(names).toMatchInlineSnapshot(`
      [
        "create_team",
        "create_team_collection",
        "create_team_environment",
        "create_team_request",
        "create_user_collection",
        "create_user_environment",
        "create_user_request",
        "delete_team",
        "delete_team_collection",
        "delete_team_environment",
        "delete_team_request",
        "delete_user_collection",
        "delete_user_environment",
        "delete_user_request",
        "duplicate_team_collection",
        "duplicate_user_collection",
        "execute_request",
        "export_team_collection",
        "export_user_collection",
        "generate_code",
        "generate_documentation",
        "get_team_collection",
        "get_team_info",
        "get_team_request",
        "get_user_collection",
        "import_team_collection",
        "import_user_collection",
        "invite_team_member",
        "leave_team",
        "list_team_collections",
        "list_team_environments",
        "list_team_requests",
        "list_teams",
        "list_user_collections",
        "list_user_environments",
        "list_user_requests",
        "move_team_collection",
        "move_team_request",
        "move_user_collection",
        "move_user_request",
        "remove_team_member",
        "rename_team",
        "revoke_team_invitation",
        "search_team_requests",
        "update_team_collection",
        "update_team_environment",
        "update_team_member_role",
        "update_team_request",
        "update_user_collection",
        "update_user_environment",
        "update_user_request",
        "validate_response",
      ]
    `);
  });
});

// ---------------------------------------------------------------------------
// Team management
// ---------------------------------------------------------------------------

describe('teams', () => {
  e2e('list_teams — returns array of teams with expected shape', async () => {
    const text = textOf(await client.callTool({ name: 'list_teams', arguments: {} }));
    log('list_teams', text);

    expect(text).not.toMatch(/auth\/fail/i);
    expect(text).not.toMatch(/^Error:/);
    // First line is "Found N team(s)"
    expect(text).toMatch(/^Found \d+ team\(s\)/);

    const teams = jsonOf<Record<string, unknown>[]>(text);
    expect(Array.isArray(teams)).toBe(true);
    expect(teams.length).toBeGreaterThan(0);
    // Each team has id, name, myRole, teamMembers
    for (const team of teams) {
      assertShape(team, {
        id: 'string',
        name: 'string',
        myRole: 'string',
      });
      expect(['OWNER', 'EDITOR', 'VIEWER']).toContain(team.myRole);
      expect(Array.isArray(team.teamMembers)).toBe(true);
    }
  });

  e2e('get_team_info — returns single team with member details', async () => {
    if (!TEAM_ID) {
      console.log('[e2e] skip: no TEAM_ID');
      return;
    }
    const text = textOf(
      await client.callTool({ name: 'get_team_info', arguments: { teamId: TEAM_ID } })
    );
    log('get_team_info', text);

    expect(text).not.toMatch(/auth\/fail/i);
    expect(text).not.toMatch(/^Error:/);

    const team = jsonOf<Record<string, unknown>>(text);
    assertShape(team, { id: 'string', name: 'string', myRole: 'string' });
    expect(team.id).toBe(TEAM_ID);
    expect(Array.isArray(team.teamMembers)).toBe(true);
    // Each member should have role and user fields
    const members = team.teamMembers as Array<Record<string, unknown>>;
    if (members.length > 0) {
      assertShape(members[0], { role: 'string', user: 'object' });
    }
  });
});

// ---------------------------------------------------------------------------
// Team management (write)
// ---------------------------------------------------------------------------

describe('team management', () => {
  e2e('create_team, rename_team, delete_team — full lifecycle', async () => {
    // Create
    const createText = textOf(
      await client.callTool({
        name: 'create_team',
        arguments: { name: 'e2e-test-team' },
      })
    );
    log('create_team', createText);
    expect(createText).toMatch(/Successfully created/);
    const team = jsonOf<{ id: string; name: string; myRole: string }>(createText);
    expect(team.name).toBe('e2e-test-team');
    expect(team.myRole).toBe('OWNER');

    try {
      // Rename
      const renameText = textOf(
        await client.callTool({
          name: 'rename_team',
          arguments: { teamId: team.id, newName: 'e2e-test-team-renamed' },
        })
      );
      log('rename_team', renameText);
      expect(renameText).toMatch(/Successfully renamed/);
      const renamed = jsonOf<{ name: string }>(renameText);
      expect(renamed.name).toBe('e2e-test-team-renamed');
    } finally {
      // Delete (best-effort, don't mask the original test failure)
      try {
        const deleteText = textOf(
          await client.callTool({
            name: 'delete_team',
            arguments: { teamId: team.id },
          })
        );
        log('delete_team', deleteText);
        expect(deleteText).toMatch(/Successfully deleted/);
      } catch (e) {
        console.error('[e2e] cleanup delete_team failed:', e);
      }
    }
  });

  // invite_team_member, revoke_team_invitation, remove_team_member,
  // update_team_member_role, leave_team: not tested in e2e because they
  // require real registered users or risk locking out the test account.
  // These are covered by the tool-list snapshot (wiring) and unit tests.
});

// ---------------------------------------------------------------------------
// Team collections (read-only)
// ---------------------------------------------------------------------------

describe('team collections – read', () => {
  e2e('list_team_collections — returns array with collection shape', async () => {
    if (!TEAM_ID) {
      console.log('[e2e] skip: no TEAM_ID');
      return;
    }
    const text = textOf(
      await client.callTool({ name: 'list_team_collections', arguments: { teamId: TEAM_ID } })
    );
    log('list_team_collections', text);

    expect(text).not.toMatch(/auth\/fail/i);
    expect(text).not.toMatch(/^Error:/);

    const collections = jsonOf<Record<string, unknown>[]>(text);
    expect(Array.isArray(collections)).toBe(true);
    // Each collection has id, title, data, parentID, teamID
    for (const col of collections) {
      assertShape(col, {
        id: 'string',
        title: 'string',
        parentID: 'string|null',
        teamID: 'string',
      });
    }
  });

  e2e('get_team_collection — returns single collection with matching ID', async () => {
    if (!TEAM_COLLECTION_ID) {
      console.log('[e2e] skip: no TEAM_COLLECTION_ID');
      return;
    }
    const text = textOf(
      await client.callTool({
        name: 'get_team_collection',
        arguments: { collectionId: TEAM_COLLECTION_ID },
      })
    );
    log('get_team_collection', text);

    expect(text).not.toMatch(/auth\/fail/i);
    expect(text).not.toMatch(/^Error:/);

    const col = jsonOf<Record<string, unknown>>(text);
    assertShape(col, {
      id: 'string',
      title: 'string',
      parentID: 'string|null',
    });
    // The query takes only a collection ID, so the owning team is unknown.
    expect('teamID' in col).toBe(false);
    expect(col.id).toBe(TEAM_COLLECTION_ID);
  });

  e2e('export_team_collection — returns valid Hoppscotch collection JSON', async () => {
    if (!TEAM_ID || !TEAM_COLLECTION_ID) {
      console.log('[e2e] skip: no TEAM_ID/TEAM_COLLECTION_ID');
      return;
    }
    const text = textOf(
      await client.callTool({
        name: 'export_team_collection',
        arguments: { teamId: TEAM_ID, collectionId: TEAM_COLLECTION_ID },
      })
    );
    log('export_team_collection', text);

    expect(text).not.toMatch(/auth\/fail/i);
    expect(text).not.toMatch(/^Error:/);
    // First content part is the prose label
    expect(text).toMatch(/Exported team collection/);
    // Second content part is the JSON, which must have name, folders, requests
    const exported = jsonOf<Record<string, unknown>>(text);
    assertShape(exported, {
      id: 'string',
      name: 'string',
    });
    expect(Array.isArray(exported.folders)).toBe(true);
    expect(Array.isArray(exported.requests)).toBe(true);
  });

  e2e('search_team_requests — Cloud returns known API limitation error', async () => {
    if (!TEAM_ID) {
      console.log('[e2e] skip: no TEAM_ID');
      return;
    }
    const text = textOf(
      await client.callTool({
        name: 'search_team_requests',
        arguments: { query: 'test', teamId: TEAM_ID },
      })
    );
    log('search_team_requests', text);

    // Cloud returns bug/team/no_require_team_role, a confirmed Cloud API limitation
    expect(text).not.toMatch(/auth\/fail/i);
    // Either results array or the known Cloud error
    const isCloudLimitation = text.includes('bug/team/no_require_team_role');
    const isResults = text.includes('Found');
    expect(isCloudLimitation || isResults).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Team collections (write: create, duplicate, delete; self-contained)
// ---------------------------------------------------------------------------

describe('team collections – write', () => {
  e2e('create, update, delete team collection — full lifecycle', async () => {
    if (!TEAM_ID) {
      console.log('[e2e] skip: no TEAM_ID');
      return;
    }

    // Create
    const createText = textOf(
      await client.callTool({
        name: 'create_team_collection',
        arguments: { teamId: TEAM_ID, title: 'e2e-test-collection' },
      })
    );
    log('create_team_collection', createText);

    expect(createText).not.toMatch(/auth\/fail/i);
    expect(createText).not.toMatch(/^Error:/);
    expect(createText).toMatch(
      /^Successfully created team collection "e2e-test-collection" \(ID: \S+\)/m
    );

    const col = jsonOf<Record<string, unknown>>(createText);
    assertShape(col, { id: 'string', title: 'string', parentID: 'string|null' });
    expect(col.title).toBe('e2e-test-collection');
    const collectionId = col.id as string;

    try {
      // Update
      const updateText = textOf(
        await client.callTool({
          name: 'update_team_collection',
          arguments: { collectionId, title: 'e2e-test-collection-updated' },
        })
      );
      log('update_team_collection', updateText);
      expect(updateText).toMatch(/Successfully updated/);
      const updated = jsonOf<Record<string, unknown>>(updateText);
      expect(updated.title).toBe('e2e-test-collection-updated');
      expect(updated.id).toBe(collectionId);
    } finally {
      // Delete (best-effort, don't mask the original test failure)
      try {
        const deleteText = textOf(
          await client.callTool({
            name: 'delete_team_collection',
            arguments: { collectionId },
          })
        );
        log('delete_team_collection', deleteText);
        expect(deleteText).toMatch(/^Successfully deleted team collection \(ID: \S+\)$/);
      } catch (e) {
        console.error('[e2e] cleanup delete_team_collection failed:', e);
      }
    }
  });

  e2e('duplicate_team_collection — returns success message', async () => {
    if (!TEAM_ID) {
      console.log('[e2e] skip: no TEAM_ID');
      return;
    }

    const before = await teamCollections();

    const createText = textOf(
      await client.callTool({
        name: 'create_team_collection',
        arguments: { teamId: TEAM_ID, title: `${ORPHAN_TAG}dup-source` },
      })
    );
    const srcId = jsonOf<Record<string, unknown>>(createText).id as string;
    if (!srcId) {
      console.log('[e2e] skip dup: create source failed');
      return;
    }

    try {
      const dupText = textOf(
        await client.callTool({
          name: 'duplicate_team_collection',
          arguments: { collectionId: srcId },
        })
      );
      log('duplicate_team_collection', dupText);
      expect(dupText).not.toMatch(/auth\/fail/i);
      expect(dupText).not.toMatch(/^Error:/);
      // Returns boolean true from GQL; the server returns a prose message
      expect(dupText).toMatch(/^Successfully duplicated team collection \(ID: \S+\)$/);
    } finally {
      // Delete source + any orphaned duplicate (API returns no ID for the duplicate)
      await client.callTool({ name: 'delete_team_collection', arguments: { collectionId: srcId } });
      const after = await teamCollections();
      await cleanupOrphanTeamCollections(before, after);
    }
  });

  e2e('import_team_collection — returns success message', async () => {
    if (!TEAM_ID) {
      console.log('[e2e] skip: no TEAM_ID');
      return;
    }

    const before = await teamCollections();

    const importText = textOf(
      await client.callTool({
        name: 'import_team_collection',
        arguments: {
          teamId: TEAM_ID,
          jsonString: JSON.stringify({ name: `${ORPHAN_TAG}imported`, folders: [], requests: [] }),
        },
      })
    );
    log('import_team_collection', importText);
    expect(importText).not.toMatch(/auth\/fail/i);
    expect(importText).toMatchInlineSnapshot(`"Successfully imported team collection(s)"`);

    // Cleanup: API returns no ID for the imported collection, so diff and delete orphans
    const after = await teamCollections();
    await cleanupOrphanTeamCollections(before, after);
  });

  e2e('move_team_collection — creates parent + child, moves child to root, cleans up', async () => {
    if (!TEAM_ID) {
      console.log('[e2e] skip: no TEAM_ID');
      return;
    }

    // Create parent
    const parentText = textOf(
      await client.callTool({
        name: 'create_team_collection',
        arguments: { teamId: TEAM_ID, title: 'e2e-move-parent' },
      })
    );
    const parentId = jsonOf<{ id: string }>(parentText).id;

    // Create child under parent
    const childText = textOf(
      await client.callTool({
        name: 'create_team_collection',
        arguments: { teamId: TEAM_ID, title: 'e2e-move-child', parentCollectionId: parentId },
      })
    );
    const childId = jsonOf<{ id: string }>(childText).id;

    try {
      // Move child to root
      const moveText = textOf(
        await client.callTool({
          name: 'move_team_collection',
          arguments: { collectionId: childId },
        })
      );
      log('move_team_collection', moveText);
      expect(moveText).toMatch(/Successfully moved/);
    } finally {
      // Cleanup
      try {
        await client.callTool({
          name: 'delete_team_collection',
          arguments: { collectionId: childId },
        });
      } catch (e) {
        console.error('[e2e] cleanup failed:', e);
      }
      try {
        await client.callTool({
          name: 'delete_team_collection',
          arguments: { collectionId: parentId },
        });
      } catch (e) {
        console.error('[e2e] cleanup failed:', e);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Team environments
// ---------------------------------------------------------------------------

describe('team environments', () => {
  e2e('list_team_environments — returns array with env shape', async () => {
    if (!TEAM_ID) {
      console.log('[e2e] skip: no TEAM_ID');
      return;
    }
    const text = textOf(
      await client.callTool({ name: 'list_team_environments', arguments: { teamId: TEAM_ID } })
    );
    log('list_team_environments', text);

    expect(text).not.toMatch(/auth\/fail/i);
    expect(text).not.toMatch(/^Error:/);

    const envs = jsonOf<Record<string, unknown>[]>(text);
    expect(Array.isArray(envs)).toBe(true);
    for (const env of envs) {
      assertShape(env, { id: 'string', teamID: 'string', name: 'string', variables: 'string' });
      // variables is a JSON string of array
      const vars = JSON.parse(env.variables as string);
      expect(Array.isArray(vars)).toBe(true);
    }

    // If TEAM_ENVIRONMENT_ID is set, verify it appears in the list
    if (TEAM_ENVIRONMENT_ID) {
      const found = envs.find((e) => e.id === TEAM_ENVIRONMENT_ID);
      expect(found).toBeDefined();
      expect(found!.teamID).toBe(TEAM_ID);
    }
  });

  e2e('create, update, delete team environment — full lifecycle', async () => {
    if (!TEAM_ID) {
      console.log('[e2e] skip: no TEAM_ID');
      return;
    }

    // Create
    const createText = textOf(
      await client.callTool({
        name: 'create_team_environment',
        arguments: {
          teamId: TEAM_ID,
          name: 'e2e-test-env',
          variables: [{ key: 'BASE_URL', value: 'https://example.com' }],
        },
      })
    );
    log('create_team_environment', createText);
    expect(createText).not.toMatch(/auth\/fail/i);
    expect(createText).toMatch(
      /^Successfully created team environment "e2e-test-env" \(ID: \S+\)/m
    );

    const created = jsonOf<Record<string, unknown>>(createText);
    assertShape(created, { id: 'string', teamID: 'string', name: 'string', variables: 'string' });
    expect(created.name).toBe('e2e-test-env');
    expect(created.teamID).toBe(TEAM_ID);
    const createdVars = JSON.parse(created.variables as string) as Array<{
      key: string;
      value: string;
    }>;
    expect(createdVars).toEqual([{ key: 'BASE_URL', value: 'https://example.com' }]);

    const envId = created.id as string;

    try {
      // Update
      const updateText = textOf(
        await client.callTool({
          name: 'update_team_environment',
          arguments: {
            environmentId: envId,
            name: 'e2e-test-env-updated',
            variables: [{ key: 'BASE_URL', value: 'https://updated.example.com' }],
          },
        })
      );
      log('update_team_environment', updateText);
      expect(updateText).not.toMatch(/auth\/fail/i);
      const updated = jsonOf<Record<string, unknown>>(updateText);
      expect(updated.id).toBe(envId);
      expect(updated.name).toBe('e2e-test-env-updated');
      const updatedVars = JSON.parse(updated.variables as string) as Array<{
        key: string;
        value: string;
      }>;
      expect(updatedVars).toEqual([{ key: 'BASE_URL', value: 'https://updated.example.com' }]);
    } finally {
      // Delete (best-effort, don't mask the original test failure)
      try {
        const deleteText = textOf(
          await client.callTool({
            name: 'delete_team_environment',
            arguments: { environmentId: envId },
          })
        );
        log('delete_team_environment', deleteText);
        expect(deleteText).toMatch(/^Successfully deleted team environment \(ID: \S+\)$/);
      } catch (e) {
        console.error('[e2e] cleanup delete_team_environment failed:', e);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// User collections
// list and export work on both backends; writes use the *_CLOUD mutations
// (reqType) on Cloud. get_user_collection is gated on Cloud: its query selects
// `parent`, which Cloud's UserCollection does not expose.
// ---------------------------------------------------------------------------

describe('user collections', () => {
  e2e('list_user_collections (REST) — returns array with collection shape', async () => {
    const text = textOf(
      await client.callTool({ name: 'list_user_collections', arguments: { type: 'REST' } })
    );
    log('list_user_collections (REST)', text);
    expect(text).not.toMatch(/auth\/fail/i);

    const collections = jsonOf<Record<string, unknown>[]>(text);
    expect(Array.isArray(collections)).toBe(true);
    for (const col of collections) {
      assertShape(col, { id: 'string', title: 'string', parentID: 'string|null' });
    }
  });

  e2e('list_user_collections (GQL) — returns array with collection shape', async () => {
    const text = textOf(
      await client.callTool({ name: 'list_user_collections', arguments: { type: 'GQL' } })
    );
    log('list_user_collections (GQL)', text);
    expect(text).not.toMatch(/auth\/fail/i);

    const collections = jsonOf<Record<string, unknown>[]>(text);
    expect(Array.isArray(collections)).toBe(true);
    for (const col of collections) {
      assertShape(col, { id: 'string', title: 'string', parentID: 'string|null' });
    }
  });

  e2e('get_user_collection (REST) — SH: fetches by ID; Cloud: gated', async () => {
    const text = textOf(
      await client.callTool({
        name: 'get_user_collection',
        arguments: { collectionId: PERSONAL_REST_COLLECTION_ID || 'placeholder' },
      })
    );
    log('get_user_collection (REST)', text);
    expect(text).not.toMatch(/auth\/fail/i);

    if (IS_CLOUD) {
      expect(text).toContain('"get_user_collection" is not supported on Hoppscotch Cloud');
      expect(text).toContain('Use team collections instead');
      return;
    }

    if (!PERSONAL_REST_COLLECTION_ID) {
      console.log('[e2e] skip get_user_collection shape check: no PERSONAL_REST_COLLECTION_ID');
      return;
    }
    expect(text).not.toMatch(/^Error:/);
    const col = jsonOf<Record<string, unknown>>(text);
    assertShape(col, { id: 'string', title: 'string', parentID: 'string|null' });
    expect(col.id).toBe(PERSONAL_REST_COLLECTION_ID);
  });

  e2e('get_user_collection (GQL) — SH: fetches by ID; Cloud: gated', async () => {
    const text = textOf(
      await client.callTool({
        name: 'get_user_collection',
        arguments: { collectionId: PERSONAL_GQL_COLLECTION_ID || 'placeholder' },
      })
    );
    log('get_user_collection (GQL)', text);
    expect(text).not.toMatch(/auth\/fail/i);

    if (IS_CLOUD) {
      expect(text).toContain('"get_user_collection" is not supported on Hoppscotch Cloud');
      expect(text).toContain('Use team collections instead');
      return;
    }

    if (!PERSONAL_GQL_COLLECTION_ID) {
      console.log(
        '[e2e] skip get_user_collection (GQL) shape check: no PERSONAL_GQL_COLLECTION_ID'
      );
      return;
    }
    expect(text).not.toMatch(/^Error:/);
    const col = jsonOf<Record<string, unknown>>(text);
    assertShape(col, { id: 'string', title: 'string', parentID: 'string|null' });
    expect(col.id).toBe(PERSONAL_GQL_COLLECTION_ID);
  });

  e2e(
    'create_user_collection and delete_user_collection (REST) — full lifecycle with update',
    async () => {
      const createText = textOf(
        await client.callTool({
          name: 'create_user_collection',
          arguments: { title: 'e2e-user-coll', type: 'REST' },
        })
      );
      log('create_user_collection (REST)', createText);
      expect(createText).not.toMatch(/auth\/fail/i);
      expect(createText).not.toMatch(/^Error:/);
      expect(createText).toMatch(
        /^Successfully created user collection "e2e-user-coll" \(ID: \S+\)/m
      );

      const created = jsonOf<Record<string, unknown>>(createText);
      assertShape(created, { id: 'string', title: 'string' });
      expect(created.title).toBe('e2e-user-coll');
      const collId = created.id as string;

      try {
        // Update
        const updateText = textOf(
          await client.callTool({
            name: 'update_user_collection',
            arguments: { collectionId: collId, type: 'REST', title: 'e2e-user-coll-updated' },
          })
        );
        log('update_user_collection', updateText);
        expect(updateText).not.toMatch(/auth\/fail/i);
        expect(updateText).not.toMatch(/^Error:/);
        const updated = jsonOf<Record<string, unknown>>(updateText);
        expect(updated.id).toBe(collId);
        expect(updated.title).toBe('e2e-user-coll-updated');
      } finally {
        // Delete (best-effort, don't mask the original test failure)
        try {
          const deleteText = textOf(
            await client.callTool({
              name: 'delete_user_collection',
              arguments: { collectionId: collId, type: 'REST' },
            })
          );
          log('delete_user_collection', deleteText);
          expect(deleteText).toMatch(/^Successfully deleted user collection \(ID: \S+\)$/);
        } catch (e) {
          console.error('[e2e] cleanup delete_user_collection failed:', e);
        }
      }
    }
  );

  e2e(
    'create_user_collection and delete_user_collection (GQL) — full lifecycle with update',
    async () => {
      const createText = textOf(
        await client.callTool({
          name: 'create_user_collection',
          arguments: { title: 'e2e-user-gql-coll', type: 'GQL' },
        })
      );
      log('create_user_collection (GQL)', createText);
      expect(createText).not.toMatch(/auth\/fail/i);
      expect(createText).not.toMatch(/^Error:/);
      expect(createText).toMatch(
        /^Successfully created user collection "e2e-user-gql-coll" \(ID: \S+\)/m
      );

      const created = jsonOf<Record<string, unknown>>(createText);
      assertShape(created, { id: 'string', title: 'string' });
      expect(created.title).toBe('e2e-user-gql-coll');
      const collId = created.id as string;

      try {
        // Update
        const updateText = textOf(
          await client.callTool({
            name: 'update_user_collection',
            arguments: { collectionId: collId, type: 'GQL', title: 'e2e-user-gql-coll-updated' },
          })
        );
        log('update_user_collection (GQL)', updateText);
        expect(updateText).not.toMatch(/auth\/fail/i);
        expect(updateText).not.toMatch(/^Error:/);
        const updated = jsonOf<Record<string, unknown>>(updateText);
        expect(updated.id).toBe(collId);
        expect(updated.title).toBe('e2e-user-gql-coll-updated');
      } finally {
        // Delete (best-effort, don't mask the original test failure)
        try {
          const deleteText = textOf(
            await client.callTool({
              name: 'delete_user_collection',
              arguments: { collectionId: collId, type: 'GQL' },
            })
          );
          log('delete_user_collection (GQL)', deleteText);
          expect(deleteText).toMatch(/^Successfully deleted user collection \(ID: \S+\)$/);
        } catch (e) {
          console.error('[e2e] cleanup delete_user_collection (GQL) failed:', e);
        }
      }
    }
  );

  e2e('export_user_collection (REST) — returns valid collection JSON', async () => {
    const text = textOf(
      await client.callTool({
        name: 'export_user_collection',
        arguments: { type: 'REST' },
      })
    );
    log('export_user_collection (REST)', text);
    expect(text).not.toMatch(/auth\/fail/i);

    expect(text).toMatch(/^Exported all REST user collections/m);
    const exported = jsonOf<unknown[]>(text);
    expect(Array.isArray(exported)).toBe(true);
    // Each exported collection has name, folders, requests
    for (const col of exported as Array<Record<string, unknown>>) {
      expect(typeof col.name).toBe('string');
      expect(Array.isArray(col.folders)).toBe(true);
      expect(Array.isArray(col.requests)).toBe(true);
    }
  });

  e2e('export_user_collection (GQL) — returns valid collection JSON', async () => {
    const text = textOf(
      await client.callTool({
        name: 'export_user_collection',
        arguments: { type: 'GQL' },
      })
    );
    log('export_user_collection (GQL)', text);
    expect(text).not.toMatch(/auth\/fail/i);

    expect(text).toMatch(/^Exported all GQL user collections/m);
    const exported = jsonOf<unknown[]>(text);
    expect(Array.isArray(exported)).toBe(true);
    for (const col of exported as Array<Record<string, unknown>>) {
      expect(typeof col.name).toBe('string');
      expect(Array.isArray(col.folders)).toBe(true);
      expect(Array.isArray(col.requests)).toBe(true);
    }
  });

  e2e('import_user_collection — success on both Cloud and SH; cleanup on both', async () => {
    const before = await userCollections();

    const text = textOf(
      await client.callTool({
        name: 'import_user_collection',
        arguments: {
          jsonString: JSON.stringify({
            name: `${ORPHAN_TAG}imported-user`,
            folders: [],
            requests: [],
          }),
          type: 'REST',
        },
      })
    );
    log('import_user_collection', text);
    expect(text).not.toMatch(/auth\/fail/i);
    expect(text).not.toMatch(/^Error:/);
    expect(text).toMatchInlineSnapshot(`"Successfully imported REST user collection(s)"`);

    // Cleanup: API returns no ID for the imported collection, so diff and delete
    // orphans. Skipped entirely if either listing could not be read.
    const after = await userCollections();
    await cleanupOrphanUserCollections(before, after);
  });

  e2e(
    'duplicate_user_collection — creates temp collection, duplicates, deletes source',
    async () => {
      const before = await userCollections();

      const createText = textOf(
        await client.callTool({
          name: 'create_user_collection',
          arguments: { title: `${ORPHAN_TAG}dup-source`, type: 'REST' },
        })
      );
      const srcId = jsonOf<Record<string, unknown>>(createText).id as string;
      if (!srcId) {
        console.log('[e2e] skip duplicate: create failed');
        return;
      }

      try {
        const dupText = textOf(
          await client.callTool({
            name: 'duplicate_user_collection',
            arguments: { collectionId: srcId, type: 'REST' },
          })
        );
        log('duplicate_user_collection', dupText);
        expect(dupText).not.toMatch(/auth\/fail/i);
        expect(dupText).not.toMatch(/^Error:/);
        expect(dupText).toMatch(/^Successfully duplicated user collection \(ID: \S+\)$/);
      } finally {
        // Cleanup source + orphaned duplicate (API returns no ID for the duplicate)
        try {
          await client.callTool({
            name: 'delete_user_collection',
            arguments: { collectionId: srcId, type: 'REST' },
          });
        } catch (e) {
          console.error('[e2e] cleanup failed:', e);
        }
        const after = await userCollections();
        await cleanupOrphanUserCollections(before, after);
      }
    }
  );

  e2e('move_user_collection — creates parent + child, moves child to root', async () => {
    const parentText = textOf(
      await client.callTool({
        name: 'create_user_collection',
        arguments: { title: 'e2e-parent', type: 'REST' },
      })
    );
    const parentId = jsonOf<Record<string, unknown>>(parentText).id as string;
    if (!parentId) {
      console.log('[e2e] skip move: create parent failed');
      return;
    }

    const childText = textOf(
      await client.callTool({
        name: 'create_user_collection',
        arguments: { title: 'e2e-child', type: 'REST', parentCollectionId: parentId },
      })
    );
    const childId = jsonOf<Record<string, unknown>>(childText).id as string;
    if (!childId) {
      await client.callTool({
        name: 'delete_user_collection',
        arguments: { collectionId: parentId, type: 'REST' },
      });
      console.log('[e2e] skip move: create child failed');
      return;
    }

    try {
      const moveText = textOf(
        await client.callTool({
          name: 'move_user_collection',
          arguments: { collectionId: childId },
        })
      );
      log('move_user_collection', moveText);
      expect(moveText).not.toMatch(/auth\/fail/i);
      expect(moveText).not.toMatch(/^Error:/);
      // Prose line confirms move to root
      expect(moveText).toMatch(/^Successfully moved user collection "e2e-child" to root/m);
      // JSON payload has the moved collection shape
      const moved = jsonOf<Record<string, unknown>>(moveText);
      assertShape(moved, { id: 'string', title: 'string' });
      expect(moved.id).toBe(childId);
      expect(moved.title).toBe('e2e-child');
    } finally {
      // Cleanup
      try {
        await client.callTool({
          name: 'delete_user_collection',
          arguments: { collectionId: childId, type: 'REST' },
        });
      } catch (e) {
        console.error('[e2e] cleanup failed:', e);
      }
      try {
        await client.callTool({
          name: 'delete_user_collection',
          arguments: { collectionId: parentId, type: 'REST' },
        });
      } catch (e) {
        console.error('[e2e] cleanup failed:', e);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Team requests (both Cloud and SH)
// ---------------------------------------------------------------------------

describe('team requests', () => {
  e2e('list_team_requests — returns array (may be empty) with request shape', async () => {
    if (!TEAM_COLLECTION_ID) {
      console.log('[e2e] skip: no TEAM_COLLECTION_ID');
      return;
    }
    const text = textOf(
      await client.callTool({
        name: 'list_team_requests',
        arguments: { collectionId: TEAM_COLLECTION_ID },
      })
    );
    log('list_team_requests', text);
    expect(text).not.toMatch(/auth\/fail/i);
    expect(text).not.toMatch(/^Error:/);

    const requests = jsonOf<Record<string, unknown>[]>(text);
    expect(Array.isArray(requests)).toBe(true);
    for (const req of requests) {
      assertShape(req, {
        id: 'string',
        title: 'string',
        request: 'string',
        collectionID: 'string',
      });
    }
  });

  e2e('create, get, update, delete team request — full lifecycle', async () => {
    if (!TEAM_COLLECTION_ID) {
      console.log('[e2e] skip: no TEAM_COLLECTION_ID');
      return;
    }

    const requestData = JSON.stringify({
      v: '10',
      method: 'GET',
      endpoint: 'https://httpbin.org/get',
      headers: [],
      params: [],
      body: { contentType: null, body: null },
      auth: { authType: 'none', authActive: false },
    });

    // Create
    const createText = textOf(
      await client.callTool({
        name: 'create_team_request',
        arguments: {
          collectionId: TEAM_COLLECTION_ID,
          teamId: TEAM_ID,
          title: 'e2e-team-request',
          request: requestData,
        },
      })
    );
    log('create_team_request', createText);
    expect(createText).not.toMatch(/auth\/fail/i);
    expect(createText).not.toMatch(/^Error:/);
    expect(createText).toMatch(
      /^Successfully created team request "e2e-team-request" \(ID: \S+\)/m
    );

    const created = jsonOf<Record<string, unknown>>(createText);
    assertShape(created, {
      id: 'string',
      title: 'string',
      request: 'string',
      collectionID: 'string',
    });
    expect(created.title).toBe('e2e-team-request');
    expect(created.collectionID).toBe(TEAM_COLLECTION_ID);
    const requestId = created.id as string;

    try {
      // Get
      const getText = textOf(
        await client.callTool({
          name: 'get_team_request',
          arguments: { requestId },
        })
      );
      log('get_team_request', getText);
      expect(getText).not.toMatch(/auth\/fail/i);
      expect(getText).not.toMatch(/^Error:/);
      const fetched = jsonOf<Record<string, unknown>>(getText);
      assertShape(fetched, {
        id: 'string',
        title: 'string',
        request: 'string',
        collectionID: 'string',
      });
      expect(fetched.id).toBe(requestId);
      expect(fetched.title).toBe('e2e-team-request');

      // Update
      const updateText = textOf(
        await client.callTool({
          name: 'update_team_request',
          arguments: { requestId, title: 'e2e-team-request-updated', request: requestData },
        })
      );
      log('update_team_request', updateText);
      expect(updateText).not.toMatch(/auth\/fail/i);
      expect(updateText).not.toMatch(/^Error:/);
      expect(updateText).toMatch(
        /^Successfully updated team request "e2e-team-request-updated" \(ID: \S+\)/m
      );
      const updated = jsonOf<Record<string, unknown>>(updateText);
      expect(updated.id).toBe(requestId);
      expect(updated.title).toBe('e2e-team-request-updated');
    } finally {
      // Delete (best-effort, don't mask the original test failure)
      try {
        const deleteText = textOf(
          await client.callTool({
            name: 'delete_team_request',
            arguments: { requestId },
          })
        );
        log('delete_team_request', deleteText);
        expect(deleteText).toMatch(/^Successfully deleted team request \(ID: \S+\)$/);
      } catch (e) {
        console.error('[e2e] cleanup delete_team_request failed:', e);
      }
    }
  });

  e2e(
    'move_team_request — creates request in coll-A, creates coll-B, moves, cleans up',
    async () => {
      if (!TEAM_COLLECTION_ID || !TEAM_ID) {
        console.log('[e2e] skip move_team_request: no TEAM_COLLECTION_ID or TEAM_ID');
        return;
      }

      const requestData = JSON.stringify({
        v: '10',
        method: 'GET',
        endpoint: 'https://httpbin.org/get',
        headers: [],
        params: [],
        body: { contentType: null, body: null },
        auth: { authType: 'none', authActive: false },
      });

      // Create a request in TEAM_COLLECTION_ID
      const createText = textOf(
        await client.callTool({
          name: 'create_team_request',
          arguments: {
            collectionId: TEAM_COLLECTION_ID,
            teamId: TEAM_ID,
            title: 'e2e-move-request',
            request: requestData,
          },
        })
      );
      expect(createText).not.toMatch(/^Error:/);
      const requestId = jsonOf<Record<string, unknown>>(createText).id as string;
      if (!requestId) {
        console.log('[e2e] skip: create failed');
        return;
      }

      // Create a destination collection
      const destText = textOf(
        await client.callTool({
          name: 'create_team_collection',
          arguments: { teamId: TEAM_ID, title: 'e2e-move-dest' },
        })
      );
      const destId = jsonOf<Record<string, unknown>>(destText).id as string;
      if (!destId) {
        await client.callTool({ name: 'delete_team_request', arguments: { requestId } });
        console.log('[e2e] skip: create dest collection failed');
        return;
      }

      try {
        // Move
        const moveText = textOf(
          await client.callTool({
            name: 'move_team_request',
            arguments: { requestId, destCollectionId: destId },
          })
        );
        log('move_team_request', moveText);
        expect(moveText).not.toMatch(/auth\/fail/i);
        expect(moveText).not.toMatch(/^Error:/);
        expect(moveText).toMatch(
          /^Successfully moved team request "e2e-move-request" to collection \(ID: \S+\)/m
        );
        const moved = jsonOf<Record<string, unknown>>(moveText);
        assertShape(moved, {
          id: 'string',
          title: 'string',
          request: 'string',
          collectionID: 'string',
        });
        expect(moved.id).toBe(requestId);
      } finally {
        // Cleanup: delete request then dest collection
        try {
          await client.callTool({ name: 'delete_team_request', arguments: { requestId } });
        } catch (e) {
          console.error('[e2e] cleanup failed:', e);
        }
        try {
          await client.callTool({
            name: 'delete_team_collection',
            arguments: { collectionId: destId },
          });
        } catch (e) {
          console.error('[e2e] cleanup failed:', e);
        }
      }
    }
  );
});

// ---------------------------------------------------------------------------
// User requests
// Writes work on both backends. list_user_requests is gated on Cloud: its query
// selects nested UserCollection.requests, which Cloud's schema does not evidence.
// ---------------------------------------------------------------------------

describe('user requests', () => {
  e2e('list_user_requests — SH: array of requests; Cloud: gated', async () => {
    const text = textOf(
      await client.callTool({
        name: 'list_user_requests',
        arguments: { collectionId: PERSONAL_REST_COLLECTION_ID || 'placeholder' },
      })
    );
    log('list_user_requests', text);
    expect(text).not.toMatch(/auth\/fail/i);

    if (IS_CLOUD) {
      expect(text).toContain('"list_user_requests" is not supported on Hoppscotch Cloud');
      expect(text).toContain('Use team requests instead');
      return;
    }

    if (!PERSONAL_REST_COLLECTION_ID) {
      console.log('[e2e] skip list_user_requests shape check: no PERSONAL_REST_COLLECTION_ID');
      return;
    }
    expect(text).not.toMatch(/^Error:/);
    const requests = jsonOf<Record<string, unknown>[]>(text);
    expect(Array.isArray(requests)).toBe(true);
    for (const req of requests) {
      assertShape(req, {
        id: 'string',
        title: 'string',
        request: 'string',
        collectionID: 'string',
      });
    }
  });

  e2e('create, update, delete user REST request — full lifecycle (both Cloud and SH)', async () => {
    if (!PERSONAL_REST_COLLECTION_ID) {
      console.log('[e2e] skip: no PERSONAL_REST_COLLECTION_ID');
      return;
    }

    const requestData = JSON.stringify({
      v: '10',
      method: 'GET',
      endpoint: 'https://httpbin.org/get',
      headers: [],
      params: [],
      body: { contentType: null, body: null },
      auth: { authType: 'none', authActive: false },
    });

    // Create
    const createText = textOf(
      await client.callTool({
        name: 'create_user_request',
        arguments: {
          collectionId: PERSONAL_REST_COLLECTION_ID,
          type: 'REST',
          title: 'e2e-user-request',
          request: requestData,
        },
      })
    );
    log('create_user_request', createText);
    expect(createText).not.toMatch(/auth\/fail/i);
    expect(createText).not.toMatch(/^Error:/);
    expect(createText).toMatch(
      /^Successfully created user request "e2e-user-request" \(ID: \S+\)/m
    );

    const created = jsonOf<Record<string, unknown>>(createText);
    assertShape(created, {
      id: 'string',
      title: 'string',
      request: 'string',
      collectionID: 'string',
    });
    expect(created.title).toBe('e2e-user-request');
    const requestId = created.id as string;

    try {
      // Update
      const updateText = textOf(
        await client.callTool({
          name: 'update_user_request',
          arguments: {
            requestId,
            type: 'REST',
            title: 'e2e-user-request-updated',
            request: requestData,
          },
        })
      );
      log('update_user_request', updateText);
      expect(updateText).not.toMatch(/auth\/fail/i);
      expect(updateText).not.toMatch(/^Error:/);
      expect(updateText).toMatch(
        /^Successfully updated user request "e2e-user-request-updated" \(ID: \S+\)/m
      );
      const updated = jsonOf<Record<string, unknown>>(updateText);
      expect(updated.id).toBe(requestId);
      expect(updated.title).toBe('e2e-user-request-updated');
    } finally {
      // Delete (best-effort, don't mask the original test failure)
      try {
        const deleteText = textOf(
          await client.callTool({
            name: 'delete_user_request',
            arguments: { requestId },
          })
        );
        log('delete_user_request', deleteText);
        expect(deleteText).toMatch(/^Successfully deleted user request \(ID: \S+\)$/);
      } catch (e) {
        console.error('[e2e] cleanup delete_user_request failed:', e);
      }
    }
  });

  e2e('create, update, delete user GQL request — full lifecycle (self-hosted)', async () => {
    if (!PERSONAL_GQL_COLLECTION_ID) {
      console.log('[e2e] skip: no PERSONAL_GQL_COLLECTION_ID');
      return;
    }

    const requestData = JSON.stringify({
      v: '4',
      url: 'https://httpbin.org/post',
      query: '{ hello }',
      variables: '{}',
      headers: [],
    });

    // Create
    const createText = textOf(
      await client.callTool({
        name: 'create_user_request',
        arguments: {
          collectionId: PERSONAL_GQL_COLLECTION_ID,
          type: 'GQL',
          title: 'e2e-user-gql-request',
          request: requestData,
        },
      })
    );
    log('create_user_request (GQL)', createText);
    expect(createText).not.toMatch(/auth\/fail/i);
    expect(createText).not.toMatch(/^Error:/);
    expect(createText).toMatch(
      /^Successfully created user request "e2e-user-gql-request" \(ID: \S+\)/m
    );

    const created = jsonOf<Record<string, unknown>>(createText);
    assertShape(created, {
      id: 'string',
      title: 'string',
      request: 'string',
      collectionID: 'string',
    });
    expect(created.title).toBe('e2e-user-gql-request');
    const requestId = created.id as string;

    try {
      // Update
      const updateText = textOf(
        await client.callTool({
          name: 'update_user_request',
          arguments: {
            requestId,
            type: 'GQL',
            title: 'e2e-user-gql-request-updated',
            request: requestData,
          },
        })
      );
      log('update_user_request (GQL)', updateText);
      expect(updateText).not.toMatch(/auth\/fail/i);
      expect(updateText).not.toMatch(/^Error:/);
      expect(updateText).toMatch(
        /^Successfully updated user request "e2e-user-gql-request-updated" \(ID: \S+\)/m
      );
      const updated = jsonOf<Record<string, unknown>>(updateText);
      expect(updated.id).toBe(requestId);
      expect(updated.title).toBe('e2e-user-gql-request-updated');
    } finally {
      // Delete (best-effort, don't mask the original test failure)
      try {
        const deleteText = textOf(
          await client.callTool({
            name: 'delete_user_request',
            arguments: { requestId },
          })
        );
        log('delete_user_request (GQL)', deleteText);
        expect(deleteText).toMatch(/^Successfully deleted user request \(ID: \S+\)$/);
      } catch (e) {
        console.error('[e2e] cleanup delete_user_request (GQL) failed:', e);
      }
    }
  });

  e2e('move_user_request — creates request + dest collection, moves, cleans up', async () => {
    if (!PERSONAL_REST_COLLECTION_ID) {
      console.log('[e2e] skip move_user_request: no PERSONAL_REST_COLLECTION_ID');
      return;
    }

    const requestData = JSON.stringify({
      v: '10',
      method: 'GET',
      endpoint: 'https://httpbin.org/get',
      headers: [],
      params: [],
      body: { contentType: null, body: null },
      auth: { authType: 'none', authActive: false },
    });

    // Create a request in PERSONAL_REST_COLLECTION_ID
    const createText = textOf(
      await client.callTool({
        name: 'create_user_request',
        arguments: {
          collectionId: PERSONAL_REST_COLLECTION_ID,
          type: 'REST',
          title: 'e2e-move-user-request',
          request: requestData,
        },
      })
    );
    const requestId = jsonOf<Record<string, unknown>>(createText).id as string;
    if (!requestId) {
      console.log('[e2e] skip: create user request failed');
      return;
    }

    // Create a destination user collection
    const destText = textOf(
      await client.callTool({
        name: 'create_user_collection',
        arguments: { title: 'e2e-user-move-dest', type: 'REST' },
      })
    );
    const destId = jsonOf<Record<string, unknown>>(destText).id as string;
    if (!destId) {
      await client.callTool({ name: 'delete_user_request', arguments: { requestId } });
      console.log('[e2e] skip: create dest collection failed');
      return;
    }

    try {
      // Move
      const moveText = textOf(
        await client.callTool({
          name: 'move_user_request',
          arguments: {
            requestId,
            sourceCollectionId: PERSONAL_REST_COLLECTION_ID,
            destCollectionId: destId,
          },
        })
      );
      log('move_user_request', moveText);
      expect(moveText).not.toMatch(/auth\/fail/i);
      expect(moveText).not.toMatch(/^Error:/);
      expect(moveText).toMatch(
        /^Successfully moved user request "e2e-move-user-request" to collection \(ID: \S+\)/m
      );
      const moved = jsonOf<Record<string, unknown>>(moveText);
      assertShape(moved, {
        id: 'string',
        title: 'string',
        request: 'string',
        collectionID: 'string',
      });
      expect(moved.id).toBe(requestId);
    } finally {
      // Cleanup
      try {
        await client.callTool({ name: 'delete_user_request', arguments: { requestId } });
      } catch (e) {
        console.error('[e2e] cleanup failed:', e);
      }
      try {
        await client.callTool({
          name: 'delete_user_collection',
          arguments: { collectionId: destId, type: 'REST' },
        });
      } catch (e) {
        console.error('[e2e] cleanup failed:', e);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// User environments (Cloud: all four tools return "not supported")
// ---------------------------------------------------------------------------

describe('user environments', () => {
  e2e('list_user_environments — SH: array of envs; Cloud: not supported', async () => {
    const text = textOf(await client.callTool({ name: 'list_user_environments', arguments: {} }));
    log('list_user_environments', text);
    expect(text).not.toMatch(/auth\/fail/i);
    if (IS_CLOUD) {
      expect(text).toContain('User environments are not supported on Hoppscotch Cloud');
      return;
    }
    const parsed = jsonOf<unknown[]>(text);
    expect(Array.isArray(parsed)).toBe(true);
    // On SH, each env should have id/name/variables
    for (const env of parsed as Array<Record<string, unknown>>) {
      assertShape(env, { id: 'string', name: 'string', variables: 'string' });
    }
  });

  e2e(
    'create/update/delete user environment — Cloud: not supported; SH: full lifecycle',
    async () => {
      const createText = textOf(
        await client.callTool({
          name: 'create_user_environment',
          arguments: { name: 'e2e-user-env', variables: [{ key: 'FOO', value: 'bar' }] },
        })
      );
      log('create_user_environment', createText);
      expect(createText).not.toMatch(/auth\/fail/i);

      // Cloud path: explicit "not supported" message
      if (createText.includes('not supported')) {
        expect(createText).toContain('User environments are not supported on Hoppscotch Cloud');
        expect(createText).toContain('Use team environments instead');
        return;
      }

      // SH path: verify create shape
      expect(createText).not.toMatch(/^Error:/);
      const created = jsonOf<Record<string, unknown>>(createText);
      assertShape(created, { id: 'string', name: 'string' });
      expect(created.name).toBe('e2e-user-env');
      const envId = created.id as string;

      try {
        const updateText = textOf(
          await client.callTool({
            name: 'update_user_environment',
            arguments: {
              environmentId: envId,
              name: 'e2e-user-env-updated',
              variables: [{ key: 'FOO', value: 'baz' }],
            },
          })
        );
        log('update_user_environment', updateText);
        expect(updateText).not.toMatch(/auth\/fail/i);
        expect(updateText).not.toMatch(/^Error:/);
        const updatedEnv = jsonOf<Record<string, unknown>>(updateText);
        expect(updatedEnv.id).toBe(envId);
        expect(updatedEnv.name).toBe('e2e-user-env-updated');
      } finally {
        // Delete (best-effort, don't mask the original test failure)
        try {
          const deleteText = textOf(
            await client.callTool({
              name: 'delete_user_environment',
              arguments: { environmentId: envId },
            })
          );
          log('delete_user_environment', deleteText);
          expect(deleteText).toMatch(/^Successfully deleted user environment \(ID: \S+\)$/);
        } catch (e) {
          console.error('[e2e] cleanup delete_user_environment failed:', e);
        }
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Request execution
// ---------------------------------------------------------------------------

describe('request execution', () => {
  e2e('execute_request — GET httpbin returns 200 with JSON body', async () => {
    const text = textOf(
      await client.callTool({
        name: 'execute_request',
        arguments: { method: 'GET', url: 'https://httpbin.org/get', headers: { 'X-Test': 'e2e' } },
      })
    );
    log('execute_request', text);
    expect(text).not.toMatch(/^Error:/);
    // Status line
    expect(text).toMatch(/Status:\s*200/);
    // httpbin echoes request headers back in the body
    expect(text).toMatch(/"X-Test":\s*"e2e"/);
  });

  e2e('validate_response — 200 criteria passes, returns PASS status', async () => {
    const text = textOf(
      await client.callTool({
        name: 'validate_response',
        arguments: {
          method: 'GET',
          url: 'https://httpbin.org/status/200',
          criteria: { expectedStatus: 200 },
        },
      })
    );
    log('validate_response', text);
    expect(text).not.toMatch(/^Error:/);
    expect(text).toMatch(/Status:\s*✅ PASS/);
    expect(text).toMatch(/## Validation Result/);
    expect(text).toMatch(/## Response Details/);
    // No Errors section on pass
    expect(text).not.toMatch(/## Errors:/);
  });
});

// ---------------------------------------------------------------------------
// Code generation (pure local: no network, fully deterministic)
// ---------------------------------------------------------------------------

describe('code generation', () => {
  e2e('generate_code (curl) — deterministic output matches snapshot', async () => {
    const text = textOf(
      await client.callTool({
        name: 'generate_code',
        arguments: { method: 'POST', url: 'https://api.example.com/data', language: 'curl' },
      })
    );
    log('generate_code (curl)', text);
    expect(text).not.toMatch(/^Error:/);
    expect(text).toMatchInlineSnapshot(`
      "\`\`\`bash
      curl \\
        -X POST \\
        'https://api.example.com/data'
      \`\`\`"
    `);
  });

  e2e('generate_code (javascript) — deterministic output matches snapshot', async () => {
    const text = textOf(
      await client.callTool({
        name: 'generate_code',
        arguments: { method: 'GET', url: 'https://api.example.com/items', language: 'javascript' },
      })
    );
    log('generate_code (js)', text);
    expect(text).not.toMatch(/^Error:/);
    expect(text).toMatchInlineSnapshot(`
      "\`\`\`javascript
      const response = await fetch(
        'https://api.example.com/items',
        {
          method: 'GET',
        }
      );

      const data = await response.json();
      console.log(data);
      \`\`\`"
    `);
  });

  e2e('generate_documentation — contains method, URL, and example sections', async () => {
    const text = textOf(
      await client.callTool({
        name: 'generate_documentation',
        arguments: {
          method: 'POST',
          url: 'https://api.example.com/users',
          title: 'Create User',
          includeExamples: true,
        },
      })
    );
    log('generate_documentation', text);
    expect(text).not.toMatch(/^Error:/);
    expect(text).toMatch(/Create User/);
    expect(text).toMatch(/POST/);
    expect(text).toMatch(/https:\/\/api\.example\.com\/users/);
    // includeExamples: true should produce example blocks
    expect(text).toMatch(/```/);
  });
});
