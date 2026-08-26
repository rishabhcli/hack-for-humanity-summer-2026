/* =========================================================================
 * synth.js — synthetic landmark generation.
 *
 * HONESTY NOTE. This module does NOT contain a second, easier pose pipeline.
 * It produces landmark frames in exactly the shape MediaPipe FaceLandmarker
 * emits ({x,y,z} normalised, 468 entries) by taking the MediaPipe canonical
 * face mesh, applying a KNOWN rigid rotation + translation, projecting it
 * through a pinhole camera model, and adding a per-landmark Gaussian noise
 * term to imitate detector jitter.
 *
 * Those frames are then fed to the SAME estimatePose() the live camera path
 * uses. That is what makes the validation number meaningful: the only thing
 * we know that the estimator does not is the ground-truth rotation.
 *
 * What this is NOT: it is not a recording of a real human, and any number
 * derived from it is labelled "synthetic" everywhere it is displayed.
 * ========================================================================= */

import { CANONICAL_FACE } from './canonical-face.js';
import { eulerToMatrix, IDX } from './pose.js';

/** Canonical-mesh face width (vertex 234 <-> 454) in canonical units. */
const CANON_WIDTH = (() => {
  const a = CANONICAL_FACE[IDX.faceRight], b = CANONICAL_FACE[IDX.faceLeft];
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
})();

/** Adult bizygomatic (cheekbone) breadth used to give the mesh a metric scale. */
export const FACE_WIDTH_MM = 140;
const MM_PER_UNIT = FACE_WIDTH_MM / CANON_WIDTH;

export const DEFAULT_CAM = {
  W: 1280,
  H: 720,
  hFovDeg: 60,           // typical laptop webcam horizontal field of view
  distanceMm: 600,       // nominal seated viewing distance
  txMm: 0,
  tyMm: 0,
};

export function focalPx(cam) {
  return (cam.W / 2) / Math.tan((cam.hFovDeg * Math.PI / 180) / 2);
}

/* Box-Muller, seeded so replay/validation runs are reproducible. */
export function makeRng(seed = 12345) {
  let s = seed >>> 0;
  const u = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  return {
    uniform: u,
    normal() {
      let a = u() || 1e-9, b = u();
      return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
    },
  };
}

/**
 * Render one synthetic landmark frame for a known head pose.
 *
 * @param {{yaw:number,pitch:number,roll:number}} pose  ground-truth, degrees
 * @param {object} cam camera model
 * @param {number} noisePx per-landmark Gaussian sigma in PIXELS (x,y). The z
 *        channel gets 2.5x this, matching the anisotropy of the real detector.
 * @param {object} rng
 * @returns {{x:number,y:number,z:number}[]} 468 normalised landmarks
 */
export function renderFrame(pose, cam = DEFAULT_CAM, noisePx = 0, rng = null) {
  const R = eulerToMatrix(pose.yaw, pose.pitch, pose.roll);
  const f = focalPx(cam);
  const D = cam.distanceMm;
  const cx = cam.W / 2, cy = cam.H / 2;
  const out = new Array(CANONICAL_FACE.length);

  for (let i = 0; i < CANONICAL_FACE.length; i++) {
    const c = CANONICAL_FACE[i];
    // rotate in the canonical (viewer-handed) frame, scale to millimetres
    const hx = MM_PER_UNIT * (R[0][0] * c[0] + R[0][1] * c[1] + R[0][2] * c[2]);
    const hy = MM_PER_UNIT * (R[1][0] * c[0] + R[1][1] * c[1] + R[1][2] * c[2]);
    const hz = MM_PER_UNIT * (R[2][0] * c[0] + R[2][1] * c[1] + R[2][2] * c[2]);
    // canonical(+Y up, +Z toward viewer) -> camera(+Y down, +Z into scene)
    const px = hx + cam.txMm;
    const py = -hy + cam.tyMm;
    const pz = -hz + D;

    // pinhole projection (true perspective — deliberately NOT the weak-
    // perspective model the estimator assumes, so foreshortening shows up
    // in the reported estimator error instead of being hidden)
    let u = cx + f * px / pz;
    let v = cy + f * py / pz;
    // MediaPipe's z: origin at head centre, "closer to camera" = more negative,
    // magnitude on roughly the same scale as normalised x.
    let zn = ((pz - D) * (f / D)) / cam.W;

    if (noisePx > 0 && rng) {
      u += rng.normal() * noisePx;
      v += rng.normal() * noisePx;
      zn += (rng.normal() * noisePx * 2.5) / cam.W;
    }
    out[i] = { x: u / cam.W, y: v / cam.H, z: zn };
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Trajectory synthesis for REPLAY
 * ------------------------------------------------------------------ */

const smoothstep = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Build a full protocol-shaped head trajectory.
 *
 * Each trial: settle at neutral -> (eyes close) -> move to the target angle ->
 * hold -> return toward the remembered neutral, missing it by a
 * proprioceptive error drawn from N(bias, sigma) -> settle.
 *
 * @returns {{fps:number, frames:{pose:object,t:number}[], plan:object[]}}
 */
export function buildTrajectory(opts = {}) {
  const {
    seed = 7,
    fps = 30,
    trialsPerDirection = 2,
    directions = ['left', 'right', 'extension', 'flexion'],
    targetDeg = { left: 40, right: -40, extension: 22, flexion: -25 },
    // per-direction proprioceptive bias and spread, in degrees
    errorBias = { left: 1.4, right: -1.1, extension: 1.9, flexion: -1.5 },
    errorSd = { left: 1.6, right: 1.5, extension: 2.1, flexion: 2.0 },
    tremorDeg = 0.28,        // physiological head tremor at rest, SD in degrees
    neutralDrift = 0.5,      // slow postural drift across the whole session
  } = opts;

  const rng = makeRng(seed);
  const frames = [];
  const plan = [];
  let t = 0;
  const push = (pose) => { frames.push({ t: frames.length / fps, pose }); };

  // baseline neutral for this "participant" — never exactly (0,0,0)
  const baseNeutral = {
    yaw: rng.normal() * 2.0,
    pitch: rng.normal() * 2.0,
    roll: rng.normal() * 1.2,
  };

  const jitter = (p, amp) => ({
    yaw: p.yaw + rng.normal() * amp,
    pitch: p.pitch + rng.normal() * amp,
    roll: p.roll + rng.normal() * amp * 0.6,
  });

  const hold = (pose, secs, amp = tremorDeg) => {
    const n = Math.round(secs * fps);
    for (let i = 0; i < n; i++) push(jitter(pose, amp));
  };
  const move = (from, to, secs) => {
    const n = Math.round(secs * fps);
    for (let i = 0; i < n; i++) {
      const s = smoothstep((i + 1) / n);
      push(jitter({
        yaw: lerp(from.yaw, to.yaw, s),
        pitch: lerp(from.pitch, to.pitch, s),
        roll: lerp(from.roll, to.roll, s),
      }, tremorDeg * 1.6));
    }
  };

  // noise-floor calibration hold at the very start
  const calibStart = frames.length;
  hold(baseNeutral, 3.0);
  const calibEnd = frames.length;

  const order = [];
  for (let r = 0; r < trialsPerDirection; r++) for (const d of directions) order.push(d);

  for (let i = 0; i < order.length; i++) {
    const d = order[i];
    const drift = {
      yaw: baseNeutral.yaw + rng.normal() * neutralDrift,
      pitch: baseNeutral.pitch + rng.normal() * neutralDrift,
      roll: baseNeutral.roll + rng.normal() * neutralDrift * 0.5,
    };
    const seg = { direction: d, index: i };

    seg.neutralStart = frames.length;
    hold(drift, 2.0);                                   // establish neutral, eyes open
    seg.neutralEnd = frames.length;

    const target = d === 'left' || d === 'right'
      ? { yaw: drift.yaw + targetDeg[d], pitch: drift.pitch, roll: drift.roll }
      : { yaw: drift.yaw, pitch: drift.pitch + targetDeg[d], roll: drift.roll };

    move(drift, target, 1.6);                           // rotate to target
    hold(target, 1.2);                                  // hold at target

    const err = errorBias[d] + rng.normal() * errorSd[d];
    const returned = d === 'left' || d === 'right'
      ? { yaw: drift.yaw + err, pitch: drift.pitch + rng.normal() * 0.8, roll: drift.roll + rng.normal() * 0.5 }
      : { yaw: drift.yaw + rng.normal() * 0.8, pitch: drift.pitch + err, roll: drift.roll + rng.normal() * 0.5 };

    move(target, returned, 1.7);                        // return to perceived neutral
    seg.returnStart = frames.length;
    hold(returned, 1.5);                                // settle
    seg.returnEnd = frames.length;
    seg.groundTruthError = err;
    plan.push(seg);
  }

  return { fps, frames, plan, calib: { start: calibStart, end: calibEnd }, baseNeutral };
}

/**
 * Named replay sources. Each is a different simulated participant so the
 * demo can show a good performer and an impaired one.
 */
export const REPLAY_SOURCES = {
  'replay-a': {
    label: 'Replay A \u2014 synthetic, low error',
    description: 'Scripted trajectory, proprioceptive error SD ~1.5\u00b0, detector noise 0.7 px.',
    noisePx: 0.7,
    traj: { seed: 7, errorBias: { left: 1.4, right: -1.1, extension: 1.9, flexion: -1.5 },
      errorSd: { left: 1.6, right: 1.5, extension: 2.1, flexion: 2.0 } },
  },
  'replay-b': {
    label: 'Replay B \u2014 synthetic, elevated error',
    description: 'Scripted trajectory with larger repositioning error, as seen in the neck-pain literature.',
    noisePx: 0.9,
    traj: { seed: 21, errorBias: { left: 4.2, right: -3.6, extension: 5.1, flexion: -4.4 },
      errorSd: { left: 2.6, right: 2.4, extension: 3.0, flexion: 2.8 } },
  },
  'replay-c': {
    label: 'Replay C \u2014 synthetic, noisy camera',
    description: 'Same participant as A but with 3x detector noise, to exercise the quality gates.',
    noisePx: 2.4,
    traj: { seed: 7, errorBias: { left: 1.4, right: -1.1, extension: 1.9, flexion: -1.5 },
      errorSd: { left: 1.6, right: 1.5, extension: 2.1, flexion: 2.0 } },
  },
};
