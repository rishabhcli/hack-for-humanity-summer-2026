/* =========================================================================
 * ui.js — rendering. Every number drawn here comes from the live pipeline or
 * from the statistics module; nothing is placeholder text.
 * ========================================================================= */

import { DIRECTION_LABEL, DIRECTIONS } from './stats.js';
import { LIMITS } from './quality.js';

export const DIR_COLOR = {
  left: '#0d6a75', right: '#9a5a08', extension: '#1d6b43', flexion: '#9c2323',
};
const INK = '#14202c', INK2 = '#4a5b6b', INK3 = '#7d8b98', LINE = '#d3dae1';

const dpr = () => Math.min(2, window.devicePixelRatio || 1);
function fit(canvas) {
  const r = canvas.getBoundingClientRect();
  const d = dpr();
  const w = Math.max(10, Math.round(r.width));
  const h = Math.max(10, Math.round(canvas.height));
  if (canvas.width !== w * d || canvas.__h !== h) {
    canvas.width = w * d; canvas.height = h * d;
    canvas.style.height = `${h}px`; canvas.__h = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/* ================= live overlay: reticle + landmark wireframe ============ */

export function drawOverlay(canvas, { pose, landmarks, neutral, isReplay, phase, targetDeg }) {
  const r = canvas.getBoundingClientRect();
  const d = dpr();
  if (canvas.width !== Math.round(r.width * d) || canvas.height !== Math.round(r.height * d)) {
    canvas.width = Math.round(r.width * d); canvas.height = Math.round(r.height * d);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(d, 0, 0, d, 0, 0);
  const W = r.width, H = r.height;
  ctx.clearRect(0, 0, W, H);
  if (!pose) return;

  // Replay has no video underneath, so draw the landmark cloud to make the
  // replayed head visible. Mirrored to match the live preview.
  if (isReplay && landmarks) {
    ctx.save();
    ctx.translate(W, 0); ctx.scale(-1, 1);
    ctx.fillStyle = 'rgba(150,120,210,0.85)';
    // letterbox the 16:9 landmark space into the stage
    for (let i = 0; i < landmarks.length; i += 2) {
      const p = landmarks[i];
      ctx.fillRect(p.x * W - 0.8, p.y * H - 0.8, 1.6, 1.6);
    }
    ctx.restore();
  }

  // ---- reticle -------------------------------------------------------
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) * 0.34;
  const SPAN = 45;                      // degrees mapped to the reticle radius
  const px = (yaw) => cx - (yaw / SPAN) * R;   // mirrored: +yaw (subject left) -> screen left
  const py = (pitch) => cy - (pitch / SPAN) * R;

  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(230,238,245,0.30)';
  for (const g of [15, 30, 45]) {
    ctx.beginPath(); ctx.arc(cx, cy, (g / SPAN) * R, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
  ctx.stroke();

  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.fillStyle = 'rgba(215,226,236,0.6)';
  ctx.textAlign = 'center';
  ctx.fillText('15\u00b0', cx + (15 / SPAN) * R, cy - 4);
  ctx.fillText('30\u00b0', cx + (30 / SPAN) * R, cy - 4);

  // ---- neutral target -------------------------------------------------
  if (neutral) {
    const nx = px(neutral.yaw), ny = py(neutral.pitch);
    ctx.strokeStyle = '#5ce0b0'; ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.arc(nx, ny, 22, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#5ce0b0';
    ctx.beginPath(); ctx.arc(nx, ny, 3, 0, Math.PI * 2); ctx.fill();
    ctx.font = '600 11px -apple-system, sans-serif';
    ctx.fillText('NEUTRAL', nx, ny - 29);
  }

  // ---- current head marker -------------------------------------------
  const hx = px(pose.yaw), hy = py(pose.pitch);
  const hidden = phase === 'closeEyes' || phase === 'toTarget' || phase === 'atTarget'
    || phase === 'returning' || phase === 'settle';
  ctx.strokeStyle = hidden ? 'rgba(255,255,255,0.55)' : '#ffffff';
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(hx, hy, 15, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(hx - 24, hy); ctx.lineTo(hx - 17, hy);
  ctx.moveTo(hx + 17, hy); ctx.lineTo(hx + 24, hy);
  ctx.moveTo(hx, hy - 24); ctx.lineTo(hx, hy - 17);
  ctx.moveTo(hx, hy + 17); ctx.lineTo(hx, hy + 24);
  ctx.stroke();

  // roll indicator: rotate a short bar through the estimated roll
  ctx.save();
  ctx.translate(hx, hy); ctx.rotate((-pose.roll * Math.PI) / 180);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(-34, 0); ctx.lineTo(34, 0); ctx.stroke();
  ctx.restore();

  // ---- numeric readout -------------------------------------------------
  ctx.font = '600 13px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'left';
  const lines = [
    `yaw   ${pose.yaw >= 0 ? '+' : ''}${pose.yaw.toFixed(1)}\u00b0`,
    `pitch ${pose.pitch >= 0 ? '+' : ''}${pose.pitch.toFixed(1)}\u00b0`,
    `roll  ${pose.roll >= 0 ? '+' : ''}${pose.roll.toFixed(1)}\u00b0`,
  ];
  ctx.fillStyle = 'rgba(16,24,32,0.62)';
  ctx.fillRect(12, H - 76, 132, 64);
  ctx.fillStyle = '#eaf1f7';
  lines.forEach((l, i) => ctx.fillText(l, 20, H - 56 + i * 18));
  ctx.textAlign = 'center';
}

/* ================= quality strip ================= */

export function renderQuality(el, gate, noise, isReplay) {
  if (!gate) { el.innerHTML = ''; return; }
  const g = gate.gates;
  const cell = (key, label, valueTxt, ok, text, frac) => `
    <div class="q ${ok === null ? 'na' : ok ? 'ok' : 'bad'}">
      <div class="k">${label}</div>
      <div class="v">${valueTxt}</div>
      <div class="t">${text}</div>
      ${frac === null ? '' : `<div class="bar"><i style="width:${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%"></i></div>`}
    </div>`;
  const num = (v, d = 0, suffix = '') => (Number.isFinite(v) ? v.toFixed(d) + suffix : '\u2014');
  const cells = [];
  cells.push(cell('face', 'Face', g.face?.ok ? 'yes' : 'no', !!g.face?.ok, g.face?.text ?? '', null));
  cells.push(cell('distance', 'Distance', num(g.distance?.value, 0, ' cm'), g.distance?.ok ?? null, g.distance?.text ?? '',
    g.distance ? (g.distance.value - LIMITS.distanceMinCm) / (LIMITS.distanceMaxCm - LIMITS.distanceMinCm) : null));
  cells.push(cell('centering', 'Centering', num(g.centering?.value, 0, '%'), g.centering?.ok ?? null, g.centering?.text ?? '',
    g.centering ? 1 - g.centering.value / (LIMITS.offCentreMaxPct * 2) : null));
  cells.push(cell('illumination', 'Illumination',
    isReplay ? 'n/a' : num(g.illumination?.value, 0),
    isReplay ? null : (g.illumination?.ok ?? null), g.illumination?.text ?? '',
    isReplay || !g.illumination ? null : g.illumination.value / 255));
  cells.push(cell('confidence', 'Landmark fit', num((g.confidence?.value ?? NaN) * 100, 0, '%'),
    g.confidence?.ok ?? null, g.confidence?.text ?? '', g.confidence?.value ?? null));
  cells.push(cell('noise', 'Noise floor', num(noise?.noiseFloorDeg, 2, '\u00b0'), g.noise?.ok ?? null, g.noise?.text ?? '',
    Number.isFinite(noise?.noiseFloorDeg) ? 1 - noise.noiseFloorDeg / LIMITS.noiseFloorMaxDeg : null));
  el.innerHTML = cells.join('');
}

/* ================= results ================= */

export function renderResults(kpiEl, tableEl, canvas, summary, noise, isReplay) {
  if (!summary || !summary.nTrials) {
    kpiEl.innerHTML = '<div class="kpi" style="grid-column:1/-1"><div class="k">No completed session</div><div class="n">Run the protocol to populate this panel. Every value here is computed from your trials.</div></div>';
    tableEl.innerHTML = '';
    fit(canvas);
    drawScatterAxes(canvas, noise);
    return;
  }
  const o = summary.overall, o3 = summary.overall3d;
  const ci = (c) => (Number.isFinite(c.lo) ? `95% CI ${c.lo.toFixed(1)}\u2013${c.hi.toFixed(1)}\u00b0` : 'CI needs n\u22652');
  kpiEl.innerHTML = `
    <div class="kpi"><div class="k">Mean JPE</div><div class="v">${o.mean.toFixed(2)}\u00b0</div><div class="n">${ci(o)}</div></div>
    <div class="kpi"><div class="k">3-D angular</div><div class="v">${o3.mean.toFixed(2)}\u00b0</div><div class="n">geodesic, all axes</div></div>
    <div class="kpi"><div class="k">Trials</div><div class="v">${summary.nTrials}</div><div class="n">${isReplay ? 'replay stream' : 'live camera'}</div></div>
    <div class="kpi"><div class="k">Noise floor</div><div class="v">${Number.isFinite(noise?.noiseFloorDeg) ? noise.noiseFloorDeg.toFixed(2) + '\u00b0' : '\u2014'}</div><div class="n">tool noise this session</div></div>`;

  const rows = DIRECTIONS.filter((d) => summary.perDirection[d]).map((d) => {
    const p = summary.perDirection[d];
    return `<tr>
      <td><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${DIR_COLOR[d]};margin-right:7px"></span>${DIRECTION_LABEL[d]}</td>
      <td>${p.n}</td>
      <td><b>${p.absolute.mean.toFixed(2)}</b></td>
      <td>${Number.isFinite(p.absolute.lo) ? `${p.absolute.lo.toFixed(2)}\u2013${p.absolute.hi.toFixed(2)}` : '\u2014'}</td>
      <td>${p.constant.mean >= 0 ? '+' : ''}${p.constant.mean.toFixed(2)}</td>
      <td>${p.angular3d.mean.toFixed(2)}</td>
    </tr>`;
  }).join('');
  tableEl.innerHTML = `<table>
    <thead><tr><th>Direction</th><th>n</th><th>Abs JPE\u00b0</th><th>95% CI</th><th>Constant\u00b0</th><th>3-D\u00b0</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="note" style="margin-top:9px">
      <b>Absolute</b> error is how far off you were, sign discarded &mdash; the clinical JPE.
      <b>Constant</b> error keeps the sign, so a consistently positive value means you habitually
      overshoot in that direction. <b>3-D</b> is the true geodesic angle between the returned and
      neutral head orientations, which also catches error that leaked into the off-axis planes.
    </div>`;
  drawScatter(canvas, summary, noise);
}

function drawScatterAxes(canvas, noise) {
  const { ctx, w, h } = fit(canvas);
  if (w < 40 || h < 40) return null;
  const cx = w / 2, cy = h / 2, R = Math.max(8, Math.min(w, h) / 2 - 26);
  const SPAN = 8;
  ctx.strokeStyle = LINE; ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.fillStyle = INK3; ctx.textAlign = 'center';
  for (let g = 2; g <= SPAN; g += 2) {
    ctx.beginPath(); ctx.arc(cx, cy, (g / SPAN) * R, 0, Math.PI * 2); ctx.stroke();
    ctx.fillText(`${g}\u00b0`, cx + (g / SPAN) * R, cy - 3);
  }
  ctx.beginPath();
  ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
  ctx.stroke();
  if (Number.isFinite(noise?.noiseFloorDeg) && noise.noiseFloorDeg > 0) {
    ctx.fillStyle = 'rgba(185,196,205,0.35)';
    ctx.beginPath(); ctx.arc(cx, cy, (noise.noiseFloorDeg / SPAN) * R, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = INK2; ctx.font = '11px -apple-system, sans-serif';
  ctx.fillText('yaw error \u2192', cx + R - 34, cy + 15);
  ctx.save(); ctx.translate(cx - 13, cy - R + 34); ctx.rotate(-Math.PI / 2);
  ctx.fillText('pitch error \u2192', 0, 0); ctx.restore();
  return { ctx, cx, cy, R, SPAN };
}

function drawScatter(canvas, summary, noise) {
  const trials = [];
  for (const d of DIRECTIONS) {
    const p = summary.perDirection[d];
    if (p && p.__trials) trials.push(...p.__trials);
  }
  const all = summary.__trials ?? trials;
  const maxErr = Math.max(4, ...all.map((t) => Math.max(Math.abs(t.dYaw), Math.abs(t.dPitch))));
  const SPAN = Math.ceil(maxErr / 2) * 2;
  const { ctx, w, h } = fit(canvas);
  const cx = w / 2, cy = h / 2, R = Math.max(8, Math.min(w, h) / 2 - 26);

  ctx.strokeStyle = LINE; ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.fillStyle = INK3; ctx.textAlign = 'center';
  const step = SPAN <= 6 ? 2 : SPAN <= 12 ? 3 : 5;
  for (let g = step; g <= SPAN; g += step) {
    ctx.beginPath(); ctx.arc(cx, cy, (g / SPAN) * R, 0, Math.PI * 2); ctx.stroke();
    ctx.fillText(`${g}\u00b0`, cx + (g / SPAN) * R, cy - 3);
  }
  if (Number.isFinite(noise?.noiseFloorDeg) && noise.noiseFloorDeg > 0) {
    ctx.fillStyle = 'rgba(185,196,205,0.4)';
    ctx.beginPath(); ctx.arc(cx, cy, (noise.noiseFloorDeg / SPAN) * R, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = '#aab6c0';
  ctx.beginPath();
  ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
  ctx.stroke();

  for (const t of all) {
    const x = cx + (t.dYaw / SPAN) * R;
    const y = cy - (t.dPitch / SPAN) * R;
    ctx.fillStyle = DIR_COLOR[t.direction] ?? INK2;
    ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.4; ctx.stroke();
  }
  ctx.fillStyle = '#14202c';
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = INK2; ctx.font = '11px -apple-system, sans-serif';
  ctx.fillText('yaw error \u2192', cx + R - 34, cy + 15);
  ctx.save(); ctx.translate(cx - 13, cy - R + 36); ctx.rotate(-Math.PI / 2);
  ctx.fillText('pitch error \u2192', 0, 0); ctx.restore();
  ctx.textAlign = 'left';
  ctx.fillStyle = INK3; ctx.font = '10.5px -apple-system, sans-serif';
  ctx.fillText('centre = you returned exactly to neutral', 6, h - 6);
}

/* ================= history + MDC band ================= */

export function renderHistory(kpiEl, canvas, tableEl, verdictEl, sessions, rel, cmp) {
  const nf = (v, d = 2, s = '\u00b0') => (Number.isFinite(v) ? v.toFixed(d) + s : '\u2014');
  kpiEl.innerHTML = `
    <div class="kpi"><div class="k">Sessions</div><div class="v">${rel.nSessions}</div><div class="n">stored locally</div></div>
    <div class="kpi"><div class="k">SEM</div><div class="v">${nf(rel.sem)}</div><div class="n">within-subject SD</div></div>
    <div class="kpi"><div class="k">MDC<sub>95</sub></div><div class="v">${nf(rel.mdc95)}</div><div class="n">1.96&middot;&radic;2&middot;SEM</div></div>
    <div class="kpi"><div class="k">ICC(2,1)</div><div class="v">${Number.isFinite(rel.icc) ? rel.icc.toFixed(3) : '\u2014'}</div><div class="n">${rel.iccDetail ? `${rel.iccDetail.n} targets \u00d7 ${rel.iccDetail.k} sessions` : rel.note || 'needs \u22652 sessions'}</div></div>`;

  drawHistory(canvas, sessions, rel);

  if (!cmp) {
    verdictEl.innerHTML = `<div class="verdict none">${rel.nSessions < 2
      ? 'Two or more sessions are needed before this tool can tell you whether a change is real. Until then it will not guess.'
      : 'Run another session to compare.'}</div>`;
  } else {
    verdictEl.innerHTML = `<div class="verdict ${!Number.isFinite(cmp.mdc95) ? 'none' : cmp.real ? 'real' : 'noise'}">
      ${cmp.verdict}
      ${Number.isFinite(cmp.mdc95) && !cmp.real ? '<br><b>Do not read anything into it.</b> A difference smaller than this tool\u2019s own repeatability is not evidence that anything changed.' : ''}
    </div>`;
  }

  tableEl.innerHTML = `<table>
    <thead><tr><th>Session</th><th>When</th><th>Trials</th><th>Mean JPE\u00b0</th><th>3-D\u00b0</th><th>Noise\u00b0</th><th>Source</th></tr></thead>
    <tbody>${sessions.map((s, i) => `<tr>
      <td>#${i + 1}</td>
      <td>${new Date(s.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
      <td>${s.summary.nTrials}</td>
      <td><b>${s.summary.overall.mean.toFixed(2)}</b></td>
      <td>${s.summary.overall3d.mean.toFixed(2)}</td>
      <td>${Number.isFinite(s.noise?.noiseFloorDeg) ? s.noise.noiseFloorDeg.toFixed(2) : '\u2014'}</td>
      <td style="color:${s.source === 'live' ? '#1d6b43' : '#6a3fa0'};font-weight:600">${s.source === 'live' ? 'live' : 'REPLAY'}</td>
    </tr>`).join('')}</tbody></table>`;
}

function drawHistory(canvas, sessions, rel) {
  const { ctx, w, h } = fit(canvas);
  const padL = 46, padR = 14, padT = 16, padB = 30;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  ctx.fillStyle = INK3; ctx.font = '11px -apple-system, sans-serif';
  if (!sessions.length) {
    ctx.textAlign = 'center';
    ctx.fillText('No sessions stored yet.', w / 2, h / 2);
    return;
  }
  const vals = sessions.map((s) => s.summary.overall.mean);
  const band = Number.isFinite(rel.mdc95) ? rel.mdc95 : 0;
  const ref = vals[0];
  let lo = Math.min(...vals, ref - band) - 0.6;
  let hi = Math.max(...vals, ref + band) + 0.6;
  lo = Math.max(0, lo);
  if (hi - lo < 2) hi = lo + 2;
  const X = (i) => padL + (sessions.length === 1 ? plotW / 2 : (i / (sessions.length - 1)) * plotW);
  const Y = (v) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;

  // gridlines
  ctx.strokeStyle = '#e6eaee'; ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const v = lo + ((hi - lo) * i) / ticks;
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = INK3; ctx.fillText(`${v.toFixed(1)}\u00b0`, padL - 7, y + 3.5);
  }

  // MDC band around the FIRST session — the "anything inside here is noise" strip
  if (band > 0) {
    ctx.fillStyle = 'rgba(207,224,226,0.65)';
    ctx.fillRect(padL, Y(ref + band), plotW, Y(ref - band) - Y(ref + band));
    ctx.strokeStyle = '#9fc0c4'; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(padL, Y(ref + band)); ctx.lineTo(w - padR, Y(ref + band));
    ctx.moveTo(padL, Y(ref - band)); ctx.lineTo(w - padR, Y(ref - band)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = 'left'; ctx.fillStyle = '#5c7a7e'; ctx.font = '600 10.5px -apple-system, sans-serif';
    ctx.fillText(`\u00b1MDC\u2089\u2085 = ${band.toFixed(2)}\u00b0 \u2014 changes inside this band are noise`, padL + 6, Y(ref + band) + 13);
  }

  // reference line
  ctx.strokeStyle = '#7d8b98'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, Y(ref)); ctx.lineTo(w - padR, Y(ref)); ctx.stroke();

  // series
  ctx.strokeStyle = '#0d6a75'; ctx.lineWidth = 2.2;
  ctx.beginPath();
  sessions.forEach((s, i) => { const x = X(i), y = Y(vals[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();

  // CI whiskers + points
  sessions.forEach((s, i) => {
    const x = X(i), c = s.summary.overall;
    if (Number.isFinite(c.lo)) {
      ctx.strokeStyle = 'rgba(13,106,117,0.45)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(x, Y(c.lo)); ctx.lineTo(x, Y(c.hi));
      ctx.moveTo(x - 4, Y(c.lo)); ctx.lineTo(x + 4, Y(c.lo));
      ctx.moveTo(x - 4, Y(c.hi)); ctx.lineTo(x + 4, Y(c.hi));
      ctx.stroke();
    }
    ctx.fillStyle = s.source === 'live' ? '#0d6a75' : '#6a3fa0';
    ctx.beginPath(); ctx.arc(x, Y(vals[i]), 5.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.fillStyle = INK2; ctx.font = '10.5px -apple-system, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`#${i + 1}`, x, h - 10);
  });
  ctx.textAlign = 'left';
  ctx.fillStyle = INK; ctx.font = '600 11px -apple-system, sans-serif';
  ctx.fillText('Mean absolute JPE per session (lower is better)', padL, 10);
}
