// TLS-02: map client certificates to usernames (RFC 7407 cert-to-name).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { certToName, mapCertificateToName, type CertToNameEntry } from '../src/index.js';
import { subjectAltNames } from '../src/node/cert-to-name.js';
import { cert, chainOf, pem, tlsClient, tlsFingerprint, tlsServer } from './tls-helpers.js';

const CA = tlsFingerprint('ca');
const name = (client: string, entries: readonly CertToNameEntry[]): string | undefined => mapCertificateToName(chainOf(client), entries)?.username;

describe('TLS-02 cert-to-name', () => {
  it('tries entries in ascending id order, whatever order they are listed in', () => {
    const entries: CertToNameEntry[] = [
      { id: 20, fingerprint: CA, mapType: 'common-name' },
      { id: 10, fingerprint: CA, mapType: 'specified', name: 'first' },
    ];
    expect(mapCertificateToName(chainOf('client'), entries)).toEqual({ username: 'first', entryId: 10 });
  });

  it('rejects duplicate ids, unknown map types and misplaced names when set up, naming the entry', () => {
    expect(() => certToName([])).toThrow(/at least one entry/);
    expect(() => certToName([{ id: 1, fingerprint: CA, mapType: 'common-name' }, { id: 1, fingerprint: CA, mapType: 'san-any' }])).toThrow(/id 1: the id is used twice/);
    expect(() => certToName([{ id: 2, fingerprint: CA, mapType: 'cn' as never }])).toThrow(/id 2: mapType must be one of/);
    expect(() => certToName([{ id: 3, fingerprint: CA, mapType: 'specified' }])).toThrow(/id 3: a specified entry needs a name/);
    expect(() => certToName([{ id: 4, fingerprint: CA, mapType: 'common-name', name: 'x' }])).toThrow(/id 4: only a specified entry has a name/);
    expect(() => certToName([{ id: -1, fingerprint: CA, mapType: 'common-name' }])).toThrow(/id must be a whole number/);
  });

  it("applies an entry whose fingerprint is the client's certificate, an intermediate or the trust anchor", () => {
    const by = (fp: string): CertToNameEntry[] => [{ id: 1, fingerprint: fp, mapType: 'specified', name: 'matched' }];
    expect(name('client', by(tlsFingerprint('client')))).toBe('matched');
    expect(name('int-client', by(tlsFingerprint('int')))).toBe('matched');
    expect(name('int-client', by(CA))).toBe('matched');
    // Another certificate's fingerprint doesn't apply.
    expect(name('client', by(tlsFingerprint('plain-client')))).toBeUndefined();
    expect(name('other-client', by(CA))).toBeUndefined();
  });

  it('maps with each RFC 7407 map type, normalising names as the RFC says', () => {
    const one = (mapType: CertToNameEntry['mapType']): string | undefined => name('client', [{ id: 1, fingerprint: CA, mapType }]);
    // client: DNS Client.Example.COM, email Ops@Example.COM, IP 192.0.2.7, IP 2001:db8::7, CN netconf.
    expect(name('client', [{ id: 1, fingerprint: CA, mapType: 'specified', name: 'admin' }])).toBe('admin');
    expect(one('san-rfc822-name')).toBe('Ops@example.com');
    expect(one('san-dns-name')).toBe('client.example.com');
    expect(one('san-ip-address')).toBe('192.0.2.7');
    expect(one('san-any')).toBe('client.example.com');
    expect(one('common-name')).toBe('netconf');
  });

  it('writes an IPv6 address as 32 lowercase hex digits', () => {
    // Only the second IP SAN is IPv6: reach it by dropping IPv4 through the parser.
    const sans = subjectAltNames(cert('client').subjectAltName)!;
    expect(sans.map(([t]) => t)).toEqual(['DNS', 'email', 'IP Address', 'IP Address']);
    const v6 = mapCertificateToName(
      [{ ...cert('client'), raw: cert('client').raw, subject: 'CN=x', subjectAltName: 'IP Address:2001:DB8:0:0:0:0:0:7' } as never, cert('ca')],
      [{ id: 1, fingerprint: CA, mapType: 'san-ip-address' }],
    );
    expect(v6?.username).toBe('20010db8000000000000000000000007');
    const compressed = mapCertificateToName(
      [{ raw: cert('client').raw, subject: 'CN=x', subjectAltName: 'IP Address:::FFFF:192.0.2.1' } as never, cert('ca')],
      [{ id: 1, fingerprint: CA, mapType: 'san-ip-address' }],
    );
    expect(compressed?.username).toBe('00000000000000000000ffffc0000201');
  });

  it('tries the next entry when a map type finds no name, and refuses when none does', () => {
    const entries: CertToNameEntry[] = [
      { id: 1, fingerprint: CA, mapType: 'san-rfc822-name' },
      { id: 2, fingerprint: CA, mapType: 'common-name' },
    ];
    // plain-client has no SANs: the email entry finds nothing, the CN entry names it.
    expect(mapCertificateToName(chainOf('plain-client'), entries)).toEqual({ username: 'plain', entryId: 2 });
    expect(name('plain-client', [{ id: 1, fingerprint: CA, mapType: 'san-any' }])).toBeUndefined();
    // Two CNs give no common name.
    expect(name('multi-cn-client', [{ id: 1, fingerprint: CA, mapType: 'common-name' }])).toBeUndefined();
    expect(mapCertificateToName([], entries)).toBeUndefined();
  });

  it('accepts tls-fingerprints for SHA-224 to SHA-512 and SHA256:<base64>, and rejects MD5, SHA-1 and malformed ones', () => {
    for (const alg of ['sha224', 'sha256', 'sha384', 'sha512'] as const) {
      expect(name('client', [{ id: 1, fingerprint: tlsFingerprint('ca', alg), mapType: 'common-name' }])).toBe('netconf');
    }
    const b64 = `SHA256:${createHash('sha256').update(cert('ca').raw).digest('base64').replace(/=+$/, '')}`;
    expect(name('client', [{ id: 1, fingerprint: b64, mapType: 'common-name' }])).toBe('netconf');
    expect(name('client', [{ id: 1, fingerprint: CA.toUpperCase(), mapType: 'common-name' }])).toBe('netconf');

    const md5 = ['01', ...createHash('md5').update(cert('ca').raw).digest('hex').match(/../g)!].join(':');
    const sha1 = ['02', ...createHash('sha1').update(cert('ca').raw).digest('hex').match(/../g)!].join(':');
    expect(() => certToName([{ id: 7, fingerprint: md5, mapType: 'common-name' }])).toThrow(/id 7: MD5 fingerprints aren't accepted/);
    expect(() => certToName([{ id: 7, fingerprint: sha1, mapType: 'common-name' }])).toThrow(/SHA-1 fingerprints aren't accepted/);
    expect(() => certToName([{ id: 7, fingerprint: '04:ab:cd', mapType: 'common-name' }])).toThrow(/has 32 octets after the algorithm octet, not 2/);
    expect(() => certToName([{ id: 7, fingerprint: 'abcdef', mapType: 'common-name' }])).toThrow(/must be a tls-fingerprint/);
    expect(() => certToName([{ id: 7, fingerprint: '09:ab', mapType: 'common-name' }])).toThrow(/hash algorithm 9 is unknown/);
  });

  it('never maps a subject alternative name that contains text looking like another name', () => {
    // tricky-client's only SAN is the email "evil@example.com, DNS:admin".
    expect(subjectAltNames(cert('tricky-client').subjectAltName)).toEqual([['email', 'evil@example.com, DNS:admin']]);
    expect(name('tricky-client', [{ id: 1, fingerprint: CA, mapType: 'san-dns-name' }])).toBeUndefined();
    expect(name('tricky-client', [{ id: 1, fingerprint: CA, mapType: 'san-any' }])).toBe('evil@example.com, dns:admin');
    // Malformed text yields no names at all.
    expect(subjectAltNames('DNS:"unterminated')).toBeUndefined();
    expect(subjectAltNames('no colon')).toBeUndefined();
  });

  it('maps over a real TLS connection, from an intermediate-issued certificate by its email address', async () => {
    // The intermediate is a configured trust anchor too: a TLS server can't see intermediates the client sends.
    const fixture = await tlsServer({
      users: [{ username: 'int-user@example.com' }],
      listener: { ca: [pem('ca.pem'), pem('int.pem')], certToName: [{ id: 5, fingerprint: tlsFingerprint('int'), mapType: 'san-rfc822-name' }] },
    });
    await (await tlsClient(fixture.port, 'int-client')).close();
    // A client the intermediate didn't issue isn't mapped by that entry.
    await expect(tlsClient(fixture.port, 'client')).rejects.toThrow();
    await fixture.close();

    // With only the root configured, the client's own intermediate is validated but can't be matched.
    const rootOnly = await tlsServer({
      users: [{ username: 'int-user@example.com' }],
      listener: { certToName: [{ id: 5, fingerprint: tlsFingerprint('int'), mapType: 'san-rfc822-name' }] },
    });
    await expect(tlsClient(rootOnly.port, 'int-client')).rejects.toThrow();
    await rootOnly.close();
  });
});
