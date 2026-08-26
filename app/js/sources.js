/* =========================================================================
 * sources.js — pose sources.
 *
 * Both the live camera and the replay stream implement the SAME interface and
 * emit the SAME frame object. Downstream, the estimator, the quality gates,
 * the protocol state machine and the statistics have no idea which one is
 * running. There is exactly one measurement pipeline in this application.
 * ========================================================================= */

import { estimatePose } from './pose.js';
import { measureIllumination } from './quality.js';
import { buildTrajectory, renderFrame, makeRng, DEFAULT_CAM, REPLAY_SOURCES } from './synth.js';

/* ------------------------------------------------------------------ */
export class LiveCameraSource {
  constructor(video, landmarker) {
    this.video = video;
    this.landmarker = landmarker;
    this.isReplay = false;
    this.label = 'Live camera';
    this.running = false;
    this.lastTs = -1;
    this._lumaCanvas = document.createElement('canvas');
    this._lumaCanvas.width = 160;
    this._lumaCanvas.height = 90;
    this._lumaCtx = this._lumaCanvas.getContext('2d', { willReadFrequently: true });
    this._lumaEvery = 5;
    this._n = 0;
    this._lastIllum = { luma: NaN, blownPct: NaN };
  }

  async start(onFrame) {
    this.onFrame = onFrame;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.running = true;
    this._loop();
  }

  _loop = () => {
    if (!this.running) return;
    const v = this.video;
    if (v.readyState >= 2 && v.videoWidth) {
      const ts = performance.now();
      if (ts !== this.lastTs) {
        this.lastTs = ts;
        let res = null;
        try { res = this.landmarker.detectForVideo(v, ts); } catch { res = null; }
        const lm = res?.faceLandmarks?.[0] ?? null;
        const W = v.videoWidth, H = v.videoHeight;
        if (lm && (this._n++ % this._lumaEvery === 0)) {
          this._lumaCtx.drawImage(v, 0, 0, 160, 90);
          this._lastIllum = measureIllumination(this._lumaCtx, lm, 160, 90);
        }
        const pose = lm ? estimatePose(lm, W, H) : null;
        this.onFrame({
          t: ts / 1000, landmarks: lm, pose, W, H,
          luma: this._lastIllum.luma, blownPct: this._lastIllum.blownPct,
          isReplay: false,
          matrix: res?.facialTransformationMatrixes?.[0] ?? null,
        });
      }
    }
    this._raf = requestAnimationFrame(this._loop);
  };

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
  }
}

/* ------------------------------------------------------------------ */
/**
 * Replay: a scripted head trajectory rendered into landmark frames by synth.js
 * and pushed through estimatePose() — the identical estimator the live path
 * uses. Labelled as replay on every frame it emits, so the UI can never show
 * it as a live measurement.
 */
export class ReplaySource {
  constructor(name = 'replay-a', { speed = 4, cam = DEFAULT_CAM } = {}) {
    const cfg = REPLAY_SOURCES[name];
    if (!cfg) throw new Error(`Unknown replay source "${name}"`);
    this.name = name;
    this.cfg = cfg;
    this.isReplay = true;
    this.label = cfg.label;
    this.speed = speed;
    this.cam = cam;
    this.traj = buildTrajectory(cfg.traj);
    this.rng = makeRng((cfg.traj.seed ?? 1) * 7919 + 13);
    this.i = 0;
    this.running = false;
    this.loop = true;
  }

  /** Rendering target for the on-screen preview: a wireframe of the landmarks,
   *  so the operator can see the replayed head moving. */
  async start(onFrame) {
    this.onFrame = onFrame;
    this.running = true;
    this.i = 0;
    this._t0 = performance.now();
    const dt = 1000 / (this.traj.fps * this.speed);
    this._timer = setInterval(() => {
      if (!this.running) return;
      const fr = this.traj.frames[this.i];
      if (!fr) {
        if (this.loop) { this.i = 0; return; }
        this.stop(); return;
      }
      this.i++;
      const lm = renderFrame(fr.pose, this.cam, this.cfg.noisePx, this.rng);
      const pose = estimatePose(lm, this.cam.W, this.cam.H);
      this.onFrame({
        t: performance.now() / 1000,
        landmarks: lm, pose, W: this.cam.W, H: this.cam.H,
        luma: NaN, blownPct: NaN,
        isReplay: true, replayName: this.name, groundTruth: fr.pose,
        matrix: null,
      });
    }, dt);
  }

  stop() {
    this.running = false;
    clearInterval(this._timer);
  }
}
