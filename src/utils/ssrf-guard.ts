/**
 * SSRF guard for execute_request / validate_response.
 *
 * Those tools fetch an arbitrary, model-supplied URL and return the full
 * response (headers + body) back into model context, a textbook SSRF and
 * read-back channel. By default we reject targets that resolve to loopback,
 * link-local (incl. cloud-metadata 169.254.169.254), private, CGNAT, or
 * unspecified addresses, and we restrict the scheme to http/https.
 *
 * This is an API-testing tool, so reaching internal/localhost hosts is a
 * legitimate workflow (self-hosted Hoppscotch, internal services). The guard
 * is therefore opt-OUT: set HOPPSCOTCH_ALLOW_PRIVATE_HOSTS=true to disable it.
 *
 * Enforcement layers:
 *   1. assertHostAllowed: scheme check + literal-IP/hostname denylist (sync).
 *   2. assertUrlAllowed:  the above, plus DNS resolution of a hostname and
 *      validation of every resolved address before the request is made.
 *   3. getPinnedDispatcher: an undici Agent whose connect-time DNS lookup
 *      re-validates every resolved address and connects ONLY to a validated one,
 *      so the SAME resolution is used for the check and the connection. This
 *      closes the same-hostname DNS-rebinding TOCTOU that layers 1-2 would
 *      otherwise leave open (a plain fetch re-resolves at connect and could reach
 *      a now-private IP after the pre-flight check passed).
 * Combined with `redirect: 'manual'` in the executor (no auto-follow), the
 * redirect-to-private-IP amplification vector is closed too.
 */
import { lookup } from 'node:dns/promises';
import { lookup as dnsLookupCb } from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'undici';

export class SSRFBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SSRFBlockedError';
  }
}

/** Hostnames blocked regardless of resolution (defense-in-depth for metadata). */
const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog']);

function blockMessage(target: string): string {
  return (
    `Blocked request to a private/internal address (${target}). ` +
    `execute_request refuses loopback, link-local, cloud-metadata, and private ` +
    `network targets by default. Set HOPPSCOTCH_ALLOW_PRIVATE_HOSTS=true to allow ` +
    `them (e.g. testing a self-hosted or local API).`
  );
}

/** A fully-expanded IPv6 address: exactly 8 hextets. */
type Hextets = [number, number, number, number, number, number, number, number];

function isBlockedV4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed → fail closed
  }
  // The length+range guard above proves all four octets are present numbers;
  // the tuple cast tells the compiler what it can't infer from `.length`.
  const [a, b, c] = parts as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10.0.0.0/8 private
    a === 127 || // 127.0.0.0/8 loopback
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local (incl. metadata)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments (incl. 192.0.0.192 Oracle IMDS)
    (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 TEST-NET-1
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 TEST-NET-3
    (a === 192 && b === 88 && c === 99) || // 192.88.99.0/24 6to4 relay anycast (deprecated)
    (a >= 224 && a <= 239) || // 224.0.0.0/4 multicast
    a >= 240 // 240.0.0.0/4 reserved + 255.255.255.255 broadcast
  );
}

/**
 * Expand a (possibly compressed / v4-embedded / zone-tagged) IPv6 literal into
 * exactly 8 hextets. Returns null if it can't be parsed (caller fails closed).
 */
function expandV6(ipRaw: string): Hextets | null {
  let ip = ipRaw.toLowerCase();
  const pct = ip.indexOf('%'); // strip zone id (e.g. fe80::1%eth0)
  if (pct >= 0) ip = ip.slice(0, pct);

  // Convert a trailing dotted-IPv4 (::ffff:127.0.0.1) into two hex hextets so
  // the hex form (::ffff:7f00:1) and the dotted form normalize identically.
  const v4m = ip.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4m) {
    const o = [Number(v4m[2]), Number(v4m[3]), Number(v4m[4]), Number(v4m[5])] as [
      number,
      number,
      number,
      number,
    ];
    if (o.some((n) => n > 255)) return null;
    ip = `${v4m[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  let groups: string[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const hextets = groups.map((g) => (g === '' ? 0 : parseInt(g, 16)));
  if (hextets.some((h) => Number.isNaN(h) || h < 0 || h > 0xffff)) return null;
  return hextets as Hextets;
}

function isBlockedV6(ipRaw: string): boolean {
  const h = expandV6(ipRaw);
  if (!h) return true; // unparseable → fail closed
  if (h.every((x) => x === 0)) return true; // :: unspecified
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1 loopback
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // Additional IANA special-purpose / non-globally-reachable ranges.
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true; // 100::/64 discard-only
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0x0001) return true; // 64:ff9b:1::/48 local NAT64
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (h[0] === 0x3fff && (h[1] & 0xf000) === 0) return true; // 3fff::/20 documentation
  if (h[0] === 0x5f00) return true; // 5f00::/16 SRv6 SIDs

  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d):
  // evaluate the embedded v4 in both hex and dotted forms. :: and ::1 are
  // already handled above, so the compatible branch (h[5]===0) only matches
  // ::/96 embeddings, never a real public IPv6 address.
  const v4embedded =
    h[0] === 0 &&
    h[1] === 0 &&
    h[2] === 0 &&
    h[3] === 0 &&
    h[4] === 0 &&
    (h[5] === 0xffff || h[5] === 0);
  if (v4embedded) {
    const a = (h[6] >> 8) & 0xff;
    const b = h[6] & 0xff;
    const c = (h[7] >> 8) & 0xff;
    const d = h[7] & 0xff;
    return isBlockedV4(`${a}.${b}.${c}.${d}`);
  }

  // Transitional IPv6 forms that embed a routable IPv4 the packet ultimately
  // reaches. An attacker can embed a private/loopback v4, so decode it and reuse
  // the v4 denylist (fail-closed bias: over-blocking a transitional address
  // with a private embedded v4 is acceptable for an opt-out guard).
  const v4FromHextets = (hi: number, lo: number): string =>
    `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;

  // 6to4 (2002::/16): gateway IPv4 in bits 16-47 (h[1], h[2]).
  if (h[0] === 0x2002 && isBlockedV4(v4FromHextets(h[1], h[2]))) return true;

  // NAT64 well-known prefix (64:ff9b::/96): IPv4 in the last 32 bits (h[6], h[7]).
  if (
    h[0] === 0x0064 &&
    h[1] === 0xff9b &&
    h[2] === 0 &&
    h[3] === 0 &&
    h[4] === 0 &&
    h[5] === 0 &&
    isBlockedV4(v4FromHextets(h[6], h[7]))
  ) {
    return true;
  }

  // Teredo (2001:0000::/32): server IPv4 in h[2],h[3]; client IPv4 in h[6],h[7]
  // bit-inverted (XOR 0xffff). Either resolving to a private v4 means an internal
  // tunnel endpoint, so fail closed on both.
  if (h[0] === 0x2001 && h[1] === 0x0000) {
    const server = v4FromHextets(h[2], h[3]);
    const client = v4FromHextets(h[6] ^ 0xffff, h[7] ^ 0xffff);
    if (isBlockedV4(server) || isBlockedV4(client)) return true;
  }

  return false;
}

/** True if a literal IP string falls in a blocked range. Non-IP input → false. */
export function isBlockedAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedV4(ip);
  if (fam === 6) return isBlockedV6(ip);
  return false;
}

/** Normalize a URL host: strip IPv6 brackets and a single trailing dot. */
function canonicalHost(url: string): string {
  return new URL(url).hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

/**
 * Scheme guard, enforced UNCONDITIONALLY, even when private hosts are allowed.
 * Only http/https may be fetched.
 */
export function assertScheme(url: string): void {
  const { protocol } = new URL(url);
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new SSRFBlockedError(
      `Unsupported URL scheme '${protocol}' — only http/https are allowed.`
    );
  }
}

/**
 * Synchronous pre-flight: scheme + blocked metadata hostnames + literal
 * private/loopback IP targets. Does NOT resolve DNS.
 */
export function assertHostAllowed(url: string): void {
  assertScheme(url);
  const host = canonicalHost(url);
  if (BLOCKED_HOSTNAMES.has(host)) throw new SSRFBlockedError(blockMessage(host));
  if (isIP(host) && isBlockedAddress(host)) throw new SSRFBlockedError(blockMessage(host));
}

/**
 * Full async guard: sync pre-flight, then (for hostnames) resolve DNS and
 * reject if ANY resolved address is private/internal. Fails CLOSED on a
 * resolution error. Call this immediately before fetch().
 */
export async function assertUrlAllowed(url: string): Promise<void> {
  assertHostAllowed(url);
  const host = canonicalHost(url);
  if (isIP(host)) return; // literal IP already validated above
  let resolved: { address: string }[];
  try {
    resolved = await lookup(host, { all: true });
  } catch {
    throw new SSRFBlockedError(
      `Could not resolve '${host}' to verify it is not an internal address — blocking. ` +
        `Retry if this is a transient DNS error, or set HOPPSCOTCH_ALLOW_PRIVATE_HOSTS=true for intentional local targets.`
    );
  }
  for (const { address } of resolved) {
    if (isBlockedAddress(address)) {
      throw new SSRFBlockedError(blockMessage(`${host} → ${address}`));
    }
  }
}

/** Whether the operator has opted out of SSRF protection. */
export function privateHostsAllowed(): boolean {
  return process.env.HOPPSCOTCH_ALLOW_PRIVATE_HOSTS === 'true';
}

type ResolvedAddress = { address: string; family: number };

/**
 * Validate a resolved address list at connect time: throws if ANY resolved
 * address is blocked (a mixed public/private result is a classic DNS-rebinding
 * tell) or the list is empty (fail closed). Returns normally when every address
 * is permitted.
 */
export function assertResolvedAddressesAllowed(
  hostname: string,
  addresses: ResolvedAddress[]
): void {
  const valid = addresses.filter((a) => typeof a.address === 'string' && a.address.length > 0);
  if (valid.length === 0) {
    throw new SSRFBlockedError(
      `Could not resolve '${hostname}' to a permitted address — blocking.`
    );
  }
  const blocked = valid.find((a) => isBlockedAddress(a.address));
  if (blocked) {
    throw new SSRFBlockedError(blockMessage(`${hostname} → ${blocked.address}`));
  }
}

type ResolveAll = (
  hostname: string,
  options: { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: ResolvedAddress[]) => void
) => void;

// Node's dns.lookup callback is overloaded: positional `(err, address, family)`
// by default, but an ARRAY `(err, addresses)` when the caller passes `all: true`.
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | ResolvedAddress[],
  family?: number
) => void;

// dns.lookup(host, { all: true }, cb) always calls back with an address array;
// the overloaded built-in type doesn't narrow on the runtime-built options.
const defaultResolveAll = dnsLookupCb as unknown as ResolveAll;

/**
 * Build the connect-time DNS lookup for the pinned dispatcher: resolve ALL
 * addresses, reject if any is blocked (fail closed), then hand the connector a
 * validated result. It MUST honor the `all` flag, because Node's default
 * `autoSelectFamily` invokes the lookup with `{ all: true }` and requires the
 * callback's address argument to be an ARRAY of `{ address, family }`; returning
 * a single positional address there makes Node throw "Invalid IP address:
 * undefined" and breaks every request. The resolver is injectable for testing.
 */
export function makePinnedLookup(resolveAll: ResolveAll = defaultResolveAll) {
  return function pinnedLookup(
    hostname: string,
    options: { all?: boolean } | undefined,
    callback: LookupCallback
  ): void {
    resolveAll(hostname, { all: true }, (err, addresses) => {
      if (err) {
        callback(err);
        return;
      }
      let valid: ResolvedAddress[];
      try {
        assertResolvedAddressesAllowed(hostname, addresses);
        valid = addresses.filter((a) => typeof a.address === 'string' && a.address.length > 0);
      } catch (e) {
        callback(e as NodeJS.ErrnoException);
        return;
      }
      if (options?.all) {
        callback(null, valid); // array form (autoSelectFamily / all:true)
      } else {
        const first = valid[0]!;
        callback(null, first.address, first.family); // positional form
      }
    });
  };
}

let pinnedAgent: Agent | null = null;

/**
 * A shared undici dispatcher whose DNS lookup re-validates every resolved address
 * and connects only to validated ones: the SAME resolution is used for the check
 * and the connection, closing the DNS-rebinding TOCTOU. Pass it as fetch's
 * `dispatcher`. Lazily created and reused.
 */
export function getPinnedDispatcher(): Agent {
  if (pinnedAgent) return pinnedAgent;
  const pinnedLookup = makePinnedLookup();
  pinnedAgent = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        // Adapt undici's positional LookupFunction type to our array-capable
        // callback; the runtime shape is dns.lookup-compatible.
        pinnedLookup(
          hostname,
          options as { all?: boolean } | undefined,
          callback as unknown as LookupCallback
        );
      },
    },
  });
  return pinnedAgent;
}
