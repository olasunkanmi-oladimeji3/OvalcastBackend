// Requests to addresses other people choose (partner webhooks), made so they can't be turned on
// Ovalcast itself (server-side request forgery):
//
// - https only in production, on the standard port, with no user:password in the address;
// - never to loopback, private, link-local (the cloud metadata service at 169.254.169.254),
//   carrier-grade NAT, multicast or reserved addresses, IPv4 or IPv6;
// - the check runs on the address actually connected to, every time, so a name that resolved to a
//   public address when it was saved and to a private one later (DNS rebinding) is still refused;
// - redirects are never followed;
// - a short time limit, the reply body is not read, and errors are reduced to a plain category so
//   they can't be used to map the internal network.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

// Two lists: Node checks IPv4 addresses against IPv6 rules too (as ::ffff:a.b.c.d), so one shared
// list would let an IPv6 rule catch every IPv4 address.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
// IPv4
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata services
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and broadcast
] as const)
  blocked4.addSubnet(net, bits, 'ipv4');
// IPv6
for (const [net, bits] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local (private)
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const)
  blocked6.addSubnet(net, bits, 'ipv6');

/** Whether an IP address is one Ovalcast must never send to. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return true;
  if (family === 4) return blocked4.check(address, 'ipv4');
  // An IPv4 address written as IPv6 (::ffff:10.0.0.1, ::ffff:a00:1): judge the IPv4 address inside.
  const v = address.toLowerCase();
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (dotted) return blocked4.check(dotted[1], 'ipv4');
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return blocked4.check([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'), 'ipv4');
  }
  return blocked6.check(address, 'ipv6');
}

const production = () => process.env.NODE_ENV === 'production';
/** Only for testing webhooks on a laptop: ALLOW_LOCAL_WEBHOOKS=true, and never in production. */
const localAllowed = () => !production() && process.env.ALLOW_LOCAL_WEBHOOKS === 'true';

/**
 * Why an address can't be used, or undefined when it's fine to save. Names are looked up too,
 * so an obviously internal one is refused at once; it's checked again on every send.
 */
export async function urlProblem(raw: string): Promise<string | undefined> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'Not a web address';
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && localAllowed())) return 'Use an https address';
  if (u.username || u.password) return 'Remove the user name and password from the address';
  if (production() && u.port && u.port !== '443') return 'Use the standard https port (443)';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (localAllowed() && (host === 'localhost' || host === '127.0.0.1')) return undefined; // testing on a laptop
  if (/^localhost$|\.local$|\.internal$|\.localhost$/i.test(host)) return 'Use a public address, not an internal one';
  if (isIP(host)) return isPrivateAddress(host) ? 'Use a public address, not an internal one' : undefined;
  const addresses = await new Promise<LookupAddress[]>((resolve) => dnsLookup(host, { all: true }, (err, list) => resolve(err ? [] : list)));
  if (!addresses.length) return 'That address doesn’t exist';
  if (addresses.some((a) => isPrivateAddress(a.address))) return 'Use a public address, not an internal one';
  return undefined;
}

/** Resolves a name for a connection, refusing it if any address it resolves to is internal. */
function guardedLookup(hostname: string, options: object, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, []);
    const allowLocal = localAllowed() && (hostname === 'localhost' || hostname === '127.0.0.1');
    if (!allowLocal && addresses.some((a) => isPrivateAddress(a.address))) return callback(Object.assign(new Error('Blocked: internal address'), { code: 'EBLOCKED' }), []);
    const all = (options as { all?: boolean }).all;
    return all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family);
  });
}

export type SafeResult = { ok: boolean; status?: number; error?: string };

/** POSTs a body to an address someone else chose. Never throws; the error is a plain category. */
export async function safePost(raw: string, body: string, headers: Record<string, string>, timeoutMs = 10_000): Promise<SafeResult> {
  const problem = await urlProblem(raw);
  if (problem) return { ok: false, error: `Refused: ${problem}` };
  const u = new URL(raw);
  // An IP address written in the URL skips the name lookup, so it's checked here instead.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host) && !(localAllowed() && host === '127.0.0.1')) return { ok: false, error: 'Refused: internal address' };
  const client = u.protocol === 'https:' ? https : http;
  return new Promise<SafeResult>((resolve) => {
    const req = client.request(
      u,
      { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() }, lookup: guardedLookup as never, timeout: timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0;
        // The reply isn't needed; don't read it. Redirects (3xx) are reported, never followed.
        res.resume();
        res.destroy();
        resolve(status >= 200 && status < 300 ? { ok: true, status } : { ok: false, status, error: status >= 300 && status < 400 ? `Redirected (HTTP ${status}); redirects aren’t followed` : `HTTP ${status}` });
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e: NodeJS.ErrnoException) =>
      resolve({ ok: false, error: e.code === 'EBLOCKED' ? 'Refused: internal address' : e.code === 'ETIMEDOUT' ? 'Timed out' : e.code === 'ENOTFOUND' ? 'Address not found' : e.code?.startsWith('ERR_TLS') || /certificate/i.test(e.message) ? 'TLS certificate problem' : 'Couldn’t connect' }),
    );
    req.end(body);
  });
}
