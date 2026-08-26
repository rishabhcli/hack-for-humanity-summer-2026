import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { egressViolationsIn, referencedNames, shippedSourceFiles } from './check-egress.mjs';
import { EGRESS_EXEMPTIONS, egressViolation, prohibitedApiCount } from './egress-policy.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');

/** Code a future contributor could plausibly write, one sample per prohibited capability. */
const EGRESS_SAMPLES = /** @type {ReadonlyArray<readonly [string, string]>} */ ([
  ['const response = await fetch("https://example.test/upload");', 'EGRESS_NETWORK_API'],
  ['navigator.sendBeacon("/telemetry", payload);', 'EGRESS_NETWORK_API'],
  ['const socket = new WebSocket("wss://example.test");', 'EGRESS_NETWORK_API'],
  ['const source = new EventSource("/events");', 'EGRESS_NETWORK_API'],
  ['const peer = new RTCPeerConnection();', 'EGRESS_NETWORK_API'],
  ['const request = new XMLHttpRequest();', 'EGRESS_NETWORK_API'],
  ['const frame = canvas.toDataURL("image/png");', 'EGRESS_FRAME_SERIALIZATION_API'],
  ['canvas.toBlob((blob) => save(blob));', 'EGRESS_FRAME_SERIALIZATION_API'],
  ['const recorder = new MediaRecorder(stream);', 'EGRESS_FRAME_SERIALIZATION_API'],
  ['const pixels = context.getImageData(0, 0, 1, 1);', 'EGRESS_FRAME_SERIALIZATION_API'],
  ['const clone = video.captureStream();', 'EGRESS_FRAME_SERIALIZATION_API'],
]);

describe('I6 — the shipped bundle has no capability to transmit or serialize a frame', () => {
  it('finds no prohibited API anywhere in shipped source', () => {
    const offenders = [];
    for (const path of shippedSourceFiles(resolve(repositoryRoot, 'src'))) {
      const file = path.slice(repositoryRoot.length + 1);
      offenders.push(...egressViolationsIn(file, readFileSync(path, 'utf8')));
    }
    expect(offenders).toEqual([]);
  });

  it('holds no exemptions, so the policy has no holes to inspect', () => {
    expect(EGRESS_EXEMPTIONS).toEqual([]);
  });

  it('prohibits every capability the policy claims to cover', () => {
    expect(prohibitedApiCount()).toBe(15);
  });
});

describe('the egress gate actually fails on prohibited code', () => {
  it('flags every sample with its rule code', () => {
    for (const [source, expectedCode] of EGRESS_SAMPLES) {
      const findings = egressViolationsIn('src/example.ts', source);
      expect(findings.length, source).toBeGreaterThan(0);
      expect(
        findings.map((finding) => finding.code),
        source,
      ).toContain(expectedCode);
    }
  });

  it('reports the line the prohibited reference is on', () => {
    const source = ['const a = 1;', 'const b = 2;', 'void fetch("/x");'].join('\n');
    const findings = egressViolationsIn('src/example.ts', source);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(3);
    expect(findings[0]?.name).toBe('fetch');
  });

  it('catches a prohibited API reached through a member access, not only a bare identifier', () => {
    expect(egressViolationsIn('src/example.ts', 'globalThis.fetch("/x");')).toHaveLength(1);
    expect(egressViolationsIn('src/example.ts', 'window.navigator.sendBeacon("/x");')).toHaveLength(
      1,
    );
  });

  it('permits code that performs no egress', () => {
    for (const clean of [
      'export function add(a: number, b: number): number { return a + b; }',
      'const stored = window.sessionStorage.getItem("session");',
      'element.addEventListener("click", () => { render(); });',
    ]) {
      expect(egressViolationsIn('src/example.ts', clean), clean).toEqual([]);
    }
  });

  it('does not flag a declaration that merely shares a prohibited name', () => {
    // A local binding is not a call target. Flagging it would push contributors toward exemptions,
    // which are the part of a policy that actually rots.
    expect(egressViolationsIn('src/example.ts', 'function toBlob() { return null; }')).toEqual([]);
    expect(egressViolationsIn('src/example.ts', 'const fetch = 1;')).toEqual([]);
  });

  it('honours a per-site exemption without opening the name globally', () => {
    expect(egressViolation('src/exempt.ts', 'fetch')).not.toBeNull();
    expect(egressViolation('src/other.ts', 'not-an-api')).toBeNull();
  });
});

describe('name extraction', () => {
  it('collects identifiers and member names but not declaration names', () => {
    const names = referencedNames(
      'src/example.ts',
      'function render(target: string) { return target.trim(); }',
    );
    const collected = names.map((entry) => entry.name);
    expect(collected).toContain('trim');
    expect(collected).toContain('target');
    expect(collected).not.toContain('render');
  });
});
