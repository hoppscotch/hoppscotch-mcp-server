import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { selectProfileTools, ALL_FULL_TOOLS } from './definitions.js';

describe('selectProfileTools', () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  it('returns the core set (the default) when no profile is provided', () => {
    const tools = selectProfileTools(undefined);
    const names = new Set(Object.keys(tools));
    // core = lean-but-functional: CRUD + execute + codegen + read-only discovery
    expect(names.has('execute_request')).toBe(true);
    expect(names.has('generate_code')).toBe(true);
    expect(names.has('list_team_requests')).toBe(true);
    expect(names.has('list_teams')).toBe(true);
    expect(names.has('get_team_info')).toBe(true);
    // ...but NOT the destructive team-admin writes or advanced collection ops
    expect(names.has('create_team')).toBe(false);
    expect(names.has('delete_team')).toBe(false);
    expect(names.has('search_team_requests')).toBe(false);
    expect(names.has('duplicate_team_collection')).toBe(false);
    // strict subset of full
    expect(Object.keys(tools).length).toBeLessThan(Object.keys(ALL_FULL_TOOLS).length);
  });

  it('returns the same set for "core" as the unset default', () => {
    expect(Object.keys(selectProfileTools('core'))).toEqual(
      Object.keys(selectProfileTools(undefined))
    );
  });

  it('exposes the reauth tool in every profile (auth is fundamental)', () => {
    for (const profile of [undefined, 'minimal', 'core', 'standard', 'full'] as const) {
      const names = new Set(Object.keys(selectProfileTools(profile)));
      expect(names.has('reauth'), String(profile)).toBe(true);
    }
  });

  it('returns the full set when "full" is explicitly requested', () => {
    const tools = selectProfileTools('full');
    expect(Object.keys(tools)).toEqual(Object.keys(ALL_FULL_TOOLS));
  });

  it('returns only minimal tools when "minimal" is requested', () => {
    const tools = selectProfileTools('minimal');
    const names = new Set(Object.keys(tools));
    expect(names.has('list_user_collections')).toBe(true);
    expect(names.has('list_team_collections')).toBe(true);
    expect(names.has('create_user_environment')).toBe(true);
    expect(names.has('execute_request')).toBe(false);
    expect(names.has('generate_code')).toBe(false);
    expect(names.has('create_team')).toBe(false);
    expect(names.has('search_team_requests')).toBe(false);
  });

  it('returns standard tools (minimal + advanced + team management) when "standard" is requested', () => {
    const tools = selectProfileTools('standard');
    const names = new Set(Object.keys(tools));
    expect(names.has('list_user_collections')).toBe(true);
    expect(names.has('search_team_requests')).toBe(true);
    expect(names.has('create_team')).toBe(true);
    expect(names.has('execute_request')).toBe(false);
    expect(names.has('generate_code')).toBe(false);
  });

  it('falls back to the default (core) and warns on stderr for an unknown profile', () => {
    const tools = selectProfileTools('premium');
    // Must NOT silently expand to full: a typo gets the lean default surface.
    expect(Object.keys(tools)).toEqual(Object.keys(selectProfileTools(undefined)));
    expect(new Set(Object.keys(tools)).has('delete_team')).toBe(false);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(
        /Unknown HOPPSCOTCH_TOOL_PROFILE.*premium.*falling back to the default \(core\)/i
      )
    );
  });

  it('accepts profile values case-insensitively', () => {
    const upper = selectProfileTools('MINIMAL');
    const mixed = selectProfileTools('Minimal');
    const lower = selectProfileTools('minimal');
    expect(Object.keys(upper)).toEqual(Object.keys(lower));
    expect(Object.keys(mixed)).toEqual(Object.keys(lower));
  });

  it('every returned tool carries MCP annotations', () => {
    for (const profile of ['minimal', 'core', 'standard', 'full'] as const) {
      const tools = selectProfileTools(profile);
      for (const [name, tool] of Object.entries(tools)) {
        expect(tool, `${profile}:${name}`).toHaveProperty('annotations');
        expect(tool.annotations, `${profile}:${name}.annotations`).toBeDefined();
      }
    }
  });

  it('minimal ⊆ core ⊆ full and minimal ⊆ standard ⊆ full (core and standard are separate branches)', () => {
    const minimal = new Set(Object.keys(selectProfileTools('minimal')));
    const core = new Set(Object.keys(selectProfileTools('core')));
    const standard = new Set(Object.keys(selectProfileTools('standard')));
    const full = new Set(Object.keys(selectProfileTools('full')));
    for (const name of minimal) {
      expect(core.has(name), `core⊇minimal: ${name}`).toBe(true);
      expect(standard.has(name), `standard⊇minimal: ${name}`).toBe(true);
    }
    for (const name of core) expect(full.has(name), `full⊇core: ${name}`).toBe(true);
    for (const name of standard) expect(full.has(name), `full⊇standard: ${name}`).toBe(true);
    // core trades team-admin for execute/codegen, so neither is a subset of the other
    expect(core.has('execute_request') && !standard.has('execute_request')).toBe(true);
    expect(standard.has('create_team') && !core.has('create_team')).toBe(true);
  });
});

/**
 * Structural view of the slice of a tool's advertised JSON Schema these tests
 * walk. Typing it beats `any`: a rename of `properties`/`description` upstream
 * becomes a compile error here rather than a silent `undefined` at runtime.
 */
interface SchemaNode {
  description?: string;
  properties?: Record<string, SchemaNode>;
}
interface AdvertisedTool {
  name: string;
  inputSchema: SchemaNode;
}

describe('advertised tool contract (tools/list inputSchema)', () => {
  const validateResponse = Object.values(ALL_FULL_TOOLS).find(
    (t) => t.name === 'validate_response'
  ) as unknown as AdvertisedTool;

  it('advertises the deprecated jsonSchema alias alongside jsonObject (backwards-compatible contract)', () => {
    const criteria = validateResponse.inputSchema.properties!.criteria.properties!;
    // Both must be discoverable so schema-driven MCP clients keep seeing the alias.
    expect(criteria.jsonObject).toBeDefined();
    expect(criteria.jsonSchema).toBeDefined();
    expect(criteria.jsonSchema.description).toMatch(/alias of jsonObject/i);
  });

  it('advertises generate_code.redactCredentials as opt-in (default false — live snippet)', () => {
    const generateCode = Object.values(ALL_FULL_TOOLS).find(
      (t) => t.name === 'generate_code'
    ) as unknown as AdvertisedTool;
    expect(generateCode.inputSchema.properties!.redactCredentials).toBeDefined();
    expect(generateCode.inputSchema.properties!.redactCredentials.description).toMatch(
      /default false/i
    );
    // The tool description must signal the live-by-default posture.
    expect(generateCode.description).toMatch(/live credentials by default/i);
  });
});
