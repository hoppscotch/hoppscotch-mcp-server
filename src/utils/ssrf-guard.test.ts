import { describe, it, expect } from 'vitest';
import {
  isBlockedAddress,
  assertHostAllowed,
  assertResolvedAddressesAllowed,
  makePinnedLookup,
  SSRFBlockedError,
} from './ssrf-guard.js';

describe('isBlockedAddress — IPv4', () => {
  it('blocks loopback, private, link-local, CGNAT, unspecified', () => {
    for (const ip of [
      '127.0.0.1',
      '127.10.20.30',
      '10.0.0.1',
      '172.16.5.4',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '198.18.0.1',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('blocks IETF-assigned, TEST-NET, multicast, and reserved ranges', () => {
    for (const ip of [
      '192.0.0.192', // Oracle cloud IMDS (192.0.0.0/24)
      '192.0.0.1', // 192.0.0.0/24 IETF protocol assignments
      '192.0.2.5', // TEST-NET-1
      '198.51.100.7', // TEST-NET-2
      '203.0.113.9', // TEST-NET-3
      '192.88.99.1', // 6to4 relay anycast (deprecated)
      '224.0.0.1', // multicast
      '239.255.255.250', // multicast (SSDP)
      '240.0.0.1', // reserved / future
      '255.255.255.255', // limited broadcast
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });
});

describe('isBlockedAddress — IPv6', () => {
  it('blocks loopback, unspecified, ULA, link-local, v4-mapped private', () => {
    for (const ip of [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('blocks HEX-form v4-mapped addresses (::ffff:7f00:1 == 127.0.0.1)', () => {
    // Regression: the dotted-only check let the canonical hex form bypass.
    for (const ip of [
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '::ffff:c0a8:1',
      '0:0:0:0:0:ffff:7f00:0001',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('allows public hex-form v4-mapped (::ffff:8.8.8.8 == ::ffff:808:808)', () => {
    expect(isBlockedAddress('::ffff:808:808')).toBe(false);
  });

  it('blocks deprecated IPv4-compatible embeddings (::a.b.c.d)', () => {
    for (const ip of ['::127.0.0.1', '::7f00:1', '::169.254.169.254']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('blocks deprecated site-local (fec0::/10) and multicast (ff00::/8)', () => {
    for (const ip of ['fec0::1', 'fec0:0:0:1::abcd', 'ff02::1', 'ff05::c']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('blocks additional IANA special-purpose IPv6 ranges', () => {
    for (const ip of [
      '100::1', // 100::/64 discard-only
      '64:ff9b:1::c0a8:1', // 64:ff9b:1::/48 local-use NAT64
      '2001:db8::1', // 2001:db8::/32 documentation
      '3fff:0:abcd::1', // 3fff::/20 documentation
      '5f00:1234::1', // 5f00::/16 SRv6 SIDs
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('allows public IPv6 and v4-mapped public', () => {
    for (const ip of ['2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it('blocks transitional embeddings (6to4 / NAT64 / Teredo) that carry a private IPv4', () => {
    for (const ip of [
      '2002:7f00:1::', // 6to4 → 127.0.0.1
      '2002:a9fe:a9fe::', // 6to4 → 169.254.169.254 (metadata)
      '2002:c0a8:101::', // 6to4 → 192.168.1.1
      '64:ff9b::7f00:1', // NAT64 well-known → 127.0.0.1
      '64:ff9b::c0a8:1', // NAT64 well-known → 192.168.0.1
      '2001:0:808:808:0:0:3f57:fefe', // Teredo, client v4 (inverted) → 192.168.1.1
      '2001:0:a00:1:0:0:f7f7:f7f7', // Teredo, server v4 → 10.0.0.1
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('allows transitional embeddings (6to4 / NAT64 / Teredo) that carry only public IPv4', () => {
    for (const ip of [
      '2002:808:808::', // 6to4 → 8.8.8.8
      '64:ff9b::808:808', // NAT64 well-known → 8.8.8.8
      '2001:0:4136:e378:8000:63bf:f7f7:fbfb', // Teredo, server 65.54.227.120 / client 8.8.4.4 (both genuinely public)
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });
});

describe('isBlockedAddress — non-IP input', () => {
  it('returns false for hostnames (resolution handled at connect time)', () => {
    expect(isBlockedAddress('example.com')).toBe(false);
    expect(isBlockedAddress('not-an-ip')).toBe(false);
  });
});

describe('assertHostAllowed', () => {
  it('rejects non-http(s) schemes', () => {
    expect(() => assertHostAllowed('file:///etc/passwd')).toThrow(SSRFBlockedError);
    expect(() => assertHostAllowed('ftp://example.com')).toThrow(SSRFBlockedError);
  });

  it('rejects literal private/loopback/metadata IPs', () => {
    expect(() => assertHostAllowed('http://127.0.0.1/x')).toThrow(SSRFBlockedError);
    expect(() => assertHostAllowed('http://169.254.169.254/latest/meta-data')).toThrow(
      SSRFBlockedError
    );
    expect(() => assertHostAllowed('http://[::1]:8080/')).toThrow(SSRFBlockedError);
    expect(() => assertHostAllowed('http://192.168.0.10/')).toThrow(SSRFBlockedError);
  });

  it('rejects known metadata hostnames, incl. trailing-dot FQDN', () => {
    expect(() => assertHostAllowed('http://metadata.google.internal/')).toThrow(SSRFBlockedError);
    expect(() => assertHostAllowed('http://metadata.google.internal./')).toThrow(SSRFBlockedError);
  });

  it('rejects hex-form v4-mapped loopback literal', () => {
    expect(() => assertHostAllowed('http://[::ffff:7f00:1]/')).toThrow(SSRFBlockedError);
  });

  it('allows public hosts (hostname resolution deferred to connect)', () => {
    expect(() => assertHostAllowed('https://api.hoppscotch.io/graphql')).not.toThrow();
    expect(() => assertHostAllowed('https://echo.hoppscotch.io/v2/orders')).not.toThrow();
    expect(() => assertHostAllowed('http://8.8.8.8/')).not.toThrow();
  });
});

describe('assertResolvedAddressesAllowed — connect-time pin', () => {
  it('allows an all-public resolution', () => {
    expect(() =>
      assertResolvedAddressesAllowed('x.test', [{ address: '93.184.216.34', family: 4 }])
    ).not.toThrow();
  });

  it('blocks when ANY resolved address is private (rebinding tell)', () => {
    expect(() =>
      assertResolvedAddressesAllowed('x.test', [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ])
    ).toThrow(SSRFBlockedError);
  });

  it('blocks a resolution to a newly-surfaced metadata IP (simulated rebind)', () => {
    expect(() =>
      assertResolvedAddressesAllowed('x.test', [{ address: '192.0.0.192', family: 4 }])
    ).toThrow(SSRFBlockedError);
  });

  it('fails closed on an empty resolution', () => {
    expect(() => assertResolvedAddressesAllowed('x.test', [])).toThrow(SSRFBlockedError);
  });
});

describe('makePinnedLookup — connect callback shape (regression: array form for autoSelectFamily)', () => {
  const resolveTo =
    (addrs: Array<{ address: string; family: number }>) =>
    (
      _h: string,
      _o: { all: true },
      cb: (e: NodeJS.ErrnoException | null, a: Array<{ address: string; family: number }>) => void
    ) =>
      cb(null, addrs);

  it('returns the ARRAY form when the connector requests all (Node autoSelectFamily)', () => {
    const lookup = makePinnedLookup(
      resolveTo([
        { address: '93.184.216.34', family: 4 },
        { address: '93.184.216.35', family: 4 },
      ])
    );
    let out: { err: unknown; addr: unknown } | undefined;
    lookup('x.test', { all: true }, (err, addr) => {
      out = { err, addr };
    });
    expect(out!.err).toBeNull();
    expect(Array.isArray(out!.addr)).toBe(true);
    expect(out!.addr).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 },
    ]);
  });

  it('returns the positional form when all is not requested', () => {
    const lookup = makePinnedLookup(resolveTo([{ address: '8.8.8.8', family: 4 }]));
    let out: unknown[] | undefined;
    lookup('x.test', {}, (err, addr, fam) => {
      out = [err, addr, fam];
    });
    expect(out).toEqual([null, '8.8.8.8', 4]);
  });

  it('blocks (errors) when any resolved address is private — the connect-time pin', () => {
    const lookup = makePinnedLookup(
      resolveTo([
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ])
    );
    let err: unknown;
    lookup('x.test', { all: true }, (e) => {
      err = e;
    });
    expect(err).toBeInstanceOf(SSRFBlockedError);
  });

  it('propagates a DNS resolution error', () => {
    const lookup = makePinnedLookup((_h, _o, cb) =>
      cb(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), [])
    );
    let err: NodeJS.ErrnoException | undefined;
    lookup('x.test', { all: true }, (e) => {
      err = e as NodeJS.ErrnoException;
    });
    expect(err?.code).toBe('ENOTFOUND');
  });
});
