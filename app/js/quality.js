/* =========================================================================
 * quality.js — geometry / illumination gating and the angular noise floor.
 *
 * A trial may not start unless every gate passes. Each failing gate returns
 * plain-language text explaining what to change, because the participant will
 * shortly have their eyes closed and cannot read a cryptic error.
 * ========================================================================= */

import { IDX } from './pose.js';
import { FACE_WIDTH_MM, DEFAULT_CAM, focalPx } from './synth.js';

export const LIMITS = {
  distanceMinCm: 35,
  distanceMaxCm: 90,
  offCentreMaxPct: 18,      // centroid offset as % of the shorter frame axis
  lumaMin: 45,              // mean luma over the face box, 0..255
  lumaMax: 225,
  blownMaxPct: 12,          // % of face-box pixels at/above 250
  rollMaxDeg: 12,
  minFitConfidence: 0.55,
  noiseFloorMaxDeg: 0.90,   // trial refused above this
  noiseFloorGoodDeg: 0.45,
};

/** Interpupillary distance in canonical units is not needed: we use the
 *  bizygomatic width (234 <-> 454) in pixels together with a nominal 140 mm
 *  physical width and the camera's focal length in pixels. The FOV is an
 *  ASSUMPTION (60 deg) and is surfaced in the UI as such. */
export function estimateDistanceCm(landmarks, W, H, hFovDeg = DEFAULT_CAM.hFovDeg) {
  const a = landmarks[IDX.faceRight], b = landmarks[IDX.faceLeft];
  const px = Math.hypot((a.x - b.x) * W, (a.y - b.y) * H);
  if (px <= 1) return NaN;
  const f = focalPx({ W, hFovDeg });
  return (FACE_WIDTH_MM * f) / px / 10;   // mm -> cm
}

/** Mean luma and blown-highlight fraction over the face bounding box.
 *  Reads from a small downsampled canvas, never from a full frame, and the
 *  pixels never leave this function. */
export function measureIllumination(ctx, landmarks, cw, ch) {
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const x0 = Math.max(0, Math.floor(minX * cw)), y0 = Math.max(0, Math.floor(minY * ch));
  const x1 = Math.min(cw, Math.ceil(maxX * cw)), y1 = Math.min(ch, Math.ceil(maxY * ch));
  const w = x1 - x0, h = y1 - y0;
  if (w < 2 || h < 2) return { luma: NaN, blownPct: NaN };
  const d = ctx.getImageData(x0, y0, w, h).data;
  let sum = 0, blown = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    sum += l; if (l >= 250) blown++; n++;
  }
  return { luma: sum / n, blownPct: (blown / n) * 100 };
}

/**
 * Evaluate every gate. Returns per-gate {ok, value, text} plus an overall
 * `ready` flag and an ordered list of blocking reasons.
 */
export function evaluateGates({ pose, landmarks, W, H, luma, blownPct, noiseFloorDeg, isReplay }) {
  const gates = {};
  const push = (key, ok, value, text) => { gates[key] = { ok, value, text }; };

  if (!pose || !landmarks) {
    push('face', false, null, 'No face detected \u2014 move into view of the camera.');
    return { gates, ready: false, reasons: ['No face detected'] };
  }
  push('face', true, 1, 'Face detected.');

  const dist = estimateDistanceCm(landmarks, W, H);
  const distOk = dist >= LIMITS.distanceMinCm && dist <= LIMITS.distanceMaxCm;
  push('distance', distOk, dist,
    distOk ? `${dist.toFixed(0)} cm \u2014 in range.`
      : dist < LIMITS.distanceMinCm ? `Too close (${dist.toFixed(0)} cm). Move back a little.`
        : `Too far (${dist.toFixed(0)} cm). Move closer.`);

  const cxN = landmarks[IDX.noseTip].x - 0.5;
  const cyN = landmarks[IDX.noseTip].y - 0.5;
  const offPct = Math.hypot(cxN, cyN) * 100;
  const cOk = offPct <= LIMITS.offCentreMaxPct;
  push('centering', cOk, offPct,
    cOk ? `${offPct.toFixed(0)}% off centre \u2014 fine.`
      : `Off centre by ${offPct.toFixed(0)}%. Line your nose up with the centre mark.`);

  // Replay streams are synthetic landmark data with no pixels, so there is no
  // illumination to measure. We say so rather than inventing a value.
  if (isReplay) {
    push('illumination', true, NaN, 'n/a \u2014 replay stream carries no pixels.');
  } else {
    const lOk = luma >= LIMITS.lumaMin && luma <= LIMITS.lumaMax && blownPct <= LIMITS.blownMaxPct;
    push('illumination', lOk, luma,
      lOk ? `Luma ${luma.toFixed(0)} \u2014 good.`
        : luma < LIMITS.lumaMin ? `Too dark (luma ${luma.toFixed(0)}). Add light in front of you.`
          : blownPct > LIMITS.blownMaxPct ? `Blown highlights on ${blownPct.toFixed(0)}% of the face. Move the light source.`
            : `Too bright (luma ${luma.toFixed(0)}). Reduce the light.`);
  }

  const rollOk = Math.abs(pose.roll) <= LIMITS.rollMaxDeg;
  push('roll', rollOk, pose.roll,
    rollOk ? `${pose.roll.toFixed(1)}\u00b0 tilt \u2014 acceptable.`
      : `Head tilted ${pose.roll.toFixed(0)}\u00b0. Level your head before starting.`);

  const conf = pose.fitConfidence;
  const confOk = conf >= LIMITS.minFitConfidence;
  push('confidence', confOk, conf,
    confOk ? `Landmark fit ${(conf * 100).toFixed(0)}%.`
      : `Landmark fit only ${(conf * 100).toFixed(0)}%. Remove glasses glare / face the camera squarely.`);

  const nfOk = Number.isFinite(noiseFloorDeg) && noiseFloorDeg <= LIMITS.noiseFloorMaxDeg;
  push('noise', nfOk, noiseFloorDeg,
    !Number.isFinite(noiseFloorDeg) ? 'Not measured yet \u2014 run the hold-still calibration.'
      : nfOk ? `${noiseFloorDeg.toFixed(2)}\u00b0 \u2014 below the ${LIMITS.noiseFloorMaxDeg.toFixed(2)}\u00b0 ceiling.`
        : `${noiseFloorDeg.toFixed(2)}\u00b0 \u2014 above the ${LIMITS.noiseFloorMaxDeg.toFixed(2)}\u00b0 ceiling. Steady the camera and re-calibrate.`);

  const reasons = Object.entries(gates).filter(([, g]) => !g.ok).map(([, g]) => g.text);
  return { gates, ready: reasons.length === 0, reasons };
}

/**
 * Angular noise floor: hold still, then take the standard deviation of the
 * estimated yaw and pitch over the window. Reported as the RMS of the two
 * per-axis SDs. This is the tool's own measurement noise, and no trial is
 * accepted while it exceeds LIMITS.noiseFloorMaxDeg.
 */
export function computeNoiseFloor(poses) {
  if (poses.length < 15) return { noiseFloorDeg: NaN, sdYaw: NaN, sdPitch: NaN, n: poses.length };
  const yaw = poses.map((p) => p.yaw), pitch = poses.map((p) => p.pitch);
  const s = (a) => {
    const m = a.reduce((x, v) => x + v, 0) / a.length;
    return Math.sqrt(a.reduce((x, v) => x + (v - m) ** 2, 0) / (a.length - 1));
  };
  const sy = s(yaw), sp = s(pitch);
  return { noiseFloorDeg: Math.sqrt((sy * sy + sp * sp) / 2), sdYaw: sy, sdPitch: sp, n: poses.length };
}
