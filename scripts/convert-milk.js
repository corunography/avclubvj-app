#!/usr/bin/env node
// Converts all .milk files in custom-presets to butterchurn .json format
// Preserves directory structure (category/subcategory/name.json)

const fs   = require('fs');
const path = require('path');

const CUSTOM_PRESETS = path.join(
  require('os').homedir(),
  'Library', 'Application Support', 'AV Club VJ', 'custom-presets'
);

// ── Key mapping: .milk → butterchurn baseVals ──────────────────────────────
const BASEVAL_MAP = {
  fRating:'rating', fGammaAdj:'gamma', fDecay:'decay',
  fVideoEchoZoom:'echo_zoom', fVideoEchoAlpha:'echo_alpha',
  nVideoEchoOrientation:'echo_orient', nWaveMode:'wave_mode',
  bAdditiveWaves:'additivewave', bWaveDots:'wave_dots', bWaveThick:'wave_thick',
  bModWaveAlphaByVolume:'modwavealphabyvolume', bMaximizeWaveColor:'maximizewavecolor',
  bTexWrap:'wrap', bDarkenCenter:'darken_center', bRedBlueStereo:'redbluestereo',
  bBrighten:'brighten', bDarken:'darken', bSolarize:'solarize', bInvert:'invert',
  fWaveAlpha:'wave_a', fWaveScale:'wave_scale', fWaveSmoothing:'wave_smoothing',
  fWaveParam:'wave_param', fModWaveAlphaStart:'modwavealphastart',
  fModWaveAlphaEnd:'modwavealphaend', fWarpAnimSpeed:'warpanimspeed',
  fWarpScale:'warpscale', fZoomExponent:'zoom_exponent', fShader:'shader',
  zoom:'zoom', rot:'rot', cx:'cx', cy:'cy', dx:'dx', dy:'dy',
  warp:'warp', sx:'sx', sy:'sy',
  wave_r:'wave_r', wave_g:'wave_g', wave_b:'wave_b', wave_x:'wave_x', wave_y:'wave_y',
  ob_size:'ob_size', ob_r:'ob_r', ob_g:'ob_g', ob_b:'ob_b', ob_a:'ob_a',
  ib_size:'ib_size', ib_r:'ib_r', ib_g:'ib_g', ib_b:'ib_b', ib_a:'ib_a',
  mv_x:'mv_x', mv_y:'mv_y', mv_dx:'mv_dx', mv_dy:'mv_dy',
  mv_l:'mv_l', mv_r:'mv_r', mv_g:'mv_g', mv_b:'mv_b', mv_a:'mv_a',
};

const SHAPE_KEYS = [
  'enabled','sides','additive','thick','x','y','r','g','b','a',
  'r2','g2','b2','a2','border_r','border_g','border_b','border_a',
  'tex_ang','tex_zoom','textured',
];
const WAVE_KEYS = [
  'enabled','r','g','b','a','samples','sep','scaling','smoothing',
  'freq','additive','thick','use_spectrum',
];

// ── Parser ─────────────────────────────────────────────────────────────────
function parseMilk(text) {
  const sections = {};
  let cur = '__top__';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^\[([^\]]+)\]$/);
    if (m) { cur = m[1].toLowerCase(); sections[cur] = sections[cur] || []; continue; }
    (sections[cur] = sections[cur] || []).push(line);
  }

  function kv(sec) {
    const out = {};
    for (const line of (sections[sec] || [])) {
      const i = line.indexOf('=');
      if (i < 0) continue;
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  }

  function eqs(map, prefix) {
    const parts = []; let i = 1;
    while (map[`${prefix}${i}`] !== undefined) { parts.push(map[`${prefix}${i}`]); i++; }
    return parts.join(';');
  }

  const p = kv('preset00');
  const baseVals = {};
  for (const [mk, bk] of Object.entries(BASEVAL_MAP)) {
    if (p[mk] !== undefined) baseVals[bk] = parseFloat(p[mk]);
  }

  const shapes = Array.from({ length: 4 }, (_, i) => {
    const s  = kv(`shape${i + 1}`);
    const bv = {};
    for (const k of SHAPE_KEYS) if (s[k] !== undefined) bv[k] = parseFloat(s[k]);
    return { enabled: bv.enabled || 0, baseVals: bv, frame_eqs_str: eqs(s, 'per_frame_'), init_eqs_str: '' };
  });

  const waves = Array.from({ length: 4 }, (_, i) => {
    const w  = kv(`wave${i + 1}`);
    const bv = {};
    for (const k of WAVE_KEYS) {
      if (w[k] !== undefined) bv[k === 'use_spectrum' ? 'spectrum' : k] = parseFloat(w[k]);
    }
    return { enabled: bv.enabled || 0, baseVals: bv, frame_eqs_str: eqs(w, 'per_frame_'), point_eqs_str: eqs(w, 'per_point_'), init_eqs_str: '' };
  });

  return {
    baseVals,
    shapes,
    waves,
    init_eqs_str:  eqs(p, 'per_frame_init_'),
    frame_eqs_str: eqs(p, 'per_frame_'),
    pixel_eqs_str: eqs(p, 'per_pixel_'),
    warp: '',
    comp: '',
  };
}

// ── Batch convert ──────────────────────────────────────────────────────────
function findMilkFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findMilkFiles(full));
    else if (entry.name.endsWith('.milk')) results.push(full);
  }
  return results;
}

const milkFiles = findMilkFiles(CUSTOM_PRESETS);
console.log(`Converting ${milkFiles.length} .milk files...`);

let ok = 0, fail = 0;
for (const milkPath of milkFiles) {
  const jsonPath = milkPath.replace(/\.milk$/, '.json');
  if (fs.existsSync(jsonPath)) { fs.unlinkSync(milkPath); ok++; continue; } // already converted
  try {
    const raw    = fs.readFileSync(milkPath, 'utf8');
    const preset = parseMilk(raw);
    fs.writeFileSync(jsonPath, JSON.stringify(preset));
    fs.unlinkSync(milkPath); // remove original .milk
    ok++;
  } catch (e) {
    console.error(`FAIL: ${milkPath}\n  ${e.message}`);
    fail++;
  }
  if ((ok + fail) % 500 === 0) process.stdout.write(`  ${ok + fail}/${milkFiles.length}...\n`);
}

console.log(`Done. ${ok} converted, ${fail} failed.`);
