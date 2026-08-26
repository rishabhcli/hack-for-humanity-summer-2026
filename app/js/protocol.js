/* =========================================================================
 * protocol.js — the cervical joint-position-error trial runner.
 *
 * THE CLINICAL TEST BEING IMPLEMENTED
 *   Seated, head in a comfortable neutral position, eyes open. The examiner
 *   records neutral. The participant closes their eyes, rotates the head to
 *   one side (or extends / flexes), holds briefly, then returns to what they
 *   believe is the original neutral position and signals. The angular
 *   difference between the returned position and the recorded neutral is the
 *   joint position error. Repeated over left rotation, right rotation,
 *   extension and flexion.
 *
 * HOW THIS RUNNER TRACKS IT
 *   The state machine is driven by the participant's actual head motion, not
 *   by a stopwatch, so a slow or fast performer is measured the same way.
 *   Neutral and return poses are captured as the mean over a STABLE window
 *   (rotation-matrix mean, see pose.meanPose), which averages down detector
 *   noise by roughly sqrt(N).
 * ========================================================================= */

import { meanPose, angularDistanceDeg } from './pose.js';
import { trialErrors, summariseSession, PRIMARY_AXIS, DIRECTIONS } from './stats.js';
import { computeNoiseFloor, evaluateGates, LIMITS } from './quality.js';
import { cue, say, CUE_TONES } from './audio.js';

export const PHASES = {
  IDLE: 'idle',
  CALIBRATE: 'calibrate',
  GATE: 'gate',
  NEUTRAL: 'neutral',
  CLOSE_EYES: 'closeEyes',
  TO_TARGET: 'toTarget',
  AT_TARGET: 'atTarget',
  RETURNING: 'returning',
  SETTLE: 'settle',
  RECORD: 'record',
  DONE: 'done',
};

const TARGET_DEG = { left: 40, right: -40, extension: 22, flexion: -25 };
const DIR_TEXT = {
  left: 'Turn your head to the left, as far as is comfortable.',
  right: 'Turn your head to the right, as far as is comfortable.',
  extension: 'Tip your head back and look up.',
  flexion: 'Tip your head forward and look down.',
};

export class ProtocolRunner {
  /**
   * @param {object} opts
   * @param {number} opts.trialsPerDirection  2 -> 8 trials total (spec: 6-10)
   */
  constructor(opts = {}) {
    this.trialsPerDirection = opts.trialsPerDirection ?? 2;
    this.directions = opts.directions ?? DIRECTIONS;
    this.onUpdate = opts.onUpdate ?? (() => {});
    this.timeScale = opts.timeScale ?? 1;   // replay runs the clock faster
    this.reset();
  }

  reset() {
    this.phase = PHASES.IDLE;
    this.trials = [];
    this.order = [];
    for (let r = 0; r < this.trialsPerDirection; r++)
      for (const d of this.directions) this.order.push(d);
    this.trialIndex = -1;
    this.window = [];            // trailing pose window for stability tests
    this.calibPoses = [];
    this.noise = { noiseFloorDeg: NaN, sdYaw: NaN, sdPitch: NaN, n: 0 };
    this.lastGate = null;
    this.phaseT0 = 0;
    this.msg = 'Ready.';
    this.countdown = null;
    this._resolve = null;
    this._reject = null;
    this.rejected = [];
  }

  /* --- helpers --- */
  get scaled() { return 1 / this.timeScale; }
  _sec(s) { return s * this.scaled; }

  _pushWindow(frame) {
    this.window.push(frame);
    const cutoff = frame.t - 1.2 * this.scaled;
    while (this.window.length && this.window[0].t < cutoff) this.window.shift();
  }

  /** SD of yaw & pitch over the trailing `secs` seconds. */
  _spread(secs = 0.7) {
    const t1 = this.window.length ? this.window[this.window.length - 1].t : 0;
    const w = this.window.filter((f) => f.t >= t1 - secs * this.scaled);
    if (w.length < 6) return { ok: false, sd: Infinity, w };
    const s = (arr) => {
      const m = arr.reduce((a, v) => a + v, 0) / arr.length;
      return Math.sqrt(arr.reduce((a, v) => a + (v - m) ** 2, 0) / (arr.length - 1));
    };
    const sy = s(w.map((f) => f.pose.yaw)), sp = s(w.map((f) => f.pose.pitch));
    return { ok: true, sd: Math.max(sy, sp), w };
  }

  _stableThreshold() {
    const nf = Number.isFinite(this.noise.noiseFloorDeg) ? this.noise.noiseFloorDeg : 0.4;
    return Math.max(0.55, nf * 3);
  }

  _enter(phase, msg) {
    this.phase = phase;
    this.msg = msg ?? this.msg;
    this.phaseT0 = this._now;
    this.onUpdate(this.snapshot());
  }

  get currentDirection() { return this.order[this.trialIndex]; }

  snapshot() {
    return {
      phase: this.phase,
      msg: this.msg,
      trialIndex: this.trialIndex,
      totalTrials: this.order.length,
      direction: this.currentDirection ?? null,
      trials: this.trials,
      noise: this.noise,
      gate: this.lastGate,
      countdown: this.countdown,
      rejected: this.rejected,
    };
  }

  /* --- public control --- */

  /** Measure the angular noise floor from a hold-still window. */
  startCalibration() {
    this.calibPoses = [];
    this._enter(PHASES.CALIBRATE, 'Hold still and look straight ahead. Measuring this camera\u2019s noise floor\u2026');
    cue('ready', 'Hold still and look straight ahead.');
    this.calibDeadline = null;
    return new Promise((resolve) => { this._calibResolve = resolve; });
  }

  /** Runs the whole protocol. Resolves with the finished session summary. */
  start() {
    this.trials = [];
    this.rejected = [];
    this.trialIndex = -1;
    this._nextTrial();
    return new Promise((res, rej) => { this._resolve = res; this._reject = rej; });
  }

  abort(reason = 'aborted') {
    this._enter(PHASES.IDLE, 'Stopped.');
    if (this._reject) { const r = this._reject; this._resolve = this._reject = null; r(new Error(reason)); }
  }

  _nextTrial() {
    this.trialIndex++;
    if (this.trialIndex >= this.order.length) return this._finish();
    this.trialData = { direction: this.currentDirection, index: this.trialIndex };
    this._enter(PHASES.GATE, 'Checking measurement conditions\u2026');
  }

  _finish() {
    const summary = summariseSession(this.trials);
    this._enter(PHASES.DONE, `All ${this.trials.length} trials complete.`);
    CUE_TONES.done();
    say('All trials complete. Showing your results.');
    const r = this._resolve;
    this._resolve = this._reject = null;
    if (r) r({ trials: this.trials, summary, noise: this.noise, rejected: this.rejected });
  }

  /* --- the state machine, fed one frame at a time --- */
  step(frame) {
    this._now = frame.t;
    // A phase can be entered before the first frame ever arrives (e.g. calibration
    // started on a freshly constructed runner). In that case phaseT0 is undefined
    // and every elapsed-time comparison is NaN, so the phase never advances.
    // Anchor the phase clock to the first frame we actually see.
    if (!Number.isFinite(this.phaseT0)) this.phaseT0 = frame.t;
    if (!frame.pose) {
      if (this.phase !== PHASES.IDLE && this.phase !== PHASES.DONE) {
        this.msg = 'Face lost \u2014 move back into view.';
        this.onUpdate(this.snapshot());
      }
      return;
    }
    this._pushWindow(frame);
    const P = frame.pose;
    const el = this._now - this.phaseT0;

    switch (this.phase) {
      case PHASES.CALIBRATE: {
        this.calibPoses.push(P);
        const need = 3.0 * this.scaled;
        this.msg = `Hold still\u2026 ${Math.max(0, need - el).toFixed(1)} s`;
        if (el >= need) {
          this.noise = computeNoiseFloor(this.calibPoses.slice(-Math.round(90)));
          const ok = this.noise.noiseFloorDeg <= LIMITS.noiseFloorMaxDeg;
          this._enter(PHASES.IDLE, ok
            ? `Noise floor ${this.noise.noiseFloorDeg.toFixed(2)}\u00b0 \u2014 good. You can start the test.`
            : `Noise floor ${this.noise.noiseFloorDeg.toFixed(2)}\u00b0 exceeds the ${LIMITS.noiseFloorMaxDeg}\u00b0 ceiling. Steady the camera and re-calibrate.`);
          cue(ok ? 'ready' : 'reject', ok ? 'Calibration complete.' : 'Calibration failed. Please steady the camera.');
          if (this._calibResolve) { this._calibResolve(this.noise); this._calibResolve = null; }
        }
        break;
      }

      case PHASES.GATE: {
        const g = evaluateGates({
          pose: P, landmarks: frame.landmarks, W: frame.W, H: frame.H,
          luma: frame.luma, blownPct: frame.blownPct,
          noiseFloorDeg: this.noise.noiseFloorDeg, isReplay: frame.isReplay,
        });
        this.lastGate = g;
        if (g.ready) {
          this._enter(PHASES.NEUTRAL,
            `Trial ${this.trialIndex + 1} of ${this.order.length}. Look straight ahead and hold still.`);
          cue('ready', `Trial ${this.trialIndex + 1}. Look straight ahead and hold still.`);
        } else {
          this.msg = `Cannot start: ${g.reasons[0]}`;
          if (el > this._sec(20)) {
            this.rejected.push({ index: this.trialIndex, reasons: g.reasons, t: Date.now() });
            this.msg = `Trial ${this.trialIndex + 1} skipped \u2014 conditions never met.`;
            CUE_TONES.reject();
            this._nextTrial();
          }
          this.onUpdate(this.snapshot());
        }
        break;
      }

      case PHASES.NEUTRAL: {
        const sp = this._spread(0.7);
        const stable = sp.ok && sp.sd < this._stableThreshold();
        this.countdown = stable ? Math.max(0, this._sec(1.4) - (this._now - (this._stableSince ?? this._now))) : null;
        if (stable) {
          if (!this._stableSince) this._stableSince = this._now;
          if (this._now - this._stableSince >= this._sec(1.4)) {
            this.trialData.neutral = meanPose(sp.w.map((f) => f.pose));
            this.trialData.neutralSpread = sp.sd;
            this._stableSince = null;
            this.countdown = null;
            this._enter(PHASES.CLOSE_EYES, 'Neutral recorded. Close your eyes now and keep them closed.');
            cue('closeEyes', 'Neutral recorded. Close your eyes, and keep them closed.');
          } else {
            this.msg = `Hold steady\u2026 recording neutral in ${this.countdown.toFixed(1)} s`;
            this.onUpdate(this.snapshot());
          }
        } else {
          this._stableSince = null;
          this.msg = 'Look straight ahead and hold still.';
          this.onUpdate(this.snapshot());
        }
        break;
      }

      case PHASES.CLOSE_EYES: {
        if (el >= this._sec(2.2)) {
          this._enter(PHASES.TO_TARGET, DIR_TEXT[this.currentDirection]);
          cue('rotate', DIR_TEXT[this.currentDirection]);
        }
        break;
      }

      case PHASES.TO_TARGET: {
        const d = this.currentDirection;
        const axis = PRIMARY_AXIS[d];
        const excursion = P[axis] - this.trialData.neutral[axis];
        const target = TARGET_DEG[d];
        const reached = Math.sign(target) === Math.sign(excursion) &&
          Math.abs(excursion) >= Math.abs(target) * 0.55;
        this.msg = `${DIR_TEXT[d]} (${Math.abs(excursion).toFixed(0)}\u00b0)`;
        if (reached) {
          this.trialData.peak = P[axis];
          this.trialData.excursion = excursion;
          this._enter(PHASES.AT_TARGET, 'Hold there.');
          cue('hold', 'Hold there.');
        } else if (el > this._sec(12)) {
          this.rejected.push({ index: this.trialIndex, reasons: ['Target rotation never reached'], t: Date.now() });
          CUE_TONES.reject();
          say('Skipping this trial.');
          this._nextTrial();
        } else this.onUpdate(this.snapshot());
        break;
      }

      case PHASES.AT_TARGET: {
        if (el >= this._sec(1.3)) {
          this._enter(PHASES.RETURNING, 'Now return to where you started, and stop when it feels right.');
          cue('returnHome', 'Now return to where you started. Stop when it feels right.');
        }
        break;
      }

      case PHASES.RETURNING: {
        const d = this.currentDirection;
        const axis = PRIMARY_AXIS[d];
        const rel = P[axis] - this.trialData.neutral[axis];
        // must have travelled back through most of the excursion before we
        // start looking for a settle, so the target hold cannot be mistaken
        // for the return
        const backHome = Math.abs(rel) <= Math.abs(this.trialData.excursion) * 0.45;
        this.msg = 'Return to your starting position\u2026';
        if (backHome) {
          this._enter(PHASES.SETTLE, 'Hold there while we record.');
        } else if (el > this._sec(14)) {
          this.rejected.push({ index: this.trialIndex, reasons: ['Return never completed'], t: Date.now() });
          CUE_TONES.reject();
          this._nextTrial();
        } else this.onUpdate(this.snapshot());
        break;
      }

      case PHASES.SETTLE: {
        const sp = this._spread(0.7);
        const stable = sp.ok && sp.sd < this._stableThreshold();
        if (stable) {
          if (!this._settleSince) this._settleSince = this._now;
          if (this._now - this._settleSince >= this._sec(1.0)) {
            this.trialData.ret = meanPose(sp.w.map((f) => f.pose));
            this.trialData.returnSpread = sp.sd;
            this._settleSince = null;
            this._enter(PHASES.RECORD, 'Recorded. Open your eyes.');
          } else {
            this.msg = `Hold\u2026 ${(this._sec(1.0) - (this._now - this._settleSince)).toFixed(1)} s`;
            this.onUpdate(this.snapshot());
          }
        } else {
          this._settleSince = null;
          if (el > this._sec(10)) {
            this.rejected.push({ index: this.trialIndex, reasons: ['Head never settled on return'], t: Date.now() });
            CUE_TONES.reject();
            this._nextTrial();
          }
        }
        break;
      }

      case PHASES.RECORD: {
        if (!this.trialData.recorded) {
          this.trialData.recorded = true;
          const e = trialErrors(this.trialData.neutral, this.trialData.ret,
            this.trialData.direction, angularDistanceDeg);
          const t = {
            index: this.trialData.index,
            direction: this.trialData.direction,
            neutral: pickEuler(this.trialData.neutral),
            ret: pickEuler(this.trialData.ret),
            excursion: this.trialData.excursion,
            neutralSpread: this.trialData.neutralSpread,
            returnSpread: this.trialData.returnSpread,
            ...e,
          };
          this.trials.push(t);
          cue('openEyes', `Open your eyes. Error ${t.absoluteError.toFixed(1)} degrees.`);
          this.onUpdate(this.snapshot());
        }
        if (el >= this._sec(2.4)) this._nextTrial();
        break;
      }

      default:
        break;
    }
  }
}

const pickEuler = (p) => ({ yaw: p.yaw, pitch: p.pitch, roll: p.roll });
