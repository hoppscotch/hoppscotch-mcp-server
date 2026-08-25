import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadConfig,
  getGraphqlUrl,
  deriveApiUrl,
  inferApiType,
  isCloudUrl,
  sanitizeTrustSensitiveEnv,
  ApiType,
  type Config,
} from './config';

describe('isCloudUrl', () => {
  it('recognises hoppscotch.io as cloud', () => {
    expect(isCloudUrl('https://hoppscotch.io')).toBe(true);
  });

  it('recognises www.hoppscotch.io as cloud', () => {
    expect(isCloudUrl('https://www.hoppscotch.io')).toBe(true);
  });

  it('treats any other hostname as self-hosted', () => {
    expect(isCloudUrl('https://my-sh.example.com')).toBe(false);
    expect(isCloudUrl('http://localhost:3000')).toBe(false);
    expect(isCloudUrl('https://api.hoppscotch.io')).toBe(false);
  });
});

describe('inferApiType', () => {
  it('returns CLOUD for hoppscotch.io', () => {
    expect(inferApiType('https://hoppscotch.io')).toBe(ApiType.CLOUD);
  });

  it('returns SELFHOST for any other URL', () => {
    expect(inferApiType('https://your-sh.example.com')).toBe(ApiType.SELFHOST);
    expect(inferApiType('http://localhost:3000')).toBe(ApiType.SELFHOST);
  });
});

describe('deriveApiUrl', () => {
  it('maps hoppscotch.io → api.hoppscotch.io', () => {
    expect(deriveApiUrl('https://hoppscotch.io')).toBe('https://api.hoppscotch.io');
  });

  it('maps self-hosted URL → <url>/backend', () => {
    expect(deriveApiUrl('https://my-sh.example.com')).toBe('https://my-sh.example.com/backend');
  });

  it('strips trailing slash before appending /backend', () => {
    expect(deriveApiUrl('https://my-sh.example.com/')).toBe('https://my-sh.example.com/backend');
  });
});

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.HOPPSCOTCH_SERVER_URL;
    delete process.env.HOPPSCOTCH_ACCESS_TOKEN;
    delete process.env.HOPPSCOTCH_TIMEOUT;
    delete process.env.HOPPSCOTCH_DEFAULT_TEAM_ID;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('defaults to Cloud when no HOPPSCOTCH_SERVER_URL is set', () => {
    const config = loadConfig();
    expect(config.serverUrl).toBe('https://hoppscotch.io');
    expect(config.apiUrl).toBe('https://api.hoppscotch.io');
    expect(config.apiType).toBe(ApiType.CLOUD);
  });

  it('infers cloud when HOPPSCOTCH_SERVER_URL is hoppscotch.io', () => {
    process.env.HOPPSCOTCH_SERVER_URL = 'https://hoppscotch.io';
    const config = loadConfig();
    expect(config.apiUrl).toBe('https://api.hoppscotch.io');
    expect(config.apiType).toBe(ApiType.CLOUD);
  });

  it('infers self-hosted when HOPPSCOTCH_SERVER_URL is a custom URL', () => {
    process.env.HOPPSCOTCH_SERVER_URL = 'https://my-sh.example.com';
    const config = loadConfig();
    expect(config.apiUrl).toBe('https://my-sh.example.com/backend');
    expect(config.apiType).toBe(ApiType.SELFHOST);
  });

  it('accepts a PAT via HOPPSCOTCH_ACCESS_TOKEN', () => {
    process.env.HOPPSCOTCH_ACCESS_TOKEN = 'pat-abc123';
    const config = loadConfig();
    expect(config.accessToken).toBe('pat-abc123');
  });

  it('accessToken is optional — loads without it', () => {
    const config = loadConfig();
    expect(config.accessToken).toBeUndefined();
  });

  it('applies default numeric values', () => {
    const config = loadConfig();
    expect(config.timeout).toBe(30000);
  });

  it('overrides defaults with env vars', () => {
    process.env.HOPPSCOTCH_TIMEOUT = '60000';

    const config = loadConfig();
    expect(config.timeout).toBe(60000);
  });

  it('accepts a large timeout (uncapped — backwards-compatible)', () => {
    process.env.HOPPSCOTCH_TIMEOUT = '1200000'; // 20 min
    expect(loadConfig().timeout).toBe(1200000);
  });

  it('throws when HOPPSCOTCH_SERVER_URL is not a valid URL', () => {
    process.env.HOPPSCOTCH_SERVER_URL = 'not-a-url';
    expect(() => loadConfig()).toThrow('Configuration validation failed');
  });

  it('rejects a non-http(s) serverUrl scheme', () => {
    process.env.HOPPSCOTCH_SERVER_URL = 'file:///etc/passwd';
    expect(() => loadConfig()).toThrow(/http or https/);
  });

  it('rejects a serverUrl with embedded credentials', () => {
    process.env.HOPPSCOTCH_SERVER_URL = 'https://user:pass@evil.example.com';
    expect(() => loadConfig()).toThrow(/embedded credentials/);
  });

  it('rejects a serverUrl with a query string', () => {
    process.env.HOPPSCOTCH_SERVER_URL = 'https://sh.example.com?x=1';
    expect(() => loadConfig()).toThrow(/query string/);
  });

  it('rejects a serverUrl with a fragment', () => {
    process.env.HOPPSCOTCH_SERVER_URL = 'https://sh.example.com#frag';
    expect(() => loadConfig()).toThrow(/fragment/);
  });
});

describe('getGraphqlUrl', () => {
  it('constructs the full GraphQL URL', () => {
    const config = {
      apiUrl: 'https://api.hoppscotch.io',
    } as unknown as Config;
    expect(getGraphqlUrl(config)).toBe('https://api.hoppscotch.io/graphql');
  });
});

describe('sanitizeTrustSensitiveEnv', () => {
  it('strips a trust-sensitive var that a .env introduced (absent from ambient)', () => {
    const env: NodeJS.ProcessEnv = { HOPPSCOTCH_ALLOW_PRIVATE_HOSTS: 'true' };
    const stripped = sanitizeTrustSensitiveEnv({ HOPPSCOTCH_ALLOW_PRIVATE_HOSTS: undefined }, env);
    expect(stripped).toContain('HOPPSCOTCH_ALLOW_PRIVATE_HOSTS');
    expect(env.HOPPSCOTCH_ALLOW_PRIVATE_HOSTS).toBeUndefined();
  });

  it('keeps a trust-sensitive var the operator set in the real environment', () => {
    const env: NodeJS.ProcessEnv = { HOPPSCOTCH_TOOL_PROFILE: 'full' };
    const stripped = sanitizeTrustSensitiveEnv({ HOPPSCOTCH_TOOL_PROFILE: 'full' }, env);
    expect(stripped).toHaveLength(0);
    expect(env.HOPPSCOTCH_TOOL_PROFILE).toBe('full');
  });

  it('strips a .env-introduced HOPPSCOTCH_SERVER_URL (the auth target is operator-only)', () => {
    const env: NodeJS.ProcessEnv = { HOPPSCOTCH_SERVER_URL: 'http://attacker.example' };
    const stripped = sanitizeTrustSensitiveEnv({ HOPPSCOTCH_SERVER_URL: undefined }, env);
    expect(stripped).toContain('HOPPSCOTCH_SERVER_URL');
    expect(env.HOPPSCOTCH_SERVER_URL).toBeUndefined();
  });

  it('strips .env-introduced HOPPSCOTCH_DEFAULT_TEAM_ID and HOPPSCOTCH_MAX_RESPONSE_BYTES', () => {
    const env: NodeJS.ProcessEnv = {
      HOPPSCOTCH_DEFAULT_TEAM_ID: 'attacker-team',
      HOPPSCOTCH_MAX_RESPONSE_BYTES: '999999999999',
    };
    const stripped = sanitizeTrustSensitiveEnv(
      { HOPPSCOTCH_DEFAULT_TEAM_ID: undefined, HOPPSCOTCH_MAX_RESPONSE_BYTES: undefined },
      env
    );
    expect(stripped).toContain('HOPPSCOTCH_DEFAULT_TEAM_ID');
    expect(stripped).toContain('HOPPSCOTCH_MAX_RESPONSE_BYTES');
    expect(env.HOPPSCOTCH_DEFAULT_TEAM_ID).toBeUndefined();
    expect(env.HOPPSCOTCH_MAX_RESPONSE_BYTES).toBeUndefined();
  });

  it('strips a .env-introduced HOPPSCOTCH_TIMEOUT (availability guard is operator-only)', () => {
    const env: NodeJS.ProcessEnv = { HOPPSCOTCH_TIMEOUT: '1200000' };
    const stripped = sanitizeTrustSensitiveEnv({ HOPPSCOTCH_TIMEOUT: undefined }, env);
    expect(stripped).toContain('HOPPSCOTCH_TIMEOUT');
    expect(env.HOPPSCOTCH_TIMEOUT).toBeUndefined();
  });

  it('strips .env-introduced auth knobs (AUTH_TIMEOUT_MS, FORCE_BROWSER_LOGIN)', () => {
    const env: NodeJS.ProcessEnv = {
      HOPPSCOTCH_AUTH_TIMEOUT_MS: '999999999',
      HOPPSCOTCH_FORCE_BROWSER_LOGIN: 'true',
    };
    const stripped = sanitizeTrustSensitiveEnv(
      { HOPPSCOTCH_AUTH_TIMEOUT_MS: undefined, HOPPSCOTCH_FORCE_BROWSER_LOGIN: undefined },
      env
    );
    expect(stripped).toContain('HOPPSCOTCH_AUTH_TIMEOUT_MS');
    expect(stripped).toContain('HOPPSCOTCH_FORCE_BROWSER_LOGIN');
    expect(env.HOPPSCOTCH_AUTH_TIMEOUT_MS).toBeUndefined();
    expect(env.HOPPSCOTCH_FORCE_BROWSER_LOGIN).toBeUndefined();
  });
});
