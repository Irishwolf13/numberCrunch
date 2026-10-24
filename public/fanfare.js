// Number Crunch celebrations: sound synthesized with Web Audio (no audio files, so nothing for the CSP to allow)
// and confetti and fireworks on the #confetti canvas. Each result tier has a score: its music, and the bursts timed
// to land on its beats.

const SOUND_KEY = 'numbercrunch.sound.v1';
const calm = matchMedia('(prefers-reduced-motion: reduce)');
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const [Fs3, G3, C4, D4, E4, Fs4, G4, A4, C5, D5, E5, Fs5, G5, A5, C6, D6, E6, Fs6, G6, A6, C7, D7, E7] =
  [54, 55, 60, 62, 64, 66, 67, 69, 72, 74, 76, 78, 79, 81, 84, 86, 88, 90, 91, 93, 96, 98, 100];

// ===== SOUND =====
let soundOn = true;
try { soundOn = localStorage.getItem(SOUND_KEY) !== 'off'; } catch { /* storage blocked: sound stays on */ }
let audio = null; // {ctx, out, bus, noise}, made on a user gesture: browsers only start audio from one
let idle = 0;     // suspends the context after IDLE_MS without a gesture, to save power; the next gesture wakes it
const IDLE_MS = 30_000;

export const isSoundOn = () => soundOn;

export function setSound(on) {
  soundOn = on;
  try { if (on) localStorage.removeItem(SOUND_KEY); else localStorage.setItem(SOUND_KEY, 'off'); } catch { /* not remembered */ }
  if (!on) return fade();
  prime();
  audio?.ctx.resume().then(() => play(chime), () => {});
}

function prime() {
  if (!soundOn) return;
  try {
    if (!audio) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const out = ctx.createGain(), limiter = ctx.createDynamicsCompressor();
      out.gain.value = 0.5;
      out.connect(limiter);
      limiter.connect(ctx.destination);
      audio = { ctx, out, bus: null, noise: null };
    }
    if (audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {});
    clearTimeout(idle);
    idle = setTimeout(() => audio.ctx.suspend().catch(() => {}), IDLE_MS);
  } catch { /* no Web Audio: the celebrations stay silent */ }
}
// Events that carry user activation, so a new context may start (touch activates on release, not on press).
for (const type of ['pointerup', 'touchend', 'keydown']) addEventListener(type, prime, { capture: true, passive: true });

// Music plays into a bus that fade() can silence; null while sound is off or not yet allowed.
function bus() {
  if (!soundOn || audio?.ctx.state !== 'running') return null;
  if (!audio.bus) { audio.bus = audio.ctx.createGain(); audio.bus.connect(audio.out); }
  return audio.bus;
}

function play(sound) {
  const b = bus();
  if (b) sound(b, audio.ctx.currentTime + 0.02);
}

function fade() {
  if (!audio?.bus) return;
  const old = audio.bus;
  old.gain.setTargetAtTime(0, audio.ctx.currentTime, 0.04);
  setTimeout(() => old.disconnect(), 300);
  audio.bus = null;
}

// Silence to peak over attack, held, then an exponential release.
function envelope(param, t, peak, attack, hold, release) {
  param.setValueAtTime(0.0001, t);
  param.exponentialRampToValueAtTime(peak, t + attack);
  param.setValueAtTime(peak, t + attack + hold);
  param.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
}

function amp(b, t, peak, attack, hold, release) {
  const g = audio.ctx.createGain();
  envelope(g.gain, t, peak, attack, hold, release);
  g.connect(b);
  return g;
}

function osc(type, freq, t, end, into, detune = 0) {
  const o = audio.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.detune.value = detune;
  o.connect(into);
  o.start(t); o.stop(end);
  return o;
}

function lead(b, midi, t, hold, gain = 0.16) {
  osc('triangle', hz(midi), t, t + hold + 0.4, amp(b, t, gain, 0.005, hold, 0.3));
  osc('square', hz(midi), t, t + hold + 0.4, amp(b, t, gain / 4, 0.005, hold, 0.15));
}

function bell(b, midi, t, gain = 0.05) {
  osc('sine', hz(midi), t, t + 0.8, amp(b, t, gain, 0.003, 0, 0.7));
  osc('sine', hz(midi) * 2.76, t, t + 0.4, amp(b, t, gain / 3, 0.003, 0, 0.3));
}

// Two detuned saws through a lowpass that opens on the attack: a cheap brass section.
function brass(b, midi, t, hold, gain = 0.1) {
  const f = hz(midi), filter = audio.ctx.createBiquadFilter();
  filter.type = 'lowpass'; filter.Q.value = 2;
  filter.frequency.setValueAtTime(f * 1.5, t);
  filter.frequency.exponentialRampToValueAtTime(f * 8, t + 0.05);
  filter.frequency.exponentialRampToValueAtTime(f * 3, t + 0.3);
  filter.connect(amp(b, t, gain, 0.025, hold, 0.2));
  for (const detune of [-7, 7]) osc('sawtooth', f, t, t + hold + 0.3, filter, detune);
}

// A muted-trombone "wah", optionally sagging by bend semitones.
function wah(b, midi, t, hold, bend = 0) {
  const f = hz(midi), filter = audio.ctx.createBiquadFilter();
  filter.type = 'lowpass'; filter.Q.value = 6;
  filter.frequency.setValueAtTime(300, t);
  filter.frequency.exponentialRampToValueAtTime(1300, t + 0.12);
  filter.frequency.exponentialRampToValueAtTime(350, t + hold + 0.15);
  filter.connect(amp(b, t, 0.09, 0.03, hold, 0.15));
  const o = osc('sawtooth', f, t, t + hold + 0.25, filter);
  if (bend) o.frequency.exponentialRampToValueAtTime(f * 2 ** (bend / 12), t + hold + 0.15);
}

function hiss(b, t, length, { type = 'highpass', freq = 6000, q = 0.7, gain = 0.1 } = {}) {
  const { ctx } = audio;
  if (!audio.noise) {
    audio.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = audio.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource(), filter = ctx.createBiquadFilter();
  src.buffer = audio.noise; src.loop = true;
  filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
  src.connect(filter);
  filter.connect(amp(b, t, gain, 0.003, 0, length));
  src.start(t, Math.random() * 0.5); src.stop(t + length + 0.05);
}

function boom(b, t, gain = 0.45) {
  osc('sine', 150, t, t + 0.6, amp(b, t, gain, 0.004, 0, 0.5)).frequency.exponentialRampToValueAtTime(42, t + 0.45);
}

const crash = (b, t, gain = 0.08) => hiss(b, t, 1.6, { freq: 5000, gain });

function pop(b, t) {
  hiss(b, t, 0.09, { type: 'bandpass', freq: 1400, q: 1.2, gain: 0.3 });
  osc('sine', 320, t, t + 0.15, amp(b, t, 0.2, 0.002, 0, 0.08)).frequency.exponentialRampToValueAtTime(90, t + 0.08);
}

function crackle(b, t) {
  boom(b, t, 0.15);
  for (let i = 0; i < 12; i++) hiss(b, t + 0.05 + Math.random() * 0.5, 0.03, { freq: 2500 + Math.random() * 5000, gain: 0.03 + Math.random() * 0.05 });
}

function whistle(b, t) {
  osc('sine', 700, t, t + 0.8, amp(b, t, 0.025, 0.05, 0.4, 0.25)).frequency.exponentialRampToValueAtTime(1900, t + 0.7);
}

function chime(b, t) { lead(b, C6, t, 0.03, 0.1); lead(b, G6, t + 0.07, 0.05, 0.08); }

// The opening of the best-time fanfares: ta-ta-ta-TAAA, then a run up.
function intro(b, t) {
  for (const d of [0, 0.11, 0.22]) brass(b, G4, t + d, 0.05);
  for (const [m, g] of [[C5, 0.13], [G4, 0.07], [E4, 0.07]]) brass(b, m, t + 0.33, 0.42, g);
  boom(b, t + 0.33); crash(b, t + 0.33); pop(b, t + 0.33);
  [G4, C5, E5].forEach((m, i) => brass(b, m, t + 0.85 + i * 0.13, 0.06));
}

// A held chord (melody note first) with a drum, a cymbal and bells running up.
function finale(b, t, chord, bells) {
  chord.forEach((m, i) => brass(b, m, t, 0.8, i ? 0.07 : 0.13));
  boom(b, t, 0.4); crash(b, t, 0.07);
  bells.forEach((m, i) => bell(b, m, t + 0.08 + i * 0.07));
}

// Times are in seconds from the start: length is when the music ends, impact is its big beat.
const SCORES = {
  win: {
    length: 1.1, impact: 0.24,
    music(b, t) {
      pop(b, t);
      [C5, E5, G5].forEach((m, i) => lead(b, m, t + i * 0.08, 0.04));
      [C6, G5, E5].forEach((m, i) => lead(b, m, t + 0.24, 0.3, i ? 0.07 : 0.16));
      [G6, C7, E7].forEach((m, i) => bell(b, m, t + 0.32 + i * 0.08));
    },
    effects: [[0, () => burst(160, CONFETTI)], [0.24, () => cannons(45, CONFETTI)]],
  },
  pb: {
    length: 2.3, impact: 0.33,
    music(b, t) { intro(b, t); finale(b, t + 1.24, [G5, E5, C5, C4], [C6, E6, G6, C7]); },
    effects: [
      [0, () => burst(50, GOLD, 0.6)],
      [0.33, () => { burst(150, GOLD); cannons(100, GOLD); shower(2.2, GOLD); }],
      [1.24, () => { burst(120, CONFETTI); cannons(70, CONFETTI); }],
    ],
  },
  global: {
    length: 4, impact: 0.33,
    music(b, t) {
      intro(b, t);
      [G5, E5, C5].forEach((m, i) => brass(b, m, t + 1.24, 0.18, i ? 0.07 : 0.12));
      boom(b, t + 1.24, 0.3);
      for (const d of [1.55, 1.66, 1.77]) brass(b, A4, t + d, 0.05);
      for (const [m, g] of [[D5, 0.13], [A4, 0.07], [Fs4, 0.07]]) brass(b, m, t + 1.88, 0.42, g);
      boom(b, t + 1.88); crash(b, t + 1.88);
      [A4, D5, Fs5].forEach((m, i) => brass(b, m, t + 2.4 + i * 0.13, 0.06));
      finale(b, t + 2.79, [A5, Fs5, D5, D4], [D6, Fs6, A6, D7]);
    },
    effects: [
      [0, () => burst(50, GOLD, 0.6)],
      [0.33, () => { burst(150, GOLD); cannons(100, GOLD); }],
      [1.24, () => { burst(90, PRISM); fireworks(5, 1.4); }],
      [1.88, () => cannons(90, PRISM)],
      [2.4, () => fireworks(4, 0.8)],
      [2.79, () => { burst(180, PRISM); cannons(110, PRISM); shower(2.6, PRISM); }],
    ],
  },
};
SCORES.first = SCORES.pb;

let timers = [], stageEnds = 0;

// Plays a result tier's celebration ('win', 'first', 'pb' or 'global') and returns the milliseconds until its big
// beat, so the page can land its own effects on it. A tier that arrives while another still plays follows it.
export function cheer(tier) {
  const score = SCORES[tier], now = performance.now(), delay = Math.max(0, stageEnds - now - 150);
  stageEnds = now + delay + score.length * 1000;
  const b = bus();
  if (b) score.music(b, audio.ctx.currentTime + delay / 1000);
  for (const [at, effect] of score.effects) timers.push(setTimeout(effect, delay + at * 1000));
  return delay + score.impact * 1000;
}

export const groan = () => play((b, t) => { wah(b, G3, t, 0.16); wah(b, Fs3, t + 0.26, 0.5, -1); });

// Stops the celebration: the music fades, queued bursts and rockets are dropped, and what is in the air fades out
// in about a third of a second.
export function hush() {
  timers.forEach(clearTimeout);
  timers = []; stageEnds = 0;
  particles = particles.filter((p) => p.kind !== 'rocket' && !(p.wait > 0));
  for (const p of particles) p.decay = Math.max(p.decay, 0.05);
  fade();
}

// ===== CONFETTI AND FIREWORKS =====
const CONFETTI = ['#00e6a0', '#4ade80', '#ffd700', '#f97316', '#ff4466', '#a855f7', '#4488ff', '#ec4899', '#fff'];
const GOLD = ['#ffd700', '#ffe866', '#ffb800', '#fff4b8', '#ff9f1a', '#fff'];
const PRISM = ['#00e6a0', '#4488ff', '#a855f7', '#ec4899', '#ffd700', '#fff'];
const MAX_PARTICLES = 1800;
const canvas = document.getElementById('confetti'), pen = canvas.getContext('2d');
let particles = [], frame = null, last = 0;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
  pen.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resize(); addEventListener('resize', resize);

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const scaled = (n) => Math.max(1, Math.round(n * (calm.matches ? 0.2 : 1)));
const add = (p) => { if (particles.length < MAX_PARTICLES) particles.push(p); };

function animate() {
  if (frame) return;
  last = performance.now();
  frame = requestAnimationFrame(tick);
}

function piece(x, y, vx, vy, colors, extra) {
  add({
    kind: 'confetti', x, y, vx, vy, gravity: 0.16, drag: 0.99, color: pick(colors), size: 4 + Math.random() * 7,
    rotation: Math.random() * 360, spin: (Math.random() - 0.5) * 14, flip: Math.random() * 6, sway: 0,
    life: 1, decay: 0.006 + Math.random() * 0.01, round: Math.random() < 0.5, ...extra,
  });
}

function burst(count, colors, power = 1) {
  const x = innerWidth / 2, y = innerHeight * 0.45;
  for (let i = scaled(count); i > 0; i--) {
    const a = Math.random() * Math.PI * 2, speed = (4 + Math.random() * 12) * (0.5 + Math.random()) * power;
    piece(x, y, Math.cos(a) * speed, Math.sin(a) * speed - 4, colors);
  }
  animate();
}

// From both bottom corners, up and inward.
function cannons(count, colors) {
  for (const dir of [1, -1]) {
    for (let i = scaled(count); i > 0; i--) {
      const a = (50 + Math.random() * 30) * Math.PI / 180, speed = Math.sqrt(0.32 * innerHeight * (0.5 + Math.random() * 0.5)) * 1.1;
      piece(dir > 0 ? 0 : innerWidth, innerHeight + 5, Math.cos(a) * speed * dir, -Math.sin(a) * speed, colors,
        { decay: 0.004 + Math.random() * 0.006 });
    }
  }
  animate();
}

// Confetti fluttering down from the top for a while.
function shower(seconds, colors) {
  for (let i = scaled(seconds * 90); i > 0; i--) {
    piece(Math.random() * innerWidth, -20, (Math.random() - 0.5) * 2, 1 + Math.random() * 2, colors, {
      gravity: 0.08, drag: 0.98, sway: 0.6 + Math.random() * 0.8, decay: 0.003 + Math.random() * 0.002,
      wait: Math.random() * seconds * 1000,
    });
  }
  animate();
}

// Rockets launched one after another over the given seconds; each bursts at the top of its climb.
function fireworks(count, seconds) {
  const n = scaled(count);
  for (let i = 0; i < n; i++) {
    const peak = innerHeight * (0.12 + Math.random() * 0.3);
    add({
      kind: 'rocket', x: innerWidth * (0.15 + Math.random() * 0.7), y: innerHeight + 10, vx: (Math.random() - 0.5) * 1.5,
      vy: -Math.sqrt(0.4 * (innerHeight + 10 - peak)), gravity: 0.2, drag: 1, color: '#fff2d0', size: 2.5,
      life: 1, decay: 0, colors: [pick(PRISM), pick(PRISM)], wait: 1 + (i / n) * seconds * 1000,
    });
  }
  animate();
}

function ember(r) {
  add({ kind: 'spark', x: r.x, y: r.y, vx: (Math.random() - 0.5) * 0.6, vy: Math.random() * 0.8, gravity: 0.03, drag: 0.96, color: '#ffcf70', size: 1.5, life: 0.7, decay: 0.04 });
}

function explode(r) {
  const n = scaled(90 + Math.random() * 40), power = 2.5 + Math.random() * 2.5;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, speed = power * (0.55 + Math.random() * 0.5);
    add({
      kind: 'spark', x: r.x, y: r.y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, gravity: 0.045, drag: 0.975,
      color: pick(r.colors), size: 1.6 + Math.random() * 1.6, life: 1, decay: 0.011 + Math.random() * 0.012,
    });
  }
  play(crackle);
}

// Advances a particle by k frames' worth (at 60 fps), so motion keeps the same speed on any refresh rate.
// Returns whether it lives on.
function move(p, k, ms) {
  if (p.wait > 0) {
    p.wait -= ms;
    if (p.wait <= 0 && p.kind === 'rocket') play(whistle);
    return true;
  }
  const drag = p.drag ** k;
  p.vx *= drag; p.vy = p.vy * drag + p.gravity * k;
  p.x += p.vx * k; p.y += p.vy * k;
  if (p.kind === 'rocket') {
    if (p.vy < 0) { if (Math.random() < 0.7) ember(p); return true; }
    explode(p);
    return false;
  }
  if (p.kind === 'confetti') { p.rotation += p.spin * k; p.flip += 0.12 * k; p.x += Math.sin(p.flip) * p.sway * k; }
  p.life -= p.decay * k;
  return p.life > 0 && p.y < innerHeight + 50;
}

// Confetti tumbles: squashing it by cos(flip) turns it edge-on and back.
function drawPiece(p) {
  pen.save();
  pen.translate(p.x, p.y); pen.rotate(p.rotation * Math.PI / 180); pen.scale(1, Math.cos(p.flip));
  pen.globalAlpha = p.life; pen.fillStyle = p.color;
  if (p.round) { pen.beginPath(); pen.arc(0, 0, p.size / 2, 0, Math.PI * 2); pen.fill(); }
  else pen.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
  pen.restore();
}

function drawSpark(p) {
  pen.globalAlpha = Math.max(0, p.life);
  pen.strokeStyle = p.color; pen.lineWidth = p.size; pen.lineCap = 'round';
  pen.beginPath(); pen.moveTo(p.x - p.vx * 3, p.y - p.vy * 3); pen.lineTo(p.x, p.y); pen.stroke();
}

// Sparks and rockets draw additively over the confetti, so they glow where they cross.
function tick(now) {
  const ms = Math.max(0, Math.min(50, now - last)), k = ms / (1000 / 60);
  last = now;
  const before = particles;
  particles = []; // explosions add their sparks here as the survivors are copied over
  for (const p of before) if (move(p, k, ms)) particles.push(p);
  pen.clearRect(0, 0, innerWidth, innerHeight);
  for (const p of particles) if (p.kind === 'confetti' && !(p.wait > 0)) drawPiece(p);
  pen.globalCompositeOperation = 'lighter';
  for (const p of particles) if (p.kind !== 'confetti' && !(p.wait > 0)) drawSpark(p);
  pen.globalCompositeOperation = 'source-over';
  pen.globalAlpha = 1;
  frame = particles.length ? requestAnimationFrame(tick) : null;
}
