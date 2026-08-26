/* =========================================================================
 * validation.js — honest estimator validation.
 *
 * WHAT GROUND TRUTH WE HAVE, AND WHAT WE DO NOT.
 *
 *   We do NOT have optical-motion-capture recordings of real necks with known
 *   angles. We are not going to pretend otherwise.
 *
 *   What we DO have is a rotation we chose ourselves. The sweep below takes
 *   the MediaPipe canonical face mesh, rotates it by a KNOWN Euler triple,
 *   projects it through a pinhole camera (true perspective, plus per-landmark
 *   Gaussian noise), and hands the resulting landmark frame to the SAME
 *   estimatePose() used by the live camera path. The reported error is the
 *   difference between the angle we imposed and the angle recovered.
 *
 *   Read that number for what it is: the estimator's own geometric and
 *   noise-propagation error on ideal landmark input. It does NOT include
 *   MediaPipe's landmark-localisation error on real faces, skin deformation,
 *   or the fact that a real head is not the canonical mesh. The real-face
 *   cross-check below covers a little of that gap, and no more.
 * ========================================================================= */

import { estimatePose, eulerToMatrix, angularDistanceDeg, eulerFromMediaPipeMatrix } from './pose.js';
import { renderFrame, makeRng, DEFAULT_CAM } from './synth.js';

/**
 * Sweep known angles and measure recovery error.
 * @returns {{rows:object[], summary:object}}
 */
export function runSyntheticSweep({
  yaws = [-45, -35, -25, -15, -8, 0, 8, 15, 25, 35, 45],
  pitches = [-25, -15, -8, 0, 8, 15, 25],
  rolls = [-8, 0, 8],
  noisePx = 0.7,
  repeats = 3,
  seed = 4242,
  cam = DEFAULT_CAM,
} = {}) {
  const rng = makeRng(seed);
  const rows = [];
  for (const yaw of yaws) {
    for (const pitch of pitches) {
      for (const roll of rolls) {
        for (let r = 0; r < repeats; r++) {
          // random rigid offset so the estimator never sees a centred face twice
          const c = {
            ...cam,
            txMm: (rng.uniform() - 0.5) * 120,
            tyMm: (rng.uniform() - 0.5) * 80,
            distanceMm: 480 + rng.uniform() * 260,
          };
          const lm = renderFrame({ yaw, pitch, roll }, c, noisePx, rng);
          const est = estimatePose(lm, c.W, c.H);
          if (!est) continue;
          const Rtrue = eulerToMatrix(yaw, pitch, roll);
          rows.push({
            yaw, pitch, roll,
            eYaw: est.yaw - yaw,
            ePitch: est.pitch - pitch,
            eRoll: est.roll - roll,
            e3d: angularDistanceDeg(est.R, Rtrue),
            distanceMm: c.distanceMm,
            fitConfidence: est.fitConfidence,
          });
        }
      }
    }
  }
  const abs = (k) => rows.map((r) => Math.abs(r[k]));
  const m = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(0.95 * (s.length - 1))]; };
  const rmse = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

  const summary = {
    n: rows.length,
    noisePx,
    maeYaw: m(abs('eYaw')), maePitch: m(abs('ePitch')), maeRoll: m(abs('eRoll')),
    rmseYaw: rmse(abs('eYaw')), rmsePitch: rmse(abs('ePitch')),
    mae3d: m(rows.map((r) => r.e3d)),
    p95_3d: p95(rows.map((r) => r.e3d)),
    max3d: Math.max(...rows.map((r) => r.e3d)),
    // The number that actually matters for JPE: the estimator error on the
    // DIFFERENCE between two poses, which is what a trial measures. Common-
    // mode bias cancels, so this is smaller than the absolute error above.
  };
  summary.estimatorErrorDeg = summary.mae3d;
  return { rows, summary };
}

/**
 * Differential accuracy: JPE is a DIFFERENCE of two poses, so systematic bias
 * that is constant across a trial cancels out. This measures the estimator's
 * error on a known angular difference — the quantity the product reports.
 */
export function runDifferentialSweep({
  trueErrors = [-6, -4, -3, -2, -1.5, -1, 1, 1.5, 2, 3, 4, 6],
  bases = [{ yaw: 0, pitch: 0 }, { yaw: 6, pitch: -4 }, { yaw: -5, pitch: 5 }],
  noisePx = 0.7,
  repeats = 12,
  framesAveraged = 30,
  seed = 909,
  cam = DEFAULT_CAM,
} = {}) {
  const rng = makeRng(seed);
  const rows = [];
  const avgPose = (pose, c) => {
    // average over N frames exactly as a trial does, so noise averaging is
    // represented faithfully
    let sy = 0, sp = 0;
    for (let i = 0; i < framesAveraged; i++) {
      const lm = renderFrame(pose, c, noisePx, rng);
      const e = estimatePose(lm, c.W, c.H);
      sy += e.yaw; sp += e.pitch;
    }
    return { yaw: sy / framesAveraged, pitch: sp / framesAveraged };
  };
  for (const base of bases) {
    for (const te of trueErrors) {
      for (let r = 0; r < repeats; r++) {
        const c = { ...cam, txMm: (rng.uniform() - 0.5) * 100, tyMm: (rng.uniform() - 0.5) * 70, distanceMm: 500 + rng.uniform() * 200 };
        const neutral = { ...base, roll: 0 };
        const returned = { yaw: base.yaw + te, pitch: base.pitch, roll: 0 };
        const a = avgPose(neutral, c), b = avgPose(returned, c);
        rows.push({ trueDeg: te, measuredDeg: b.yaw - a.yaw, err: (b.yaw - a.yaw) - te });
      }
    }
  }
  const errs = rows.map((r) => Math.abs(r.err));
  const mm = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const s = [...errs].sort((x, y) => x - y);
  return {
    rows,
    summary: {
      n: rows.length,
      framesAveraged,
      noisePx,
      maeDeg: mm(errs),
      p95Deg: s[Math.floor(0.95 * (s.length - 1))],
      maxDeg: s[s.length - 1],
      biasDeg: mm(rows.map((r) => r.err)),
    },
  };
}

/**
 * Cross-check on a REAL face image: compare our Procrustes estimator against
 * MediaPipe's own facialTransformationMatrix on the same frame. Neither is
 * ground truth — agreement between two independent estimators is weaker
 * evidence than a known angle, and is labelled as such in the UI.
 */
export async function runRealFaceCrossCheck(landmarker, imgUrl = './data/face-fixture.png') {
  const img = new Image();
  img.src = imgUrl;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  const res = landmarker.detect(c);
  if (!res.faceLandmarks?.length) return { ok: false, reason: 'No face detected in the fixture image.' };
  const lm = res.faceLandmarks[0];
  const ours = estimatePose(lm, c.width, c.height);
  const mpMat = res.facialTransformationMatrixes?.[0];
  const theirs = mpMat ? eulerFromMediaPipeMatrix(mpMat) : null;
  return {
    ok: true,
    landmarkCount: lm.length,
    imageSize: `${c.width}x${c.height}`,
    ours: { yaw: ours.yaw, pitch: ours.pitch, roll: ours.roll, fitConfidence: ours.fitConfidence },
    mediapipe: theirs,
    delta: theirs ? {
      yaw: ours.yaw - theirs.yaw, pitch: ours.pitch - theirs.pitch, roll: ours.roll - theirs.roll,
    } : null,
  };
}
