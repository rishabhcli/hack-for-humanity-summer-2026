/* =========================================================================
 * pose.js — head-orientation estimator
 *
 * WHAT THIS DOES
 *   Takes a MediaPipe FaceLandmarker landmark array (normalised x,y in [0,1]
 *   image space, z in the same metric as x) and recovers a rigid rotation of
 *   the head relative to the MediaPipe canonical face mesh.
 *
 * METHOD
 *   Umeyama / Horn absolute orientation (similarity transform: rotation +
 *   uniform scale + translation) solved in closed form via the largest
 *   eigenvector of Horn's 4x4 quaternion matrix. Fitted over a SKULL-RIGID
 *   landmark subset only (see RIGID_IDX): no lips, no jaw, no eyelids, no
 *   brows, so facial expression does not leak into the pose.
 *
 *   Horn's quaternion form is used in preference to an SVD because it can
 *   never return a reflection, so no det() sign correction is needed.
 *
 * COORDINATE CONVENTIONS  (stated explicitly, as required)
 *   Canonical mesh frame  : +X = subject's anatomical LEFT as drawn (image
 *                           right when the subject faces the camera),
 *                           +Y = up, +Z = out of the face toward the viewer.
 *   Observed camera frame : we convert MediaPipe's image coords into the same
 *                           handedness with  X = x*W,  Y = -y*H,  Z = -z*W.
 *                           (MediaPipe y grows DOWNWARD and z grows AWAY from
 *                           the camera, hence both negations.)
 *                           Frames are fed to the detector UNMIRRORED; the
 *                           mirror is applied in CSS for display only.
 *
 *   Euler order           : intrinsic Y-X-Z, i.e.  R = Ry(yaw)·Rx(pitch)·Rz(roll)
 *   Signs (verified against the synthetic generator in validation.js):
 *     yaw   > 0  ->  head rotated toward the participant's LEFT
 *     pitch > 0  ->  head extended (chin up / looking up)
 *     roll  > 0  ->  head tilted so the participant's LEFT ear drops
 *   All angles are returned in DEGREES.
 * ========================================================================= */

import { CANONICAL_FACE } from './canonical-face.js';

const DEG = 180 / Math.PI;

/* -------------------------------------------------------------------------
 * Skull-rigid landmark subset.
 * Chosen because these vertices sit over bone or over tissue that does not
 * move with expression: nasal bridge and tip, the four canthi, the lateral
 * orbital rims, the temples, the zygomatic arches and the forehead midline.
 * Deliberately EXCLUDED: 61/291/13/14 (lips), 152 (chin, moves with jaw),
 * 159/145 (eyelids, move with blink), 105/334 (brows, move with expression).
 * ---------------------------------------------------------------------- */
export const RIGID_IDX = [
  // nasal bridge / dorsum / tip  (deep Z relief => strong pitch+yaw leverage)
  1, 4, 5, 6, 19, 94, 168, 197, 195, 8,
  // eye corners: inner + outer canthi, both sides (very stable)
  33, 133, 362, 263, 243, 463, 130, 359,
  // lateral orbital rim / temples
  226, 446, 234, 454, 127, 356,
  // forehead midline
  10, 151, 9, 108, 337,
  // zygomatic / upper cheek
  116, 345, 117, 346, 111, 340,
];

// Landmarks used for the geometry gates (not for the fit).
export const IDX = {
  noseTip: 1,
  rightEyeOuter: 33,   // image-left when subject faces camera
  leftEyeOuter: 263,
  rightEyeInner: 133,
  leftEyeInner: 362,
  faceRight: 234,
  faceLeft: 454,
  forehead: 10,
  chin: 152,
};

// Pre-extract the canonical rigid points once.
const CANON_RIGID = RIGID_IDX.map((i) => CANONICAL_FACE[i]);

/* ---------------- small linear algebra ---------------- */

// Jacobi eigen-decomposition of a real symmetric NxN matrix.
// Returns { values: number[], vectors: number[][] } with vectors[k] = k-th eigenvector.
function jacobiEigen(Ain, n, sweeps = 64) {
  const A = Ain.map((r) => r.slice());
  const V = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let s = 0; s < sweeps; s++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-18) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const sn = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - sn * akq;
          A[k][q] = sn * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - sn * aqk;
          A[q][k] = sn * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - sn * vkq;
          V[k][q] = sn * vkp + c * vkq;
        }
      }
    }
  }
  const values = Array.from({ length: n }, (_, i) => A[i][i]);
  const vectors = Array.from({ length: n }, (_, k) => V.map((row) => row[k]));
  return { values, vectors };
}

export function quatToMatrix(q) {
  const [w, x, y, z] = q;
  const n = Math.hypot(w, x, y, z) || 1;
  const W = w / n, X = x / n, Y = y / n, Z = z / n;
  return [
    [1 - 2 * (Y * Y + Z * Z), 2 * (X * Y - W * Z), 2 * (X * Z + W * Y)],
    [2 * (X * Y + W * Z), 1 - 2 * (X * X + Z * Z), 2 * (Y * Z - W * X)],
    [2 * (X * Z - W * Y), 2 * (Y * Z + W * X), 1 - 2 * (X * X + Y * Y)],
  ];
}

/** Intrinsic Y-X-Z decomposition:  R = Ry(yaw)·Rx(pitch)·Rz(roll).  Degrees. */
export function matrixToEuler(R) {
  const sp = Math.min(1, Math.max(-1, -R[1][2]));
  const pitch = Math.asin(sp);
  let yaw, roll;
  if (Math.abs(sp) > 0.9999) {
    // gimbal lock (|pitch| ~ 90 deg) — far outside cervical range, handled for safety
    yaw = Math.atan2(-R[2][0], R[0][0]);
    roll = 0;
  } else {
    yaw = Math.atan2(R[0][2], R[2][2]);
    roll = Math.atan2(R[1][0], R[1][1]);
  }
  return { yaw: yaw * DEG, pitch: pitch * DEG, roll: roll * DEG };
}

export function eulerToMatrix(yawDeg, pitchDeg, rollDeg) {
  const y = yawDeg / DEG, p = pitchDeg / DEG, r = rollDeg / DEG;
  const cy = Math.cos(y), sy = Math.sin(y);
  const cp = Math.cos(p), sp = Math.sin(p);
  const cr = Math.cos(r), sr = Math.sin(r);
  // R = Ry·Rx·Rz, expanded
  return [
    [cy * cr + sy * sp * sr, -cy * sr + sy * sp * cr, sy * cp],
    [cp * sr, cp * cr, -sp],
    [-sy * cr + cy * sp * sr, sy * sr + cy * sp * cr, cy * cp],
  ];
}

/** Geodesic angle between two rotation matrices, in degrees. The true 3-D
 *  angular error — not a per-axis approximation. */
export function angularDistanceDeg(Ra, Rb) {
  // trace(Ra · Rb^T)
  let tr = 0;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) tr += Ra[i][k] * Rb[i][k];
  const c = Math.min(1, Math.max(-1, (tr - 1) / 2));
  return Math.acos(c) * DEG;
}

/* ---------------- the estimator ---------------- */

/**
 * Convert MediaPipe normalised landmarks to the canonical-handed metric frame.
 * @param {{x:number,y:number,z:number}[]} lm
 * @param {number} W frame width in px
 * @param {number} H frame height in px
 */
function toMetric(lm, W, H) {
  const out = new Array(lm.length);
  for (let i = 0; i < lm.length; i++) {
    const p = lm[i];
    out[i] = [p.x * W, -p.y * H, -p.z * W];
  }
  return out;
}

/**
 * Horn absolute orientation over the rigid subset.
 * Solves for R, s, t minimising  || obs - (s·R·canon + t) ||^2 .
 * @returns {{R:number[][], quat:number[], scale:number, residual:number}}
 */
function hornFit(canon, obs) {
  const n = canon.length;
  const cm = [0, 0, 0], om = [0, 0, 0];
  for (let i = 0; i < n; i++)
    for (let a = 0; a < 3; a++) { cm[a] += canon[i][a]; om[a] += obs[i][a]; }
  for (let a = 0; a < 3; a++) { cm[a] /= n; om[a] /= n; }

  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let normC = 0, normO = 0;
  for (let i = 0; i < n; i++) {
    const c = [canon[i][0] - cm[0], canon[i][1] - cm[1], canon[i][2] - cm[2]];
    const o = [obs[i][0] - om[0], obs[i][1] - om[1], obs[i][2] - om[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a][b] += c[a] * o[b];
    normC += c[0] * c[0] + c[1] * c[1] + c[2] * c[2];
    normO += o[0] * o[0] + o[1] * o[1] + o[2] * o[2];
  }

  const [Sxx, Sxy, Sxz] = S[0], [Syx, Syy, Syz] = S[1], [Szx, Szy, Szz] = S[2];
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  const { values, vectors } = jacobiEigen(N, 4);
  let best = 0;
  for (let i = 1; i < 4; i++) if (values[i] > values[best]) best = i;
  const q = vectors[best];
  const R = quatToMatrix(q);

  // Umeyama scale (symmetric form): s = trace(S^T R) / normC
  let num = 0;
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) num += S[a][b] * R[b][a];
  const scale = normC > 0 ? num / normC : 1;

  // RMS residual after the fit, expressed as a fraction of the model's RMS radius.
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const c = [canon[i][0] - cm[0], canon[i][1] - cm[1], canon[i][2] - cm[2]];
    const o = [obs[i][0] - om[0], obs[i][1] - om[1], obs[i][2] - om[2]];
    for (let a = 0; a < 3; a++) {
      const pred = scale * (R[a][0] * c[0] + R[a][1] * c[1] + R[a][2] * c[2]);
      const d = o[a] - pred;
      sse += d * d;
    }
  }
  const rms = Math.sqrt(sse / n);
  const modelRadius = Math.sqrt(normC / n) * Math.abs(scale);
  const residual = modelRadius > 0 ? rms / modelRadius : 1;

  return { R, quat: q, scale, residual, centroidObs: om, centroidCanon: cm };
}

/**
 * Full pose estimate from one landmark frame.
 * @param {{x:number,y:number,z:number}[]} landmarks 468/478 MediaPipe landmarks
 * @param {number} W frame width px
 * @param {number} H frame height px
 * @returns {{yaw,pitch,roll,R,scale,residual,fitConfidence,centroid}|null}
 */
export function estimatePose(landmarks, W, H) {
  if (!landmarks || landmarks.length < 468) return null;
  const metric = toMetric(landmarks, W, H);
  const obs = RIGID_IDX.map((i) => metric[i]);
  const fit = hornFit(CANON_RIGID, obs);
  const e = matrixToEuler(fit.R);
  // Map normalised Procrustes residual -> 0..1 confidence.
  // residual 0.00 -> 1.00 ; 0.06 -> ~0.50 ; >=0.12 -> ~0.
  const fitConfidence = Math.max(0, Math.min(1, 1 - fit.residual / 0.12));
  return {
    yaw: e.yaw,
    pitch: e.pitch,
    roll: e.roll,
    R: fit.R,
    scale: fit.scale,
    residual: fit.residual,
    fitConfidence,
    centroid: fit.centroidObs,
  };
}

/**
 * Euler angles straight out of MediaPipe's own facialTransformationMatrixes.
 * Used ONLY as an independent cross-check in the validation panel — the live
 * measurement path uses estimatePose() above.
 * MediaPipe emits a column-major 4x4 in an OpenGL-style frame with +Y up and
 * +Z toward the viewer, which already matches our canonical handedness.
 */
export function eulerFromMediaPipeMatrix(mat4) {
  const m = mat4.data ?? mat4;
  const R = [
    [m[0], m[4], m[8]],
    [m[1], m[5], m[9]],
    [m[2], m[6], m[10]],
  ];
  return matrixToEuler(R);
}

/** Circular-safe mean of a set of poses: averages rotation matrices then
 *  re-orthonormalises via a Horn fit against the identity-rotated frame. For
 *  the small angles in this protocol a component-wise mean is equivalent to
 *  <0.01 deg, but we do it properly so large rotations are handled too. */
export function meanPose(poses) {
  if (!poses.length) return null;
  // Average quaternions by eigen-decomposition of the outer-product sum
  // (Markley's method) — robust and sign-agnostic.
  const M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (const p of poses) {
    const q = matrixToQuat(p.R);
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) M[a][b] += q[a] * q[b];
  }
  const { values, vectors } = jacobiEigen(M, 4);
  let best = 0;
  for (let i = 1; i < 4; i++) if (values[i] > values[best]) best = i;
  const R = quatToMatrix(vectors[best]);
  const e = matrixToEuler(R);
  return { ...e, R };
}

export function matrixToQuat(R) {
  const tr = R[0][0] + R[1][1] + R[2][2];
  let w, x, y, z;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (R[2][1] - R[1][2]) / s; y = (R[0][2] - R[2][0]) / s; z = (R[1][0] - R[0][1]) / s;
  } else if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
    const s = Math.sqrt(1 + R[0][0] - R[1][1] - R[2][2]) * 2;
    w = (R[2][1] - R[1][2]) / s; x = 0.25 * s; y = (R[0][1] + R[1][0]) / s; z = (R[0][2] + R[2][0]) / s;
  } else if (R[1][1] > R[2][2]) {
    const s = Math.sqrt(1 + R[1][1] - R[0][0] - R[2][2]) * 2;
    w = (R[0][2] - R[2][0]) / s; x = (R[0][1] + R[1][0]) / s; y = 0.25 * s; z = (R[1][2] + R[2][1]) / s;
  } else {
    const s = Math.sqrt(1 + R[2][2] - R[0][0] - R[1][1]) * 2;
    w = (R[1][0] - R[0][1]) / s; x = (R[0][2] + R[2][0]) / s; y = (R[1][2] + R[2][1]) / s; z = 0.25 * s;
  }
  return [w, x, y, z];
}
