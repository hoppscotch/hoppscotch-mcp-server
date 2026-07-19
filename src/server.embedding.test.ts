import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HoppscotchMCPServer } from './server';
import { ApiType, type Config } from './config';
import { VERSION } from './version';

// The public library entry (`createServer` / package `main`) was cut for v1 —
// the package ships bin-only. These tests still guard the *internal* seams that
// made that cut safe and keep it cheap to reverse: the server class must stay
// lifecycle-free (no signal hijack), `run()` must accept an injected transport,
// and the tool profile must flow through `Config` (not `process.env`).
const baseConfig: Config = {
  serverUrl: 'https://hoppscotch.io',
  apiUrl: 'https://api.hoppscotch.io',
  apiType: ApiType.CLOUD,
  timeout: 30000,
};

describe('HoppscotchMCPServer (lifecycle-free internals)', () => {
  it('construction does NOT hijack process signal handlers (the class must not)', () => {
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    new HoppscotchMCPServer(baseConfig);
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });

  it('exposes a valid VERSION', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('transport-agnostic run() + protocol handshake (in-process)', () => {
  it('serves an initialize + tools/list over an injected in-memory transport (core = 39)', async () => {
    const server = new HoppscotchMCPServer({ ...baseConfig, toolProfile: 'core' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.run(serverTransport); // injected transport, not stdio

    const client = new Client({ name: 'embed-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientTransport); // performs the initialize handshake

    const { tools } = await client.listTools();
    // core profile = 39 tools; proves the profile selection flows through Config.
    expect(tools.length).toBe(39);
    expect(tools.every((t) => typeof t.name === 'string')).toBe(true);

    await client.close();
    await server.close();
  });

  it('respects the toolProfile from Config (full = 53)', async () => {
    const server = new HoppscotchMCPServer({ ...baseConfig, toolProfile: 'full' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.run(serverTransport);

    const client = new Client({ name: 'embed-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools.length).toBe(53);

    await client.close();
    await server.close();
  });
});
