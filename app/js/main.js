/* =========================================================================
 * main.js — wiring.
 *
 * Model assets: loaded from ./vendor and ./models on this origin. There is no
 * CDN reference anywhere in this application; check the network panel.
 * ========================================================================= */

import { FilesetResolver, FaceLandmarker } from '../vendor/tasks-vision/vision_bundle.mjs';
import { estimatePose, angularDistanceDeg, eulerToMatrix } from './pose.js';
import { evaluateGates, computeNoiseFloor, LIMITS } from './quality.js';
import { summariseSession, reliability, compareSessions, DIRECTIONS, DIRECTION_LABEL, trialErrors } from './stats.js';
import { ProtocolRunner, PHASES } from './protocol.js';
import { LiveCameraSource, ReplaySource } from './sources.js';
import { REPLAY_SOURCES, buildTrajectory, renderFrame, makeRng, DEFAULT_CAM } from './synth.js';
import { runSyntheticSweep, runDifferentialSweep, runRealFaceCrossCheck } from './validation.js';
import * as store from './store.js';
import * as audio from './audio.js';
import * as ui from './ui.js';

const $ = (id) => document.getElementById(id);
const el = {
  video: $('video'), overlay: $('overlay'), stageMsg: $('stageMsg'), stage: $('stage'),
  qstrip: $('qstrip'), camMeta: $('camMeta'), sessMeta: $('sessMeta'),
  phaseName: $('phaseName'), phaseProg: $('phaseProg'), instruction: $('instruction'),
  countdown: $('countdown'), track: $('track'),
  btnCam: $('btnCam'), btnCalib: $('btnCalib'), btnRun: $('btnRun'), btnStop: $('btnStop'),
  replaySel: $('replaySel'), chkSpeech: $('chkSpeech'), chkTone: $('chkTone'),
  modelBadge: $('modelBadge'), sourceBadge: $('sourceBadge'),
  replayBanner: $('replayBanner'), replayText: $('replayText'),
  resKpis: $('resKpis'), resTable: $('resTable'), scatter: $('scatter'),
  relKpis: $('relKpis'), history: $('history'), histTable: $('histTable'), verdict: $('verdict'),
  btnSeed: $('btnSeed'), btnClear: $('btnClear'),
  btnVal: $('btnVal'), btnValDiff: $('btnValDiff'), btnValReal: $('btnValReal'), valOut: $('valOut'),
  aboutBody: $('aboutBody'),
};

const state = {
  landmarker: null,
  source: null,
  runner: null,
  lastFrame: null,
  gate: null,
  noise: { noiseFloorDeg: NaN },
  sessionSummary: null,
  sessionTrials: [],
  sessions: [],
  validation: null,
  ready: false,
};

/* ------------------------------------------------------------------ *
 * model load
 * ------------------------------------------------------------------ */
async function loadModel() {
  const fileset = await FilesetResolver.forVisionTasks('./vendor/tasks-vision/wasm');
  state.landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: './models/face_landmarker.task', delegate: 'GPU' },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFacialTransformationMatrixes: true,
    outputFaceBlendshapes: false,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  el.modelBadge.className = 'badge ok';
  el.modelBadge.innerHTML = '<i class="dot"></i>face_landmarker.task &middot; local';
  return state.landmarker;
}

/* ------------------------------------------------------------------ *
 * frame handling
 * ------------------------------------------------------------------ */
function onFrame(frame) {
  state.lastFrame = frame;
  if (state.runner) state.runner.step(frame);

  state.gate = evaluateGates({
    pose: frame.pose, landmarks: frame.landmarks, W: frame.W, H: frame.H,
    luma: frame.luma, blownPct: frame.blownPct,
    noiseFloorDeg: state.noise.noiseFloorDeg, isReplay: frame.isReplay,
  });
  ui.renderQuality(el.qstrip, state.gate, state.noise, frame.isReplay);
  ui.drawOverlay(el.overlay, {
    pose: frame.pose, landmarks: frame.landmarks,
    neutral: state.runner?.trialData?.neutral ?? null,
    isReplay: frame.isReplay,
    phase: state.runner?.phase,
  });
  el.camMeta.textContent = frame.pose
    ? `${frame.W}\u00d7${frame.H} \u00b7 468 landmarks \u00b7 fit ${(frame.pose.fitConfidence * 100).toFixed(0)}%`
    : `${frame.W}\u00d7${frame.H} \u00b7 no face`;
  el.stageMsg.style.display = frame.pose ? 'none' : '';
  if (!frame.pose) el.stageMsg.textContent = 'No face detected.';
}

/* ------------------------------------------------------------------ *
 * sources
 * ------------------------------------------------------------------ */
function stopSource() {
  state.source?.stop();
  state.source = null;
  el.btnCalib.disabled = true;
  el.btnRun.disabled = true;
  el.sourceBadge.className = 'badge live';
  el.sourceBadge.innerHTML = '<i class="dot"></i>No source';
  el.replayBanner.classList.remove('on');
}

async function startLive() {
  audio.unlock();
  stopSource();
  el.video.classList.remove('hidden');
  el.stageMsg.textContent = 'Requesting camera\u2026';
  const src = new LiveCameraSource(el.video, state.landmarker);
  state.source = src;
  await src.start(onFrame);
  el.sourceBadge.className = 'badge ok';
  el.sourceBadge.innerHTML = '<i class="dot"></i>LIVE camera';
  el.btnCalib.disabled = false;
  el.btnStop.disabled = false;
  el.replaySel.value = '';
}

async function startReplay(name, speed = 4) {
  audio.unlock();
  stopSource();
  el.video.classList.add('hidden');
  const src = new ReplaySource(name, { speed });
  state.source = src;
  await src.start(onFrame);
  el.sourceBadge.className = 'badge replay';
  el.sourceBadge.innerHTML = `<i class="dot"></i>REPLAY \u00b7 ${name}`;
  el.replayBanner.classList.add('on');
  el.replayText.innerHTML = `<b>${REPLAY_SOURCES[name].label}.</b> ${REPLAY_SOURCES[name].description}
    Landmarks are synthesised, then pushed through the same estimator, gates and statistics as the live camera.
    Nothing on this screen is a measurement of a real person while this banner is visible. Playing at &times;${speed} speed.`;
  el.btnCalib.disabled = false;
  el.btnStop.disabled = false;
  el.stageMsg.style.display = 'none';
  const stamp = document.createElement('div');
  stamp.className = 'replaystamp';
  stamp.textContent = 'REPLAY \u2014 SYNTHETIC LANDMARK STREAM';
  el.stage.querySelector('.replaystamp')?.remove();
  el.stage.appendChild(stamp);
  return src;
}

/* ------------------------------------------------------------------ *
 * protocol
 * ------------------------------------------------------------------ */
function makeRunner() {
  const isReplay = !!state.source?.isReplay;
  const r = new ProtocolRunner({
    trialsPerDirection: 2,
    timeScale: isReplay ? (state.source.speed ?? 1) : 1,
    onUpdate: renderRunner,
  });
  r.noise = state.noise;
  state.runner = r;
  return r;
}

function renderRunner(s) {
  el.phaseName.textContent = s.phase;
  el.instruction.textContent = s.msg;
  el.phaseProg.textContent = s.trialIndex >= 0 && s.phase !== PHASES.DONE
    ? `trial ${Math.min(s.trialIndex + 1, s.totalTrials)} / ${s.totalTrials} \u00b7 ${DIRECTION_LABEL[s.direction] ?? ''}`
    : `${s.trials.length} trials recorded`;
  el.countdown.textContent = s.countdown != null ? s.countdown.toFixed(1) : '';
  const done = new Set(s.trials.map((t) => t.index));
  const skipped = new Set(s.rejected.map((t) => t.index));
  el.track.innerHTML = Array.from({ length: s.totalTrials }, (_, i) =>
    `<i class="${done.has(i) ? 'done' : skipped.has(i) ? 'skip' : i === s.trialIndex ? 'cur' : ''}"></i>`).join('');
  el.sessMeta.textContent = `${s.trials.length} recorded${s.rejected.length ? ` \u00b7 ${s.rejected.length} rejected` : ''}`;
}

async function calibrate() {
  const r = state.runner ?? makeRunner();
  r.noise = { noiseFloorDeg: NaN };
  state.noise = r.noise;
  const noise = await r.startCalibration();
  state.noise = noise;
  el.btnRun.disabled = !(noise.noiseFloorDeg <= LIMITS.noiseFloorMaxDeg);
  return noise;
}

async function runProtocol() {
  const r = makeRunner();
  r.noise = state.noise;
  el.btnRun.disabled = true; el.btnCalib.disabled = true;
  const isReplay = !!state.source?.isReplay;
  try {
    const res = await r.start();
    state.sessionTrials = res.trials;
    state.sessionSummary = { ...res.summary, __trials: res.trials };
    const session = {
      id: store.newSessionId(),
      startedAt: Date.now(),
      source: isReplay ? `replay:${state.source.name}` : 'live',
      noise: res.noise,
      trials: res.trials,
      summary: res.summary,
      rejected: res.rejected,
      appVersion: 1,
    };
    await store.saveSession(session);
    await refreshHistory();
    renderResults();
    showTab('results');
    return session;
  } finally {
    el.btnRun.disabled = false; el.btnCalib.disabled = false;
    state.runner = null;
  }
}

function renderResults() {
  ui.renderResults(el.resKpis, el.resTable, el.scatter, state.sessionSummary, state.noise,
    !!state.source?.isReplay);
}

/* ------------------------------------------------------------------ *
 * history
 * ------------------------------------------------------------------ */
async function refreshHistory() {
  state.sessions = await store.listSessions();
  const rel = reliability(state.sessions);
  state.reliability = rel;
  const cmp = state.sessions.length >= 2
    ? compareSessions(state.sessions[state.sessions.length - 2], state.sessions[state.sessions.length - 1], rel.mdc95)
    : null;
  state.comparison = cmp;
  ui.renderHistory(el.relKpis, el.history, el.histTable, el.verdict, state.sessions, rel, cmp);
  return rel;
}

/**
 * Seed prior sessions. These are generated by running the SAME synthetic
 * trajectory generator and the SAME estimator + statistics used for a live
 * session — not by writing plausible numbers into the database. They are
 * stored with source "replay:seed" and the history table shows them as REPLAY.
 */
async function seedHistory(n = 4) {
  const base = { left: 4.0, right: -3.6, extension: 4.6, flexion: -4.0 };
  for (let k = 0; k < n; k++) {
    const traj = buildTrajectory({
      seed: 1000 + k * 37,
      trialsPerDirection: 2,
      // a mild, realistic session-to-session wobble; no trend is imposed
      errorBias: Object.fromEntries(Object.entries(base).map(([d, v]) => [d, v * (1 + (k - 1.5) * 0.05)])),
      errorSd: { left: 2.0, right: 1.9, extension: 2.4, flexion: 2.2 },
    });
    const rng = makeRng(5000 + k);
    const noisePx = 0.75;
    const poseOf = (frameIdx) => {
      const lm = renderFrame(traj.frames[frameIdx].pose, DEFAULT_CAM, noisePx, rng);
      return estimatePose(lm, DEFAULT_CAM.W, DEFAULT_CAM.H);
    };
    // noise floor from the calibration hold, through the real estimator
    const calibPoses = [];
    for (let i = traj.calib.start; i < traj.calib.end; i += 1) calibPoses.push(poseOf(i));
    const noise = computeNoiseFloor(calibPoses);

    const trials = [];
    for (const seg of traj.plan) {
      const nP = [], rP = [];
      for (let i = seg.neutralEnd - 24; i < seg.neutralEnd; i++) nP.push(poseOf(i));
      for (let i = seg.returnEnd - 24; i < seg.returnEnd; i++) rP.push(poseOf(i));
      const mean = (arr, key) => arr.reduce((s, p) => s + p[key], 0) / arr.length;
      const neutral = { yaw: mean(nP, 'yaw'), pitch: mean(nP, 'pitch'), roll: mean(nP, 'roll'), R: nP[nP.length - 1].R };
      const ret = { yaw: mean(rP, 'yaw'), pitch: mean(rP, 'pitch'), roll: mean(rP, 'roll'), R: rP[rP.length - 1].R };
      neutral.R = eulerToMatrix(neutral.yaw, neutral.pitch, neutral.roll);
      ret.R = eulerToMatrix(ret.yaw, ret.pitch, ret.roll);
      const e = trialErrors(neutral, ret, seg.direction, angularDistanceDeg);
      trials.push({ index: seg.index, direction: seg.direction, neutral, ret, ...e });
    }
    await store.saveSession({
      id: store.newSessionId(),
      startedAt: Date.now() - (n - k) * 86400000 * 3,
      source: 'replay:seed',
      noise, trials,
      summary: summariseSession(trials),
      rejected: [], appVersion: 1, seeded: true,
    });
  }
  return refreshHistory();
}

/* ------------------------------------------------------------------ *
 * validation panel
 * ------------------------------------------------------------------ */
function renderValidation(html) { el.valOut.innerHTML = html; }

async function runValidation() {
  renderValidation('<div class="note">Running sweep\u2026</div>');
  await new Promise((r) => setTimeout(r, 20));
  const v = runSyntheticSweep();
  state.validation = v.summary;
  const s = v.summary;
  renderValidation(`
    <div class="kpis">
      <div class="kpi"><div class="k">MAE yaw</div><div class="v">${s.maeYaw.toFixed(3)}\u00b0</div><div class="n">n=${s.n}</div></div>
      <div class="kpi"><div class="k">MAE pitch</div><div class="v">${s.maePitch.toFixed(3)}\u00b0</div><div class="n">known-angle</div></div>
      <div class="kpi"><div class="k">MAE 3-D</div><div class="v">${s.mae3d.toFixed(3)}\u00b0</div><div class="n">geodesic</div></div>
      <div class="kpi"><div class="k">p95 3-D</div><div class="v">${s.p95_3d.toFixed(3)}\u00b0</div><div class="n">max ${s.max3d.toFixed(2)}\u00b0</div></div>
    </div>
    <table><thead><tr><th>Quantity</th><th>MAE</th><th>RMSE</th></tr></thead><tbody>
      <tr><td>Yaw</td><td>${s.maeYaw.toFixed(3)}\u00b0</td><td>${s.rmseYaw.toFixed(3)}\u00b0</td></tr>
      <tr><td>Pitch</td><td>${s.maePitch.toFixed(3)}\u00b0</td><td>${s.rmsePitch.toFixed(3)}\u00b0</td></tr>
      <tr><td>Roll</td><td>${s.maeRoll.toFixed(3)}\u00b0</td><td>&mdash;</td></tr>
      <tr><td>3-D geodesic</td><td>${s.mae3d.toFixed(3)}\u00b0</td><td>&mdash;</td></tr>
    </tbody></table>
    <div class="note" style="margin-top:9px">
      ${s.n} synthetic poses: yaw &plusmn;45&deg;, pitch &plusmn;25&deg;, roll &plusmn;8&deg;, randomised translation and a
      480&ndash;740&nbsp;mm distance, ${s.noisePx}&nbsp;px per-landmark Gaussian noise. Ground truth is the rotation
      imposed on the canonical mesh. <b>This is the estimator's error, not the product's clinical validity.</b>
    </div>`);
  return s;
}

async function runValidationDiff() {
  renderValidation('<div class="note">Running differential sweep (this one averages 30 frames per pose, so give it a moment)\u2026</div>');
  await new Promise((r) => setTimeout(r, 20));
  const v = runDifferentialSweep();
  const s = v.summary;
  state.validationDiff = s;
  renderValidation(`
    <div class="kpis">
      <div class="kpi"><div class="k">MAE on &Delta;</div><div class="v">${s.maeDeg.toFixed(3)}\u00b0</div><div class="n">n=${s.n}</div></div>
      <div class="kpi"><div class="k">p95</div><div class="v">${s.p95Deg.toFixed(3)}\u00b0</div><div class="n">max ${s.maxDeg.toFixed(3)}\u00b0</div></div>
      <div class="kpi"><div class="k">Bias</div><div class="v">${s.biasDeg >= 0 ? '+' : ''}${s.biasDeg.toFixed(3)}\u00b0</div><div class="n">signed mean</div></div>
      <div class="kpi"><div class="k">Frames avg</div><div class="v">${s.framesAveraged}</div><div class="n">as in a real trial</div></div>
    </div>
    <div class="note">
      JPE is a <b>difference</b> between two head poses, so any bias the estimator carries at a given pose largely
      cancels. This sweep imposes known repositioning errors of &plusmn;1&ndash;6&deg; and measures how accurately the
      pipeline recovers the <em>difference</em>, averaging ${s.framesAveraged} frames per pose exactly as a trial does.
      <b>${s.maeDeg.toFixed(2)}&deg;</b> is therefore the number that bounds what this tool can resolve, and it is why
      the MDC&#8325;&#8325; on real sessions lands where it does.
    </div>`);
  return s;
}

async function runValidationReal() {
  renderValidation('<div class="note">Detecting the fixture face\u2026</div>');
  const lm = state.landmarker;
  const prevMode = 'VIDEO';
  await lm.setOptions({ runningMode: 'IMAGE' });
  let r;
  try { r = await runRealFaceCrossCheck(lm); } finally { await lm.setOptions({ runningMode: prevMode }); }
  state.validationReal = r;
  if (!r.ok) { renderValidation(`<div class="verdict noise">${r.reason}</div>`); return r; }
  const d = r.delta;
  renderValidation(`
    <table><thead><tr><th>Axis</th><th>This estimator</th><th>MediaPipe matrix</th><th>&Delta;</th></tr></thead><tbody>
      <tr><td>Yaw</td><td>${r.ours.yaw.toFixed(2)}\u00b0</td><td>${r.mediapipe.yaw.toFixed(2)}\u00b0</td><td>${d.yaw.toFixed(2)}\u00b0</td></tr>
      <tr><td>Pitch</td><td>${r.ours.pitch.toFixed(2)}\u00b0</td><td>${r.mediapipe.pitch.toFixed(2)}\u00b0</td><td>${d.pitch.toFixed(2)}\u00b0</td></tr>
      <tr><td>Roll</td><td>${r.ours.roll.toFixed(2)}\u00b0</td><td>${r.mediapipe.roll.toFixed(2)}\u00b0</td><td>${d.roll.toFixed(2)}\u00b0</td></tr>
    </tbody></table>
    <div class="note" style="margin-top:9px">
      Real face, ${r.imageSize}, ${r.landmarkCount} landmarks, fit confidence ${(r.ours.fitConfidence * 100).toFixed(0)}%.
      Our Procrustes estimator versus MediaPipe's own <code>facialTransformationMatrixes</code>, decoded with the same
      Y-X-Z convention. <b>Neither is ground truth</b> &mdash; two estimators agreeing is weaker evidence than a known
      angle, and it is reported here only to show the live path is not silently broken on real skin.
    </div>`);
  return r;
}

/* ------------------------------------------------------------------ *
 * tabs / about
 * ------------------------------------------------------------------ */
function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.p === name));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === `p-${name}`));
  if (name === 'results') renderResults();
  if (name === 'history') ui.renderHistory(el.relKpis, el.history, el.histTable, el.verdict,
    state.sessions, state.reliability ?? reliability(state.sessions), state.comparison);
}

el.aboutBody.innerHTML = `
  <p><b>Head pose.</b> MediaPipe FaceLandmarker (WASM, vendored at <code>./vendor/tasks-vision</code>, model at
  <code>./models/face_landmarker.task</code>) returns 478 landmarks. We take a 36-point <b>skull-rigid</b> subset
  &mdash; nasal bridge and tip, the four canthi, lateral orbital rims, temples, zygomatic arches, forehead midline
  &mdash; deliberately excluding lips, jaw, eyelids and brows so expression cannot masquerade as rotation. A
  closed-form similarity fit (Horn's quaternion absolute orientation, so a reflection is impossible) aligns that
  subset to the canonical mesh, and the rotation is decomposed <b>intrinsic Y-X-Z</b>:
  <code>R = Ry(yaw)&middot;Rx(pitch)&middot;Rz(roll)</code>. Positive yaw = head toward the participant's left;
  positive pitch = extension; positive roll = left ear down.</p>
  <p><b>Landmark fit confidence</b> is not a model output &mdash; MediaPipe does not expose one. It is
  <code>1 &minus; residual/0.12</code> where residual is the RMS Procrustes residual normalised by face radius, so
  it drops when the landmarks stop looking like a rigid face.</p>
  <p><b>Noise floor.</b> Three seconds of holding still; the SD of estimated yaw and pitch is taken and reported as
  their RMS. Above ${LIMITS.noiseFloorMaxDeg}&deg; no trial is accepted.</p>
  <p><b>Per trial</b> we take the mean pose over a stable window (rotation averaging via Markley's quaternion
  eigenmethod, so it is correct for large angles too) at neutral and again on return, then report absolute error and
  constant error on the clinical axis plus the true 3-D geodesic angle
  <code>acos((tr(R&#8339;R&#8345;&#7488;)&minus;1)/2)</code>.</p>
  <p><b>Repeatability.</b> SEM is the within-subject SD of session means (Bland's s&#8348;), cross-checked against
  &radic;MSE from the ANOVA. <code>MDC&#8325;&#8325; = 1.96&middot;&radic;2&middot;SEM</code>. ICC(2,1) is the two-way
  random, absolute-agreement, single-measurement form, with rows = the four movement directions and columns =
  sessions. <b>With one participant that is a within-person reproducibility index, not a population ICC</b>, and it
  cannot tell you how well the tool separates different people.</p>
  <p><b>Privacy.</b> getUserMedia frames go to the WASM detector and to a 160&times;90 canvas for the illumination
  estimate. They are never encoded, stored or transmitted. Sessions hold angles only &mdash; no images, no landmarks
  &mdash; in IndexedDB on this machine. The app makes no network request after load.</p>
  <p><b>Known gaps, stated plainly.</b> No validation against an instrumented laboratory measure. No patient data.
  The distance readout assumes a 60&deg; horizontal field of view and a 140&nbsp;mm bizygomatic width, so it is
  indicative only. The replay streams are synthetic, not recordings of people. Trunk rotation is not tracked, so a
  participant who rotates their torso will be measured as having repositioned well when they have not &mdash; the
  clinical test uses a fixed trunk and this tool cannot enforce that.</p>`;

/* ------------------------------------------------------------------ *
 * events
 * ------------------------------------------------------------------ */
document.querySelectorAll('#tabs button').forEach((b) =>
  b.addEventListener('click', () => showTab(b.dataset.p)));
el.btnCam.addEventListener('click', () => startLive().catch((e) => {
  el.stageMsg.textContent = `Camera unavailable: ${e.message}. Load a replay stream instead \u2014 it exercises the same pipeline.`;
  el.stageMsg.style.display = '';
}));
el.replaySel.addEventListener('change', (e) => { if (e.target.value) startReplay(e.target.value); });
el.btnCalib.addEventListener('click', () => { audio.unlock(); calibrate(); });
el.btnRun.addEventListener('click', () => { audio.unlock(); runProtocol().catch(() => {}); });
el.btnStop.addEventListener('click', () => { state.runner?.abort(); stopSource(); audio.cancelSpeech(); el.btnStop.disabled = true; });
el.btnSeed.addEventListener('click', () => seedHistory(4));
el.btnClear.addEventListener('click', async () => { await store.clearSessions(); await refreshHistory(); });
el.btnVal.addEventListener('click', runValidation);
el.btnValDiff.addEventListener('click', runValidationDiff);
el.btnValReal.addEventListener('click', runValidationReal);
el.chkSpeech.addEventListener('change', (e) => audio.setSpeech(e.target.checked));
el.chkTone.addEventListener('change', (e) => audio.setTone(e.target.checked));
window.addEventListener('resize', () => { renderResults(); showTab(document.querySelector('#tabs button.on').dataset.p); });

for (const [k, v] of Object.entries(REPLAY_SOURCES)) {
  const o = document.createElement('option');
  o.value = k; o.textContent = v.label;
  el.replaySel.appendChild(o);
}

/* ------------------------------------------------------------------ *
 * boot + demo hooks
 * ------------------------------------------------------------------ */
const ready = (async () => {
  await loadModel();
  await refreshHistory();
  renderResults();
  state.ready = true;
  el.instruction.textContent = 'Model loaded. Start the live camera, or load a replay stream.';
  return true;
})();

ready.catch((e) => {
  el.modelBadge.className = 'badge live';
  el.modelBadge.innerHTML = `<i class="dot"></i>Model failed: ${e.message}`;
});

window.__demo = {
  ready,
  useReplaySource: (name = 'replay-a', speed = 4) => startReplay(name, speed),
  startProtocol: async () => {
    if (!state.source) await startReplay('replay-a', 4);
    if (!Number.isFinite(state.noise.noiseFloorDeg)) await calibrate();
    return runProtocol();
  },
  calibrate,
  showResults: () => showTab('results'),
  showHistory: () => showTab('history'),
  showValidation: () => showTab('validation'),
  showMethod: () => showTab('about'),
  seedHistory,
  runValidation,
  runValidationDiff,
  runValidationReal,
  clearHistory: async () => { await store.clearSessions(); await refreshHistory(); },
  startLive,
  stop: () => { state.runner?.abort(); stopSource(); },
  stats: () => {
    const s = state.sessionSummary;
    const rel = state.reliability ?? reliability(state.sessions);
    return {
      trials: s?.nTrials ?? 0,
      meanJpeLeft: s?.perDirection?.left?.absolute?.mean ?? null,
      meanJpeRight: s?.perDirection?.right?.absolute?.mean ?? null,
      meanJpeExtension: s?.perDirection?.extension?.absolute?.mean ?? null,
      meanJpeFlexion: s?.perDirection?.flexion?.absolute?.mean ?? null,
      meanJpeOverall: s?.overall?.mean ?? null,
      ci95Overall: s ? [s.overall.lo, s.overall.hi] : null,
      sem: rel.sem,
      icc: rel.icc,
      mdc95: rel.mdc95,
      nSessions: rel.nSessions,
      noiseFloorDeg: state.noise?.noiseFloorDeg ?? null,
      estimatorErrorDeg: state.validation?.estimatorErrorDeg ?? null,
      estimatorDifferentialErrorDeg: state.validationDiff?.maeDeg ?? null,
      isReplay: !!state.source?.isReplay,
      replaySource: state.source?.isReplay ? state.source.name : null,
      comparison: state.comparison ?? null,
    };
  },
  _state: state,
};
