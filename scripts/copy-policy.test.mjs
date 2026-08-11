import { describe, expect, it } from 'vitest';

import {
  APPROVED_DISCLAIMERS as RUNTIME_DISCLAIMERS,
  PROHIBITED_COPY_PATTERNS as RUNTIME_PATTERNS,
  displayThreshold,
  displayThresholdById,
  isDisplayable,
  screenStatementText,
} from '../src/report/clinical-statement';
import { documentText, literalsIn } from './check-copy.mjs';
import { APPROVED_DISCLAIMERS, PROHIBITED_COPY_PATTERNS, copyViolations } from './copy-policy.mjs';

/**
 * Copy that must never ship, one per rule, phrased the way it would plausibly be written.
 *
 * @type {ReadonlyArray<readonly [string, string]>}
 */
const PROHIBITED_SAMPLES = [
  ['You have a concussion.', 'COPY_ASSERTS_DIAGNOSIS'],
  ['Your result is normal.', 'COPY_ASSERTS_DIAGNOSIS'],
  ['Concussion detected — see the report below.', 'COPY_ASSERTS_DIAGNOSIS'],
  ['You are cleared for return to play.', 'COPY_ASSERTS_CLEARANCE'],
  ['It is safe to drive now.', 'COPY_ASSERTS_CLEARANCE'],
  ['Your recovery complete — well done.', 'COPY_ASSERTS_CLEARANCE'],
  ['We recommend two weeks of rest.', 'COPY_ASSERTS_TREATMENT'],
  ['Follow the treatment plan on the next screen.', 'COPY_ASSERTS_TREATMENT'],
];

describe('the build-time copy gate actually fails on prohibited language', () => {
  it('flags every prohibited sample with its rule code', () => {
    for (const [sample, expectedCode] of PROHIBITED_SAMPLES) {
      const violations = copyViolations(sample);
      expect(violations.length, sample).toBeGreaterThan(0);
      expect(
        violations.map((violation) => violation.code),
        sample,
      ).toContain(expectedCode);
    }
  });

  it('flags prohibited language embedded in markup, not only whole strings', () => {
    const markup = '<section><h2>Result</h2><p>You are cleared to return to sport.</p></section>';
    expect(copyViolations(markup).length).toBeGreaterThan(0);
  });

  it('permits an approved disclaimer even though it contains the prohibited words', () => {
    for (const disclaimer of APPROVED_DISCLAIMERS) {
      expect(copyViolations(disclaimer), disclaimer).toEqual([]);
    }
  });

  it('permits an approved disclaimer embedded in the markup that actually ships', () => {
    const markup = `<h2 id="safety-title">${APPROVED_DISCLAIMERS[0]}</h2>`;
    expect(copyViolations(markup)).toEqual([]);
  });

  it('refuses a near-miss variant of an approved disclaimer', () => {
    // One word changed. The allowlist is exact so a weakened disclaimer cannot drift in.
    const weakened = 'This is probably not a diagnosis or a return-to-activity decision.';
    expect(copyViolations(weakened).length).toBeGreaterThan(0);
  });

  it('passes clean copy through untouched', () => {
    for (const clean of [
      'This attempt was not measured. Correct the conditions listed and take it again.',
      'Inside this session’s measurement error — not a change.',
      'Move back from the camera until your whole head is comfortably in frame.',
      'Stop and seek care from a qualified clinician if symptoms are concerning or worsen.',
    ]) {
      expect(copyViolations(clean), clean).toEqual([]);
    }
  });
});

describe('the build-time policy and the runtime policy cannot drift apart', () => {
  it('declares the same rules in the same order with identical patterns', () => {
    expect(RUNTIME_PATTERNS).toHaveLength(PROHIBITED_COPY_PATTERNS.length);
    for (const [index, rule] of PROHIBITED_COPY_PATTERNS.entries()) {
      const runtimeRule = RUNTIME_PATTERNS[index];
      expect(runtimeRule).toBeDefined();
      expect(runtimeRule?.code).toBe(rule.code);
      expect(runtimeRule?.label).toBe(rule.label);
      expect(runtimeRule?.pattern.source).toBe(rule.pattern.source);
      expect(runtimeRule?.pattern.flags).toBe(rule.pattern.flags);
    }
  });

  it('declares the same approved disclaimers', () => {
    expect([...RUNTIME_DISCLAIMERS]).toEqual([...APPROVED_DISCLAIMERS]);
  });

  it('agrees with the runtime screen on every sample', () => {
    for (const [sample, expectedCode] of PROHIBITED_SAMPLES) {
      const result = screenStatementText(sample);
      expect(result.ok, sample).toBe(false);
      if (!result.ok) {
        expect(result.code, sample).toBe(expectedCode);
      }
    }
    for (const disclaimer of APPROVED_DISCLAIMERS) {
      expect(screenStatementText(disclaimer).ok, disclaimer).toBe(true);
    }
  });
});

describe('I7 — a clinical threshold is undisplayable until its source has been read', () => {
  it('refuses the registry’s cutoff because its primary source is unverified', () => {
    const result = displayThresholdById('cervical-jpe-abnormal-cutoff');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('THRESHOLD_REVIEW_NOT_VERIFIED');
    }
  });

  it('refuses an unknown threshold rather than inventing one', () => {
    const result = displayThresholdById('not-a-real-threshold');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('THRESHOLD_NOT_FOUND');
    }
  });

  it('refuses a verified review whose citation a reader could not follow', () => {
    const result = displayThreshold({
      citation: {
        doi: null,
        population: 'adults with chronic neck pain',
        publication: 'Journal of Nowhere',
        reportedValue: '4.5 degrees',
        title: 'A study',
        url: null,
        year: 1991,
      },
      id: 'incomplete',
      review: {
        outstanding: null,
        reviewedOn: '2026-08-10',
        reviewer: 'reviewer',
        status: 'verified-against-primary-source',
      },
      unit: 'degrees',
      value: 4.5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('THRESHOLD_CITATION_INCOMPLETE');
    }
  });

  it('displays a threshold only once it is both cited and reviewed, and attributes it', () => {
    const result = displayThreshold({
      citation: {
        doi: '10.0000/example',
        population: 'adults with chronic neck pain',
        publication: 'Journal of Example Medicine',
        reportedValue: '4.5 degrees',
        title: 'An example of a fully cited source',
        url: null,
        year: 1991,
      },
      id: 'example',
      review: {
        outstanding: null,
        reviewedOn: '2026-08-10',
        reviewer: 'reviewer',
        status: 'verified-against-primary-source',
      },
      unit: 'degrees',
      value: 4.5,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isDisplayable(result.value)).toBe(true);
      expect(result.value.text).toContain('4.5 degrees');
      expect(result.value.attribution).toContain('Journal of Example Medicine');
      expect(result.value.attribution).toContain('Population:');
    }
  });

  it('refuses to treat a hand-built statement object as displayable', () => {
    expect(isDisplayable({ attribution: null, text: 'Anything at all.' })).toBe(false);
    expect(isDisplayable(null)).toBe(false);
    expect(isDisplayable('a string')).toBe(false);
  });
});

describe('the copy gate reads what actually ships', () => {
  it('extracts string and template literals from a source file', () => {
    const literals = literalsIn('src/report/clinical-statement.ts');
    expect(literals.length).toBeGreaterThan(0);
    expect(literals.every((literal) => literal.line > 0)).toBe(true);
    expect(literals.some((literal) => literal.text.includes('Reference line: '))).toBe(true);
  });

  it('strips markup, scripts, and styles from the document shell', () => {
    const text = documentText(
      '<html><head><style>p{color:red}</style><script>const a = "You have a concussion";</script></head><body><p>Visible copy.</p></body></html>',
    );
    expect(text).toBe('Visible copy.');
    expect(copyViolations(text)).toEqual([]);
  });
});
