/**
 * Clinical thresholds and the copy that may state them.
 *
 * Two invariants meet here.
 *
 * **I7 — every clinical threshold requires an authoritative citation and review before display.**
 * A threshold is not a number in this codebase; it is a {@link ClinicalThreshold} carrying its
 * primary source and a review record. `displayThreshold` refuses any threshold whose review is not
 * `verified-against-primary-source`, so an unreviewed number cannot reach a screen even if someone
 * adds it to the registry.
 *
 * **I1 — the system never outputs a diagnosis or a return-to-activity decision.** Every string that
 * reaches a user through this module passes {@link screenStatementText}, which refuses diagnostic
 * and clearance language. The same rule is enforced over the whole shipped bundle at build time by
 * `scripts/check-copy.mjs`, because a rule applied only to strings that happen to route through one
 * module is not an enforcement.
 *
 * The registry currently contains one threshold and it is **not** displayable, because its primary
 * source has not been read and reviewed. That is the honest state, and it is what makes this
 * invariant observable rather than decorative: the product shows no clinical threshold today.
 */

declare const displayableBrand: unique symbol;

export type ReviewStatus =
  | 'pending-source-verification'
  | 'rejected-source-does-not-support'
  | 'verified-against-primary-source';

export type Citation = Readonly<{
  /** Digital object identifier, when the source has one. */
  doi: string | null;
  /** Exact quantity the source reports, transcribed rather than paraphrased. */
  reportedValue: string;
  /** Population the source studied. A threshold is only meaningful for the population it came from. */
  population: string;
  publication: string;
  title: string;
  url: string | null;
  year: number;
}>;

export type ThresholdReview = Readonly<{
  /** Who read the primary source. Never a display name of an end user. */
  reviewer: string;
  reviewedOn: string | null;
  status: ReviewStatus;
  /** What remains before this threshold could be displayed, when it is not yet verified. */
  outstanding: string | null;
}>;

export type ClinicalThreshold = Readonly<{
  citation: Citation;
  id: string;
  review: ThresholdReview;
  unit: string;
  value: number;
}>;

/**
 * Text cleared for display to a user.
 *
 * Obtainable only from {@link screenStatementText} or {@link displayThreshold}.
 */
export type DisplayableStatement = Readonly<{
  readonly [displayableBrand]: true;
  /** Provenance shown alongside the text, so a number never appears without its source. */
  attribution: string | null;
  text: string;
}>;

const mintedStatements = new WeakSet<object>();

export function isDisplayable(candidate: unknown): candidate is DisplayableStatement {
  return typeof candidate === 'object' && candidate !== null && mintedStatements.has(candidate);
}

export type CopyRefusalCode =
  'COPY_ASSERTS_CLEARANCE' | 'COPY_ASSERTS_DIAGNOSIS' | 'COPY_ASSERTS_TREATMENT' | 'COPY_EMPTY';

export type ThresholdRefusalCode =
  'THRESHOLD_NOT_FOUND' | 'THRESHOLD_REVIEW_NOT_VERIFIED' | 'THRESHOLD_CITATION_INCOMPLETE';

export type CopyResult =
  | Readonly<{ code: CopyRefusalCode; ok: false }>
  | Readonly<{ ok: true; value: DisplayableStatement }>;

export type ThresholdResult =
  | Readonly<{ code: CopyRefusalCode | ThresholdRefusalCode; ok: false }>
  | Readonly<{ ok: true; value: DisplayableStatement }>;

/**
 * Language this product must never emit.
 *
 * Each pattern is paired with the refusal it triggers. The patterns are deliberately broad: a false
 * refusal costs one rewrite, and a false acceptance ships a clinical claim this instrument has no
 * standing to make.
 */
export const PROHIBITED_COPY_PATTERNS: readonly Readonly<{
  code: CopyRefusalCode;
  label: string;
  pattern: RegExp;
}>[] = [
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
 * Disclaimers are the reason a naive pattern match cannot be the whole rule: the sentence that most
 * needs to appear is the one that says this is not a diagnosis. Each entry is an exact string, so a
 * near-miss variant is refused and has to be added deliberately rather than drifting in.
 */
export const APPROVED_DISCLAIMERS: readonly string[] = [
  'This is not a diagnosis or a return-to-activity decision.',
  'This tool does not provide a diagnosis, a clinical interpretation, or a return-to-activity decision.',
  'No result here is a diagnosis. Seek care from a qualified clinician.',
];

/**
 * Character ranges inside `text` that an approved disclaimer covers.
 *
 * Shipped copy is frequently a template containing markup, so an approved sentence appears as a
 * substring rather than as the whole string. A prohibited match is permitted only when it lies
 * entirely inside one of these ranges.
 */
export function approvedRanges(text: string): readonly Readonly<{ end: number; start: number }>[] {
  const ranges: { end: number; start: number }[] = [];
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

/** @internal */
function screen(text: string): CopyRefusalCode | null {
  if (text.trim() === '') {
    return 'COPY_EMPTY';
  }
  const ranges = approvedRanges(text);

  for (const rule of PROHIBITED_COPY_PATTERNS) {
    const scanner = new RegExp(rule.pattern.source, `${rule.pattern.flags.replace('g', '')}g`);
    let match = scanner.exec(text);
    while (match !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (!ranges.some((range) => start >= range.start && end <= range.end)) {
        return rule.code;
      }
      scanner.lastIndex = Math.max(scanner.lastIndex, start + 1);
      match = scanner.exec(text);
    }
  }
  return null;
}

/** Clears a string for display, or refuses it with the rule it violated. */
export function screenStatementText(text: string, attribution: string | null = null): CopyResult {
  const violation = screen(text);
  if (violation !== null) {
    return { code: violation, ok: false };
  }
  const statement = { attribution, text } as unknown as DisplayableStatement;
  mintedStatements.add(statement);
  return { ok: true, value: statement };
}

/** A citation is complete only when a reader could find the source from it. */
export function citationIsComplete(citation: Citation): boolean {
  return (
    citation.title.trim() !== '' &&
    citation.publication.trim() !== '' &&
    citation.population.trim() !== '' &&
    citation.reportedValue.trim() !== '' &&
    Number.isSafeInteger(citation.year) &&
    (citation.doi !== null || citation.url !== null)
  );
}

/**
 * Renders a clinical threshold for display, or refuses.
 *
 * A threshold reaches a screen only when its citation is complete *and* a human has recorded that
 * they read the primary source and it says what the registry claims it says.
 */
export function displayThreshold(threshold: ClinicalThreshold): ThresholdResult {
  // The human review is checked first because it is the more informative refusal: an unreviewed
  // threshold is unreviewed regardless of how complete its bibliography looks.
  if (threshold.review.status !== 'verified-against-primary-source') {
    return { code: 'THRESHOLD_REVIEW_NOT_VERIFIED', ok: false };
  }
  if (!citationIsComplete(threshold.citation)) {
    return { code: 'THRESHOLD_CITATION_INCOMPLETE', ok: false };
  }

  const attribution = `${threshold.citation.title}. ${threshold.citation.publication}, ${String(threshold.citation.year)}. Population: ${threshold.citation.population}.`;
  return screenStatementText(
    `Reference line: ${String(threshold.value)} ${threshold.unit}, as reported for ${threshold.citation.population}.`,
    attribution,
  );
}

/**
 * The clinical threshold registry.
 *
 * Adding an entry here does not make it displayable. Reading the primary source, confirming it
 * reports the value claimed, and recording that review does.
 */
export const CLINICAL_THRESHOLDS: readonly ClinicalThreshold[] = [
  {
    citation: {
      doi: null,
      population: 'adults with chronic neck pain, compared with asymptomatic controls',
      publication: 'Archives of Physical Medicine and Rehabilitation',
      reportedValue:
        'not yet transcribed — the commonly repeated 4.5 degree cutoff is cited to this work secondhand and has not been checked against it',
      title: 'Cervicocephalic kinesthetic sensibility in patients with cervical pain',
      url: null,
      year: 1991,
    },
    id: 'cervical-jpe-abnormal-cutoff',
    review: {
      outstanding:
        'Obtain and read the primary source. Confirm the reported value, its population, and its measurement protocol. If the source does not support the value, mark this rejected and remove the number.',
      reviewedOn: null,
      reviewer: 'unassigned',
      status: 'pending-source-verification',
    },
    unit: 'degrees',
    value: 4.5,
  },
];

/** Looks up a threshold and renders it, refusing when it is unknown or unreviewed. */
export function displayThresholdById(id: string): ThresholdResult {
  const threshold = CLINICAL_THRESHOLDS.find((candidate) => candidate.id === id);
  if (threshold === undefined) {
    return { code: 'THRESHOLD_NOT_FOUND', ok: false };
  }
  return displayThreshold(threshold);
}
