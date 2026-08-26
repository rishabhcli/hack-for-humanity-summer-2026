/* =========================================================================
 * audio.js — spoken and tonal cues.
 *
 * The whole point of this test is that it is performed with the eyes CLOSED,
 * so the interface has to be audible. Two independent channels:
 *   1. Web Speech API for the instructions.
 *   2. WebAudio oscillator tones, which always work even where speech
 *      synthesis has no installed voice. Distinct pitch per event so the
 *      participant can follow the protocol from tone alone.
 * ========================================================================= */

let ctx = null;
let speechOn = true;
let toneOn = true;
let lastSpoken = '';

export function setSpeech(on) { speechOn = on; }
export function setTone(on) { toneOn = on; }
export const isSpeechAvailable = () => typeof speechSynthesis !== 'undefined';

function audioCtx() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Unlock audio on the first user gesture (browser autoplay policy). */
export function unlock() {
  const c = audioCtx();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
  if (isSpeechAvailable()) {
    // Priming utterance: zero-length, silent, makes later calls immediate.
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch { /* no voices installed — tones still work */ }
  }
}

export function tone(freq = 660, ms = 180, gain = 0.14, type = 'sine') {
  if (!toneOn) return;
  const c = audioCtx();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  const t0 = c.currentTime;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
  g.gain.setValueAtTime(gain, t0 + ms / 1000 - 0.03);
  g.gain.linearRampToValueAtTime(0, t0 + ms / 1000);
  o.connect(g); g.connect(c.destination);
  o.start(t0); o.stop(t0 + ms / 1000 + 0.02);
}

export const CUE_TONES = {
  ready:      () => tone(520, 140),
  closeEyes:  () => { tone(440, 160); setTimeout(() => tone(330, 220), 180); },
  rotate:     () => tone(700, 200),
  hold:       () => tone(880, 120),
  returnHome: () => { tone(700, 130); setTimeout(() => tone(520, 200), 150); },
  openEyes:   () => { tone(660, 120); setTimeout(() => tone(880, 120), 130); setTimeout(() => tone(1046, 200), 260); },
  reject:     () => { tone(220, 300, 0.14, 'square'); },
  done:       () => { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 190), i * 150)); },
  tick:       () => tone(1200, 45, 0.07),
};

export function say(text, { rate = 1.02, pitch = 1.0 } = {}) {
  if (!speechOn || !isSpeechAvailable()) return;
  if (text === lastSpoken) { /* still speak — repeats are meaningful here */ }
  lastSpoken = text;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate; u.pitch = pitch; u.volume = 1;
    speechSynthesis.speak(u);
  } catch { /* ignore: tones carry the protocol */ }
}

export function cancelSpeech() {
  if (isSpeechAvailable()) { try { speechSynthesis.cancel(); } catch { /* noop */ } }
}

/** Fire the tone and the spoken line for a protocol event together. */
export function cue(name, text) {
  (CUE_TONES[name] || CUE_TONES.ready)();
  if (text) setTimeout(() => say(text), 260);
}
