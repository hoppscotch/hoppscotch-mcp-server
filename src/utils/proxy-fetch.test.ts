import http from 'http';
import net, { type AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasProxyEnv, proxyAwareFetch } from './proxy-fetch';

const PROXY_ENV = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

function listen(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const portOf = (server: http.Server): number => (server.address() as AddressInfo).port;

describe('proxy-fetch', () => {
  const saved: Record<string, string | undefined> = {};
  const servers: http.Server[] = [];

  beforeEach(() => {
    for (const name of PROXY_ENV) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(async () => {
    for (const name of PROXY_ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    vi.unstubAllGlobals();
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
    );
  });

  describe('hasProxyEnv', () => {
    it('is false when no proxy variable is set', () => {
      expect(hasProxyEnv({})).toBe(false);
    });

    it('ignores blank values', () => {
      expect(hasProxyEnv({ HTTPS_PROXY: '  ' })).toBe(false);
    });

    it.each(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'])('detects %s', (name) => {
      expect(hasProxyEnv({ [name]: 'http://127.0.0.1:7890' })).toBe(true);
    });
  });

  describe('proxyAwareFetch', () => {
    it('uses the global fetch when no proxy is configured', async () => {
      const fetchMock = vi.fn(async () => new Response('{"ok":true}'));
      vi.stubGlobal('fetch', fetchMock);

      const res = await proxyAwareFetch('https://example.invalid/x', { method: 'POST' });

      expect(await res.json()).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledWith('https://example.invalid/x', { method: 'POST' });
    });

    it('tunnels the request through HTTP_PROXY when it is set', async () => {
      const origin = await listen((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ host: req.headers.host, path: req.url }));
      });
      servers.push(origin);
      // Minimal CONNECT proxy: records the requested authority and splices the
      // tunnel to the local origin, so the fake hostname below never needs DNS.
      const connects: string[] = [];
      const proxy = await listen((_req, res) => {
        res.statusCode = 405;
        res.end();
      });
      proxy.on('connect', (req, clientSocket, head) => {
        connects.push(String(req.url));
        const upstream = net.connect(portOf(origin), '127.0.0.1', () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstream.destroy());
      });
      servers.push(proxy);

      process.env.HTTP_PROXY = `http://127.0.0.1:${portOf(proxy)}`;
      const res = await proxyAwareFetch('http://upstream.test:8080/v1/token', {
        method: 'POST',
        body: '{}',
      });

      expect(await res.json()).toEqual({ host: 'upstream.test:8080', path: '/v1/token' });
      expect(connects).toEqual(['upstream.test:8080']);
    });

    it('bypasses the proxy for hosts listed in NO_PROXY', async () => {
      const origin = await listen((_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end('{"via":"direct"}');
      });
      servers.push(origin);
      const proxyHits: string[] = [];
      const proxy = await listen((req, res) => {
        proxyHits.push(String(req.url));
        res.end('{"via":"proxy"}');
      });
      proxy.on('connect', (req, socket) => {
        proxyHits.push(String(req.url));
        socket.destroy();
      });
      servers.push(proxy);

      process.env.HTTP_PROXY = `http://127.0.0.1:${portOf(proxy)}`;
      process.env.NO_PROXY = '127.0.0.1';
      const res = await proxyAwareFetch(`http://127.0.0.1:${portOf(origin)}/`);

      expect(await res.json()).toEqual({ via: 'direct' });
      expect(proxyHits).toEqual([]);
    });

    it('adds a proxy hint to a timeout', async () => {
      const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout));

      const err = await proxyAwareFetch('https://identitytoolkit.googleapis.com/v1/x').catch(
        (e: unknown) => e
      );

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/Could not reach identitytoolkit\.googleapis\.com/);
      expect((err as Error).message).toMatch(/HTTPS_PROXY/);
      expect((err as Error).cause).toBe(timeout);
    });

    it('passes other errors through unchanged', async () => {
      const boom = new Error('boom');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(boom));

      await expect(proxyAwareFetch('https://example.invalid/')).rejects.toBe(boom);
    });
  });
});
