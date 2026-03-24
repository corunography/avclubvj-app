/**
 * hydra-engine.js
 * Wraps hydra-synth for use inside the visualizer window.
 *
 * Audio strategy: Hydra's own Audio class reassigns a.fft each tick()
 * and only works via Meyda/mic. Instead we create a plain fake `a` object
 * with a stable fft array, assign it to window.a, and mutate it in-place
 * from our existing AnalyserNode every rAF. Preset code using () => a.fft[0]
 * reads from this live object.
 */

import Hydra from 'hydra-synth';

let hydra         = null;
let hydraCanvas   = null;
let audioAnalyser = null;  // AnalyserNode shared from visualizer.js
let fftData       = null;
let fftRafId      = null;
let active        = false;

// Stable fake audio object — fft array is NEVER replaced, only mutated
const fakeAudio = {
  fft:  [0, 0, 0, 0],
  vol:  0,
  beat: { _framesSinceBeat: 0, threshold: 40, _cutoff: 0, holdFrames: 20, decay: 0.98 },
  tick: () => {},           // no-op — we pump manually
  hide: () => {},
  show: () => {},
};

// p1–p8: user-controllable params (sliders or defaults)
export const hydraParams = { p1: 0.5, p2: 0.5, p3: 0.5, p4: 0.5, p5: 0.5, p6: 0.5, p7: 0.5, p8: 0.5 };

export function initHydra(canvas) {
  if (hydra) return;
  hydraCanvas = canvas;

  hydra = new Hydra({
    canvas,
    detectAudio:         false,
    enableStreamCapture: false,
    makeGlobal:          true,   // puts osc/noise/src/solid/gradient etc on window
    autoLoop:            true,
  });

  // Wire in our fake audio object so `a.fft[n]` works in preset code
  hydra.synth.a = fakeAudio;
  window.a      = fakeAudio;

  // Also expose a0–a3 helper functions the same way Hydra normally would:
  // a0(scale, offset) returns () => a.fft[0] * scale + offset
  [0, 1, 2, 3].forEach(i => {
    window['a' + i] = (scale = 1, offset = 0) => () => fakeAudio.fft[i] * scale + offset;
  });

  // Expose p1–p8 as globals so preset code can use them directly
  for (const k of Object.keys(hydraParams)) {
    Object.defineProperty(window, k, {
      get: () => hydraParams[k],
      configurable: true,
    });
  }
}

export function setHydraAudioAnalyser(analyserNode) {
  audioAnalyser = analyserNode;
  if (analyserNode) {
    fftData = new Uint8Array(analyserNode.frequencyBinCount);
  }
}

// Pump Web Audio FFT → fakeAudio.fft[] in-place every frame
// Splits frequency bins into 4 bands: bass / low-mid / high-mid / treble
function pumpAudio() {
  if (!active) return;
  if (audioAnalyser && fftData) {
    audioAnalyser.getByteFrequencyData(fftData);
    const len  = fftData.length;
    const step = Math.floor(len / 4);
    let total  = 0;
    for (let i = 0; i < 4; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) sum += fftData[i * step + j];
      // Boost and apply power curve so quiet signals still drive visuals
    const raw = (sum / step) / 255;
    const val = Math.min(1, Math.pow(raw, 0.6) * 2.2);
      fakeAudio.fft[i] = val;   // mutate in-place — never replace the array
      total += val;
    }
    fakeAudio.vol = total / 4;
  }
  fftRafId = requestAnimationFrame(pumpAudio);
}

let presetLoadId = 0; // cancels stale seed→load sequences

const BLEND_MS = 400; // fade-out duration before new preset kicks in

export function loadHydraPreset(code) {
  if (!hydra) return false;

  const id = ++presetLoadId;

  // Fade canvas out, seed buffers, load preset, fade back in
  if (hydraCanvas) {
    hydraCanvas.style.transition = `opacity ${BLEND_MS * 0.5}ms ease-out`;
    hydraCanvas.style.opacity = '0';
  }

  setTimeout(() => {
    if (id !== presetLoadId) return;

    // Seed all output buffers so feedback presets have something to start from
    try {
      /* eslint-disable no-new-func */
      new Function(`
        osc(15, 0.1, 1.4).color(0.8, 0.3, 1.0).modulate(noise(3), 0.25).brightness(0.25).out(o0);
        osc(20, 0.08, 0.8).color(0.3, 0.9, 0.6).modulate(noise(2.5), 0.2).brightness(0.2).out(o1);
        osc(10, 0.12, 2.1).color(1.0, 0.5, 0.2).modulate(noise(4), 0.3).brightness(0.2).out(o2);
      `)();
      /* eslint-enable no-new-func */
    } catch (e) { /* ignore */ }

    // Wait ~10 frames for seed to render rich content, then load real preset
    let frames = 0;
    function waitAndLoad() {
      if (id !== presetLoadId) return;
      if (++frames < 10) { requestAnimationFrame(waitAndLoad); return; }
      try {
        // eslint-disable-next-line no-new-func
        new Function(code)();
      } catch (err) {
        console.error('[Hydra] preset error:', err);
      }
      // Fade back in
      if (hydraCanvas) {
        hydraCanvas.style.transition = `opacity ${BLEND_MS}ms ease-in`;
        hydraCanvas.style.opacity = '1';
      }
    }
    requestAnimationFrame(waitAndLoad);
  }, BLEND_MS * 0.5);

  return true;
}

export function showHydra() {
  if (!hydraCanvas) return;
  hydraCanvas.style.display = 'block';
  active = true;
  cancelAnimationFrame(fftRafId);
  pumpAudio();
}

export function hideHydra() {
  if (!hydraCanvas) return;
  hydraCanvas.style.display = 'none';
  active = false;
  cancelAnimationFrame(fftRafId);
  fftRafId = null;
}

export function setHydraParam(key, value) {
  if (key in hydraParams) hydraParams[key] = value;
}

export function isHydraActive() { return active; }
