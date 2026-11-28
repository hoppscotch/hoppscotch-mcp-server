import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net, { type AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasProxyEnv, proxyAwareFetch, proxyAwareFetchJson } from './proxy-fetch';

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

/** Self-signed localhost certificate made with openssl; null when openssl is unavailable. */
function selfSignedCert(): { key: string; cert: string } | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-fetch-cert-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-keyout',
        path.join(dir, 'key.pem'),
        '-out',
        path.join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' }
    );
    return {
      key: fs.readFileSync(path.join(dir, 'key.pem'), 'utf8'),
      cert: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8'),
    };
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const tlsFixture = selfSignedCert();

/** Minimal CONNECT proxy that records each requested authority and splices to `targetPort`. */
async function connectProxy(targetPort: number, connects: string[]): Promise<http.Server> {
  const proxy = await listen((_req, res) => {
    res.statusCode = 405;
    res.end();
  });
  proxy.on('connect', (req, clientSocket, head) => {
    connects.push(String(req.url));
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  return proxy;
}

const portOf = (server: http.Server | https.Server): number =>
  (server.address() as AddressInfo).port;

describe('proxy-fetch', () => {
  const saved: Record<string, string | undefined> = {};
  const servers: (http.Server | https.Server)[] = [];

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
    vi.unstubAllEnvs();
    await Promise.all(
      servers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
            s.closeAllConnections();
          })
      )
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

    it.skipIf(!tlsFixture)('tunnels an https:// request through HTTPS_PROXY', async () => {
      // Both Firebase endpoints are https://, so the proxy has to see a CONNECT for
      // port 443 and the TLS handshake and request then run inside the tunnel.
      const origin = await new Promise<https.Server>((resolve) => {
        const server = https.createServer(tlsFixture!, (req, res) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ host: req.headers.host, path: req.url, tls: true }));
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
      });
      servers.push(origin);
      const connects: string[] = [];
      const proxy = await connectProxy(portOf(origin), connects);
      servers.push(proxy);

      process.env.HTTPS_PROXY = `http://127.0.0.1:${portOf(proxy)}`;
      // The origin's certificate is self-signed; accept it for this test only.
      vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
      const res = await proxyAwareFetch('https://identitytoolkit.test/v1/accounts:signIn?key=k', {
        method: 'POST',
        body: '{}',
      });

      expect(await res.json()).toEqual({
        host: 'identitytoolkit.test',
        path: '/v1/accounts:signIn?key=k',
        tls: true,
      });
      expect(connects).toEqual(['identitytoolkit.test:443']);
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

  describe('proxyAwareFetchJson', () => {
    it('returns the response and parsed body', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('{"ok":true}', { status: 400 }))
      );

      const { res, data } = await proxyAwareFetchJson<{ ok: boolean }>('https://example.invalid/');

      expect(res.status).toBe(400);
      expect(data).toEqual({ ok: true });
    });

    it('adds the proxy hint when the request times out before headers', async () => {
      const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout));

      await expect(proxyAwareFetchJson('https://securetoken.googleapis.com/v1/x')).rejects.toThrow(
        /Could not reach securetoken\.googleapis\.com.*HTTPS_PROXY/
      );
    });

    it.each([
      ['no proxy configured', false],
      ['a proxy configured', true],
    ])(
      'adds the proxy hint when the body stalls after the headers (%s)',
      async (_label, viaProxy) => {
        // Headers and the first bytes of the body arrive, then the server goes quiet.
        const origin = await listen((_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"idToken":');
        });
        servers.push(origin);
        const connects: string[] = [];
        let target = `http://127.0.0.1:${portOf(origin)}/v1/token`;
        if (viaProxy) {
          const proxy = await connectProxy(portOf(origin), connects);
          servers.push(proxy);
          process.env.HTTP_PROXY = `http://127.0.0.1:${portOf(proxy)}`;
          target = 'http://stalled.test:8080/v1/token';
        }

        const err = await proxyAwareFetchJson(target, { signal: AbortSignal.timeout(300) }).catch(
          (e: unknown) => e
        );

        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/Could not reach (127\.0\.0\.1|stalled\.test)/);
        expect((err as Error).message).toMatch(/HTTPS_PROXY/);
        if (viaProxy) expect(connects).toEqual(['stalled.test:8080']);
      }
    );

    it('does not rewrite a malformed JSON body error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('<html>'))
      );

      await expect(proxyAwareFetchJson('https://example.invalid/')).rejects.toBeInstanceOf(
        SyntaxError
      );
    });
  });
});
