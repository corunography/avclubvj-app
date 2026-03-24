import butterchurn from 'butterchurn';
import { initHydra, setHydraAudioAnalyser, loadHydraPreset, showHydra, hideHydra, isHydraActive, setHydraParam } from './hydra-engine.js';
import butterchurnPresets from 'butterchurn-presets';
import butterchurnPresetsExtra from 'butterchurn-presets/lib/butterchurnPresetsExtra.min';
import butterchurnPresetsExtra2 from 'butterchurn-presets/lib/butterchurnPresetsExtra2.min';
import butterchurnPresetsMD1 from 'butterchurn-presets/lib/butterchurnPresetsMD1.min';
import butterchurnPresetsNonMinimal from 'butterchurn-presets/lib/butterchurnPresetsNonMinimal.min';
import weeklyWeek1 from 'butterchurn-presets-weekly/weeks/week1/presets.json';
import weeklyWeek2 from 'butterchurn-presets-weekly/weeks/week2/presets.json';
import weeklyWeek3 from 'butterchurn-presets-weekly/weeks/week3/presets.json';
import weeklyWeek4 from 'butterchurn-presets-weekly/weeks/week4/presets.json';
import weeklyWeek5 from 'butterchurn-presets-weekly/weeks/week5/presets.json';

// Load baron community presets directly from JSON files (bypasses ESM async loading)
const baronPresets = {};
const baronCtx = require.context('butterchurn-presets-baron/dist/presets', false, /\.json$/);
baronCtx.keys().forEach(key => {
  baronPresets[key.replace('./', '').replace('.json', '')] = baronCtx(key);
});

// ── MilkDrop built-in compiler ────────────────────────────────────────────────
// Community presets use frame_eqs_str with bare MilkDrop function names like
// equal(), above(), below(), div(), pow(), randint(). butterchurn compiles
// equations as new Function('a', code) with only 'a' in scope, so those names
// are unresolved → ReferenceError or "Unexpected token 'return'" (when the
// string is undefined → 'undefined return a;').
//
// Fix: pre-compile all equation strings ourselves, passing the builtins as
// named parameters. butterchurn skips recompilation when init_eqs is already
// a function (typeof check), so it just uses our pre-built versions.

const MD_BUILTIN_NAMES = [
  'equal','above','below','div','pow','randint',
  'sign','sqr','sqrt','int','sigmoid','log',
  'mod','band','bor','bnot','bitand','log10',
];
const MD_BUILTIN_FNS = [
  (a,b) => a===b?1:0,
  (a,b) => a>b?1:0,
  (a,b) => a<b?1:0,
  (a,b) => b!==0?a/b:0,
  (a,b) => a>=0?Math.pow(a,b):-Math.pow(-a,b),
  (n)   => Math.floor(Math.random()*(n>0?n:1)),
  (a)   => a>0?1:a<0?-1:0,
  (a)   => a*a,
  (a)   => Math.sqrt(Math.abs(a)),
  (a)   => Math.trunc(a),
  (a,b) => 1/(1+Math.exp(-a*b)),
  (a)   => Math.log(Math.abs(a)+1e-9),
  (a,b) => b!==0?a%b:0,
  (a,b) => (a!==0&&b!==0)?1:0,
  (a,b) => (a!==0||b!==0)?1:0,
  (a)   => a!==0?0:1,
  (a,b) => Math.floor(a)&Math.floor(b),
  (a)   => Math.log10(Math.abs(a)+1e-9),
];
const NOOP_EQ = (a) => a;

// Cache compiled equation functions by source string to avoid redundant
// new Function() JIT compilations on every preset load / param slider tick.
const EQ_CACHE = new Map();
const EQ_CACHE_MAX = 300;

function compileEqStr(str) {
  if (!str || typeof str !== 'string') return NOOP_EQ;
  if (EQ_CACHE.has(str)) return EQ_CACHE.get(str);
  let compiled;
  try {
    const fn = new Function('a', ...MD_BUILTIN_NAMES, str + ' return a;');
    compiled = (a) => fn(a, ...MD_BUILTIN_FNS);
  } catch (e) {
    console.warn('[AV Club VJ] Equation compile error:', e.message);
    compiled = NOOP_EQ;
  }
  // Evict oldest entry if cache is full
  if (EQ_CACHE.size >= EQ_CACHE_MAX) {
    EQ_CACHE.delete(EQ_CACHE.keys().next().value);
  }
  EQ_CACHE.set(str, compiled);
  return compiled;
}

// ── State ────────────────────────────────────────────────────────────────────

let visualizer = null;
let audioCtx = null;
let sourceNode = null;
let currentPresetData = null; // deep copy of the loaded preset for live editing

// 3-band EQ — BiquadFilterNodes inserted between sourceNode and gainNode.
// Boosts/cuts the audio signal going into butterchurn's analyser, directly
// influencing how much a.bass / a.mid / a.treb fire inside preset equations.
let bassFilter = null; // lowshelf  @ 120 Hz
let midFilter  = null; // peaking   @ 800 Hz, Q=1
let trebFilter = null; // highshelf @ 3000 Hz

// Syphon state
let syphonEnabled = false;

// Syphon Overlay (transparent alpha) state
let syphonOverlayEnabled  = false;
let overlayAlphaCanvas    = null;    // OffscreenCanvas for alpha output composition
let overlayAlphaCtx       = null;
let overlayAlphaPixelBuf  = null;    // Uint8Array, reused each frame
let overlayAlphaBufW      = 0;
let overlayAlphaBufH      = 0;
let _overlayWasActive     = false;   // dirty flag: flush one trailing transparent frame

// Trivia visibility flags for overlay channel — DOM opacity isn't easily polled
let triviaOverlayVisible    = false;
let triviaScoreboardVisible = false;

// Async PBO readback state — eliminates the synchronous gl.readPixels GPU stall.
// Two PBOs ping-pong: while one is being read by the CPU, the GPU writes to the other.
let syphonPBOs = null;      // [pboA, pboB]
let syphonPBOIdx = 0;       // which PBO the GPU is writing to this frame
let syphonPBOReady = false; // true once first async readback has been kicked off
let syphonPBOW = 0;
let syphonPBOH = 0;
let syphonPixelBuf = null;  // reusable Uint8Array

let gainNode = null;
let audioSensitivity = 1.0;

// Performance state
let targetFps = 60;
let lastFrameTime = 0;
let rafId = null;     // requestAnimationFrame handle
let sleepId = null;   // setTimeout handle for FPS sleep

// GPU load tracking
let perfFrameCount  = 0;
let perfWindowStart = 0;
let perfSkipEnabled = false;
let hydraActive     = false; // suppress perf measurements while Hydra is rendering
let perfThreshold   = 150; // % over target before flagging
let perfOverloadSec = 0;   // consecutive seconds above threshold
let perfSkipCooldownUntil = 0; // don't skip again until this timestamp
const PERF_OVERLOAD_TRIGGER = 4;  // seconds above threshold before skip
const PERF_SKIP_COOLDOWN    = 30000; // ms between skips
const LOW_FPS_LOG_THRESHOLD  = 25;   // fps below which a preset gets logged
const LOW_FPS_LOG_WARMUP_MS  = 5000; // wait this long after load before logging
const lowFpsLoggedPresets    = new Set(); // logged once per preset per session
let   lowFpsLogReadyAt       = 0;    // don't log until this timestamp

// Beat detection state
let beatAnalyserNode = null;
let beatFreqData = null;

// VU meter state — smoothed per-band levels sent to controls ~15fps
let vuLevels = { bass: 0, mid: 0, treb: 0, overall: 0 };
let vuFrameCount = 0;

// Brightness auto-skip
let brightSkipEnabled   = false;
let brightFrameCount    = 0;
let brightSustained     = 0;       // consecutive high-brightness readings
let brightSampleBuf     = null;    // reused 16×16 Uint8Array for non-Syphon path
const BRIGHT_CHECK_EVERY = 60;    // rendered frames between checks (~2 s at 30 fps)
const BRIGHT_THRESHOLD   = 0.75;  // avg normalised luminance to consider "too bright"
const BRIGHT_SUSTAIN_REQ = 2;     // consecutive high readings before alerting (~4 s)
// Dark + loud skip
let darkSkipEnabled  = false;
let darkSustained    = 0;
const DARK_THRESHOLD  = 0.08;    // avg luminance below this = "black" scene
const DARK_AUDIO_MIN  = 0.30;    // overall VU must exceed this to trigger (ignore silence)
const VU_ATTACK  = 0.85; // fast rise
const VU_RELEASE = 0.12; // slow fall
// Beat detection — dual-EMA approach
let beatSlowAvg = 0;           // ~6s exponential average — tracks background energy level
let beatFastAvg = 0;           // ~0.15s exponential average — tracks transients
const BEAT_SLOW_COEF  = 0.005; // ~200 frames time-constant at 30fps (~6.7s)
const BEAT_FAST_COEF  = 0.18;  // ~5.6 frames time-constant at 30fps (~0.18s)
const BEAT_THRESHOLD  = 1.35;  // fast must exceed slow by this factor to register a beat
let beatRefractoryUntil = 0;
let beatTimestamps = [];
let beatSyncEnabled = false;
let detectedBpm = 0;
let beatConfidence = 0;        // 0–1, how consistent the inter-beat intervals are

const MESH_QUALITY = {
  high:    { meshWidth: 32, meshHeight: 24 },
  medium:  { meshWidth: 16, meshHeight: 12 },
  low:     { meshWidth: 8,  meshHeight: 6  },
  ultralow:{ meshWidth: 4,  meshHeight: 3  },
};
let currentQuality = 'high';
let currentPresetName = null; // track for reinit

const canvas = document.getElementById('canvas');

// Pre-create the WebGL2 context with high-performance GPU preference.
// Browsers/Electron reuse an existing context on the same canvas, so
// butterchurn's internal getContext('webgl2') call will get this one.
// On dual-GPU Macs this forces the discrete GPU instead of integrated.
canvas.getContext('webgl2', { powerPreference: 'high-performance', antialias: false });
const statusEl = document.getElementById('status');

// Initialise Hydra on its own canvas
const hydraCanvas = document.getElementById('hydra-canvas');
initHydra(hydraCanvas);

// Preset map (built-in + community + custom) — ~1,840 presets total
// Weekly presets are stored as S3 URL strings — filter to objects only
function mergePresetObjects(...sources) {
  const out = {};
  for (const src of sources) {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === 'object') out[k] = v;
    }
  }
  return out;
}
const builtinPresets = mergePresetObjects(
  butterchurnPresets.getPresets(),
  butterchurnPresetsExtra.getPresets(),
  butterchurnPresetsExtra2.getPresets(),
  butterchurnPresetsMD1.getPresets(),
  butterchurnPresetsNonMinimal.getPresets(),
  weeklyWeek1, weeklyWeek2, weeklyWeek3, weeklyWeek4, weeklyWeek5,
  baronPresets,
);
const customPresets = {}; // name → preset object

// Default baseVals — grabbed once from the first known-good builtin preset.
// Used to fill missing fields in sparse custom/imported presets so butterchurn
// never receives `undefined` for expected numeric parameters.
const DEFAULT_BASE_VALS = Object.values(builtinPresets)[0]?.baseVals || {};
const DEFAULT_SHAPE_BASE_VALS = { enabled: 0, sides: 4, textured: 0, x: 0.5, y: 0.5, rad: 0.1, ang: 0, r: 1, g: 1, b: 1, a: 1, r2: 1, g2: 1, b2: 1, a2: 1, border_r: 1, border_g: 1, border_b: 1, border_a: 0 };
const DEFAULT_WAVE_BASE_VALS  = { enabled: 0, samples: 512, sep: 0, smoothing: 0.5, scaling: 1, r: 1, g: 1, b: 1, a: 1 };

function normalizePreset(preset) {
  const baseVals = { ...DEFAULT_BASE_VALS, ...(preset.baseVals || {}) };

  // Three cases for equation compilation:
  // 1. Already compiled functions (original npm preset objects) — use as-is.
  //    butterchurn skips its own compilation when init_eqs is already a function.
  // 2. JS-format equations (AI-generated/glitch presets, param overrides) — compile
  //    with compileEqStr which has math builtins in scope. Flagged with _jsFormat:true.
  // 3. MilkDrop-format equations (converted .milk presets, npm preset JSON) — leave
  //    init_eqs/frame_eqs/pixel_eqs as undefined so butterchurn compiles from *_str
  //    fields natively with full MilkDrop variable scope (bass, fps, time, q1-q32…).
  let init_eqs  = preset.init_eqs;
  let frame_eqs = preset.frame_eqs;
  let pixel_eqs = preset.pixel_eqs;

  if (typeof init_eqs === 'function') {
    // Case 1: already compiled, use as-is
  } else if (preset._jsFormat) {
    // Case 2: JS-format — compile with our MilkDrop math-builtin wrapper
    init_eqs  = compileEqStr(preset.init_eqs_str);
    frame_eqs = compileEqStr(preset.frame_eqs_str);
    pixel_eqs = (preset.pixel_eqs_str && preset.pixel_eqs_str !== '')
      ? compileEqStr(preset.pixel_eqs_str)
      : '';
  } else {
    // Case 3: MilkDrop-format — let butterchurn compile natively
    init_eqs  = undefined;
    frame_eqs = undefined;
    pixel_eqs = undefined;
  }

  // Shapes
  const MAX_SHAPE_INSTANCES = 50;
  const shapes = (preset.shapes || []).map(s => {
    const bv = { ...DEFAULT_SHAPE_BASE_VALS, ...(s.baseVals || {}) };
    if (bv.num_inst > MAX_SHAPE_INSTANCES) bv.num_inst = MAX_SHAPE_INSTANCES;
    if (bv.enabled === 0 || typeof s.init_eqs === 'function') {
      return { ...s, baseVals: bv };
    }
    if (preset._jsFormat) {
      return {
        ...s,
        baseVals:  bv,
        init_eqs:  compileEqStr(s.init_eqs_str),
        frame_eqs: compileEqStr(s.frame_eqs_str),
      };
    }
    return { ...s, baseVals: bv, init_eqs: undefined, frame_eqs: undefined };
  });

  // Waves
  const waves = (preset.waves || []).map(w => {
    const bv = { ...DEFAULT_WAVE_BASE_VALS, ...(w.baseVals || {}) };
    if (bv.enabled === 0 || typeof w.init_eqs === 'function') {
      return { ...w, baseVals: bv };
    }
    if (preset._jsFormat) {
      return {
        ...w,
        baseVals:   bv,
        init_eqs:   compileEqStr(w.init_eqs_str),
        frame_eqs:  compileEqStr(w.frame_eqs_str),
        point_eqs:  (w.point_eqs_str && w.point_eqs_str !== '')
          ? compileEqStr(w.point_eqs_str)
          : '',
      };
    }
    return { ...w, baseVals: bv, init_eqs: undefined, frame_eqs: undefined, point_eqs: undefined };
  });

  return { ...preset, baseVals, init_eqs, frame_eqs, pixel_eqs, shapes, waves };
}

// ── Canvas sizing ─────────────────────────────────────────────────────────────

function resizeCanvas() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w;
  canvas.height = h;
  if (visualizer) visualizer.setRendererSize(w, h);
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ── Butterchurn init ──────────────────────────────────────────────────────────

function initVisualizer(presetToLoad = null) {
  if (!audioCtx) return;

  const q = MESH_QUALITY[currentQuality] || MESH_QUALITY.high;
  visualizer = butterchurn.createVisualizer(audioCtx, canvas, {
    width: canvas.width,
    height: canvas.height,
    pixelRatio: 1,
    meshWidth: q.meshWidth,
    meshHeight: q.meshHeight,
  });

  if (gainNode) visualizer.connectAudio(gainNode);

  // Use applyPreset so currentPresetData is always populated
  const allBuiltinKeys = Object.keys(builtinPresets);
  const randomKey = allBuiltinKeys[Math.floor(Math.random() * allBuiltinKeys.length)];
  const name = presetToLoad || randomKey;
  const preset = builtinPresets[name] || customPresets[name];
  if (preset) applyPreset(preset, name, 0);
}

function reinitVisualizer(quality) {
  const savedPreset = currentPresetName;
  currentQuality = quality;

  // Stop render loop, destroy old visualizer, reset PBO state
  stopRenderLoop();
  destroySyphonPBOs();
  visualizer = null;

  initVisualizer(savedPreset);
  startRenderLoop();
}

function stopRenderLoop() {
  if (rafId)   { cancelAnimationFrame(rafId); rafId = null; }
  if (sleepId) { clearTimeout(sleepId);      sleepId = null; }
}

// ── Async PBO readback helpers ────────────────────────────────────────────────
// Eliminates the synchronous gl.readPixels GPU stall for Syphon output.
// Two PBOs ping-pong: GPU writes this frame's pixels to one while the CPU
// reads last frame's pixels from the other — fully parallel, zero wait.

function initSyphonPBOs(gl, w, h) {
  destroySyphonPBOs();
  syphonPBOs = [gl.createBuffer(), gl.createBuffer()];
  syphonPBOW = w;
  syphonPBOH = h;
  syphonPixelBuf = new Uint8Array(w * h * 4);
  for (const pbo of syphonPBOs) {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, w * h * 4, gl.STREAM_READ);
  }
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  syphonPBOIdx = 0;
  syphonPBOReady = false;
}

function destroySyphonPBOs() {
  if (!syphonPBOs) return;
  const gl = canvas.getContext('webgl2');
  if (gl) { for (const pbo of syphonPBOs) gl.deleteBuffer(pbo); }
  syphonPBOs = null;
  syphonPBOReady = false;
  syphonPixelBuf = null;
}

function syphonAsyncFrame(gl) {
  const w = canvas.width;
  const h = canvas.height;

  // Reinit PBOs if not created or canvas was resized
  if (!syphonPBOs || w !== syphonPBOW || h !== syphonPBOH) {
    initSyphonPBOs(gl, w, h);
  }

  const writePBO = syphonPBOs[syphonPBOIdx];
  const readPBO  = syphonPBOs[1 - syphonPBOIdx];

  // CPU reads from last frame's PBO (ready by now — GPU is done with it)
  if (syphonPBOReady) {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, readPBO);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, syphonPixelBuf);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    compositeOverlayIntoSyphonBuf(w, h);
    window.api.syphonSendFrame(syphonPixelBuf.buffer, w, h);
    // Overlay-only channel (transparent alpha) — runs independently of main channel
    if (syphonOverlayEnabled) renderAlphaOverlayFrame(w, h);
  }

  // GPU kicks off async read into the write PBO (non-blocking)
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, writePBO);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0); // offset 0 = PBO mode
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

  syphonPBOIdx   = 1 - syphonPBOIdx;
  syphonPBOReady = true;
}

function checkBrightness(gl) {
  let lum = 0, count = 0;

  if (syphonPixelBuf && syphonPBOReady) {
    // Whole-frame data already in CPU memory — sample ~256 evenly spaced pixels
    const stride = Math.max(1, Math.floor(syphonPixelBuf.length / 4 / 256));
    for (let i = 0; i < syphonPixelBuf.length - 3; i += stride * 4) {
      lum += 0.299 * syphonPixelBuf[i] + 0.587 * syphonPixelBuf[i + 1] + 0.114 * syphonPixelBuf[i + 2];
      count++;
    }
  } else {
    // Fallback: tiny 16×16 center readPixels (1 KB — negligible GPU stall)
    const w = 16, h = 16;
    const cx = Math.max(0, Math.floor(canvas.width  / 2) - 8);
    const cy = Math.max(0, Math.floor(canvas.height / 2) - 8);
    if (!brightSampleBuf) brightSampleBuf = new Uint8Array(w * h * 4);
    gl.readPixels(cx, cy, w, h, gl.RGBA, gl.UNSIGNED_BYTE, brightSampleBuf);
    for (let i = 0; i < brightSampleBuf.length - 3; i += 4) {
      lum += 0.299 * brightSampleBuf[i] + 0.587 * brightSampleBuf[i + 1] + 0.114 * brightSampleBuf[i + 2];
      count++;
    }
  }

  const brightness = count > 0 ? lum / (count * 255) : 0;

  // Too bright?
  if (brightSkipEnabled) {
    if (brightness > BRIGHT_THRESHOLD) {
      if (++brightSustained >= BRIGHT_SUSTAIN_REQ) {
        brightSustained = 0;
        window.api.sendToControl({ type: 'brightness-alert', level: brightness });
      }
    } else {
      brightSustained = 0;
    }
  }

  // Too dark while audio is loud?
  if (darkSkipEnabled) {
    const loud = vuLevels.overall > DARK_AUDIO_MIN;
    if (brightness < DARK_THRESHOLD && loud) {
      if (++darkSustained >= BRIGHT_SUSTAIN_REQ) {
        darkSustained = 0;
        window.api.sendToControl({ type: 'darkness-alert', level: brightness });
      }
    } else {
      darkSustained = 0;
    }
  }
}

function startRenderLoop() {
  if (rafId || sleepId) return;
  const gl = canvas.getContext('webgl2');

  function loop() {
    rafId = null;
    if (!visualizer) { scheduleFrame(0); return; }

    const minInterval = 1000 / targetFps;
    const now = performance.now();
    const timestamp = now; // wall-clock alias — keeps beat detection code working
    const elapsed = now - lastFrameTime;

    // If we woke up too early, sleep the remainder — use wall-clock (performance.now)
    // not rAF timestamp which drifts on 120Hz ProMotion displays
    if (elapsed < minInterval - 1) {
      scheduleFrame(minInterval - elapsed);
      return;
    }
    lastFrameTime = now;

    visualizer.render();

    // GPU load tracking — measure actual vs target FPS every 1 second
    perfFrameCount++;
    const perfNow = performance.now();
    if (perfNow - perfWindowStart >= 1000) {
      const elapsed    = perfNow - perfWindowStart;
      const frameSnap  = perfFrameCount; // snapshot before reset
      perfFrameCount   = 0;
      perfWindowStart  = perfNow;

      // Skip all perf measurements while Hydra is active — butterchurn isn't
      // rendering so FPS would read as 0 and falsely trigger perf-skip.
      if (!hydraActive) {
        const actualFps = Math.round(frameSnap / elapsed * 1000);
        // loadPct: 100% = on target, 200% = running at half speed (GPU struggling)
        const loadPct = Math.min(300, Math.round(targetFps / Math.max(1, actualFps) * 100));
        window.api.sendToControl({ type: 'perf-update', loadPct, actualFps, targetFps });

        // Log presets that drop below 25fps — once per preset per session, after warmup
        if (actualFps < LOW_FPS_LOG_THRESHOLD && perfNow >= lowFpsLogReadyAt && currentPresetName && !lowFpsLoggedPresets.has(currentPresetName)) {
          lowFpsLoggedPresets.add(currentPresetName);
          window.api.logLowFpsPreset(currentPresetName, actualFps);
        }

        if (perfSkipEnabled && loadPct > perfThreshold && perfNow > perfSkipCooldownUntil) {
          perfOverloadSec++;
          if (perfOverloadSec >= PERF_OVERLOAD_TRIGGER) {
            perfOverloadSec = 0;
            perfSkipCooldownUntil = perfNow + PERF_SKIP_COOLDOWN;
            window.api.sendToControl({ type: 'perf-skip' });
          }
        } else if (loadPct <= perfThreshold) {
          if (perfOverloadSec > 0) {
            perfOverloadSec = Math.max(0, perfOverloadSec - 1);
          }
        }
      }
    }

    // Beat detection
    if (beatSyncEnabled && detectBeat(timestamp)) {
      window.api.sendToControl({ type: 'beat-tick', bpm: detectedBpm, confidence: beatConfidence });
    } else if (beatSyncEnabled && detectedBpm > 0 && Math.round(timestamp) % 500 < 17) {
      window.api.sendToControl({ type: 'bpm-update', bpm: detectedBpm, confidence: beatConfidence });
    }

    // Syphon: async PBO readback — no GPU stall
    if (syphonEnabled && gl) syphonAsyncFrame(gl);

    // VU meter — send levels to controls ~15fps (every 4 rendered frames)
    if (++vuFrameCount % 4 === 0) tickVU();

    // Brightness auto-skip
    if (brightSkipEnabled && gl && ++brightFrameCount >= BRIGHT_CHECK_EVERY) {
      brightFrameCount = 0;
      checkBrightness(gl);
    }

    scheduleFrame(0);
  }

  // Use setTimeout sleep when targeting low FPS to avoid unnecessary CPU wakeups
  function scheduleFrame(delayHint) {
    const minInterval = 1000 / targetFps;
    const sinceLastMs = performance.now() - lastFrameTime;
    const sleepMs = Math.max(0, minInterval - sinceLastMs - 2); // 2ms rAF scheduling margin

    if (sleepMs > 6) {
      // Sleep via setTimeout, then request exactly one rAF — saves CPU wakeups at 15/30fps
      sleepId = setTimeout(() => {
        sleepId = null;
        rafId = requestAnimationFrame(loop);
      }, sleepMs);
    } else {
      rafId = requestAnimationFrame(loop);
    }
  }

  scheduleFrame(0);
}

// ── Audio setup ───────────────────────────────────────────────────────────────

async function startAudio(deviceId) {
  try {
    if (sourceNode) sourceNode.disconnect();
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    let stream;
    if (deviceId === '__system__') {
      // System audio via ScreenCaptureKit (macOS 13+)
      // getDisplayMedia is intercepted by setDisplayMediaRequestHandler in main.js
      // which auto-selects the screen and enables loopback audio — no picker shown
      stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      // Drop video track — we only need the audio
      stream.getVideoTracks().forEach(t => t.stop());
    } else {
      const constraints = {
        audio: deviceId && deviceId !== 'mic'
          ? { deviceId: { exact: deviceId } }
          : true,
        video: false,
      };
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    }
    sourceNode = audioCtx.createMediaStreamSource(stream);

    // 3-band EQ chain — created fresh each time so filter states are clean
    bassFilter = audioCtx.createBiquadFilter();
    bassFilter.type = 'lowshelf';
    bassFilter.frequency.value = 120;  // Hz — covers kick/sub/bass guitar
    bassFilter.gain.value = 0;

    midFilter = audioCtx.createBiquadFilter();
    midFilter.type = 'peaking';
    midFilter.frequency.value = 800;   // Hz — guitars, piano, brass, voice
    midFilter.Q.value = 1;
    midFilter.gain.value = 0;

    trebFilter = audioCtx.createBiquadFilter();
    trebFilter.type = 'highshelf';
    trebFilter.frequency.value = 3000; // Hz — cymbals, hi-hats, presence
    trebFilter.gain.value = 0;

    gainNode = audioCtx.createGain();
    gainNode.gain.value = audioSensitivity;

    // Signal chain: source → EQ filters → gain → butterchurn
    sourceNode.connect(bassFilter);
    bassFilter.connect(midFilter);
    midFilter.connect(trebFilter);
    trebFilter.connect(gainNode);

    // Beat detection taps the post-EQ signal (bass boost amplifies kick hits → better detection)
    beatAnalyserNode = audioCtx.createAnalyser();
    beatAnalyserNode.fftSize = 1024;
    beatAnalyserNode.smoothingTimeConstant = 0.1;
    trebFilter.connect(beatAnalyserNode); // tap after all EQ filters so VU reflects full EQ
    beatFreqData = new Uint8Array(beatAnalyserNode.frequencyBinCount);

    // Hydra taps post-gain so the sensitivity slider is honoured
    const hydraAnalyserNode = audioCtx.createAnalyser();
    hydraAnalyserNode.fftSize = 1024;
    hydraAnalyserNode.smoothingTimeConstant = 0.3;
    gainNode.connect(hydraAnalyserNode);
    setHydraAudioAnalyser(hydraAnalyserNode);

    if (!visualizer) {
      initVisualizer();
      startRenderLoop();
    } else {
      visualizer.connectAudio(gainNode);
    }

    setStatus('', 2000);
  } catch (err) {
    setStatus(`mic error: ${err.message}`);
    console.error('Audio error:', err);
  }
}

// ── Preset loading ────────────────────────────────────────────────────────────

let _lastPresetTime = 0;
const PRESET_COOLDOWN_MS = 350; // ignore calls within 350ms of the last one

function applyPreset(presetObj, name, blendTime = 2) {
  if (!visualizer) return;
  const now = performance.now();
  if (now - _lastPresetTime < PRESET_COOLDOWN_MS) return;
  _lastPresetTime = now;

  currentPresetData = JSON.parse(JSON.stringify(presetObj)); // deep copy for editing
  lowFpsLogReadyAt  = performance.now() + LOW_FPS_LOG_WARMUP_MS; // warmup before FPS logging
  // _baseFrameEqs caches original equations before param overrides — reset on new load
  try {
    visualizer.loadPreset(normalizePreset(presetObj), blendTime);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    console.error('[AV Club VJ] loadPreset failed:', msg, '\nPreset:', name);
    window.api.sendToControl({ type: 'preset-load-error', name, error: msg });
    return;
  }
  const displayName = name ? name.split('/').pop() : '';
  currentPresetName = displayName || presetObj.name || 'Custom';
  setStatus(displayName, displayName ? 3000 : 0);
  window.api.sendToControl({
    type: 'current-preset',
    name: currentPresetName,
    baseVals: currentPresetData.baseVals || {},
    frameEqs: currentPresetData.frame_eqs_str || '',
    pixelEqs: currentPresetData.pixel_eqs_str || '',
    initEqs:  currentPresetData.init_eqs_str  || '',
  });
}

function loadPresetByName(name, blendTime = 2) {
  if (!visualizer) return;
  const preset = builtinPresets[name] || customPresets[name];
  if (preset) {
    currentPresetName = name;
    applyPreset(preset, name, blendTime);
  }
}

function loadPresetData(presetObj, name, blendTime = 2) {
  if (!visualizer) return;
  applyPreset(presetObj, name, blendTime);
}

// ── Glitch / preset generator ─────────────────────────────────────────────────
// All generated equation snippets use frame_eqs_str format:
// variables use a.* prefix, math functions use Math.*, so butterchurn
// can compile them normally via new Function('a', code + ' return a;').

function generateGlitchPreset(mode) {
  const r    = (mn, mx) => mn + Math.random() * (mx - mn);
  const ri   = (mn, mx) => Math.floor(r(mn, mx + 1));
  const coin = (p = 0.5) => Math.random() < p;
  const f    = (n, d = 4) => Number(n.toFixed(d));
  const fv   = (mn, mx) => f(r(mn, mx));

  // Per-frame snippets in frame_eqs_str JS format (a.* prefix, Math.*)
  const frameSnippets = [
    () => `a.zoom = ${fv(0.85,1.35)} + ${fv(0.05,0.28)}*Math.sin(a.time*${fv(0.4,6.0)});`,
    () => `a.zoom = ${fv(0.85,1.2)} + ${fv(0.05,0.3)}*a.bass;`,
    () => `a.rot = ${fv(-0.4,0.4)}*Math.sin(a.time*${fv(0.3,4.0)});`,
    () => `a.rot = ${fv(-0.25,0.25)} + ${fv(0.02,0.15)}*a.mid;`,
    () => `a.dx = ${fv(0.008,0.06)}*Math.sin(a.time*${fv(0.4,5.0)});`,
    () => `a.dy = ${fv(0.008,0.06)}*Math.cos(a.time*${fv(0.4,5.0)});`,
    () => `a.warp = ${fv(1.0,8.0)};`,
    () => `a.warp = ${fv(0.5,5.0)} + ${fv(0.5,3.0)}*a.bass;`,
    () => `a.cx = 0.5 + ${fv(0.08,0.38)}*Math.sin(a.time*${fv(0.2,2.5)});`,
    () => `a.cy = 0.5 + ${fv(0.08,0.38)}*Math.cos(a.time*${fv(0.2,2.5)});`,
    () => `a.sx = ${fv(0.92,1.08)} + ${fv(0.01,0.08)}*a.treb;`,
    () => `a.sy = ${fv(0.92,1.08)} - ${fv(0.01,0.08)}*a.treb;`,
    () => `a.decay = ${fv(0.82,0.96)};`,
    () => `a.gammaadj = ${fv(0.6,3.0)};`,
    () => `a.echo_alpha = ${fv(0.05,0.65)};`,
    () => `a.echo_zoom = ${fv(0.7,2.5)};`,
  ];

  // Per-pixel snippets — vertex coords use a.x, a.y, a.ang, a.rad
  const pixelSnippets = [
    () => `a.zoom = a.zoom*(1.0+${fv(0.015,0.10)}*Math.sin(a.x*${fv(2.0,15.0)}+a.time*${fv(0.3,3.0)}));`,
    () => `a.zoom = a.zoom*(1.0+${fv(0.015,0.09)}*Math.cos(a.y*${fv(2.0,15.0)}+a.time*${fv(0.3,3.0)}));`,
    () => `a.zoom = a.zoom+${fv(0.005,0.04)}*a.bass*Math.sin(a.ang*${fv(2.0,8.0)});`,
    () => `a.rot = a.rot+${fv(0.002,0.02)}*Math.sin(a.rad*${fv(2.0,10.0)}+a.time);`,
    () => `a.rot = a.rot+${fv(0.002,0.015)}*a.treb*Math.cos(a.ang*${fv(2.0,8.0)});`,
    () => `a.dx = a.dx+${fv(0.001,0.012)}*Math.sin(a.y*${fv(2.0,12.0)}+a.time*${fv(0.2,2.0)});`,
    () => `a.dy = a.dy+${fv(0.001,0.012)}*Math.cos(a.x*${fv(2.0,12.0)}+a.time*${fv(0.2,2.0)});`,
    () => `a.dx = a.dx+${fv(0.002,0.014)}*a.mid*Math.cos(a.ang*${fv(2.0,8.0)});`,
    () => `a.dy = a.dy+${fv(0.002,0.014)}*a.bass*Math.sin(a.rad*${fv(2.0,8.0)});`,
  ];

  const shuffle = arr => [...arr].sort(() => Math.random() - 0.5);

  if (mode === 'randomize' && currentPresetData) {
    // Perturb baseVals ±15%, keep equations intact
    const base = currentPresetData.baseVals || {};
    const perturb = (v, mn, mx, scale = 0.15) => {
      const delta = (Math.random() * 2 - 1) * (mx - mn) * scale;
      return Math.max(mn, Math.min(mx, (v ?? (mn + mx) / 2) + delta));
    };
    return {
      ...currentPresetData,
      name: `Randomized ${Date.now()}`,
      baseVals: {
        ...base,
        zoom:          perturb(base.zoom,          0.6, 1.8),
        rot:           perturb(base.rot,           -1,  1),
        warp:          perturb(base.warp,           0,  8),
        warpscale:     perturb(base.warpscale,      0.1, 4),
        warpanimspeed: perturb(base.warpanimspeed,  0.1, 4),
        decay:         perturb(base.decay,          0.85, 1.0, 0.05),
        gammaadj:      perturb(base.gammaadj,       0.3, 3.5),
        cx:            perturb(base.cx,             0.2, 0.8),
        cy:            perturb(base.cy,             0.2, 0.8),
        dx:            perturb(base.dx,            -0.2, 0.2),
        dy:            perturb(base.dy,            -0.2, 0.2),
        echo_zoom:     perturb(base.echo_zoom,      0.5, 3.5),
        echo_alpha:    perturb(base.echo_alpha,     0,   0.8),
      },
    };
  }

  if (mode === 'glitch' && currentPresetData) {
    // Aggressive glitch — append extreme overrides to frame_eqs_str
    const extremeFrameSnippets = [
      () => `a.decay = ${fv(0.50,0.82)};`,
      () => `a.zoom = ${fv(1.5,3.0)} + ${fv(0.3,1.2)}*a.bass;`,
      () => `a.zoom = ${fv(0.3,0.7)} + ${fv(0.4,1.5)}*Math.sin(a.time*${fv(1.0,8.0)});`,
      () => `a.rot = ${fv(0.5,3.14)};`,
      () => `a.rot = ${fv(-3.14,3.14)}*Math.sin(a.time*${fv(0.5,4.0)});`,
      () => `a.warp = ${fv(8.0,20.0)};`,
      () => `a.warp = ${fv(5.0,15.0)} + ${fv(2.0,8.0)}*a.bass;`,
      () => `a.echo_alpha = ${fv(0.5,0.95)};`,
      () => `a.echo_zoom = ${fv(1.5,3.5)};`,
      () => `a.gammaadj = ${fv(2.5,5.0)};`,
      () => `a.dx = ${fv(0.05,0.25)}*Math.sin(a.time*${fv(1.0,6.0)});`,
      () => `a.dy = ${fv(0.05,0.25)}*Math.cos(a.time*${fv(1.0,6.0)});`,
      () => `a.cx = 0.5 + ${fv(0.2,0.48)}*Math.sin(a.time*${fv(0.3,3.0)});`,
      () => `a.cy = 0.5 + ${fv(0.2,0.48)}*Math.cos(a.time*${fv(0.3,3.0)});`,
      () => `a.sx = ${fv(0.5,1.8)} + ${fv(0.1,0.5)}*a.treb;`,
      () => `a.sy = ${fv(1.8,0.5)} + ${fv(0.1,0.5)}*a.mid;`,
    ];
    const extremePixelSnippets = [
      () => `a.zoom = a.zoom*(1.0+${fv(0.05,0.25)}*Math.sin(a.x*${fv(3.0,20.0)}+a.time*${fv(0.5,4.0)}));`,
      () => `a.zoom = a.zoom*(1.0+${fv(0.05,0.20)}*Math.cos(a.y*${fv(3.0,20.0)}+a.time*${fv(0.5,4.0)}));`,
      () => `a.rot = a.rot+${fv(0.02,0.12)}*Math.sin(a.rad*${fv(2.0,12.0)}+a.time);`,
      () => `a.rot = a.rot+${fv(0.05,0.25)}*a.bass*Math.cos(a.ang*${fv(2.0,10.0)});`,
      () => `a.dx = a.dx+${fv(0.01,0.06)}*Math.sin(a.y*${fv(3.0,15.0)}+a.time*${fv(0.5,3.0)});`,
      () => `a.dy = a.dy+${fv(0.01,0.06)}*Math.cos(a.x*${fv(3.0,15.0)}+a.time*${fv(0.5,3.0)});`,
      () => `a.zoom = a.zoom+${fv(0.02,0.10)}*a.treb*Math.sin(a.ang*${fv(3.0,12.0)});`,
    ];
    const addedFrame = shuffle(extremeFrameSnippets).slice(0, ri(4,8)).map(fn => fn()).join('\n');
    const addedPixel = shuffle(extremePixelSnippets).slice(0, ri(2,5)).map(fn => fn()).join('\n');
    // Append to frame_eqs_str so normalizePreset compiles the combined code
    return {
      ...currentPresetData,
      _jsFormat: true,
      name: `Glitch ${Date.now()}`,
      frame_eqs_str: '\n' + addedFrame,
      pixel_eqs_str: '\n' + addedPixel,
    };
  }

  // 'new' — use a random existing preset as structural base (guarantees all baseVals
  // fields are present), then replace all equations with generated ones.
  // Equations are in frame_eqs_str JS format so butterchurn/normalizePreset can compile them.
  const frameEqsStr = shuffle(frameSnippets).slice(0, ri(4,9)).map(fn => fn()).join('\n');
  const pixelEqsStr = shuffle(pixelSnippets).slice(0, ri(2,5)).map(fn => fn()).join('\n');

  const allKeys = Object.keys(builtinPresets);
  const randomBase = JSON.parse(JSON.stringify(
    builtinPresets[allKeys[Math.floor(Math.random() * allKeys.length)]]
  ));

  return {
    ...randomBase,
    _jsFormat: true,
    name: `Generated ${Date.now()}`,
    baseVals: {
      ...randomBase.baseVals,
      // Override key motion params with random aggressive values
      decay:         r(0.70, 0.88),
      gammaadj:      r(0.8,  2.5),
      zoom:          r(0.82, 1.18),
      rot:           coin(0.6) ? r(-0.6, 0.6) : 0.0,
      warp:          r(1.5,  7.0),
      warpscale:     r(0.4,  2.5),
      warpanimspeed: r(0.5,  3.5),
      cx:            r(0.3,  0.7),
      cy:            r(0.3,  0.7),
      dx:            coin(0.5) ? r(-0.06, 0.06) : 0.0,
      dy:            coin(0.5) ? r(-0.06, 0.06) : 0.0,
      echo_zoom:     coin(0.5) ? r(0.8,  2.5)   : 1.0,
      echo_alpha:    coin(0.5) ? r(0.1,  0.6)   : 0.0,
    },
    // Override with generated equations in frame_eqs_str JS format
    init_eqs_str:  '',
    frame_eqs_str: frameEqsStr,
    pixel_eqs_str: pixelEqsStr,
  };
}

// ── VU meter ──────────────────────────────────────────────────────────────────

// ── Glitch effects ────────────────────────────────────────────────────────────

function injectBassKick() {
  if (!audioCtx || !bassFilter) return;
  const osc      = audioCtx.createOscillator();
  const kickGain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 65;
  kickGain.gain.setValueAtTime(6.0, audioCtx.currentTime);
  kickGain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
  osc.connect(kickGain);
  kickGain.connect(bassFilter);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.12);
}

function clearCanvasStyle() {
  canvas.style.transition = '';
  canvas.style.filter     = '';
  canvas.style.transform  = '';
}

// STROBE — overdrive flash + bass kick
function triggerStrobe() {
  injectBassKick();
  canvas.style.transition = 'none';
  canvas.style.filter     = 'brightness(4) contrast(4) saturate(2)';
  canvas.style.transform  = 'scale(1.015) translate(3px, -3px)';
  setTimeout(() => {
    canvas.style.filter    = 'invert(1) hue-rotate(120deg) brightness(1.5)';
    canvas.style.transform = 'scale(0.99) translate(-2px, 2px)';
    setTimeout(clearCanvasStyle, 50);
  }, 45);
}

// SHAKE — earthquake jitter; magnitude scales with live bass level
function triggerShake() {
  // vuLevels.bass is 0–1; map to 22px (quiet) → 70px (full bass)
  const bassMag = 22 + Math.round((vuLevels.bass ?? 0) * 48);
  const total   = 12 + Math.round((vuLevels.bass ?? 0) * 6); // more hits at high bass
  let count = 0;
  function step() {
    if (count >= total) { clearCanvasStyle(); return; }
    const mag = bassMag * (1 - count / total); // taper off
    const dx  = (Math.random() - 0.5) * mag * 2;
    const dy  = (Math.random() - 0.5) * mag * 0.7; // horizontal-biased like a real hit
    canvas.style.transition = 'none';
    canvas.style.transform  = `translate(${dx}px, ${dy}px)`;
    count++;
    setTimeout(step, 26);
  }
  step();
}

// ZOOM PUNCH — scale out → overshoot back → settle
function triggerZoomPunch() {
  canvas.style.transition = 'none';
  canvas.style.transform  = 'scale(1.28)';
  setTimeout(() => {
    canvas.style.transform = 'scale(0.94)';
    setTimeout(() => {
      canvas.style.transform = 'scale(1.03)';
      setTimeout(clearCanvasStyle, 70);
    }, 65);
  }, 75);
}

// COLOR CRUSH — strip color → stark B&W → oversaturate back to color
function triggerColorCrush() {
  canvas.style.transition = 'none';
  canvas.style.filter     = 'saturate(0) contrast(9) brightness(0.8)';
  setTimeout(() => {
    canvas.style.filter = 'saturate(0) contrast(3)';
    setTimeout(() => {
      canvas.style.filter = 'saturate(4) contrast(1.4)';
      setTimeout(clearCanvasStyle, 110);
    }, 130);
  }, 160);
}

// BLUR PULSE — shockwave: instant hard blur+bright → snap back sharp
function triggerTunnel() {
  canvas.style.transition = 'none';
  canvas.style.filter     = 'blur(28px) brightness(3) saturate(2.5)';
  canvas.style.transform  = 'scale(1.04)';
  setTimeout(() => {
    canvas.style.transition = 'filter 0.18s ease-out, transform 0.18s ease-out';
    canvas.style.filter     = 'blur(0px) brightness(1) saturate(1)';
    canvas.style.transform  = '';
    setTimeout(clearCanvasStyle, 200);
  }, 70);
}

// Shared blackout overlay + state
let blackoutOverlay = null;
let blackoutActive  = false;

function ensureOverlay() {
  if (!blackoutOverlay) {
    blackoutOverlay = document.createElement('div');
    blackoutOverlay.style.cssText = 'position:fixed;inset:0;background:#000;pointer-events:none;opacity:0;z-index:999';
    document.body.appendChild(blackoutOverlay);
  }
  return blackoutOverlay;
}

// BLACK STROBE — brief black flash then snaps back to correct blackout state
function triggerBlackStrobe() {
  const ov = ensureOverlay();
  ov.style.transition = 'none';
  ov.style.opacity    = '1';
  setTimeout(() => {
    ov.style.transition = 'opacity 0.06s ease-out';
    ov.style.opacity    = blackoutActive ? '1' : '0';
  }, 50);
}

// BLACKOUT — toggle; canvas keeps rendering underneath for instant restore
function setBlackout(active) {
  blackoutActive = active;
  const ov = ensureOverlay();
  ov.style.transition = 'opacity 0.05s';
  ov.style.opacity    = active ? '1' : '0';
}

function tickVU() {
  if (!beatAnalyserNode || !beatFreqData || !audioCtx) return;

  // Always read fresh frequency data (beat detection may not be running)
  beatAnalyserNode.getByteFrequencyData(beatFreqData);

  const nyquist  = audioCtx.sampleRate / 2;
  const binCount = beatAnalyserNode.frequencyBinCount;
  const bassEnd  = Math.round(200  / nyquist * binCount);
  const midEnd   = Math.round(2000 / nyquist * binCount);

  let bassSum = 0, midSum = 0, trebSum = 0;
  // Skip bin 0 (DC component — 0 Hz — is always elevated and not audible)
  for (let i = 1;       i < bassEnd;  i++) bassSum += beatFreqData[i];
  for (let i = bassEnd; i < midEnd;   i++) midSum  += beatFreqData[i];
  for (let i = midEnd;  i < binCount; i++) trebSum += beatFreqData[i];

  const bassCount  = Math.max(1, bassEnd - 1);
  const bassRaw    = Math.min(1, bassSum  / bassCount             / 160);
  const midRaw     = Math.min(1, midSum   / (midEnd - bassEnd)   / 160);
  const trebRaw    = Math.min(1, trebSum  / (binCount - midEnd)  / 160);
  const overallRaw = Math.min(1, (bassRaw + midRaw + trebRaw) / 3);

  // Exponential smoothing — fast attack, slow release
  const smooth = (prev, raw) =>
    raw > prev ? prev + (raw - prev) * VU_ATTACK
               : prev + (raw - prev) * VU_RELEASE;

  vuLevels.bass    = smooth(vuLevels.bass,    bassRaw);
  vuLevels.mid     = smooth(vuLevels.mid,     midRaw);
  vuLevels.treb    = smooth(vuLevels.treb,    trebRaw);
  vuLevels.overall = smooth(vuLevels.overall, overallRaw);

  window.api.sendToControl({ type: 'audio-levels', ...vuLevels });
}

// ── Beat detection ────────────────────────────────────────────────────────────

function normalizeBpm(bpm) {
  // Octave-fold into the 60–200 BPM musical range
  while (bpm > 0 && bpm < 60)  bpm *= 2;
  while (bpm > 200)             bpm /= 2;
  return bpm;
}

function detectBeat(timestamp) {
  if (!beatAnalyserNode || !beatFreqData) return false;

  beatAnalyserNode.getByteFrequencyData(beatFreqData);

  // Sum bass energy: 20–200 Hz
  const nyquist = audioCtx.sampleRate / 2;
  const bassEnd = Math.max(1, Math.round(200 / nyquist * beatAnalyserNode.frequencyBinCount));
  let energy = 0;
  for (let i = 1; i <= bassEnd; i++) energy += beatFreqData[i];
  energy /= bassEnd;

  // Dual-EMA update — slow tracks background level, fast tracks transients
  beatSlowAvg = beatSlowAvg * (1 - BEAT_SLOW_COEF) + energy * BEAT_SLOW_COEF;
  beatFastAvg = beatFastAvg * (1 - BEAT_FAST_COEF) + energy * BEAT_FAST_COEF;

  // Refractory period — minimum 280ms between beats (caps at ~214 BPM)
  if (timestamp < beatRefractoryUntil) return false;

  // Beat = fast transient significantly exceeds the slow background, above noise floor
  if (beatSlowAvg > 5 && beatFastAvg > BEAT_THRESHOLD * beatSlowAvg) {
    beatRefractoryUntil = timestamp + 280;

    // Track timestamps for BPM calculation
    beatTimestamps.push(timestamp);
    if (beatTimestamps.length > 24) beatTimestamps.shift();

    if (beatTimestamps.length >= 4) {
      const intervals = [];
      for (let i = 1; i < beatTimestamps.length; i++) {
        intervals.push(beatTimestamps[i] - beatTimestamps[i - 1]);
      }
      // Reject outliers > 40% from median
      const sorted = [...intervals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const clean = intervals.filter(iv => Math.abs(iv - median) < median * 0.4);

      if (clean.length >= 3) {
        const avg = clean.reduce((a, b) => a + b) / clean.length;
        // Octave-fold into musical BPM range before committing
        const normalizedBpm = normalizeBpm(60000 / avg);

        // Confidence = 1 − coefficient_of_variation (0=perfect, 1=chaotic)
        const variance = clean.reduce((s, iv) => s + (iv - avg) ** 2, 0) / clean.length;
        const cv = Math.sqrt(variance) / avg;
        const conf = Math.max(0, Math.min(1, 1 - cv * 3));

        // Only commit BPM when confidence is reasonable
        if (conf > 0.25) {
          detectedBpm  = Math.round(normalizedBpm);
          beatConfidence = conf;
        }
      }
    }

    return true;
  }
  return false;
}

// ── Status overlay ────────────────────────────────────────────────────────────

let statusTimer = null;
function setStatus(text, hideAfterMs = 0) {
  statusEl.textContent = text;
  statusEl.classList.remove('hidden');
  clearTimeout(statusTimer);
  if (hideAfterMs > 0) {
    statusTimer = setTimeout(() => statusEl.classList.add('hidden'), hideAfterMs);
  }
}

// ── Venue Overlay ─────────────────────────────────────────────────────────────

const overlayCanvas  = document.getElementById('overlay-canvas');
const overlayCtx     = overlayCanvas?.getContext('2d');
const domMarqueeBar  = document.getElementById('dom-marquee-bar');
const domMarqueeText = document.getElementById('dom-marquee-text');

// Parse '#rrggbb' → [r, g, b] for rgba() construction
function parseHexColor(hex) {
  const m = (hex || '#000').match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? [parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)] : [0,0,0];
}

// Resize overlay canvas to match window pixel dimensions
function resizeOverlay() {
  if (!overlayCanvas) return;
  const w = window.innerWidth  || screen.width  || 1280;
  const h = window.innerHeight || screen.height || 720;
  overlayCanvas.width  = w;
  overlayCanvas.height = h;
}

// After a resize, bounce logos must reinitialize to new canvas bounds.
// Called from event listeners only — not the initial resizeOverlay() call,
// which runs before logoOverlays is declared and would throw a ReferenceError.
function resetBouncesOnResize() {
  for (const o of Object.values(logoOverlays)) {
    if (logoBounce(o.cfg)) { o.state.bx = null; o.state.edgeDwell = 0; }
  }
}

window.addEventListener('resize', () => { resizeOverlay(); resetBouncesOnResize(); });
window.addEventListener('load',   () => { resizeOverlay(); resetBouncesOnResize(); });
resizeOverlay(); // initial call — logoOverlays not yet declared, so no bounce reset here

// ── Marquee state ─────────────────────────────────────────────────────────────
let marqueeConfig = { speed: 3, fontSize: 52, color: '#ffffff', bgColor: '#000000', bgAlpha: 0.65, position: 'bottom' };
let marqueeQueue          = [];   // pending messages
let audienceQueue         = [];   // priority audience submissions (play once, not looped)
let marqueeCurrent        = null; // message currently scrolling
let marqueeX              = 0;    // current left edge of text
let marqueeTextW          = 0;    // measured width of current text
let marqueeLoop           = true;
let marqueeRunning        = false;
let marqueeIntervalMins   = 0;    // 0 = no repeat scheduling
let marqueeOrigMessages   = [];   // original message list for re-scheduling
let marqueeRepeatTimeout  = null; // setTimeout handle for repeat
let _marqueeLastT         = 0;   // for time-based scroll delta
let marqueeOffscreen      = null; // pre-rendered text image (OffscreenCanvas)
// Fade state
let marqueeFadeAlpha      = 0;    // current alpha (0–1)
let marqueeFadeIn         = false;
let marqueeFadeOut        = false;
let marqueeFadeStart      = 0;
const MARQUEE_FADE_MS     = 400;  // fade duration in ms

function marqueeFadeToStop() {
  // Trigger fade-out; caller is responsible for cleaning up after delay
  marqueeFadeOut = true;
  marqueeFadeIn  = false;
  marqueeFadeStart = performance.now();
  // DOM mode: fade bar out via CSS transition
  if (!syphonEnabled && domMarqueeBar) {
    domMarqueeBar.style.transition = `opacity ${MARQUEE_FADE_MS}ms ease`;
    domMarqueeBar.style.opacity = '0';
  }
}

// Start CSS-animated DOM marquee for the current message (used when Syphon is off)
function startDOMMarquee() {
  if (!domMarqueeBar || !domMarqueeText || !marqueeCurrent) return;

  const fs   = marqueeConfig.fontSize;
  const barH = fs + 32;
  const w    = window.innerWidth;

  // Bar position
  domMarqueeBar.style.height = barH + 'px';
  switch (marqueeConfig.position) {
    case 'top':
      domMarqueeBar.style.top = '0'; domMarqueeBar.style.bottom = '';
      break;
    case 'center':
      domMarqueeBar.style.top = `calc(50% - ${barH / 2}px)`; domMarqueeBar.style.bottom = '';
      break;
    default:
      domMarqueeBar.style.bottom = '0'; domMarqueeBar.style.top = '';
      break;
  }

  // Colors
  const [r, g, b] = parseHexColor(marqueeConfig.bgColor);
  domMarqueeBar.style.background = `rgba(${r},${g},${b},${marqueeConfig.bgAlpha})`;

  // Text style
  domMarqueeText.style.font  = `bold ${fs}px "SF Pro Display","Helvetica Neue",Arial,sans-serif`;
  domMarqueeText.style.color = marqueeConfig.color;
  domMarqueeText.textContent = marqueeCurrent;

  // Calculate animation duration from speed (px/frame at 60fps → px/sec)
  const totalDist = w + marqueeTextW + 40;
  const pxPerSec  = Math.max(1, marqueeConfig.speed) * 60;
  const durMs     = Math.max(500, Math.round(totalDist / pxPerSec * 1000));

  // Set CSS custom properties for start/end X positions
  domMarqueeText.style.setProperty('--mq-start', `${w + 20}px`);
  domMarqueeText.style.setProperty('--mq-end',   `-${Math.ceil(marqueeTextW) + 20}px`);

  // Show bar with fade-in
  domMarqueeBar.style.display    = 'flex';
  domMarqueeBar.style.transition = 'none';
  domMarqueeBar.style.opacity    = '0';
  domMarqueeBar.offsetWidth;     // force reflow so transition fires
  domMarqueeBar.style.transition = `opacity ${MARQUEE_FADE_MS}ms ease`;
  domMarqueeBar.style.opacity    = '1';

  // Reset animation then start it
  domMarqueeText.style.animation = 'none';
  domMarqueeText.offsetWidth;    // force reflow
  domMarqueeText.style.animation = `dom-marquee-scroll ${durMs}ms linear forwards`;
}

// animationend → advance to next message (DOM mode only)
domMarqueeText?.addEventListener('animationend', () => {
  if (!marqueeRunning || syphonEnabled) return;

  if (marqueeQueue.length > 0) {
    if (marqueeLoop) {
      // Continuous: instant swap, no fade
      marqueeNext();
    } else {
      // Fade out, then next
      marqueeFadeOut = true;
      domMarqueeBar.style.transition = `opacity ${MARQUEE_FADE_MS}ms ease`;
      domMarqueeBar.style.opacity = '0';
      setTimeout(() => { marqueeFadeOut = false; marqueeNext(); }, MARQUEE_FADE_MS + 16);
    }
  } else {
    // Last message — fade out and stop (marqueeNext handles scheduling)
    domMarqueeBar.style.transition = `opacity ${MARQUEE_FADE_MS}ms ease`;
    domMarqueeBar.style.opacity = '0';
    setTimeout(() => {
      if (!marqueeRunning) domMarqueeBar.style.display = 'none';
    }, MARQUEE_FADE_MS + 50);
    marqueeNext(); // handles stop + optional repeat scheduling
  }
});

function marqueeNext() {
  // Audience messages are priority — play once (not looped back in)
  if (audienceQueue.length > 0) {
    marqueeCurrent = audienceQueue.shift();
  } else if (marqueeQueue.length === 0) {
    marqueeRunning = false;
    marqueeCurrent = null;
    marqueeFadeIn  = false;
    marqueeFadeOut = false;
    marqueeOffscreen = null;
    if (!syphonEnabled && domMarqueeBar) domMarqueeBar.style.display = 'none';
    // Schedule repeat if requested
    if (marqueeIntervalMins > 0 && marqueeOrigMessages.length > 0) {
      if (marqueeRepeatTimeout) clearTimeout(marqueeRepeatTimeout);
      marqueeRepeatTimeout = setTimeout(() => {
        marqueeQueue = [...marqueeOrigMessages];
        marqueeNext();
      }, marqueeIntervalMins * 60000);
    }
    return;
  } else {
    marqueeCurrent = marqueeQueue.shift();
    if (marqueeLoop) marqueeQueue.push(marqueeCurrent);
  }
  if (!overlayCtx) return;
  // Ensure canvas has real dimensions before measuring text
  if (!overlayCanvas.width || !overlayCanvas.height) resizeOverlay();
  const fs = marqueeConfig.fontSize;
  const font = `bold ${fs}px "SF Pro Display","Helvetica Neue",Arial,sans-serif`;
  overlayCtx.font = font;
  marqueeTextW = overlayCtx.measureText(marqueeCurrent).width;
  marqueeRunning  = true;
  marqueeFadeIn   = true;
  marqueeFadeOut  = false;
  marqueeFadeAlpha = 0;
  marqueeFadeStart = performance.now();
  _marqueeLastT   = 0;

  if (syphonEnabled) {
    // Canvas mode — pre-render to GPU-cached ImageBitmap, blitted by compositor each frame
    marqueeX = overlayCanvas.width + 20;
    const padX = 8, padY = 8;
    const oc = new OffscreenCanvas(Math.ceil(marqueeTextW) + padX * 2, fs + padY * 2);
    const octx = oc.getContext('2d');
    octx.font = font;
    octx.fillStyle = marqueeConfig.color;
    octx.textBaseline = 'middle';
    octx.fillText(marqueeCurrent, padX, oc.height / 2);
    const bitmap = oc.transferToImageBitmap();
    marqueeOffscreen = { bitmap, padX, padY, fs };
  } else {
    // DOM mode — CSS animation handles rendering; zero JS per frame
    marqueeOffscreen = null;
    marqueeX = overlayCanvas.width + 20; // keep in sync for canvas-free scroll tracking
    startDOMMarquee();
  }
}

// ── Logo overlay state ────────────────────────────────────────────────────────
const logoOverlays = {}; // id → { img, cfg, state }
let logosEnabled = true;

// Global sequence state
let logoGlobalIntervalMins = 5;
let logoGlobalDurationSecs = 10;
let logoSeqTimer  = null;
let logoSeqIdx    = 0;

function logoVisibility(cfg) {
  // Migrate legacy 'mode' field: 'bounce' → always-on+bounce, else use visibility
  if (cfg.visibility) return cfg.visibility;
  return (cfg.mode === 'sequence') ? 'sequence' : 'always-on';
}

function logoBounce(cfg) {
  if (typeof cfg.bounce === 'boolean') return cfg.bounce;
  return cfg.mode === 'bounce';
}

function logoSeqOrder() {
  // Only sequence-visibility logos participate in the timed cycle
  return Object.values(logoOverlays).filter(o => logoVisibility(o.cfg) === 'sequence').map(o => o.cfg.id);
}

function logoSeqNext(idx) {
  const ids = logoSeqOrder();
  if (ids.length === 0) return;
  const id = ids[idx % ids.length];
  logoSeqIdx = (idx + 1) % ids.length;
  showLogoNow(id, logoGlobalDurationSecs);
  // Schedule next logo after current finishes + interval
  if (logoSeqTimer) clearTimeout(logoSeqTimer);
  logoSeqTimer = setTimeout(
    () => logoSeqNext(logoSeqIdx),
    (logoGlobalDurationSecs + logoGlobalIntervalMins * 60) * 1000
  );
}

function logoSeqStart() {
  if (logoSeqTimer) { clearTimeout(logoSeqTimer); logoSeqTimer = null; }
  const ids = logoSeqOrder();
  if (ids.length === 0) return;
  logoSeqIdx = 0;
  // First show after initial interval
  logoSeqTimer = setTimeout(() => logoSeqNext(0), logoGlobalIntervalMins * 60000);
}

function addLogo(cfg) {
  const img = new Image();
  img.src = cfg.dataUrl;
  logoOverlays[cfg.id] = {
    img,
    cfg,
    state: { showing: false, fadingIn: false, fadingOut: false, fadeStart: 0, showUntil: 0,
             bx: null, by: null, bvx: 0, bvy: 0, edgeDwell: 0 }
  };
  // Restart sequence to include the new logo (if it's a sequence-visibility logo)
  if (logoVisibility(cfg) === 'sequence') logoSeqStart();
}

function showLogoNow(id, durationSecs) {
  const o = logoOverlays[id];
  if (!o) return;
  const now = Date.now();
  const dur = (durationSecs ?? logoGlobalDurationSecs) * 1000;
  o.state.showing   = true;
  o.state.fadingIn  = true;
  o.state.fadingOut = false;
  o.state.fadeStart = now;
  o.state.showUntil = now + dur;
}

function triggerLogo(id) {
  showLogoNow(id, logoGlobalDurationSecs);
}

// ── Bounce physics ─────────────────────────────────────────────────────────────
// Updates state.bx/by/bvx/bvy each frame. Includes an edge-dwell so the logo
// visibly pauses at each wall (like a real DVD screensaver) before bouncing back.
function tickBounce(state, imgW, imgH, w, h, speed) {
  if (imgW >= w || imgH >= h) return; // image larger than canvas — skip

  // First-time init (or after canvas resize reset)
  if (state.bx === null) {
    state.bx = (w - imgW) / 2;
    state.by = (h - imgH) / 2;
    const angle = Math.random() * Math.PI * 2;
    state.bvx = Math.cos(angle) * speed;
    state.bvy = Math.sin(angle) * speed;
    // Ensure motion on both axes
    if (Math.abs(state.bvx) < 0.3) state.bvx = 0.3 * Math.sign(state.bvx || 1);
    if (Math.abs(state.bvy) < 0.3) state.bvy = 0.3 * Math.sign(state.bvy || 1);
    state.edgeDwell = 0;
    return;
  }

  // Re-scale to match current speed slider value
  const curSpeed = Math.hypot(state.bvx, state.bvy);
  if (curSpeed > 0 && Math.abs(curSpeed - speed) > 0.05) {
    state.bvx *= speed / curSpeed;
    state.bvy *= speed / curSpeed;
  }

  state.bx += state.bvx;
  state.by += state.bvy;

  let hit = false;
  // Right edge: image right side = bx + imgW must not exceed w
  if (state.bx + imgW >= w) { state.bx = w - imgW; state.bvx = -Math.abs(state.bvx); hit = true; }
  // Left edge
  if (state.bx <= 0)        { state.bx = 0;         state.bvx =  Math.abs(state.bvx); hit = true; }
  // Bottom edge: image bottom = by + imgH must not exceed h
  if (state.by + imgH >= h) { state.by = h - imgH;  state.bvy = -Math.abs(state.bvy); hit = true; }
  // Top edge
  if (state.by <= 0)        { state.by = 0;          state.bvy =  Math.abs(state.bvy); hit = true; }

  if (hit) state.edgeDwell = 0;
}

// ── Trivia overlay ────────────────────────────────────────────────────────────
const triviaOverlayEl    = document.getElementById('trivia-overlay');
const triviaQuestionEl   = document.getElementById('trivia-question');
const triviaCategoryEl   = document.getElementById('trivia-category-label');
const triviaTimerEl      = document.getElementById('trivia-timer');
const triviaOptEls       = [...document.querySelectorAll('.trivia-opt')];
const triviaScorePanel   = document.getElementById('trivia-scoreboard-panel');
const triviaScoreRows    = document.getElementById('trivia-scoreboard-rows');
const triviaQrRow        = document.getElementById('trivia-qr-row');
const triviaQrImg        = document.getElementById('trivia-qr-img');
let triviaQrFadeTimer    = null;

function triviaQrFadeIn() {
  if (!triviaQrRow) return;
  if (triviaQrFadeTimer) { clearTimeout(triviaQrFadeTimer); triviaQrFadeTimer = null; }
  triviaQrRow.style.display = 'flex';
  triviaQrRow.offsetHeight; // force reflow
  triviaQrRow.style.opacity = '1';
}

function triviaQrFadeOut() {
  if (!triviaQrRow) return;
  triviaQrRow.style.opacity = '0';
  if (triviaQrFadeTimer) clearTimeout(triviaQrFadeTimer);
  triviaQrFadeTimer = setTimeout(() => { triviaQrFadeTimer = null; triviaQrRow.style.display = 'none'; }, 500);
}

let triviaCountdown      = null;
let triviaScoreTimer     = null;
let triviaCorrectIdx     = -1;

function triviaShow(msg) {
  if (!triviaOverlayEl) return;
  triviaHideScoreboard();
  // Populate question and options
  if (triviaQuestionEl)  triviaQuestionEl.textContent  = msg.question || '';
  if (triviaCategoryEl)  triviaCategoryEl.textContent  = msg.category || '';
  triviaCorrectIdx = msg.correctIndex ?? -1;
  const letters = ['A','B','C','D'];
  triviaOptEls.forEach((el, i) => {
    el.querySelector('.trivia-opt-letter').textContent = letters[i];
    el.querySelector('.trivia-opt-text').textContent   = msg.options?.[i] || '';
    el.className = 'trivia-opt';
  });
  // Countdown timer
  let remaining = msg.timeLimit || 30;
  if (triviaTimerEl) { triviaTimerEl.textContent = remaining; triviaTimerEl.className = ''; }
  if (triviaCountdown) clearInterval(triviaCountdown);
  triviaCountdown = setInterval(() => {
    remaining--;
    if (triviaTimerEl) {
      triviaTimerEl.textContent = Math.max(0, remaining);
      triviaTimerEl.className   = remaining <= 5 ? 'danger' : remaining <= 10 ? 'warn' : '';
    }
    if (remaining <= 0) { clearInterval(triviaCountdown); triviaCountdown = null; }
  }, 1000);
  // If QR data is bundled with the question, pre-load it so both fade in together
  if (msg.qrDataUrl && triviaQrRow && triviaQrImg) {
    triviaQrImg.src = msg.qrDataUrl;
    triviaQrRow.style.display = 'flex';
    triviaQrRow.style.opacity = '0'; // will be faded in below after overlay starts fading
  } else if (triviaQrRow) {
    triviaQrRow.style.display = 'none';
    triviaQrRow.style.opacity = '0';
  }
  // Fade in overlay — question and QR placeholder start together
  triviaOverlayEl.style.display = 'flex';
  triviaOverlayEl.offsetHeight;
  triviaOverlayEl.style.opacity = '1';
  triviaOverlayVisible = true; // overlay channel flag
  // Now fade in the QR row on the same frame
  if (msg.qrDataUrl && triviaQrRow) {
    triviaQrRow.offsetHeight;
    triviaQrRow.style.opacity = '1';
  }
}

function triviaReveal(correctIndex) {
  if (triviaCountdown) { clearInterval(triviaCountdown); triviaCountdown = null; }
  qrDomStop(); // hide regular QR if showing
  triviaQrFadeOut();
  const idx = correctIndex ?? triviaCorrectIdx;
  triviaOptEls.forEach((el, i) => {
    el.classList.add(i === idx ? 'correct' : 'wrong');
  });
  if (triviaTimerEl) { triviaTimerEl.textContent = '✓'; triviaTimerEl.className = ''; }
}

function triviaShowScoreboard(scores) {
  if (!triviaScorePanel || !triviaScoreRows || !scores?.length) return;
  triviaScoreRows.innerHTML = scores.slice(0, 8).map((s, i) => `
    <div class="trivia-score-row">
      <span class="trivia-score-rank">${i + 1}</span>
      <span class="trivia-score-name">${s.team}</span>
      <span class="trivia-score-pts">${s.score} pt${s.score !== 1 ? 's' : ''}</span>
    </div>
  `).join('');
  triviaScorePanel.style.display = 'flex';
  triviaScorePanel.offsetHeight;
  triviaScorePanel.style.opacity = '1';
  triviaScoreboardVisible = true; // overlay channel flag
  // Auto-hide after 8 seconds
  if (triviaScoreTimer) clearTimeout(triviaScoreTimer);
  triviaScoreTimer = setTimeout(triviaHideScoreboard, 8000);
}

function triviaHideScoreboard() {
  triviaScoreboardVisible = false; // overlay channel flag
  if (!triviaScorePanel) return;
  triviaScorePanel.style.opacity = '0';
  if (triviaScoreTimer) { clearTimeout(triviaScoreTimer); triviaScoreTimer = null; }
  setTimeout(() => { triviaScorePanel.style.display = 'none'; }, 500);
}

function triviaHide() {
  triviaOverlayVisible = false; // overlay channel flag
  if (triviaCountdown) { clearInterval(triviaCountdown); triviaCountdown = null; }
  qrDomStop(); // hide regular QR if trivia is dismissed early
  triviaQrFadeOut();
  triviaHideScoreboard();
  if (!triviaOverlayEl) return;
  triviaOverlayEl.style.opacity = '0';
  setTimeout(() => { triviaOverlayEl.style.display = 'none'; }, 500);
}

// ── QR overlay (DOM-based — avoids CSP restrictions on canvas image loading) ──
let qrOverlayEnabled    = false;  // master toggle
let qrOverlayShowing    = false;  // currently visible on screen
let qrOverlayShowSec    = 15;     // seconds to show
let qrOverlayIntervalMin = 5;     // minutes between shows
let qrOverlayShowTimer  = null;
let qrOverlayHideTimer  = null;

const qrDomEl    = document.getElementById('qr-overlay-dom');
const qrDomImg   = document.getElementById('qr-overlay-img');
const qrDomLabel = document.getElementById('qr-overlay-label');

function qrNotifyControls(showing) {
  window.api?.sendToControl({ type: 'qr-overlay-status', showing, enabled: qrOverlayEnabled });
}

const QR_FADE_MS = 800;
let qrFadeTimer     = null;  // post-fade-out: schedules display:none + next show
let qrHideAfterStop = null;  // post-stop: schedules display:none after user cancels

function qrClearAllTimers() {
  if (qrFadeTimer)        { clearTimeout(qrFadeTimer);        qrFadeTimer     = null; }
  if (qrHideAfterStop)    { clearTimeout(qrHideAfterStop);    qrHideAfterStop = null; }
  if (qrOverlayShowTimer) { clearTimeout(qrOverlayShowTimer); qrOverlayShowTimer = null; }
  if (qrOverlayHideTimer) { clearTimeout(qrOverlayHideTimer); qrOverlayHideTimer = null; }
}

function qrDomShow() {
  if (!qrDomEl || !qrOverlayEnabled) return;
  // Cancel any pending hide-after-stop so it doesn't undo the new show
  if (qrHideAfterStop) { clearTimeout(qrHideAfterStop); qrHideAfterStop = null; }
  if (qrFadeTimer)     { clearTimeout(qrFadeTimer);     qrFadeTimer     = null; }
  qrDomEl.style.display = 'flex';
  // Force reflow so the CSS transition fires from opacity 0
  qrDomEl.offsetHeight; // eslint-disable-line no-unused-expressions
  qrDomEl.style.opacity = '1';
  qrOverlayShowing = true;
  qrNotifyControls(true);
  if (qrOverlayHideTimer) clearTimeout(qrOverlayHideTimer);
  qrOverlayHideTimer = setTimeout(qrDomHide, qrOverlayShowSec * 1000);
}

function qrDomHide() {
  if (!qrDomEl) return;
  qrDomEl.style.opacity = '0';
  qrOverlayShowing = false;
  qrNotifyControls(false);
  // After fade-out completes: hide element and schedule next show
  if (qrFadeTimer) clearTimeout(qrFadeTimer);
  qrFadeTimer = setTimeout(() => {
    qrFadeTimer = null;
    if (qrDomEl) qrDomEl.style.display = 'none';
    if (!qrOverlayEnabled) return;
    if (qrOverlayShowTimer) clearTimeout(qrOverlayShowTimer);
    qrOverlayShowTimer = setTimeout(qrDomShow, qrOverlayIntervalMin * 60 * 1000);
  }, QR_FADE_MS + 50);
}

function qrDomStop() {
  qrOverlayEnabled = false;
  qrOverlayShowing = false;
  qrClearAllTimers();
  if (qrDomEl) qrDomEl.style.opacity = '0';
  // Hide element after the fade-out transition completes
  qrHideAfterStop = setTimeout(() => {
    qrHideAfterStop = null;
    if (qrDomEl) qrDomEl.style.display = 'none';
  }, QR_FADE_MS + 50);
  qrNotifyControls(false);
}

const QR_POSITION_ALIGN = {
  'center':       { alignItems: 'center',     justifyContent: 'center'    },
  'top-left':     { alignItems: 'flex-start', justifyContent: 'flex-start' },
  'top-right':    { alignItems: 'flex-start', justifyContent: 'flex-end'  },
  'bottom-left':  { alignItems: 'flex-end',   justifyContent: 'flex-start' },
  'bottom-right': { alignItems: 'flex-end',   justifyContent: 'flex-end'  },
};
let qrCurrentPosition = 'center';
let qrCustomX     = null; // null = use position preset
let qrCustomY     = null;
let qrCustomScale = 1.0;

function applyQrPosition() {
  if (!qrDomEl) return;
  const pos = QR_POSITION_ALIGN[qrCurrentPosition] || QR_POSITION_ALIGN['center'];
  qrDomEl.style.alignItems     = pos.alignItems;
  qrDomEl.style.justifyContent = pos.justifyContent;

  const GAP = 32; // base inset from screen edge in px
  // Marquee bar height — add clearance if QR and marquee share the same edge
  const barH = marqueeConfig.fontSize + 32;
  const atBottom = qrCurrentPosition.startsWith('bottom');
  const atTop    = qrCurrentPosition.startsWith('top');

  const padTop    = (atTop    && marqueeConfig.position === 'top')    ? barH + GAP : (qrCurrentPosition === 'center' ? 0 : GAP);
  const padBottom = (atBottom && marqueeConfig.position === 'bottom') ? barH + GAP : (qrCurrentPosition === 'center' ? 0 : GAP);
  const padSide   = qrCurrentPosition === 'center' ? 0 : GAP;

  qrDomEl.style.padding = `${padTop}px ${padSide}px ${padBottom}px ${padSide}px`;

  if (qrCustomX !== null && qrCustomY !== null) {
    // Custom absolute positioning: override flex alignment
    qrDomEl.style.alignItems     = 'flex-start';
    qrDomEl.style.justifyContent = 'flex-start';
    const panel = qrDomEl.querySelector('.qr-panel');
    if (panel) {
      panel.style.position        = 'absolute';
      panel.style.left            = qrCustomX + '%';
      panel.style.top             = qrCustomY + '%';
      panel.style.transform       = `translate(-50%, -50%) scale(${qrCustomScale})`;
      panel.style.transformOrigin = 'center center';
    }
  } else {
    // Reset any absolute positioning
    const panel = qrDomEl.querySelector?.('.qr-panel');
    if (panel) { panel.style.position = ''; panel.style.left = ''; panel.style.top = ''; panel.style.transform = ''; }
  }
}

function qrDomStart(dataUrl, label, showSec, intervalMin, position, x, y, scale) {
  qrDomStop(); // clear any existing timers
  if (dataUrl && qrDomImg) qrDomImg.src = dataUrl;
  if (label && qrDomLabel) qrDomLabel.textContent = label;
  if (showSec)     qrOverlayShowSec     = showSec;
  if (intervalMin) qrOverlayIntervalMin = intervalMin;
  qrCurrentPosition = position || 'center';
  qrCustomX     = (x != null) ? x : null;
  qrCustomY     = (y != null) ? y : null;
  qrCustomScale = scale ?? 1.0;
  applyQrPosition();
  qrOverlayEnabled = true;
  qrDomShow(); // show immediately, then cycle
}

// ── Overlay render (called every animation frame) ─────────────────────────────
let overlayHasContent = false; // used by Syphon compositor
let _prevHadLogos     = false; // tracks whether logos were drawn last frame (for full-clear on disable)
// Dirty band for partial Syphon composite: {y, h} in screen coords, or null = full frame needed
let overlayDirtyBand  = null;

function renderOverlay() {
  if (!overlayCtx) return;
  const w = overlayCanvas.width;
  const h = overlayCanvas.height;

  // Canvas marquee is only active when Syphon needs pixel data; DOM handles display otherwise
  const canvasMarqueeActive = syphonEnabled && (marqueeRunning || marqueeFadeOut);

  // Fast path: nothing to draw — just ensure canvas is clear and bail
  const anythingActive = canvasMarqueeActive ||
    (logosEnabled && Object.values(logoOverlays).some(({ img }) => img.complete && img.naturalWidth));
  if (!anythingActive) {
    if (overlayHasContent) {
      overlayCtx.clearRect(0, 0, w, h);
      overlayHasContent = false;
    }
    return;
  }

  // Only clear what's needed — if no logos, just clear the marquee bar region.
  // If logos were drawn last frame but not this frame, do a full clear to wipe stale pixels.
  const hasLogos = logosEnabled && Object.values(logoOverlays).some(({ img }) => img.complete && img.naturalWidth);
  if (hasLogos || !canvasMarqueeActive || _prevHadLogos) {
    overlayCtx.clearRect(0, 0, w, h);
  } else {
    // Marquee only — clear just the bar strip
    const fs = marqueeConfig.fontSize;
    const barH = fs + 32;
    let barY;
    switch (marqueeConfig.position) {
      case 'top': barY = 0; break;
      case 'center': barY = (h - barH) / 2; break;
      default: barY = h - barH;
    }
    overlayCtx.clearRect(0, barY, w, barH);
  }

  const now = Date.now();
  let hasContent = false;

  // ── Draw logos ──────────────────────────────────────────────────────────────
  if (logosEnabled) for (const { img, cfg, state } of Object.values(logoOverlays)) {
    if (!img.complete || !img.naturalWidth) continue;
    if (!w || !h) continue;

    const imgW = Math.round(w * cfg.sizePct / 100);
    const imgH = Math.round(imgW * (img.naturalHeight / img.naturalWidth));

    const vis     = logoVisibility(cfg);
    const isBounce = logoBounce(cfg);

    // ── Determine alpha (visibility/fade state) ───────────────────────────────
    let drawAlpha;
    if (vis === 'always-on') {
      drawAlpha = cfg.opacity;
    } else {
      // Sequence: advance state machine
      if (state.showing && now > state.showUntil) {
        state.showing = false; state.fadingOut = true; state.fadeStart = now;
      }
      if (state.fadingIn  && now > state.fadeStart + 500) state.fadingIn  = false;
      if (state.fadingOut && now > state.fadeStart + 500)  state.fadingOut = false;

      if (!state.showing && !state.fadingIn && !state.fadingOut) {
        // Not visible — still advance bounce physics so it keeps moving while hidden
        if (isBounce) tickBounce(state, imgW, imgH, w, h, cfg.bounceSpeed ?? 1.5);
        continue;
      }

      drawAlpha = cfg.opacity;
      if (state.fadingIn)  drawAlpha *= Math.min(1, (now - state.fadeStart) / 500);
      if (state.fadingOut) drawAlpha *= 1 - Math.min(1, (now - state.fadeStart) / 500);
      if (drawAlpha <= 0) continue;
    }

    // ── Determine position ────────────────────────────────────────────────────
    let drawX, drawY;
    if (isBounce) {
      tickBounce(state, imgW, imgH, w, h, cfg.bounceSpeed ?? 1.5);
      drawX = Math.round(state.bx);
      drawY = Math.round(state.by);
    } else {
      drawX = Math.round((w * (cfg.xPct ?? 90) / 100) - imgW / 2);
      drawY = Math.round((h * (cfg.yPct ?? 90) / 100) - imgH / 2);
    }

    overlayCtx.save();
    overlayCtx.globalAlpha = drawAlpha;
    overlayCtx.drawImage(img, drawX, drawY, imgW, imgH);
    overlayCtx.restore();
    hasContent = true;
  }

  // ── Draw marquee (canvas path — only when Syphon needs pixel data) ──────────
  if (canvasMarqueeActive && marqueeRunning && marqueeCurrent) {
    const nowMs = performance.now();

    // Update fade state
    if (marqueeFadeIn) {
      marqueeFadeAlpha = Math.min(1, (nowMs - marqueeFadeStart) / MARQUEE_FADE_MS);
      if (marqueeFadeAlpha >= 1) { marqueeFadeIn = false; marqueeFadeAlpha = 1; }
    } else if (marqueeFadeOut) {
      marqueeFadeAlpha = Math.max(0, 1 - (nowMs - marqueeFadeStart) / MARQUEE_FADE_MS);
    } else {
      marqueeFadeAlpha = 1;
    }

    const fadeA = marqueeFadeAlpha;
    const fs   = marqueeConfig.fontSize;
    const barH = fs + 32;
    let   barY;
    switch (marqueeConfig.position) {
      case 'top':    barY = 0;               break;
      case 'center': barY = (h - barH) / 2; break;
      default:       barY = h - barH;        break;
    }

    // Strip
    overlayCtx.save();
    overlayCtx.fillStyle   = marqueeConfig.bgColor;
    overlayCtx.globalAlpha = marqueeConfig.bgAlpha * fadeA;
    overlayCtx.fillRect(0, barY, w, barH);
    overlayCtx.restore();

    // Text — blit GPU-cached ImageBitmap (compositor handles this, near-zero CPU)
    if (marqueeOffscreen) {
      const { bitmap, padX } = marqueeOffscreen;
      const drawY = barY + (barH - bitmap.height) / 2;
      overlayCtx.save();
      overlayCtx.globalAlpha = fadeA;
      overlayCtx.drawImage(bitmap, marqueeX - padX, drawY);
      overlayCtx.restore();
    }

    // Advance (only when fully visible — don't scroll during fade-in)
    // Time-based so speed is frame-rate independent (speed = px/frame at 60fps)
    if (!marqueeFadeIn) {
      const dt = _marqueeLastT > 0 ? Math.min(nowMs - _marqueeLastT, 50) : 16.7;
      _marqueeLastT = nowMs;
      marqueeX -= marqueeConfig.speed * (dt / 16.7);
      if (marqueeX + marqueeTextW < 0) {
        // Trigger fade-out before switching to next message (skip fade in continuous loop mode)
        if (!marqueeFadeOut && marqueeQueue.length > 0) {
          if (marqueeLoop) {
            // Continuous mode: instant swap, no fade between messages
            marqueeNext();
          } else {
            marqueeFadeOut = true; marqueeFadeIn = false; marqueeFadeStart = nowMs;
            setTimeout(() => { marqueeFadeOut = false; marqueeNext(); }, MARQUEE_FADE_MS + 16);
          }
        } else if (!marqueeFadeOut) {
          marqueeNext();
        }
      }
    }
    hasContent = true;
  }

  // QR overlay is DOM-based — no canvas drawing needed here

  _prevHadLogos     = hasLogos;
  overlayHasContent = hasContent;

  // Track dirty band so Syphon compositor only processes the marquee strip (not full frame)
  // when only marquee is active. Falls back to null (full composite) when logos are present.
  if (hasContent && !hasLogos && canvasMarqueeActive) {
    const fs   = marqueeConfig.fontSize;
    const bH   = fs + 32;
    let   bY;
    switch (marqueeConfig.position) {
      case 'top':    bY = 0; break;
      case 'center': bY = Math.round((h - bH) / 2); break;
      default:       bY = h - bH; break;
    }
    overlayDirtyBand = { y: bY, h: bH };
  } else {
    overlayDirtyBand = null;
  }
}

// Overlay loop — runs at display refresh rate but skips work when idle
(function overlayLoop() {
  renderOverlay();
  requestAnimationFrame(overlayLoop);
})();

// Syphon composite: alpha-blend overlay onto syphonPixelBuf (GL bottom-up order).
// When only the marquee bar is active (no logos), composites only the bar strip —
// reducing getImageData + pixel work from (w×h) to (w×barH), typically 10–15× less.
let syphonCompositeCanvas = null;
let syphonCompositeCtx    = null;

function compositeOverlayIntoSyphonBuf(w, h) {
  if (!overlayHasContent || !syphonPixelBuf) return;

  // Determine the screen-coord region to composite (band = marquee strip, null = full frame)
  const band  = overlayDirtyBand;
  const bandY = band ? band.y : 0;
  const bandH = band ? band.h : h;

  // In the GL buffer (bottom-up), the screen band [bandY, bandY+bandH) maps to
  // GL rows [h-bandY-bandH, h-bandY), i.e. glBandY = h - bandY - bandH.
  const glBandY = Math.max(0, h - bandY - bandH);

  // Reuse composite canvas; recreate only when size changes
  if (!syphonCompositeCanvas || syphonCompositeCanvas.width !== w || syphonCompositeCanvas.height !== bandH) {
    syphonCompositeCanvas = new OffscreenCanvas(w, bandH);
    syphonCompositeCtx    = syphonCompositeCanvas.getContext('2d');
  }

  // Blit the band from the overlay canvas into the composite canvas, flipped vertically
  syphonCompositeCtx.clearRect(0, 0, w, bandH);
  syphonCompositeCtx.save();
  syphonCompositeCtx.translate(0, bandH);
  syphonCompositeCtx.scale(1, -1);
  // drawImage with source rect crops to just the band; dest fills our small canvas
  syphonCompositeCtx.drawImage(overlayCanvas, 0, bandY, w, bandH, 0, 0, w, bandH);
  syphonCompositeCtx.restore();

  const overlayData = syphonCompositeCtx.getImageData(0, 0, w, bandH).data;
  const stride      = w * 4;

  // Alpha-composite only the band rows into syphonPixelBuf
  for (let row = 0; row < bandH; row++) {
    const srcOff = row * stride;
    const dstOff = (glBandY + row) * stride;
    for (let col = 0; col < w; col++) {
      const si = srcOff + col * 4;
      const a  = overlayData[si + 3] / 255;
      if (a <= 0) continue;
      const di = dstOff + col * 4;
      const ia = 1 - a;
      syphonPixelBuf[di]     = overlayData[si]     * a + syphonPixelBuf[di]     * ia;
      syphonPixelBuf[di + 1] = overlayData[si + 1] * a + syphonPixelBuf[di + 1] * ia;
      syphonPixelBuf[di + 2] = overlayData[si + 2] * a + syphonPixelBuf[di + 2] * ia;
    }
  }
}

// ── Syphon Overlay alpha channel rendering ────────────────────────────────────
//
// Publishes a second concurrent Syphon server ("AV Club VJ Overlay") that
// contains only foreground overlays (marquee, logos, photos, trivia, QR) on a
// fully transparent background. Downstream VJ apps can composite this over their
// own video. Uses straight (un-premultiplied) alpha throughout.

function isOverlayChannelActive() {
  return overlayHasContent || photoPlaying || qrOverlayShowing
      || triviaOverlayVisible || triviaScoreboardVisible;
}

// Utility: draw a rounded rectangle path (uses native ctx.roundRect from Chromium)
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// Utility: word-wrap text centred at cx
function wrapTextCentered(ctx, text, cx, y, maxW, lineH) {
  const words = text.split(' ');
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, cx, y);
      line = word;
      y += lineH;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, cx, y);
}

// Draw QR code overlay to alpha canvas — mirrors the DOM #qr-overlay-dom element
function drawQRToCanvas(ctx, w, h) {
  if (!qrDomEl || !qrDomImg || !qrDomImg.complete || !qrDomImg.naturalWidth) return;
  const opacity = parseFloat(qrDomEl.style.opacity) || 0;
  if (opacity <= 0) return;

  const QR_SIZE = 220, panelW = 272, panelH = 316, GAP = 32;
  let px, py;
  switch (qrCurrentPosition) {
    case 'top-left':     px = GAP; py = GAP; break;
    case 'top-right':    px = w - panelW - GAP; py = GAP; break;
    case 'bottom-left':  px = GAP; py = h - panelH - GAP; break;
    case 'bottom-right': px = w - panelW - GAP; py = h - panelH - GAP; break;
    default:             px = (w - panelW) / 2; py = (h - panelH) / 2; break;
  }
  // Custom x/y override
  if (qrCustomX !== null && qrCustomY !== null) {
    px = Math.round(w * qrCustomX / 100) - panelW / 2;
    py = Math.round(h * qrCustomY / 100) - panelH / 2;
  }

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = 'rgba(0,0,0,0.82)';
  roundRectPath(ctx, px, py, panelW, panelH, 18);
  ctx.fill();
  const imgX = px + (panelW - QR_SIZE) / 2;
  const imgY = py + 22;
  ctx.drawImage(qrDomImg, imgX, imgY, QR_SIZE, QR_SIZE);
  const labelText = qrDomLabel ? qrDomLabel.textContent : '';
  if (labelText) {
    ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(labelText, px + panelW / 2, imgY + QR_SIZE + 26);
  }
  ctx.restore();
}

// Draw trivia overlay to alpha canvas — mirrors #trivia-overlay and #trivia-scoreboard-panel
function drawTriviaToCanvas(ctx, w, h) {
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

  // ── Scoreboard ───────────────────────────────────────────────────────────────
  if (triviaScoreboardVisible && triviaScorePanel) {
    const sbOpacity = parseFloat(triviaScorePanel.style.opacity) || 0;
    if (sbOpacity > 0) {
      const rows = triviaScoreRows
        ? [...triviaScoreRows.querySelectorAll('.trivia-score-row')]
        : [];
      const rowH = 68, padX = 56, innerW = Math.min(860, w - 80);
      const panelH = 72 + rows.length * (rowH + 10) + 20;
      const px = (w - innerW) / 2, py = (h - panelH) / 2;

      ctx.save();
      ctx.globalAlpha = sbOpacity;
      ctx.fillStyle = 'rgba(0,0,0,0.92)';
      roundRectPath(ctx, px, py, innerW, panelH, 26);
      ctx.fill();

      ctx.font = `900 42px ${FONT}`;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText('Scoreboard', w / 2, py + 56);

      rows.forEach((rowEl, i) => {
        const rank = rowEl.querySelector('.trivia-score-rank')?.textContent || String(i + 1);
        const name = rowEl.querySelector('.trivia-score-name')?.textContent || '';
        const pts  = rowEl.querySelector('.trivia-score-pts')?.textContent || '';
        const ry = py + 72 + i * (rowH + 10);
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        roundRectPath(ctx, px + 8, ry, innerW - 16, rowH, 14);
        ctx.fill();
        ctx.font = `800 28px ${FONT}`; ctx.fillStyle = '#888'; ctx.textAlign = 'left';
        ctx.fillText(rank, px + padX, ry + rowH / 2 + 10);
        ctx.font = `600 30px ${FONT}`; ctx.fillStyle = '#fff';
        ctx.fillText(name, px + padX + 48, ry + rowH / 2 + 11);
        ctx.font = `900 38px ${FONT}`; ctx.fillStyle = '#ffd60a'; ctx.textAlign = 'right';
        ctx.fillText(pts, px + innerW - padX, ry + rowH / 2 + 14);
      });
      ctx.restore();
    }
  }

  // ── Question panel ───────────────────────────────────────────────────────────
  if (triviaOverlayVisible && triviaOverlayEl) {
    const qOpacity = parseFloat(triviaOverlayEl.style.opacity) || 0;
    if (qOpacity <= 0) return;

    ctx.save();
    ctx.globalAlpha = qOpacity;

    const padX = 28, padTop = 22;
    const hasInlineQR = triviaQrRow
      && triviaQrRow.style.display !== 'none'
      && parseFloat(triviaQrRow.style.opacity || '0') > 0
      && triviaQrImg?.complete;
    const qrColW  = hasInlineQR ? 260 : 0;
    const qrGap   = hasInlineQR ? 20 : 0;
    const totalW  = Math.min(880, w - 64);
    const qPanelW = totalW - qrColW - qrGap;
    const panelX  = (w - totalW) / 2;
    const panelY  = Math.round(h * 0.18);

    // Option geometry
    const optH = 52, optGap = 8;
    const optW = (qPanelW - padX * 2 - optGap) / 2;
    const optsY = panelY + padTop + 28 + 8 + 80; // category + question
    const panelH = optsY - panelY + 2 * optH + optGap + padTop;

    // Panel
    ctx.fillStyle = 'rgba(0,0,0,0.90)';
    roundRectPath(ctx, panelX, panelY, qPanelW, panelH, 20);
    ctx.fill();

    // Category
    const catText = triviaOverlayEl.querySelector('.trivia-category')?.textContent || '';
    ctx.font = `500 11px ${FONT}`; ctx.fillStyle = '#888'; ctx.textAlign = 'left';
    ctx.fillText(catText.toUpperCase(), panelX + padX, panelY + padTop + 11);

    // Timer
    const timerText = triviaTimerEl?.textContent || '';
    const timerCls  = triviaTimerEl?.className || '';
    ctx.font = `800 32px ${FONT}`;
    ctx.fillStyle = timerCls.includes('danger') ? '#ff453a'
                  : timerCls.includes('warn')   ? '#ff9500' : '#fff';
    ctx.textAlign = 'right';
    ctx.fillText(timerText, panelX + qPanelW - padX, panelY + padTop + 12);

    // Question
    const questionText = triviaQuestionEl?.textContent || '';
    ctx.font = `700 22px ${FONT}`; ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
    wrapTextCentered(ctx, questionText, panelX + qPanelW / 2,
      panelY + padTop + 28 + 8, qPanelW - padX * 2, 30);

    // Options (2×2 grid)
    const LETTERS = ['A', 'B', 'C', 'D'];
    triviaOptEls.forEach((el, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const ox = panelX + padX + col * (optW + optGap);
      const oy = optsY + row * (optH + optGap);
      const isCorrect = el.classList.contains('correct');
      const isWrong   = el.classList.contains('wrong');
      ctx.save();
      if (isWrong) ctx.globalAlpha *= 0.28;
      ctx.fillStyle = isCorrect ? 'rgba(52,199,89,0.28)' : 'rgba(255,255,255,0.08)';
      roundRectPath(ctx, ox, oy, optW, optH, 12);
      ctx.fill();
      // Letter circle
      const cr = 14, clx = ox + 18 + cr, cly = oy + optH / 2;
      ctx.fillStyle = isCorrect ? '#34c759' : 'rgba(255,255,255,0.15)';
      ctx.beginPath(); ctx.arc(clx, cly, cr, 0, Math.PI * 2); ctx.fill();
      ctx.font = `800 14px ${FONT}`; ctx.fillStyle = isCorrect ? '#000' : '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(LETTERS[i], clx, cly + 5);
      // Option text
      const optText = el.querySelector('.trivia-opt-text')?.textContent || '';
      ctx.font = `500 14px ${FONT}`; ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
      ctx.fillText(optText, ox + 52, oy + optH / 2 + 5);
      ctx.restore();
    });

    // Inline QR panel alongside question card
    if (hasInlineQR) {
      const qrX = panelX + qPanelW + qrGap;
      ctx.fillStyle = 'rgba(0,0,0,0.82)';
      roundRectPath(ctx, qrX, panelY, qrColW, panelH, 20);
      ctx.fill();
      const qrSize = Math.min(qrColW - 40, panelH - 40);
      ctx.drawImage(triviaQrImg, qrX + (qrColW - qrSize) / 2, panelY + 18, qrSize, qrSize);
    }
    ctx.restore();
  }
}

// Draw photo overlay to alpha canvas — reads post-animation position via getBoundingClientRect()
function drawPhotoToCanvas(ctx, w, h) {
  const overlay = document.getElementById('photo-overlay');
  const frame   = document.getElementById('photo-frame');
  const img     = document.getElementById('photo-img');
  if (!overlay || !frame || !img || !img.complete || !img.naturalWidth) return;

  const opacity = parseFloat(overlay.style.opacity) || 0;
  if (opacity <= 0) return;

  // getBoundingClientRect() gives the actual rendered position including CSS entrance animations
  const rect = frame.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  ctx.save();
  ctx.globalAlpha = opacity;

  // Semi-transparent backdrop (matches CSS rgba(0,0,0,0.55) on #photo-overlay)
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, w, h);

  // Polaroid frame (white, drop shadow)
  ctx.shadowColor = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = 36;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = '#fff';
  roundRectPath(ctx, rect.left, rect.top, rect.width, rect.height, 3);
  ctx.fill();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

  // Photo image (18px padding on sides/top, 64px space at bottom for caption)
  const PAD = 18, capH = 64;
  ctx.drawImage(img,
    rect.left + PAD, rect.top  + PAD,
    rect.width - PAD * 2, rect.height - PAD - capH);

  // Caption text
  const cap = document.getElementById('photo-caption');
  if (cap && cap.style.display !== 'none' && cap.textContent.trim()) {
    ctx.font = '16px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.fillStyle = '#333';
    ctx.textAlign = 'center';
    ctx.fillText(cap.textContent.trim(),
      rect.left + rect.width / 2,
      rect.top  + rect.height - capH / 2 + 6);
  }

  ctx.restore();
}

// Main alpha overlay renderer — called once per frame when overlay server is running.
// Composes all visible overlay content on a transparent background and sends to
// the "AV Club VJ Overlay" Syphon server. Vertical flip is done in the native layer.
function renderAlphaOverlayFrame(w, h) {
  // Lazy-allocate canvas + pixel buffer when size changes
  if (!overlayAlphaCanvas || overlayAlphaBufW !== w || overlayAlphaBufH !== h) {
    overlayAlphaCanvas   = new OffscreenCanvas(w, h);
    overlayAlphaCtx      = overlayAlphaCanvas.getContext('2d');
    overlayAlphaPixelBuf = new Uint8Array(w * h * 4);
    overlayAlphaBufW = w;
    overlayAlphaBufH = h;
  }

  const active = isOverlayChannelActive();

  // Dirty-flag optimisation: skip entirely if nothing visible this frame OR last frame.
  // On the first frame after going inactive, we still send one clean transparent frame
  // so downstream apps (Resolume etc.) see a proper reset rather than a frozen last frame.
  if (!active && !_overlayWasActive) return;
  _overlayWasActive = active;

  const ctx = overlayAlphaCtx;
  ctx.clearRect(0, 0, w, h); // transparent background — alpha=0 everywhere by default

  // Layer 1: marquee + logos from overlayCanvas (already has transparent background)
  if (overlayHasContent) ctx.drawImage(overlayCanvas, 0, 0);

  // Layer 2: DOM overlay equivalents
  if (triviaOverlayVisible || triviaScoreboardVisible) drawTriviaToCanvas(ctx, w, h);
  if (qrOverlayShowing)  drawQRToCanvas(ctx, w, h);
  if (photoPlaying)      drawPhotoToCanvas(ctx, w, h);

  // Extract pixels (top-left origin — native layer performs the vertical flip,
  // same convention as the main Syphon channel)
  overlayAlphaPixelBuf.set(ctx.getImageData(0, 0, w, h).data);
  window.api.syphonOverlaySendFrame(overlayAlphaPixelBuf.buffer, w, h);
}

// ── IPC message handler ───────────────────────────────────────────────────────

window.api.onMessage((msg) => {
  switch (msg.type) {
    case 'start-audio':
      startAudio(msg.deviceId);
      break;

    case 'load-preset':
      loadPresetByName(msg.name, msg.blendTime ?? 2);
      break;

    case 'load-preset-data':
      customPresets[msg.name] = msg.preset;
      loadPresetData(msg.preset, msg.name, msg.blendTime ?? 2);
      break;

    case 'register-custom-preset':
      // Register without loading (used on startup to populate custom map)
      customPresets[msg.name] = msg.preset;
      break;

    case 'set-renderer-size':
      resizeCanvas();
      break;

    case 'set-sensitivity':
      audioSensitivity = msg.value;
      if (gainNode) gainNode.gain.value = audioSensitivity;
      break;

    case 'strobe':      triggerStrobe();     break;
    case 'shake':       triggerShake();      break;
    case 'zoom-punch':  triggerZoomPunch();  break;
    case 'color-crush': triggerColorCrush(); break;
    case 'tunnel':      triggerTunnel();     break;
    case 'black-strobe': triggerBlackStrobe(); break;
    case 'blackout':     setBlackout(msg.active); break;

    case 'set-audio-eq':
      // msg.bass / msg.mid / msg.treb are dB values (-15 to +15)
      if (bassFilter) bassFilter.gain.setTargetAtTime(msg.bass ?? 0, audioCtx.currentTime, 0.05);
      if (midFilter)  midFilter.gain.setTargetAtTime(msg.mid  ?? 0, audioCtx.currentTime, 0.05);
      if (trebFilter) trebFilter.gain.setTargetAtTime(msg.treb ?? 0, audioCtx.currentTime, 0.05);
      break;

    case 'beat-sync-enable':
      beatSyncEnabled = true;
      beatTimestamps  = [];
      detectedBpm     = 0;
      beatConfidence  = 0;
      beatSlowAvg     = 0;
      beatFastAvg     = 0;
      break;

    case 'reset-bpm':
      beatTimestamps  = [];
      detectedBpm     = 0;
      beatConfidence  = 0;
      beatSlowAvg     = 0;
      beatFastAvg     = 0;
      break;

    case 'beat-sync-disable':
      beatSyncEnabled = false;
      break;

    case 'set-brightness-skip':
      brightSkipEnabled = !!msg.enabled;
      brightSustained   = 0;
      brightFrameCount  = 0;
      break;

    case 'set-darkness-skip':
      darkSkipEnabled = !!msg.enabled;
      darkSustained   = 0;
      break;

    case 'set-perf-skip':
      perfSkipEnabled  = !!msg.enabled;
      perfThreshold    = msg.threshold ?? 150;
      perfOverloadSec  = 0;
      break;

    case 'set-perf-threshold':
      perfThreshold   = msg.threshold ?? 150;
      perfOverloadSec = 0;
      break;

    case 'syphon-enable':
      syphonEnabled = true;
      // Switch running marquee from DOM to canvas mode
      if (marqueeRunning && marqueeCurrent) {
        if (domMarqueeBar) domMarqueeBar.style.display = 'none';
        // Restart current message in canvas mode
        marqueeQueue.unshift(marqueeCurrent);
        marqueeCurrent = null; marqueeRunning = false;
        marqueeNext();
      }
      break;

    case 'syphon-disable':
      syphonEnabled = false;
      destroySyphonPBOs(); // free GPU memory when Syphon turns off
      // Switch running marquee from canvas to DOM mode
      if (marqueeRunning && marqueeCurrent) {
        marqueeOffscreen = null;
        startDOMMarquee();
      }
      break;

    case 'syphon-overlay-enable':
      syphonOverlayEnabled = true;
      break;

    case 'syphon-overlay-disable':
      syphonOverlayEnabled  = false;
      _overlayWasActive     = false;
      overlayAlphaPixelBuf  = null; // free memory
      overlayAlphaCanvas    = null;
      overlayAlphaCtx       = null;
      break;

    case 'set-fps-cap':
      targetFps = Math.max(1, msg.fps || 60);
      break;

    case 'set-quality':
      if (MESH_QUALITY[msg.quality]) reinitVisualizer(msg.quality);
      break;

    case 'update-preset-params':
      // Append param overrides in JS format (a.* prefix) so they win even if
      // the preset recomputes these variables dynamically every frame.
      // We use an empty base so MilkDrop-format equations don't pollute the JS string.
      if (currentPresetData && msg.baseVals) {
        currentPresetData.baseVals = { ...currentPresetData.baseVals, ...msg.baseVals };
        // Build override suffix in JS format (a.* prefix)
        const overrideSuffix = Object.entries(msg.baseVals)
          .map(([k, v]) => `a.${k} = ${v};`)
          .join('\n');
        const patched = {
          ...currentPresetData,
          _jsFormat: true,
          frame_eqs_str: overrideSuffix,
          pixel_eqs_str: '',
        };
        visualizer.loadPreset(normalizePreset(patched), 0.1);
        // Push updated code to controls
        window.api.sendToControl({
          type: 'preset-code-update',
          frameEqs: patched.frame_eqs_str,
          pixelEqs: patched.pixel_eqs_str || '',
        });
      }
      break;

    case 'update-preset-code':
      // User edited code directly in the code view
      if (currentPresetData) {
        currentPresetData.frame_eqs_str = msg.frameEqs ?? currentPresetData.frame_eqs_str;
        currentPresetData.pixel_eqs_str = msg.pixelEqs ?? currentPresetData.pixel_eqs_str;
        visualizer.loadPreset(normalizePreset(currentPresetData), 0);
      }
      break;

    case 'generate-glitch-preset': {
      const generated = generateGlitchPreset(msg.mode);
      if (generated) {
        const blend = msg.mode === 'new' ? (msg.blendTime ?? 2) : 0.3;
        applyPreset(generated, generated.name, blend);
      }
      break;
    }

    case 'get-preset-for-save':
      if (currentPresetData) {
        window.api.sendToControl({ type: 'preset-for-save', preset: currentPresetData });
      }
      break;

    case 'load-hydra-preset': {
      const ok = loadHydraPreset(msg.code);
      if (ok) {
        // Switch to Hydra mode: show hydra canvas, pause butterchurn render
        hydraActive = true;
        perfOverloadSec = 0; // reset so it can't fire immediately on exit
        showHydra();
        canvas.style.display = 'none';
        setStatus(msg.name || 'Hydra', 3000);
        window.api.sendToControl({ type: 'current-preset', name: msg.name || 'Hydra' });
      }
      break;
    }

    case 'exit-hydra-mode':
      hydraActive = false;
      perfOverloadSec = 0; // fresh slate when returning to butterchurn
      perfWindowStart = performance.now(); // reset FPS window
      perfFrameCount  = 0;
      hideHydra();
      canvas.style.display = 'block';
      break;

    case 'set-hydra-param':
      setHydraParam(msg.key, msg.value);
      break;

    // ── Venue Overlay ──────────────────────────────────────────────────────────
    case 'marquee-start': {
      marqueeConfig = { ...marqueeConfig, ...msg.config };
      if (qrOverlayEnabled) applyQrPosition(); // re-check clearance if marquee position changed
      marqueeLoop   = !!msg.loop;
      marqueeIntervalMins  = msg.intervalMins > 0 ? msg.intervalMins : 0;
      marqueeOrigMessages  = (msg.messages || []).filter(s => s.trim());
      marqueeQueue         = [...marqueeOrigMessages];
      if (marqueeRepeatTimeout) { clearTimeout(marqueeRepeatTimeout); marqueeRepeatTimeout = null; }
      marqueeRunning = false;
      marqueeCurrent = null;
      marqueeNext();
      break;
    }
    case 'marquee-stop':
      marqueeQueue        = [];
      marqueeIntervalMins = 0;
      marqueeOrigMessages = [];
      if (marqueeRepeatTimeout) { clearTimeout(marqueeRepeatTimeout); marqueeRepeatTimeout = null; }
      if (marqueeRunning && marqueeCurrent) {
        // Fade out gracefully, then clear
        marqueeFadeToStop();
        setTimeout(() => {
          marqueeRunning = false; marqueeCurrent = null; marqueeFadeAlpha = 0;
          if (domMarqueeBar) domMarqueeBar.style.display = 'none';
        }, MARQUEE_FADE_MS + 50);
      } else {
        marqueeRunning = false; marqueeCurrent = null; marqueeFadeAlpha = 0;
        if (domMarqueeBar) domMarqueeBar.style.display = 'none';
      }
      break;

    case 'marquee-play-once': {
      const txt = (msg.text || '').trim();
      if (!txt) break;
      marqueeLoop  = false;   // single play — do not re-queue
      marqueeQueue = [txt];   // replace queue so nothing else follows
      if (!marqueeRunning) marqueeNext();
      break;
    }

    case 'marquee-config':
      marqueeConfig = { ...marqueeConfig, ...msg.config };
      // Re-measure if font size changed
      if (marqueeCurrent && overlayCtx) {
        overlayCtx.font = `bold ${marqueeConfig.fontSize}px "SF Pro Display","Helvetica Neue",Arial,sans-serif`;
        marqueeTextW = overlayCtx.measureText(marqueeCurrent).width;
      }
      // Refresh DOM marquee if currently displayed
      if (!syphonEnabled && marqueeRunning && marqueeCurrent) startDOMMarquee();
      break;

    case 'trivia-question':
      triviaShow(msg);
      break;
    case 'trivia-reveal':
      triviaReveal(msg.correctIndex);
      break;
    case 'trivia-scoreboard':
      triviaShowScoreboard(msg.scores);
      break;
    case 'trivia-hide':
      triviaHide();
      break;

    case 'audience-qr-overlay':
      if (msg.show) {
        if (msg.trivia) {
          // Trivia mode: embed QR inside the trivia panel (centered with question)
          if (triviaQrImg && msg.dataUrl) triviaQrImg.src = msg.dataUrl;
          triviaQrFadeIn();
        } else {
          qrDomStart(msg.dataUrl || null, msg.label || null, msg.showSec || 15, msg.intervalMin || 5, msg.position || 'center', msg.x, msg.y, msg.scale);
        }
      } else {
        qrDomStop();
        triviaQrFadeOut();
      }
      break;

    case 'qr-update-position':
      qrCustomX     = msg.x     ?? qrCustomX;
      qrCustomY     = msg.y     ?? qrCustomY;
      qrCustomScale = msg.scale ?? qrCustomScale;
      applyQrPosition();
      break;

    case 'audience-message':
      // Legacy / unmoderated direct path — push to priority queue
      if (msg.text) {
        audienceQueue.push(msg.text);
        if (!marqueeRunning) marqueeNext();
      }
      break;

    case 'marquee-queue-add':
      // Approved audience message — plays once (priority queue, not looped back)
      if (msg.text) {
        audienceQueue.push(msg.text);
        if (!marqueeRunning) marqueeNext();
      }
      break;

    case 'logos-enabled':
      logosEnabled = !!msg.enabled;
      break;

    case 'logo-global-config':
      logoGlobalIntervalMins = msg.intervalMins ?? logoGlobalIntervalMins;
      logoGlobalDurationSecs = msg.durationSecs ?? logoGlobalDurationSecs;
      logoSeqStart();
      break;

    case 'logo-add':
      addLogo(msg.logo);
      break;

    case 'logo-remove':
      delete logoOverlays[msg.id];
      logoSeqStart(); // restart sequence without removed logo
      break;

    case 'logo-update': {
      const o = logoOverlays[msg.id];
      if (o) {
        const prevVis    = logoVisibility(o.cfg);
        const prevBounce = logoBounce(o.cfg);
        o.cfg = { ...o.cfg, ...msg.cfg };
        const newVis    = logoVisibility(o.cfg);
        const newBounce = logoBounce(o.cfg);
        // Reset bounce physics when enabling bounce
        if (!prevBounce && newBounce) { o.state.bx = null; o.state.edgeDwell = 0; }
        // Restart sequence if visibility changed to/from sequence
        if (prevVis !== newVis) logoSeqStart();
      }
      break;
    }

    case 'logo-trigger':
      triggerLogo(msg.id);
      break;

    case 'photo-display':
      queuePhoto(msg.dataUrl, msg.caption || '', msg.duration || 10);
      break;

    case 'request-current-preset':
      window.api.sendToControl({ type: 'current-preset', name: currentPresetName });
      break;

    case 'photo-kill': {
      // Skip current photo and advance to next in queue
      if (photoOverlayTimer) { clearTimeout(photoOverlayTimer); photoOverlayTimer = null; }
      photoPlaying = false;
      const killOverlay = document.getElementById('photo-overlay');
      const killFrame   = document.getElementById('photo-frame');
      const killImg     = document.getElementById('photo-img');
      if (killOverlay) {
        killOverlay.style.transition = 'opacity 0.25s ease';
        killOverlay.style.opacity    = '0';
        setTimeout(() => {
          killOverlay.style.display = 'none';
          if (killFrame) killFrame.style.animation = 'none';
          if (killImg)   killImg.src = '';
          processPhotoQueue(); // advance to next photo if one is waiting
        }, 280);
      }
      break;
    }
  }
});

// ── Photo overlay ─────────────────────────────────────────────────────────────

let photoOverlayTimer = null;
let photoQueue        = []; // { dataUrl, caption, duration }
let photoPlaying      = false;

function queuePhoto(dataUrl, caption, duration) {
  photoQueue.push({ dataUrl, caption, duration });
  if (!photoPlaying) processPhotoQueue();
}

function processPhotoQueue() {
  if (photoQueue.length === 0) { photoPlaying = false; return; }
  photoPlaying = true;
  const next = photoQueue.shift();
  showPhotoOverlay(next.dataUrl, next.caption, next.duration, processPhotoQueue);
}

const PHOTO_ENTRANCES = [
  { name: 'drop',        dur: 0.80 },
  { name: 'slide-left',  dur: 0.65 },
  { name: 'slide-right', dur: 0.65 },
  { name: 'zoom',        dur: 0.65 },
  { name: 'slam',        dur: 0.60 },
  { name: 'spin-drop',   dur: 0.95 },
  { name: 'fade',        dur: 0.85 },
];

function showPhotoOverlay(dataUrl, caption, durationSec, onComplete) {
  const overlay = document.getElementById('photo-overlay');
  const frame   = document.getElementById('photo-frame');
  const img     = document.getElementById('photo-img');
  const cap     = document.getElementById('photo-caption');
  if (!overlay || !img) return;

  // Clear any previous timer
  if (photoOverlayTimer) { clearTimeout(photoOverlayTimer); photoOverlayTimer = null; }

  // Random entrance + random slight tilt (-4° to +4°)
  const entrance = PHOTO_ENTRANCES[Math.floor(Math.random() * PHOTO_ENTRANCES.length)];
  const tilt     = (Math.random() - 0.5) * 8;
  frame.style.setProperty('--photo-tilt', tilt.toFixed(1) + 'deg');
  frame.style.transform = '';

  img.src = dataUrl;
  cap.textContent = caption;
  cap.style.display = caption ? 'block' : 'none';

  // Reset any previous animation, show overlay
  frame.style.animation = 'none';
  overlay.style.transition = 'opacity 0.45s ease';
  overlay.style.opacity    = '0';
  overlay.style.display    = 'flex';
  void frame.offsetWidth; // force reflow so animation restart takes effect

  // Kick off entrance animation + backdrop fade simultaneously
  frame.style.animation = `photo-${entrance.name} ${entrance.dur}s cubic-bezier(0.22,1,0.36,1) forwards`;
  requestAnimationFrame(() => requestAnimationFrame(() => { overlay.style.opacity = '1'; }));

  // Hold, then slow-fade out
  photoOverlayTimer = setTimeout(() => {
    overlay.style.transition = 'opacity 1s ease';
    overlay.style.opacity    = '0';
    photoOverlayTimer = setTimeout(() => {
      overlay.style.display = 'none';
      frame.style.animation = 'none';
      img.src = '';
      photoOverlayTimer = null;
      if (onComplete) onComplete();
    }, 1100);
  }, durationSec * 1000);
}

// ── Startup ───────────────────────────────────────────────────────────────────

(async () => {
  const config = await window.api.getConfig();

  // Register custom presets into memory
  const customList = await window.api.getCustomPresets();
  for (const item of customList) {
    try {
      const raw = await window.api.readPresetFile(item.filePath);
      const parsed = JSON.parse(raw);
      customPresets[item.name] = parsed;
    } catch (_) {
      console.warn('Could not load custom preset:', item.name);
    }
  }

  // Auto-start with mic
  startAudio(config.audioSource || 'mic');
})();
