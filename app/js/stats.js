/* =========================================================================
 * stats.js — the repeatability engine.
 *
 * Everything here is computed from the trial data at runtime. Nothing is
 * hard-coded, sampled from a table of "typical" values, or smoothed toward a
 * nicer answer.
 * ========================================================================= */

export const DIRECTIONS = ['left', 'right', 'extension', 'flexion'];
export const DIRECTION_LABEL = {
  left: 'Left rotation',
  right: 'Right rotation',
  extension: 'Extension (up)',
  flexion: 'Flexion (down)',
};
/** Which Euler axis is the primary/clinical axis for each direction. */
export const PRIMARY_AXIS = {
  left: 'yaw', right: 'yaw', extension: 'pitch', flexion: 'pitch',
};

export const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

/** Sample standard deviation (n-1 denominator). */
export function sd(a) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

/* Two-sided Student-t critical values at alpha = 0.05, df 1..40.
 * Beyond df 40 the normal approximation (1.960) is within 0.6%. */
const T95 = [NaN,
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
  2.040, 2.037, 2.035, 2.032, 2.030, 2.028, 2.026, 2.024, 2.023, 2.021];
export const tCrit95 = (df) => (df < 1 ? NaN : df <= 40 ? T95[df] : 1.96);

/** Mean with a 95% confidence interval on the mean (t-based). */
export function meanCI(values) {
  const n = values.length;
  const m = mean(values);
  if (n < 2) return { mean: m, lo: NaN, hi: NaN, n, sd: NaN, sem: NaN };
  const s = sd(values);
  const semMean = s / Math.sqrt(n);
  const t = tCrit95(n - 1);
  return { mean: m, lo: m - t * semMean, hi: m + t * semMean, n, sd: s, sem: semMean };
}

/* ------------------------------------------------------------------ *
 * Per-trial error metrics
 * ------------------------------------------------------------------ */

/**
 * @param {object} t trial with {direction, neutral:{yaw,pitch,roll,R}, ret:{...}}
 * Returns constant (signed) error, absolute error on the primary axis, and the
 * true 3-D geodesic angular error between the neutral and returned head poses.
 */
export function trialErrors(neutral, ret, direction, angularDistanceDeg) {
  const dYaw = ret.yaw - neutral.yaw;
  const dPitch = ret.pitch - neutral.pitch;
  const dRoll = ret.roll - neutral.roll;
  const axis = PRIMARY_AXIS[direction];
  const constantError = axis === 'yaw' ? dYaw : dPitch;
  return {
    dYaw, dPitch, dRoll,
    constantError,                       // signed, on the clinical axis
    absoluteError: Math.abs(constantError),
    angularError3d: angularDistanceDeg(ret.R, neutral.R), // full 3-D geodesic
  };
}

/* ------------------------------------------------------------------ *
 * Session-level aggregation
 * ------------------------------------------------------------------ */

/** Mean absolute JPE per direction with a 95% CI, plus the session-wide mean. */
export function summariseSession(trials) {
  const perDirection = {};
  for (const d of DIRECTIONS) {
    const t = trials.filter((x) => x.direction === d);
    if (!t.length) continue;
    perDirection[d] = {
      direction: d,
      n: t.length,
      absolute: meanCI(t.map((x) => x.absoluteError)),
      constant: meanCI(t.map((x) => x.constantError)),
      angular3d: meanCI(t.map((x) => x.angularError3d)),
    };
  }
  const all = trials.map((t) => t.absoluteError);
  return {
    perDirection,
    overall: meanCI(all),
    overall3d: meanCI(trials.map((t) => t.angularError3d)),
    nTrials: trials.length,
  };
}

/* ------------------------------------------------------------------ *
 * Test-retest reliability
 * ------------------------------------------------------------------ */

/**
 * ICC(2,1) — two-way RANDOM effects, ABSOLUTE agreement, SINGLE measurement.
 * Shrout & Fleiss (1979) / McGraw & Wong (1996).
 *
 *              MSR - MSE
 *   ICC = ---------------------------------------------
 *          MSR + (k-1)MSE + (k/n)(MSC - MSE)
 *
 * where rows are the n measurement targets and columns the k repeated
 * sessions. MSR = between-row mean square, MSC = between-column (session)
 * mean square, MSE = residual mean square.
 *
 * @param {number[][]} X  X[row][col], no missing cells.
 */
export function icc21(X) {
  const n = X.length;
  if (n < 2) return { icc: NaN, reason: 'need >= 2 measurement targets' };
  const k = X[0].length;
  if (k < 2) return { icc: NaN, reason: 'need >= 2 sessions' };
  if (X.some((r) => r.length !== k)) return { icc: NaN, reason: 'ragged matrix' };

  let grand = 0;
  for (const r of X) for (const v of r) grand += v;
  grand /= n * k;

  const rowMean = X.map((r) => r.reduce((s, v) => s + v, 0) / k);
  const colMean = Array.from({ length: k }, (_, j) =>
    X.reduce((s, r) => s + r[j], 0) / n);

  let SST = 0;
  for (const r of X) for (const v of r) SST += (v - grand) ** 2;
  const SSR = k * rowMean.reduce((s, m) => s + (m - grand) ** 2, 0);
  const SSC = n * colMean.reduce((s, m) => s + (m - grand) ** 2, 0);
  const SSE = SST - SSR - SSC;

  const dfR = n - 1, dfC = k - 1, dfE = (n - 1) * (k - 1);
  const MSR = SSR / dfR, MSC = SSC / dfC, MSE = dfE > 0 ? SSE / dfE : NaN;

  const denom = MSR + (k - 1) * MSE + (k / n) * (MSC - MSE);
  const icc = denom !== 0 ? (MSR - MSE) / denom : NaN;
  return {
    icc: Number.isFinite(icc) ? Math.max(-1, Math.min(1, icc)) : NaN,
    MSR, MSC, MSE, n, k,
    // sqrt(MSE) is the ANOVA estimate of the within-target SD = standard
    // error of measurement.
    semAnova: Number.isFinite(MSE) && MSE > 0 ? Math.sqrt(MSE) : NaN,
  };
}

/**
 * Within-subject standard deviation (Bland's s_w) = the standard error of
 * measurement, computed directly from this participant's repeated session
 * means. With a single participant this is the correct SEM estimator; the
 * ANOVA sqrt(MSE) above is reported alongside as a cross-check.
 */
export function semFromSessions(sessionMeans) {
  const k = sessionMeans.length;
  if (k < 2) return { sem: NaN, k, reason: 'need >= 2 sessions' };
  return { sem: sd(sessionMeans), k, mean: mean(sessionMeans) };
}

/** MDC95 = 1.96 * sqrt(2) * SEM — the smallest change that exceeds
 *  measurement noise with 95% confidence. */
export const mdc95 = (sem) => 1.96 * Math.SQRT2 * sem;

/**
 * Build the reliability picture from a list of stored sessions.
 * Rows of the ICC matrix are the four movement DIRECTIONS (the measurement
 * targets); columns are sessions. Only directions present in EVERY session
 * are used, so the matrix is complete.
 */
export function reliability(sessions) {
  const usable = sessions.filter((s) => s.summary && Number.isFinite(s.summary.overall?.mean));
  const k = usable.length;
  const out = {
    nSessions: k, sem: NaN, mdc95: NaN, icc: NaN, iccDetail: null,
    sessionMeans: usable.map((s) => s.summary.overall.mean),
    note: '',
  };
  if (k < 2) { out.note = 'At least 2 completed sessions are required.'; return out; }

  const s = semFromSessions(out.sessionMeans);
  out.sem = s.sem;
  out.mdc95 = mdc95(s.sem);

  const common = DIRECTIONS.filter((d) =>
    usable.every((s2) => Number.isFinite(s2.summary.perDirection?.[d]?.absolute?.mean)));
  if (common.length >= 2) {
    const X = common.map((d) => usable.map((s2) => s2.summary.perDirection[d].absolute.mean));
    const r = icc21(X);
    out.icc = r.icc;
    out.iccDetail = { ...r, rows: common };
  } else {
    out.note = 'ICC needs at least 2 directions present in every session.';
  }
  return out;
}

/**
 * The honest verdict. Compares two sessions against MDC95 and refuses to call
 * a sub-MDC change real.
 */
export function compareSessions(a, b, mdc) {
  const ma = a.summary.overall.mean, mb = b.summary.overall.mean;
  const delta = mb - ma;                 // negative = improvement (lower error)
  const improved = delta < 0;
  const magnitude = Math.abs(delta);
  const real = Number.isFinite(mdc) && magnitude > mdc;
  return {
    from: ma, to: mb, delta, magnitude, improved, real, mdc95: mdc,
    verdict: !Number.isFinite(mdc)
      ? 'Not enough sessions yet to know this tool\u2019s own noise level.'
      : real
        ? `Your mean JPE ${improved ? 'improved' : 'worsened'} by ${magnitude.toFixed(1)}\u00b0; MDC95 is ${mdc.toFixed(1)}\u00b0, so this change IS larger than measurement noise.`
        : `Your mean JPE ${improved ? 'improved' : 'worsened'} by ${magnitude.toFixed(1)}\u00b0; MDC95 is ${mdc.toFixed(1)}\u00b0, so this change is NOT distinguishable from measurement noise.`,
  };
}
