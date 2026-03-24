#!/usr/bin/env node
// Converts all .milk files from the MILK/ProjectMilkSyphon/presets folder
// to butterchurn .json format using the official milkdrop-eel-parser +
// milkdrop-preset-utils (same pipeline as milkdrop-preset-converter-node).
// Preserves directory structure (category/subcategory/name.json).
// Skips HLSL shader conversion (leaves warp/comp as empty strings).

const fs   = require('fs');
const path = require('path');

const ROOT  = path.join(__dirname, '..', 'node_modules');
const parser = require(path.join(ROOT, 'milkdrop-eel-parser', 'release', 'md-parser.min'));
const utils  = require(path.join(ROOT, 'milkdrop-preset-utils', 'dist', 'milkdrop-preset-utils.min'));

const SRC_DIR  = path.join(__dirname, '..', 'MILK', 'ProjectMilkSyphon', 'presets');
const DEST_DIR = path.join(
  require('os').homedir(),
  'Library', 'Application Support', 'AV Club VJ', 'custom-presets'
);

function findMilkFiles(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findMilkFiles(full, results);
    else if (entry.name.endsWith('.milk')) results.push(full);
  }
  return results;
}

function convertPreset(milkText) {
  const parts = utils.splitPreset(milkText);

  const parsed = parser.convert_preset_wave_and_shape(
    parts.presetVersion,
    parts.presetInit,
    parts.perFrame,
    parts.perVertex,
    parts.shapes,
    parts.waves
  );

  const presetMap = utils.createBasePresetFuns(parsed, parts.shapes, parts.waves);

  // createBasePresetFuns sets *_str fields to compiled JS (a['variable'] notation).
  // Don't overwrite them — that's what normalizePreset needs for compileEqStr.

  // No HLSL→GLSL conversion — skip shaders (leaves warp/comp as '')
  presetMap.warp = '';
  presetMap.comp = '';

  return {
    baseVals: parts.baseVals,
    ...presetMap,
    _jsFormat: true,  // marks that *_str fields are compiled JS (a['var'] notation)
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const milkFiles = findMilkFiles(SRC_DIR);
console.log(`Converting ${milkFiles.length} .milk files from ${SRC_DIR} ...`);
console.log(`Output: ${DEST_DIR}`);

// Clear existing custom-presets (remove old JSONs)
function clearDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { clearDir(full); fs.rmdirSync(full, { recursive: true }); }
    else fs.unlinkSync(full);
  }
}
clearDir(DEST_DIR);
fs.mkdirSync(DEST_DIR, { recursive: true });

let ok = 0, fail = 0;

for (const milkPath of milkFiles) {
  // Compute relative path from SRC_DIR → preserve category/subcategory structure
  const rel      = path.relative(SRC_DIR, milkPath);
  const jsonRel  = rel.replace(/\.milk$/i, '.json');
  const destPath = path.join(DEST_DIR, jsonRel);

  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  try {
    const raw    = fs.readFileSync(milkPath, 'utf8');
    const preset = convertPreset(raw);
    fs.writeFileSync(destPath, JSON.stringify(preset));
    ok++;
  } catch (e) {
    fail++;
    if (fail <= 20) console.error(`FAIL: ${rel}\n  ${e.message}`);
  }

  if ((ok + fail) % 500 === 0) process.stdout.write(`  ${ok + fail}/${milkFiles.length}...\n`);
}

console.log(`\nDone. ${ok} converted, ${fail} failed.`);
