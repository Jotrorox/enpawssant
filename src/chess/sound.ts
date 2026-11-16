// Board sounds, synthesised with the Web Audio API (no audio files).
//
// A piece landing is modelled as a small block of wood: a few inharmonic partials (the modes of a
// free bar, which is what makes it read as "wood" rather than "beep") that die away quickly, a low
// thump from the board and a short noise click for the contact. Every hit is nudged in pitch and
// level so repeated moves never sound machine-gunned. Everything runs through a tiny synthetic room
// and a limiter so layered sounds stay warm and never clip.

import { createSignal } from "solid-js";

export type SoundKind =
  | "move"
  | "capture"
  | "castle"
  | "check"
  | "promote"
  | "mate"
  | "illegal"
  | "pickup";

const STORAGE_KEY = "enpawssant.sound";

function loadPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

const [soundEnabled, setSoundSignal] = createSignal(loadPreference());

export { soundEnabled };

export function setSoundEnabled(enabled: boolean) {
  setSoundSignal(enabled);
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Not persisting the preference is fine.
  }
  if (enabled) playSound("move");
}

type Engine = { ac: AudioContext; dry: AudioNode; room: AudioNode; noise: AudioBuffer };
let engine: Engine | undefined;

function setup(): Engine {
  if (engine) {
    if (engine.ac.state === "suspended") void engine.ac.resume();
    return engine;
  }
  const ac = new AudioContext({ latencyHint: "interactive" });

  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -12;
  limiter.knee.value = 6;
  limiter.ratio.value = 6;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.1;
  limiter.connect(ac.destination);

  const dry = ac.createGain();
  dry.gain.value = 0.6;
  dry.connect(limiter);

  const reverb = ac.createConvolver();
  reverb.buffer = roomImpulse(ac);
  const wet = ac.createGain();
  wet.gain.value = 0.16;
  const room = ac.createGain();
  room.connect(reverb).connect(wet).connect(limiter);

  const noise = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.1), ac.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  engine = { ac, dry, room, noise };
  return engine;
}

/** A short, dark stereo tail: decaying noise, low-passed so it sounds like wood, not tile. */
function roomImpulse(ac: AudioContext): AudioBuffer {
  const length = Math.floor(ac.sampleRate * 0.45);
  const impulse = ac.createBuffer(2, length, ac.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    let smoothed = 0;
    for (let i = 0; i < length; i++) {
      smoothed += 0.3 * (Math.random() * 2 - 1 - smoothed);
      data[i] = smoothed * (1 - i / length) ** 4;
    }
  }
  return impulse;
}

/** Starts the audio engine from a user gesture so the first real sound isn't late. */
export function primeAudio() {
  if (!soundEnabled()) return;
  try {
    setup();
  } catch {
    // Audio is a nicety; ignore environments without it.
  }
}

/** Random factor in `1 ± amount`. */
const jitter = (amount: number) => 1 + (Math.random() * 2 - 1) * amount;

function bus(e: Engine, gain: number): GainNode {
  const node = e.ac.createGain();
  node.gain.value = gain;
  node.connect(e.dry);
  node.connect(e.room);
  return node;
}

/** One decaying sine partial, optionally sliding down into its pitch. */
function partial(
  e: Engine,
  out: AudioNode,
  at: number,
  freq: number,
  gain: number,
  decay: number,
  glideFrom?: number,
) {
  const osc = e.ac.createOscillator();
  if (glideFrom) {
    osc.frequency.setValueAtTime(glideFrom, at);
    osc.frequency.exponentialRampToValueAtTime(freq, at + Math.min(0.035, decay * 0.5));
  } else {
    osc.frequency.setValueAtTime(freq, at);
  }
  const env = e.ac.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(gain, at + 0.0015);
  env.gain.setTargetAtTime(0, at + 0.0015, decay / 5);
  osc.connect(env).connect(out);
  osc.start(at);
  osc.stop(at + decay * 1.2 + 0.05);
}

function noiseBurst(
  e: Engine,
  out: AudioNode,
  at: number,
  options: { duration: number; gain: number; type: BiquadFilterType; freq: number; q?: number },
) {
  const source = e.ac.createBufferSource();
  source.buffer = e.noise;
  const filter = e.ac.createBiquadFilter();
  filter.type = options.type;
  filter.frequency.value = options.freq;
  filter.Q.value = options.q ?? 0.8;
  const env = e.ac.createGain();
  env.gain.setValueAtTime(options.gain, at);
  env.gain.setTargetAtTime(0, at, options.duration / 5);
  source.connect(filter).connect(env).connect(out);
  source.start(at, Math.random() * 0.04);
  source.stop(at + options.duration + 0.03);
}

// Mode ratios of a free wooden bar; higher modes are quieter and die faster.
const WOOD_MODES = [
  { ratio: 1, gain: 0.5, decay: 0.08 },
  { ratio: 2.76, gain: 0.2, decay: 0.045 },
  { ratio: 5.4, gain: 0.09, decay: 0.026 },
  { ratio: 8.93, gain: 0.05, decay: 0.015 },
];

/** A piece set down on the board. `pitch` scales the whole hit, `hardness` brightens it. */
function woodHit(e: Engine, at: number, pitch: number, hardness: number, level: number) {
  const out = bus(e, level * jitter(0.08));
  const base = 560 * pitch * jitter(0.035);
  for (const mode of WOOD_MODES) {
    const bright = mode.ratio > 3 ? hardness : 1;
    partial(e, out, at, base * mode.ratio, mode.gain * bright, mode.decay * jitter(0.1));
  }
  partial(e, out, at, 135 * pitch, 0.42, 0.07, 240 * pitch);
  noiseBurst(e, out, at, {
    duration: 0.012,
    gain: 0.22 * hardness,
    type: "bandpass",
    freq: 3000 * pitch,
    q: 0.9,
  });
}

/** A small bell: slightly stretched partials and a long ring. */
function bell(e: Engine, at: number, freq: number, level: number, decay: number) {
  const out = bus(e, level);
  partial(e, out, at, freq, 1, decay);
  partial(e, out, at, freq * 2.01, 0.45, decay * 0.55);
  partial(e, out, at, freq * 3.02, 0.2, decay * 0.35);
  partial(e, out, at, freq * 4.16, 0.1, decay * 0.2);
}

/** Plays a board sound, optionally `delay` seconds from now (to land with an animation). */
export function playSound(kind: SoundKind, delay = 0) {
  if (!soundEnabled()) return;
  try {
    const e = setup();
    const at = e.ac.currentTime + 0.004 + delay;
    switch (kind) {
      case "move":
        woodHit(e, at, 1, 0.8, 0.85);
        break;
      case "capture":
        // A hard, bright hit, then the captured piece knocking against it.
        woodHit(e, at, 1.12, 1.4, 1);
        woodHit(e, at + 0.03, 0.8, 0.7, 0.55);
        break;
      case "castle":
        woodHit(e, at, 0.96, 0.8, 0.85);
        woodHit(e, at + 0.085, 1.06, 0.9, 0.7);
        break;
      case "check":
        // A cat-collar bell: ting-ting.
        bell(e, at + 0.02, 1976, 0.06, 0.55);
        bell(e, at + 0.1, 2637, 0.045, 0.7);
        break;
      case "promote":
        woodHit(e, at, 1.05, 1, 0.85);
        [1047, 1319, 1568, 2093].forEach((freq, i) => {
          bell(e, at + 0.05 + i * 0.055, freq, 0.05, 0.5);
        });
        break;
      case "mate":
        woodHit(e, at, 0.9, 1.2, 1);
        [523, 659, 784, 1047].forEach((freq, i) => {
          bell(e, at + 0.12 + i * 0.09, freq, 0.06, 1.4);
        });
        break;
      case "illegal": {
        // A soft, muffled bonk.
        const out = bus(e, 0.5);
        partial(e, out, at, 115, 0.6, 0.11, 190);
        noiseBurst(e, out, at, { duration: 0.03, gain: 0.15, type: "lowpass", freq: 700 });
        break;
      }
      case "pickup": {
        const out = bus(e, 0.35 * jitter(0.1));
        partial(e, out, at, 1500 * jitter(0.04), 0.08, 0.02);
        noiseBurst(e, out, at, { duration: 0.008, gain: 0.12, type: "highpass", freq: 4200 });
        break;
      }
    }
  } catch {
    // Audio is a nicety; ignore environments without it.
  }
}
