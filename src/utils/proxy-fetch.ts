/**
 * fetch() that honours the standard proxy environment variables.
 *
 * Node's built-in fetch ignores HTTP_PROXY / HTTPS_PROXY / NO_PROXY unless
 * NODE_USE_ENV_PROXY=1 is set, and that switch only exists on Node 24+, while this
 * package supports Node >= 22. On a network where the Firebase endpoints used for
 * Hoppscotch Cloud sign-in are only reachable through a proxy, the login callback
 * arrived but the token exchange timed out. When a proxy variable is set we route
 * the call through undici's EnvHttpProxyAgent instead; otherwise the global fetch
 * is used unchanged.
 */
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

/** True when any of the standard proxy variables holds a value. */
export function hasProxyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return PROXY_VARS.some((name) => (env[name] ?? '').trim() !== '');
}

let cachedAgent: { key: string; agent: EnvHttpProxyAgent } | null = null;

/** EnvHttpProxyAgent reads the environment at construction, so rebuild it when it changes. */
function proxyAgent(): EnvHttpProxyAgent {
  const key = [...PROXY_VARS, 'NO_PROXY', 'no_proxy'].map((n) => process.env[n] ?? '').join('\n');
  if (!cachedAgent || cachedAgent.key !== key) {
    void cachedAgent?.agent.close().catch(() => undefined);
    cachedAgent = { key, agent: new EnvHttpProxyAgent() };
  }
  return cachedAgent.agent;
}

function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'TimeoutError' || err.name === 'AbortError' || err.message === 'fetch failed';
}

/**
 * Drop-in replacement for `fetch(url, init)` for calls to third-party endpoints.
 * A timeout or connection failure is rethrown with a hint about proxy settings,
 * since the bare "operation was aborted due to timeout" does not say what to fix.
 */
export async function proxyAwareFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    if (hasProxyEnv()) {
      return (await undiciFetch(url, {
        ...init,
        dispatcher: proxyAgent(),
      } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
    }
    return await fetch(url, init);
  } catch (err) {
    if (!isNetworkFailure(err)) throw err;
    const host = new URL(url).host;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not reach ${host} (${detail}). If this network needs a proxy, set HTTPS_PROXY ` +
        `(and NO_PROXY for hosts that must stay direct) in the MCP server's environment.`,
      { cause: err }
    );
  }
}
