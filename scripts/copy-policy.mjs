/**
 * The shipped-copy policy.
 *
 * Domain invariant I1 — "the system never outputs a diagnosis or return-to-activity decision" —
 * cannot be enforced by a check that only runs on strings which happen to be routed through one
 * module. This file is the canonical policy, and `scripts/check-copy.mjs` applies it to every
 * string literal in the shipped bundle plus the document shell, at build time.
 *
 * `src/report/clinical-statement.ts` carries the same policy for the runtime path. The two are kept
 * identical by `scripts/copy-policy.test.mjs`, which fails if they drift.
 */

/**
 * @typedef CopyRule
 * @property {string} code
 * @property {string} label
 * @property {RegExp} pattern
 */

/**
 * Language this product must never emit.
 *
 * The patterns are deliberately broad. A false refusal costs one rewrite; a false acceptance ships
 * a clinical claim this instrument has no standing to make.
 *
 * @type {readonly CopyRule[]}
 */
export const PROHIBITED_COPY_PATTERNS = [
  {
    code: 'COPY_ASSERTS_DIAGNOSIS',
    label: 'asserts or denies a clinical finding about the person',
    pattern:
      /\b(?:you (?:have|do not have|don't have)|diagnos(?:is|es|ed|tic)|(?:is|are) (?:normal|abnormal)|concussion (?:detected|confirmed|ruled out)|(?:you are|you're) (?:fine|healthy|injured|concussed)|impairment (?:detected|confirmed))\b/iu,
  },
  {
    code: 'COPY_ASSERTS_CLEARANCE',
    label: 'asserts a clearance or resumption decision',
    pattern:
      /\b(?:return[-\s]to[-\s](?:play|sport|learn|activity|work|driving)|cleared (?:to|for)|safe to (?:return|play|drive|train|resume)|you (?:may|can) (?:now )?(?:resume|return)|fit to (?:play|drive|train)|recovery complete|fully recovered)\b/iu,
  },
  {
    code: 'COPY_ASSERTS_TREATMENT',
    label: 'prescribes or endorses a course of care',
    pattern:
      /\b(?:we (?:recommend|prescribe)|you should (?:take|stop taking|start)|prescribed dose|recommended dose|treatment plan|therapy (?:is|was) (?:working|effective))\b/iu,
  },
];

/**
 * Copy that contains a prohibited pattern but is permitted because it *denies* the claim.
 *
 * Disclaimers are why a bare pattern match cannot be the whole rule: the sentence that most needs
 * to appear is the one saying this tool does not diagnose. Each entry is an exact sentence, so a
 * near-miss variant is refused and has to be added here deliberately rather than drifting in.
 *
 * @type {readonly string[]}
 */
export const APPROVED_DISCLAIMERS = [
  'This is not a diagnosis or a return-to-activity decision.',
  'This tool does not provide a diagnosis, a clinical interpretation, or a return-to-activity decision.',
  'No result here is a diagnosis. Seek care from a qualified clinician.',
];

/**
 * Character ranges inside `text` that are covered by an approved disclaimer.
 *
 * Shipped copy is frequently a template containing markup, so an approved sentence appears as a
 * substring rather than as the whole string. A prohibited match is permitted only when it lies
 * entirely inside one of these ranges.
 *
 * @param {string} text
 * @returns {Array<{end: number, start: number}>}
 */
export function approvedRanges(text) {
  /** @type {Array<{end: number, start: number}>} */
  const ranges = [];
  for (const disclaimer of APPROVED_DISCLAIMERS) {
    let searchFrom = 0;
    while (searchFrom <= text.length) {
      const start = text.indexOf(disclaimer, searchFrom);
      if (start === -1) {
        break;
      }
      ranges.push({ end: start + disclaimer.length, start });
      searchFrom = start + 1;
    }
  }
  return ranges;
}

/**
 * Every prohibited phrase in `text` that is not covered by an approved disclaimer.
 *
 * @param {string} text
 * @returns {Array<{code: string, label: string, phrase: string}>}
 */
export function copyViolations(text) {
  const ranges = approvedRanges(text);
  /** @type {Array<{code: string, label: string, phrase: string}>} */
  const violations = [];

  for (const rule of PROHIBITED_COPY_PATTERNS) {
    const scanner = new RegExp(rule.pattern.source, `${rule.pattern.flags.replace('g', '')}g`);
    let match;
    while ((match = scanner.exec(text)) !== null) {
      if (match[0] === '') {
        scanner.lastIndex += 1;
        continue;
      }
      const start = match.index;
      const end = start + match[0].length;
      const permitted = ranges.some((range) => start >= range.start && end <= range.end);
      if (!permitted) {
        violations.push({ code: rule.code, label: rule.label, phrase: match[0] });
      }
    }
  }

  return violations;
}
