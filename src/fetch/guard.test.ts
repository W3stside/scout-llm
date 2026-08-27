/**
 * The address classifier is the SSRF boundary; every case here is a concrete attack that
 * must stay refused, or a legitimate destination that must stay reachable.
 */

import { describe, expect, it } from 'vitest';
import { hostGuardError, isPublicAddress, resolvesOnlyPublic } from './guard.ts';

describe('isPublicAddress — IPv4', () => {
    it('refuses loopback, RFC1918, and the docker bridge', () => {
        expect(isPublicAddress('127.0.0.1')).toBe(false);
        expect(isPublicAddress('127.255.255.254')).toBe(false);
        expect(isPublicAddress('10.0.0.5')).toBe(false);
        expect(isPublicAddress('192.168.1.1')).toBe(false);
        expect(isPublicAddress('172.16.0.1')).toBe(false);
        expect(isPublicAddress('172.17.0.1')).toBe(false); // docker0 gateway — the Ollama route
        expect(isPublicAddress('172.31.255.255')).toBe(false);
    });

    it('refuses the cloud metadata address', () => {
        expect(isPublicAddress('169.254.169.254')).toBe(false);
    });

    it('refuses CGNAT, benchmark, documentation, multicast and reserved space', () => {
        expect(isPublicAddress('100.64.0.1')).toBe(false);
        expect(isPublicAddress('198.18.0.1')).toBe(false);
        expect(isPublicAddress('192.0.2.1')).toBe(false);
        expect(isPublicAddress('224.0.0.1')).toBe(false);
        expect(isPublicAddress('255.255.255.255')).toBe(false);
        expect(isPublicAddress('0.0.0.0')).toBe(false);
    });

    it('accepts ordinary public addresses, including near-miss neighbours', () => {
        expect(isPublicAddress('1.1.1.1')).toBe(true);
        expect(isPublicAddress('93.184.216.34')).toBe(true);
        expect(isPublicAddress('172.15.0.1')).toBe(true); // just below 172.16/12
        expect(isPublicAddress('172.32.0.1')).toBe(true); // just above 172.16/12
        expect(isPublicAddress('100.63.255.255')).toBe(true); // just below CGNAT
        expect(isPublicAddress('11.0.0.1')).toBe(true); // just above 10/8
    });
});

describe('isPublicAddress — IPv6', () => {
    it('refuses loopback, unspecified, ULA and link-local', () => {
        expect(isPublicAddress('::1')).toBe(false);
        expect(isPublicAddress('::')).toBe(false);
        expect(isPublicAddress('fc00::1')).toBe(false);
        expect(isPublicAddress('fd12:3456::1')).toBe(false);
        expect(isPublicAddress('fe80::1')).toBe(false);
    });

    it('judges a v4-mapped address by its embedded v4 — the classic bypass', () => {
        expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false);
        expect(isPublicAddress('::ffff:169.254.169.254')).toBe(false);
        expect(isPublicAddress('::ffff:1.1.1.1')).toBe(true);
    });

    it('refuses NAT64 and 6to4, which smuggle an embedded v4', () => {
        expect(isPublicAddress('64:ff9b::7f00:1')).toBe(false);
        expect(isPublicAddress('2002:7f00:1::')).toBe(false);
    });

    it('refuses a zone index outright', () => {
        expect(isPublicAddress('fe80::1%eth0')).toBe(false);
    });

    it('accepts ordinary public v6', () => {
        expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    });
});

describe('hostGuardError', () => {
    it('refuses IP-literal hostnames — the case net.connect never sends to lookup', () => {
        expect(hostGuardError('127.0.0.1')).not.toBeNull();
        expect(hostGuardError('[::1]')).not.toBeNull();
        expect(hostGuardError('169.254.169.254')).not.toBeNull();
    });

    it('refuses names that address local infrastructure by convention', () => {
        expect(hostGuardError('localhost')).not.toBeNull();
        expect(hostGuardError('foo.localhost')).not.toBeNull();
        expect(hostGuardError('host.docker.internal')).not.toBeNull();
        expect(hostGuardError('metadata.google.internal')).not.toBeNull();
        expect(hostGuardError('printer.local')).not.toBeNull();
    });

    it('is case-insensitive and unmoved by a trailing dot', () => {
        expect(hostGuardError('LOCALHOST')).not.toBeNull();
        expect(hostGuardError('host.docker.INTERNAL.')).not.toBeNull();
    });

    it('passes ordinary public hostnames through to DNS-level checking', () => {
        expect(hostGuardError('olx.pt')).toBeNull();
        expect(hostGuardError('www.standvirtual.com')).toBeNull();
        expect(hostGuardError('1.1.1.1')).toBeNull();
    });
});

describe('resolvesOnlyPublic — the browser path verdict', () => {
    // Only cases that need no network: name-level refusals, and literals that resolve to
    // themselves. Anything requiring live DNS would make the suite flaky offline.
    it('refuses local names and private literals without resolving anything', async () => {
        expect(await resolvesOnlyPublic('localhost')).toBe(false);
        expect(await resolvesOnlyPublic('host.docker.internal')).toBe(false);
        expect(await resolvesOnlyPublic('127.0.0.1')).toBe(false);
        expect(await resolvesOnlyPublic('169.254.169.254')).toBe(false);
    });

    it('accepts a public literal — nothing to resolve, nothing to rebind', async () => {
        expect(await resolvesOnlyPublic('1.1.1.1')).toBe(true);
    });
});
