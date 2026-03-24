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

// ── Hydra presets ──────────────────────────────────────────────────────────────
const hydraPresets = [];
const hydraCtx = require.context('./hydra-presets', false, /\.json$/);
hydraCtx.keys().forEach(key => {
  const data = hydraCtx(key);
  hydraPresets.push({ id: key, name: data.name, code: data.code });
});

// ── State ─────────────────────────────────────────────────────────────────────

let config = {};
let isInitialized = false; // blocks persistConfig until init is complete
let currentPresetName = null;
let currentTab = 'builtin'; // 'builtin' | 'custom' | 'favorites' | 'hydra'
let hydraMode = false;

// ── Favorites ─────────────────────────────────────────────────────────────────
const FAV_KEY = 'avclubvj_favorites';
let favorites = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]'));
function saveFavorites() { localStorage.setItem(FAV_KEY, JSON.stringify([...favorites])); }
function toggleFavorite(id) {
  if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
  saveFavorites();
  renderList();
}
function makeFavBtn(id) {
  const btn = document.createElement('button');
  btn.className = 'btn-fav' + (favorites.has(id) ? ' faved' : '');
  btn.textContent = '⭐';
  btn.title = favorites.has(id) ? 'Remove from favorites' : 'Add to favorites';
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggleFavorite(id); });
  return btn;
}
let customPresets = []; // [{ name, filePath, ext }]
let cycleTimer = null;
let filteredBuiltin = [];

const allBuiltinNames = Object.keys({
  ...butterchurnPresets.getPresets(),
  ...butterchurnPresetsExtra.getPresets(),
  ...butterchurnPresetsExtra2.getPresets(),
  ...butterchurnPresetsMD1.getPresets(),
  ...butterchurnPresetsNonMinimal.getPresets(),
  ...weeklyWeek1,
  ...weeklyWeek2,
  ...weeklyWeek3,
  ...weeklyWeek4,
  ...weeklyWeek5,
  ...baronPresets,
}).sort();

// Presets excluded from rotation — syntax errors or confirmed low-FPS (<25fps)
const KNOWN_BAD_PRESETS = new Set([
  // Syntax errors (fail to load)
  'Chemlock - Berry Maddog 20-20',
  'shifter - ralter oilslick b',
  'PieturP - HSL-here-we-go-circles',
  'PieturP - HSL-here-we-go-circle',
  'PieturP - HSL-tunnelvisions',
  // Low FPS (logged below 25fps during testing)
  'Rozzor _ Esotic - PPL _NWI_ Mandala Chill Color Reactive Texture Tweaked',
  'beta106i - Arise_ _Padded_',
  'stahlregen - dots (layered) - suksma world humanvirus replication killphreqs mix3',
  'Phmall - Mayan Sunrize _y_',
  'Rovastar-AltarsOfMadness(DuelMi',
  'Esotic vs Rozzor - Pixie Party Light _No Wave Invasion_ Mandala Chill Red Yellow',
  'Hexcollie - Swaying Escher Trance ',
  'Dbleja - Hovering Over Mars',
  'fiShbRaiN - witchcraft _ritual dance remix_',
  'Phat_Rovastar - What_does_your_soul_look_like7',
  'beta106i - Corners of the Globe',
  'Aderrasi + Geiss - Airhandler (Kali Mix) - Canvas Mix',
  'Eo.S. - multisphere 01 B_Phat_Ra_mix',
  'shifter - crosshatch neopsy',
  'LuxXx - StickVerse II',
  'idiot24-7 - Hyper Travel (first 1.03 preset) solarized',
  'Illusion&rovastar-fadedspirals',
  'stahlregen + geiss + shifter - babylon',
  'Dbleja - Horizontology _Blue Mix_',
  'flexi - bouncing balls [double mindblob neon mix]',
  'amandio c - secret garden 6',
  'Phat_fiShbRaiN_Mandala_Bare_No_Border_mix',
  'martin - Flexis swarm in Martins pond [not yet a boid implementation] ',
  'Zylot - Paint Spill (Music Reactive Paint Mix)',
  'ORB - Waaa',
]);

// ── DOM refs ──────────────────────────────────────────────────────────────────

const presetList     = document.getElementById('preset-list');
const searchInput    = document.getElementById('preset-search');
const cycleEnabled        = document.getElementById('cycle-enabled');
const cycleInterval       = document.getElementById('cycle-interval');
const importedEnabled     = document.getElementById('imported-enabled');
const importedChance      = document.getElementById('imported-chance');
const mixGeneratedCheck   = document.getElementById('mix-generated');
const mixGeneratedChance  = document.getElementById('mix-generated-chance');
const favCycleCheck       = document.getElementById('fav-cycle-enabled');
const favCycleChance      = document.getElementById('fav-cycle-chance');
const blendTime      = document.getElementById('blend-time');
const audioDevice    = document.getElementById('audio-device');
const resPreset      = document.getElementById('res-preset');
const customResRow   = document.getElementById('custom-res-row');
const customW        = document.getElementById('custom-w');
const customH        = document.getElementById('custom-h');
const currentName    = document.getElementById('current-preset-name');
const presetCount    = document.getElementById('preset-count');

// ── Helpers ───────────────────────────────────────────────────────────────────

function enabledBuiltin() {
  return allBuiltinNames.filter(n => !config.disabledPresets?.includes(n) && !KNOWN_BAD_PRESETS.has(n));
}

function sendToViz(msg) {
  window.api.sendToViz(msg);
}

// Last raw levels received from the visualizer (pre-sensitivity scaling)
let lastVURaw = { bass: 0, mid: 0, treb: 0, overall: 0 };

function setVU(id, level) {
  const el = document.getElementById(id);
  if (el) el.style.transform = `scaleX(${Math.max(0, Math.min(1, level ?? 0))})`;
}

// tanh compression curve — maps [0,∞) → [0,1) asymptotically.
// Responds to sensitivity but never hard-clips: at high sensitivity the bar
// pushes near full while still showing dynamics, rather than pinning at 100%.
//   sens=1, raw=0.3  → ~42%    sens=3, raw=0.3  → ~83%
//   sens=5, raw=0.3  → ~97%    sens=5, raw=0.1  → ~80%  (still visible range)
function vuCompress(raw, sens) {
  return Math.tanh(raw * sens * 1.5);
}

// Apply sensitivity scaling to the stored raw levels and update all VU bars.
// Called both on incoming audio-levels messages and on sensitivity slider change.
function applyVUGains() {
  const sens = Number(sensitivitySlider?.value ?? 1);
  setVU('vu-bass',        vuCompress(lastVURaw.bass,    sens));
  setVU('vu-mid',         vuCompress(lastVURaw.mid,     sens));
  setVU('vu-treb',        vuCompress(lastVURaw.treb,    sens));
  setVU('vu-sensitivity', vuCompress(lastVURaw.overall, sens));
}

function persistConfig() {
  if (!isInitialized) return;
  config.cycleEnabled       = cycleEnabled.checked;
  config.cycleInterval      = Number(cycleInterval.value);
  config.importedEnabled    = importedEnabled.checked;
  config.importedChance     = importedChance.value;
  config.mixGenerated       = mixGeneratedCheck.checked;
  config.mixGeneratedChance = mixGeneratedChance.value;
  config.favCycleEnabled    = favCycleCheck?.checked ?? false;
  config.favCycleChance     = favCycleChance?.value ?? '0.20';
  config.blendTime       = Number(blendTime.value);
  config.brightSkip      = true;
  config.darkSkip        = true;
  config.perfSkip        = perfSkipCheckbox?.checked  ?? false;
  config.perfThreshold   = perfThresholdSelect?.value ?? '150';
  config.beatSyncEnabled = beatSyncCheckbox?.checked ?? false;
  config.beatDivisor     = beatDivisorSelect?.value ?? '4';
  config.eqBass = Number(eqBassSlider?.value ?? 0);
  config.eqMid  = Number(eqMidSlider?.value  ?? 0);
  config.eqTreb = Number(eqTrebSlider?.value ?? 0);
  window.api.saveConfig(config);
}

// ── Preset loading ────────────────────────────────────────────────────────────

async function loadPreset(name, isCustom = false) {
  // Exit Hydra mode when a butterchurn preset is loaded
  if (hydraMode) {
    hydraMode = false;
    sendToViz({ type: 'exit-hydra-mode' });
  }
  currentPresetName = name;
  document.querySelectorAll('.preset-item').forEach(el => {
    el.classList.toggle('active', el.dataset.name === name);
  });

  const blend = Number(blendTime.value) || 2;

  if (isCustom) {
    const item = customPresets.find(p => p.id === name || p.name === name);
    if (!item) return;
    try {
      const raw = await window.api.readPresetFile(item.filePath);
      const preset = JSON.parse(raw);
      sendToViz({ type: 'load-preset-data', name, preset, blendTime: blend });
    } catch (e) {
      console.error('Failed to load custom preset:', e);
    }
  } else {
    sendToViz({ type: 'load-preset', name, blendTime: blend });
  }

  restartCycleTimer();
}

function nextPreset() {
  const pool = enabledBuiltin();
  if (!pool.length) return;
  const idx = pool.indexOf(currentPresetName);
  const next = pool[(idx + 1) % pool.length];
  loadPreset(next, false);
}

function randomPreset() {
  const builtins    = enabledBuiltin();
  const customs     = customPresets;
  const importedOn  = importedEnabled?.checked ?? true;
  const importedPct = (importedOn && customs.length) ? Number(importedChance?.value ?? 0.20) : 0;

  // ── Favorites weighted pick ───────────────────────────────────────────
  const favOn  = favCycleCheck?.checked ?? false;
  const favPct = favOn && favorites.size ? Number(favCycleChance?.value ?? 0.20) : 0;
  if (favPct > 0 && Math.random() < favPct) {
    const favPool = [...favorites].filter(id =>
      builtins.includes(id) || customs.some(p => p.id === id || p.name === id)
    );
    if (favPool.length) {
      const id = favPool[Math.floor(Math.random() * favPool.length)];
      const isCustom = customs.some(p => p.id === id || p.name === id);
      loadPreset(id, isCustom);
      return;
    }
  }

  if (!builtins.length && !customs.length) return;

  // No customs, or imported disabled — always pick builtin
  if (!customs.length || importedPct === 0) {
    if (!builtins.length) return;
    loadPreset(builtins[Math.floor(Math.random() * builtins.length)], false);
    return;
  }

  // No builtins — always pick custom
  if (!builtins.length) {
    const p = customs[Math.floor(Math.random() * customs.length)];
    loadPreset(p.id, true);
    return;
  }

  // Weighted pick: importedPct chance of imported, rest goes to builtins
  if (Math.random() < importedPct) {
    const p = customs[Math.floor(Math.random() * customs.length)];
    loadPreset(p.id, true);
  } else {
    loadPreset(builtins[Math.floor(Math.random() * builtins.length)], false);
  }
}

// cycleNext: used by timer + beat sync — occasionally fires Generate New
function cycleNext() {
  if (hydraMode) return; // never interrupt a Hydra session via auto-cycle
  if (mixGeneratedCheck.checked && Math.random() < Number(mixGeneratedChance.value)) {
    sendToViz({ type: 'generate-glitch-preset', mode: 'new', blendTime: Number(blendTime.value) || 2 });
  } else {
    randomPreset();
  }
}

// ── Auto-cycle ────────────────────────────────────────────────────────────────

function restartCycleTimer() {
  clearInterval(cycleTimer);
  if (!cycleEnabled.checked) return;
  const secs = Number(cycleInterval.value) || 15;
  cycleTimer = setInterval(() => cycleNext(), secs * 1000);
}

// ── Brightness / darkness auto-skip — always enabled, no UI toggle ────────────

// ── GPU performance monitor ────────────────────────────────────────────────────

const perfSkipCheckbox    = document.getElementById('perf-skip-check');
const perfThresholdSelect = document.getElementById('perf-threshold');
const perfBar             = document.getElementById('perf-bar');
const perfLabel           = document.getElementById('perf-label');

function updatePerfThresholdLabels() {
  if (!perfThresholdSelect) return;
  const targetFps = Number(fpsCapSelect?.value ?? 60);
  perfThresholdSelect.querySelectorAll('option').forEach(opt => {
    const pct      = Number(opt.value);
    const triggerFps = Math.round(targetFps * 100 / pct);
    opt.textContent = `${pct}% — drops below ${triggerFps} fps`;
  });
}

document.getElementById('open-low-fps-log')?.addEventListener('click', () => {
  window.api.openLowFpsLog();
});

perfSkipCheckbox?.addEventListener('change', () => {
  sendToViz({ type: 'set-perf-skip', enabled: perfSkipCheckbox.checked, threshold: Number(perfThresholdSelect?.value ?? 150) });
  config.perfSkip = perfSkipCheckbox.checked;
  persistConfig();
});

perfThresholdSelect?.addEventListener('change', () => {
  sendToViz({ type: 'set-perf-threshold', threshold: Number(perfThresholdSelect.value) });
  config.perfThreshold = perfThresholdSelect.value;
  persistConfig();
});

// ── Beat sync ─────────────────────────────────────────────────────────────────

const beatSyncCheckbox = document.getElementById('beat-sync-enabled');
const beatDivisorSelect = document.getElementById('beat-divisor');
const bpmDisplay = document.getElementById('bpm-display');
let beatCounter = 0;
let lastBpmUpdate = 0;

function updateBpmDisplay(bpm, confidence) {
  if (!bpmDisplay) return;
  bpmDisplay.textContent = `${bpm} BPM`;
  // Color-code by confidence: green = high, yellow = medium, red = low
  if (confidence >= 0.65)      bpmDisplay.style.color = '#4caf50';
  else if (confidence >= 0.35) bpmDisplay.style.color = '#f0c040';
  else                         bpmDisplay.style.color = '#e05050';
}

document.getElementById('btn-reset-bpm')?.addEventListener('click', () => {
  sendToViz({ type: 'reset-bpm' });
  if (bpmDisplay) { bpmDisplay.textContent = '— BPM'; bpmDisplay.style.color = ''; }
  beatCounter = 0;
});

beatSyncCheckbox?.addEventListener('change', () => {
  const enabled = beatSyncCheckbox.checked;
  sendToViz({ type: enabled ? 'beat-sync-enable' : 'beat-sync-disable' });
  if (!enabled) bpmDisplay.textContent = '— BPM';
  beatCounter = 0;
  config.beatSyncEnabled = enabled;
  persistConfig();
});

beatDivisorSelect?.addEventListener('change', () => {
  beatCounter = 0;
  config.beatDivisor = beatDivisorSelect.value;
  persistConfig();
});

// ── Preset list rendering ─────────────────────────────────────────────────────

function renderBuiltinList() {
  const query = searchInput.value.toLowerCase();
  // Exclude Classic presets whose name also appears in the library (avoid duplicates)
  const libraryNames = new Set(customPresets.filter(p => p.category).map(p => p.name));
  filteredBuiltin = allBuiltinNames.filter(n => !libraryNames.has(n) && !KNOWN_BAD_PRESETS.has(n) && n.toLowerCase().includes(query));

  // Categorized presets (from disk library) that match the search
  const libPresets = customPresets.filter(p => p.category &&
    (p.name.toLowerCase().includes(query) ||
     (p.category    || '').toLowerCase().includes(query) ||
     (p.subcategory || '').toLowerCase().includes(query)));

  presetList.innerHTML = '';
  presetCount.textContent = filteredBuiltin.length + libPresets.length;

  // ── Original butterchurn presets ──
  if (filteredBuiltin.length) {
    const hdr = document.createElement('li');
    hdr.className = 'preset-category-header depth-1';
    const catKey = '__classic__';
    const isCollapsed = collapsedCategories.has(catKey);
    hdr.innerHTML = `<span class="cat-chevron">${isCollapsed ? '▶' : '▾'}</span><span class="cat-label">Classic (${filteredBuiltin.length})</span>`;
    hdr.addEventListener('click', () => {
      if (collapsedCategories.has(catKey)) collapsedCategories.delete(catKey);
      else collapsedCategories.add(catKey);
      renderBuiltinList();
    });
    presetList.appendChild(hdr);

    if (!isCollapsed) {
      for (const name of filteredBuiltin) {
        const disabled = config.disabledPresets?.includes(name);
        const li = document.createElement('li');
        li.className = 'preset-item' + (disabled ? ' disabled' : '') + (name === currentPresetName ? ' active' : '');
        li.dataset.name = name;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'preset-toggle';
        checkbox.checked = !disabled;
        checkbox.title = disabled ? 'Enable preset' : 'Disable preset';
        checkbox.addEventListener('change', (e) => { e.stopPropagation(); togglePreset(name, checkbox.checked); });

        const span = document.createElement('span');
        span.className = 'preset-name';
        span.textContent = name;

        const actions = document.createElement('div');
        actions.className = 'preset-actions';
        const loadBtn = document.createElement('button');
        loadBtn.className = 'btn-load';
        loadBtn.textContent = 'Load';
        loadBtn.addEventListener('click', (e) => { e.stopPropagation(); loadPreset(name, false); });
        actions.appendChild(loadBtn);

        li.appendChild(checkbox);
        li.appendChild(span);
        li.appendChild(makeFavBtn(name));
        li.appendChild(actions);
        li.addEventListener('click', () => loadPreset(name, false));
        presetList.appendChild(li);
      }
    }
  }

  // ── Library presets (categorized, from disk) ──
  if (libPresets.length) {
    const catMap = new Map();
    for (const item of libPresets) {
      if (!catMap.has(item.category)) catMap.set(item.category, new Map());
      const sub = item.subcategory || '';
      if (!catMap.get(item.category).has(sub)) catMap.get(item.category).set(sub, []);
      catMap.get(item.category).get(sub).push(item);
    }

    for (const [cat, subMap] of [...catMap].sort(([a], [b]) => a.localeCompare(b))) {
      const catCollapsed = collapsedCategories.has(cat);
      presetList.appendChild(makeCategoryHeader(cat, cat, 1));
      if (!catCollapsed) {
        for (const [sub, items] of [...subMap].sort(([a], [b]) => a.localeCompare(b))) {
          if (sub) {
            const subKey = `${cat}/${sub}`;
            const subCollapsed = collapsedCategories.has(subKey);
            presetList.appendChild(makeCategoryHeader(sub, subKey, 2));
            if (!subCollapsed) for (const item of items) presetList.appendChild(makePresetItem(item));
          } else {
            for (const item of items) presetList.appendChild(makePresetItem(item));
          }
        }
      }
    }
  }
}

// Collapsed state for category/subcategory headers — persists across re-renders
const collapsedCategories = new Set();

function makePresetItem(item) {
  const li = document.createElement('li');
  li.className = 'preset-item' + (item.id === currentPresetName ? ' active' : '');
  li.dataset.name = item.id;

  const span = document.createElement('span');
  span.className = 'preset-name';
  span.textContent = item.name;

  const actions = document.createElement('div');
  actions.className = 'preset-actions';

  const loadBtn = document.createElement('button');
  loadBtn.className = 'btn-load';
  loadBtn.textContent = 'Load';
  loadBtn.addEventListener('click', (e) => { e.stopPropagation(); loadPreset(item.id, true); });

  const delBtn = document.createElement('button');
  delBtn.className = 'btn-danger';
  delBtn.textContent = '✕';
  delBtn.title = 'Delete preset';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.api.deleteCustomPreset(item.filePath);
    customPresets = await window.api.getCustomPresets();
    renderCustomList();
  });

  actions.appendChild(loadBtn);
  actions.appendChild(delBtn);
  li.appendChild(span);
  li.appendChild(makeFavBtn(item.id));
  li.appendChild(actions);
  li.addEventListener('click', () => loadPreset(item.id, true));
  return li;
}

function makeCategoryHeader(label, key, depth) {
  const li = document.createElement('li');
  li.className = `preset-category-header depth-${depth}`;
  li.dataset.catKey = key;
  const isCollapsed = collapsedCategories.has(key);
  li.innerHTML = `<span class="cat-chevron">${isCollapsed ? '▶' : '▾'}</span><span class="cat-label">${label}</span>`;
  li.addEventListener('click', () => {
    if (collapsedCategories.has(key)) collapsedCategories.delete(key);
    else collapsedCategories.add(key);
    renderList();
  });
  return li;
}

function renderCustomList() {
  const query = searchInput.value.toLowerCase();
  // Custom tab shows only root-level presets (no category) — generated + manually imported
  const filtered = customPresets.filter(p =>
    !p.category && p.name.toLowerCase().includes(query)
  );

  presetList.innerHTML = '';
  presetCount.textContent = filtered.length;

  if (!filtered.length) {
    const li = document.createElement('li');
    li.style.cssText = 'padding:16px;color:#6e6e73;font-size:12px;text-align:center';
    li.textContent = 'No custom presets yet. Generated presets and imported files appear here.';
    presetList.appendChild(li);
    return;
  }

  // Separate root-level (no category) from categorised presets
  const rootItems = filtered.filter(p => !p.category);
  const categorised = filtered.filter(p => p.category);

  // Root-level items (generated presets, manually imported flat files)
  for (const item of rootItems) presetList.appendChild(makePresetItem(item));

  // Group by category → subcategory
  const catMap = new Map(); // category → Map(subcategory → items[])
  for (const item of categorised) {
    if (!catMap.has(item.category)) catMap.set(item.category, new Map());
    const subMap = catMap.get(item.category);
    const subKey = item.subcategory || '';
    if (!subMap.has(subKey)) subMap.set(subKey, []);
    subMap.get(subKey).push(item);
  }

  for (const [cat, subMap] of [...catMap].sort(([a], [b]) => a.localeCompare(b))) {
    const catCollapsed = collapsedCategories.has(cat);
    presetList.appendChild(makeCategoryHeader(cat, cat, 1));

    if (!catCollapsed) {
      for (const [sub, items] of [...subMap].sort(([a], [b]) => a.localeCompare(b))) {
        if (sub) {
          const subKey = `${cat}/${sub}`;
          const subCollapsed = collapsedCategories.has(subKey);
          presetList.appendChild(makeCategoryHeader(sub, subKey, 2));
          if (!subCollapsed) {
            for (const item of items) presetList.appendChild(makePresetItem(item));
          }
        } else {
          // Items directly in category with no subcategory
          for (const item of items) presetList.appendChild(makePresetItem(item));
        }
      }
    }
  }
}

function renderFavoritesList() {
  const query = searchInput.value.toLowerCase();
  presetList.innerHTML = '';

  // Gather all favorited presets from both builtin and custom
  const favItems = [];
  for (const id of favorites) {
    if (allBuiltinNames.includes(id)) {
      favItems.push({ id, name: id, isBuiltin: true });
    } else {
      const cp = customPresets.find(p => p.id === id || p.name === id);
      if (cp) favItems.push({ ...cp, isBuiltin: false });
    }
  }

  const filtered = favItems.filter(p => p.name.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));

  presetCount.textContent = filtered.length;

  if (!filtered.length) {
    const li = document.createElement('li');
    li.style.cssText = 'padding:16px;color:#6e6e73;font-size:12px;text-align:center';
    li.textContent = favorites.size === 0
      ? 'No favorites yet. Click ⭐ on any preset to save it here.'
      : 'No favorites match your search.';
    presetList.appendChild(li);
    return;
  }

  for (const item of filtered) {
    const li = document.createElement('li');
    const isActive = item.id === currentPresetName || item.name === currentPresetName;
    li.className = 'preset-item' + (isActive ? ' active' : '');
    li.dataset.name = item.id;

    const span = document.createElement('span');
    span.className = 'preset-name';
    span.textContent = item.name;

    const actions = document.createElement('div');
    actions.className = 'preset-actions';
    const loadBtn = document.createElement('button');
    loadBtn.className = 'btn-load';
    loadBtn.textContent = 'Load';
    loadBtn.addEventListener('click', (e) => { e.stopPropagation(); loadPreset(item.id, !item.isBuiltin); });
    actions.appendChild(loadBtn);

    li.appendChild(span);
    li.appendChild(makeFavBtn(item.id));
    li.appendChild(actions);
    li.addEventListener('click', () => loadPreset(item.id, !item.isBuiltin));
    presetList.appendChild(li);
  }
}

function renderHydraList() {
  const query = searchInput.value.toLowerCase();
  const list = document.getElementById('preset-list');
  list.innerHTML = '';

  const filtered = hydraPresets.filter(p => p.name.toLowerCase().includes(query));
  if (!filtered.length) {
    const li = document.createElement('li');
    li.className = 'preset-empty';
    li.textContent = 'No Hydra presets found';
    list.appendChild(li);
    return;
  }

  filtered.forEach(p => {
    const li = document.createElement('li');
    li.className = 'preset-item';
    if (p.name === currentPresetName) li.classList.add('active');
    const span = document.createElement('span');
    span.textContent = p.name;
    li.appendChild(span);
    li.addEventListener('click', () => {
      loadHydraPreset(p);
    });
    list.appendChild(li);
  });
}

// ── Hydra code editor state ───────────────────────────────────────────────────
let currentHydraPreset = null; // { id, name, code } of the loaded preset
const hydraCodeEl   = document.getElementById('hydra-code');
const hydraStatusEl = document.getElementById('hydra-editor-status');

function setEditorStatus(msg, type = '') {
  if (!hydraStatusEl) return;
  hydraStatusEl.textContent  = msg;
  hydraStatusEl.className    = `hydra-editor-status ${type}`;
}

function populateEditor(p) {
  if (hydraCodeEl) hydraCodeEl.value = p.code || '';
  setEditorStatus('');
}

function loadHydraPreset(p) {
  hydraMode          = true;
  currentPresetName  = p.name;
  currentHydraPreset = p;
  populateEditor(p);
  sendToViz({ type: 'load-hydra-preset', name: p.name, code: p.code });
  renderList();
}

// ▶ Run — execute whatever is in the editor right now
document.getElementById('btn-hydra-run')?.addEventListener('click', () => {
  const code = hydraCodeEl?.value?.trim();
  if (!code) return;
  hydraMode = true;
  sendToViz({ type: 'load-hydra-preset', name: currentHydraPreset?.name || 'Custom', code });
  setEditorStatus('Running…', '');
  setTimeout(() => setEditorStatus(''), 1200);
});

// ↩ Reset — restore the saved version of the current preset
document.getElementById('btn-hydra-reset')?.addEventListener('click', () => {
  if (!currentHydraPreset) return;
  populateEditor(currentHydraPreset);
  sendToViz({ type: 'load-hydra-preset', name: currentHydraPreset.name, code: currentHydraPreset.code });
  setEditorStatus('Reset to saved', 'ok');
  setTimeout(() => setEditorStatus(''), 1500);
});

// 💾 Save — overwrite current preset file
document.getElementById('btn-hydra-save')?.addEventListener('click', () => {
  const code = hydraCodeEl?.value?.trim();
  if (!code || !currentHydraPreset) { setEditorStatus('No preset loaded', 'error'); return; }
  const updated = { ...currentHydraPreset, code };
  window.api.saveHydraPreset({ id: currentHydraPreset.id, name: currentHydraPreset.name, code })
    .then(() => {
      currentHydraPreset = updated;
      // Update in-memory list
      const idx = hydraPresets.findIndex(p => p.id === updated.id);
      if (idx >= 0) hydraPresets[idx] = updated;
      setEditorStatus('Saved ✓', 'ok');
      setTimeout(() => setEditorStatus(''), 1500);
    })
    .catch(err => setEditorStatus(`Save failed: ${err.message}`, 'error'));
});

// ＋ Save As — create a new preset with a new name
document.getElementById('btn-hydra-save-as')?.addEventListener('click', () => {
  const code = hydraCodeEl?.value?.trim();
  if (!code) { setEditorStatus('Nothing to save', 'error'); return; }
  const name = prompt('Name for new preset:', currentHydraPreset ? `${currentHydraPreset.name} copy` : 'My Preset');
  if (!name) return;
  window.api.saveHydraPreset({ id: null, name, code })
    .then(saved => {
      hydraPresets.push(saved);
      currentHydraPreset = saved;
      currentPresetName  = saved.name;
      renderList();
      setEditorStatus(`Saved as "${saved.name}" ✓`, 'ok');
      setTimeout(() => setEditorStatus(''), 2000);
    })
    .catch(err => setEditorStatus(`Save failed: ${err.message}`, 'error'));
});

// Cmd/Ctrl+Enter shortcut to run from editor
hydraCodeEl?.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('btn-hydra-run')?.click();
  }
  // Tab key → insert 2 spaces instead of losing focus
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = hydraCodeEl.selectionStart;
    const v = hydraCodeEl.value;
    hydraCodeEl.value = v.slice(0, s) + '  ' + v.slice(hydraCodeEl.selectionEnd);
    hydraCodeEl.selectionStart = hydraCodeEl.selectionEnd = s + 2;
  }
});

function renderList() {
  if (currentTab === 'builtin') renderBuiltinList();
  else if (currentTab === 'favorites') renderFavoritesList();
  else if (currentTab === 'hydra') renderHydraList();
  else renderCustomList();
}

// ── Toggle preset enabled/disabled ───────────────────────────────────────────

function togglePreset(name, enabled) {
  if (!config.disabledPresets) config.disabledPresets = [];
  if (enabled) {
    config.disabledPresets = config.disabledPresets.filter(n => n !== name);
  } else {
    if (!config.disabledPresets.includes(name)) config.disabledPresets.push(name);
  }
  // Update item class
  const item = presetList.querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (item) item.classList.toggle('disabled', !enabled);
  persistConfig();
}

// ── Audio devices ─────────────────────────────────────────────────────────────

const systemAudioNotice = document.getElementById('system-audio-notice');

async function populateAudioDevices() {
  // Always seed the dropdown with a working default first
  audioDevice.innerHTML = '';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = 'mic';
  defaultOpt.textContent = 'Default Microphone';
  audioDevice.appendChild(defaultOpt);

  // System Audio option (macOS 13+ / ScreenCaptureKit)
  const sysOpt = document.createElement('option');
  sysOpt.value = '__system__';
  sysOpt.textContent = 'System Audio (macOS 13+, needs permission)';
  audioDevice.appendChild(sysOpt);

  // Restore previously selected source
  if (config.audioSource) audioDevice.value = config.audioSource;
  if (systemAudioNotice) systemAudioNotice.style.display = audioDevice.value === '__system__' ? 'block' : 'none';

  // Try to enumerate real devices
  try {
    // getUserMedia triggers the OS permission prompt; if it fails we still
    // have the default option above so the UI isn't broken.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    // Stop the test stream immediately — we just needed the permission grant
    stream.getTracks().forEach(t => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === 'audioinput');

    for (const d of inputs) {
      // Skip duplicates (some drivers expose same device twice)
      if ([...audioDevice.options].some(o => o.value === d.deviceId)) continue;
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Audio Input (${d.deviceId.slice(0, 8)})`;
      audioDevice.appendChild(opt);
    }
    // Re-apply saved selection after real devices are appended
    if (config.audioSource) audioDevice.value = config.audioSource;
    if (systemAudioNotice) systemAudioNotice.style.display = audioDevice.value === '__system__' ? 'block' : 'none';
  } catch (e) {
    console.warn('Audio device enumeration failed:', e.message);
    // Default option is still there, user can still click Connect
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

document.getElementById('btn-random').addEventListener('click', () => {
  randomPreset();
  beatCounter = 0; // reset beat-sync counter so next cycle starts fresh
});

// Show/hide system audio notice when dropdown changes
audioDevice.addEventListener('change', () => {
  if (systemAudioNotice) systemAudioNotice.style.display = audioDevice.value === '__system__' ? 'block' : 'none';
});

document.getElementById('btn-start-audio').addEventListener('click', () => {
  const deviceId = audioDevice.value;
  config.audioSource = deviceId;
  sendToViz({ type: 'start-audio', deviceId });
  persistConfig();
  // Hide the "not connected" warning once user hits Connect
  const warn = document.getElementById('audio-source-warn');
  if (warn) warn.style.display = 'none';
});

const sensitivitySlider = document.getElementById('sensitivity');
const sensitivityVal = document.getElementById('sensitivity-val');
sensitivitySlider.addEventListener('input', () => {
  const v = Number(sensitivitySlider.value);
  sensitivityVal.textContent = v.toFixed(1);
  config.sensitivity = v;
  sendToViz({ type: 'set-sensitivity', value: v });
  applyVUGains(); // immediately rescale VU display
  persistConfig();
});

// ── 3-Band EQ ─────────────────────────────────────────────────────────────────

const GENRE_PRESETS = {
  flat:      { bass:  0, mid:  0, treb:  0, sens: 1.0 },
  edm:       { bass:  9, mid:  2, treb:  7, sens: 1.4 },
  classical: { bass: -3, mid:  5, treb:  3, sens: 0.7 },
  rock:      { bass:  6, mid:  7, treb:  4, sens: 1.2 },
  jazz:      { bass:  1, mid:  9, treb:  3, sens: 0.9 },
};

const eqBassSlider = document.getElementById('eq-bass');
const eqMidSlider  = document.getElementById('eq-mid');
const eqTrebSlider = document.getElementById('eq-treb');
const eqBassVal    = document.getElementById('eq-bass-val');
const eqMidVal     = document.getElementById('eq-mid-val');
const eqTrebVal    = document.getElementById('eq-treb-val');
const genreBtns    = document.querySelectorAll('.btn-genre');

function sendEQ() {
  const bass = Number(eqBassSlider.value);
  const mid  = Number(eqMidSlider.value);
  const treb = Number(eqTrebSlider.value);
  eqBassVal.textContent = (bass >= 0 ? '+' : '') + bass;
  eqMidVal.textContent  = (mid  >= 0 ? '+' : '') + mid;
  eqTrebVal.textContent = (treb >= 0 ? '+' : '') + treb;
  config.eqBass = bass;
  config.eqMid  = mid;
  config.eqTreb = treb;
  sendToViz({ type: 'set-audio-eq', bass, mid, treb });
}

function applyGenrePreset(genre) {
  const p = GENRE_PRESETS[genre];
  if (!p) return;
  eqBassSlider.value = p.bass;
  eqMidSlider.value  = p.mid;
  eqTrebSlider.value = p.treb;
  sensitivitySlider.value = p.sens;
  sensitivityVal.textContent = p.sens.toFixed(1);
  config.sensitivity = p.sens;
  config.activeGenre = genre;
  sendToViz({ type: 'set-sensitivity', value: p.sens });
  sendEQ();
  persistConfig();
  genreBtns.forEach(b => b.classList.toggle('active', b.dataset.genre === genre));
}

eqBassSlider.addEventListener('input', () => { config.activeGenre = null; genreBtns.forEach(b => b.classList.remove('active')); sendEQ(); persistConfig(); });
eqMidSlider.addEventListener('input',  () => { config.activeGenre = null; genreBtns.forEach(b => b.classList.remove('active')); sendEQ(); persistConfig(); });
eqTrebSlider.addEventListener('input', () => { config.activeGenre = null; genreBtns.forEach(b => b.classList.remove('active')); sendEQ(); persistConfig(); });

genreBtns.forEach(btn => {
  btn.addEventListener('click', () => applyGenrePreset(btn.dataset.genre));
});

cycleEnabled.addEventListener('change', () => { persistConfig(); restartCycleTimer(); });
cycleInterval.addEventListener('change', () => { persistConfig(); restartCycleTimer(); });
importedEnabled.addEventListener('change',   () => { persistConfig(); updateCycleWeighting(); });
importedChance.addEventListener('change',    () => { persistConfig(); updateCycleWeighting(); });
mixGeneratedCheck.addEventListener('change', () => { persistConfig(); updateCycleWeighting(); });
mixGeneratedChance.addEventListener('change',() => { persistConfig(); updateCycleWeighting(); });
favCycleCheck?.addEventListener('change',    () => { persistConfig(); updateCycleWeighting(); });
favCycleChance?.addEventListener('change',   () => { persistConfig(); updateCycleWeighting(); });
blendTime.addEventListener('change', persistConfig);

// Grey out other cycle pools when one is set to 100%
function updateCycleWeighting() {
  const favIs100      = (favCycleCheck?.checked)    && favCycleChance?.value   === '1.00';
  const importedIs100 = (importedEnabled?.checked)  && importedChance?.value   === '1.00';
  const genIs100      = (mixGeneratedCheck?.checked) && mixGeneratedChance?.value === '1.00';

  const lockImported = favIs100 || genIs100;
  const lockGen      = favIs100 || importedIs100;
  const lockFav      = importedIs100 || genIs100;

  setRowDisabled(importedEnabled,   importedChance,   lockImported);
  setRowDisabled(mixGeneratedCheck, mixGeneratedChance, lockGen);
  setRowDisabled(favCycleCheck,     favCycleChance,   lockFav);
}

function setRowDisabled(checkbox, select, disabled) {
  if (!checkbox || !select) return;
  // Don't disable the row that IS the 100% one — only the others
  const isThe100 = checkbox.checked && select.value === '1.00';
  if (isThe100) return;
  const el = checkbox.closest('.row');
  if (el) el.style.opacity = disabled ? '0.35' : '';
  checkbox.disabled = disabled;
  select.disabled   = disabled;
}
updateCycleWeighting();

searchInput.addEventListener('input', renderList);

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTab = btn.dataset.tab;
    // Leaving Hydra tab → restore butterchurn
    if (currentTab !== 'hydra' && hydraMode) {
      hydraMode = false;
      sendToViz({ type: 'exit-hydra-mode' });
    }
    document.getElementById('hydra-params').classList.toggle('hidden', currentTab !== 'hydra');
    document.getElementById('hydra-editor').classList.toggle('hidden', currentTab !== 'hydra');
    renderList();
  });
});

// ── Hydra parameter sliders ───────────────────────────────────────────────────
function setHydraSlider(n, val) {
  const slider = document.getElementById(`hp${n}`);
  const label  = document.getElementById(`hp${n}-val`);
  if (!slider) return;
  slider.value = val;
  label.textContent = val.toFixed(2);
  sendToViz({ type: 'set-hydra-param', key: `p${n}`, value: val });
}

[1,2,3,4,5,6,7,8].forEach(n => {
  const slider = document.getElementById(`hp${n}`);
  if (!slider) return;
  slider.addEventListener('input', () => setHydraSlider(n, parseFloat(slider.value)));
});

document.getElementById('btn-hydra-randomize')?.addEventListener('click', () => {
  [1,2,3,4,5,6,7,8].forEach(n => setHydraSlider(n, Math.round(Math.random() * 100) / 100));
});

resPreset.addEventListener('change', () => {
  customResRow.classList.toggle('hidden', resPreset.value !== 'custom');
});

document.getElementById('btn-apply-res').addEventListener('click', () => {
  let w, h;
  if (resPreset.value === 'custom') {
    w = Number(customW.value);
    h = Number(customH.value);
  } else {
    [w, h] = resPreset.value.split('x').map(Number);
  }
  if (w && h) {
    window.api.setVizSize(w, h);
    config.outputWidth = w;
    config.outputHeight = h;
    persistConfig();
  }
});

document.getElementById('btn-import').addEventListener('click', async () => {
  const imported = await window.api.importPresets();
  if (imported.length) {
    customPresets = await window.api.getCustomPresets();
    // Register with visualizer so it can play them without re-reading disk
    for (const item of customPresets) {
      try {
        const raw = await window.api.readPresetFile(item.filePath);
        const preset = JSON.parse(raw);
        sendToViz({ type: 'register-custom-preset', name: item.name, preset });
      } catch (_) {}
    }
    if (currentTab === 'custom') renderList();
    // Switch to custom tab to show the new imports
    document.querySelector('[data-tab="custom"]').click();
  }
});

// ── MIDI ──────────────────────────────────────────────────────────────────────

let midiAccess = null;
let midiLearnTarget = null; // 'random' | 'sensitivity' | 'randomizeParams' | null
let midiMappings = {};

const midiStatusEl         = document.getElementById('midi-status');
const midiLabelRandom      = document.getElementById('midi-label-random');
const midiLabelGenerate    = document.getElementById('midi-label-generate');
const midiLabelSensitivity = document.getElementById('midi-label-sensitivity');
const midiLabelRandomize   = document.getElementById('midi-label-randomize');
const midiLabelStrobe      = document.getElementById('midi-label-strobe');
const midiLabelBlackStrobe = document.getElementById('midi-label-black-strobe');
const midiLabelBlackout    = document.getElementById('midi-label-blackout');
const midiLabelShake       = document.getElementById('midi-label-shake');
const midiLabelZoomPunch   = document.getElementById('midi-label-zoom-punch');
const midiLabelColorCrush  = document.getElementById('midi-label-color-crush');
const midiLabelTunnel      = document.getElementById('midi-label-tunnel');
const midiLabelRandomText  = document.getElementById('midi-label-random-text');
const learnRandomBtn       = document.getElementById('midi-learn-random');
const learnGenerateBtn     = document.getElementById('midi-learn-generate');
const learnSensitivityBtn  = document.getElementById('midi-learn-sensitivity');
const learnRandomizeBtn    = document.getElementById('midi-learn-randomize');
const learnStrobeBtn       = document.getElementById('midi-learn-strobe');
const learnBlackStrobeBtn  = document.getElementById('midi-learn-black-strobe');
const learnBlackoutBtn     = document.getElementById('midi-learn-blackout');
const learnShakeBtn        = document.getElementById('midi-learn-shake');
const learnZoomPunchBtn    = document.getElementById('midi-learn-zoom-punch');
const learnColorCrushBtn   = document.getElementById('midi-learn-color-crush');
const learnTunnelBtn       = document.getElementById('midi-learn-tunnel');

function midiMappingLabel(m) {
  if (!m) return '—';
  if (m.type === 'note') return `Ch${m.channel + 1} Note ${m.note}`;
  if (m.type === 'cc')   return `Ch${m.channel + 1} CC ${m.cc}`;
  return '—';
}

function updateMidiLabels() {
  midiLabelRandom.textContent      = midiMappingLabel(midiMappings.random);
  midiLabelSensitivity.textContent = midiMappingLabel(midiMappings.sensitivity);
  if (midiLabelRandomize)   midiLabelRandomize.textContent   = midiMappingLabel(midiMappings.randomizeParams);
  if (midiLabelGenerate)    midiLabelGenerate.textContent    = midiMappingLabel(midiMappings.generateNew);
  if (midiLabelStrobe)      midiLabelStrobe.textContent      = midiMappingLabel(midiMappings.strobe);
  if (midiLabelBlackStrobe) midiLabelBlackStrobe.textContent = midiMappingLabel(midiMappings.blackStrobe);
  if (midiLabelBlackout)    midiLabelBlackout.textContent    = midiMappingLabel(midiMappings.blackout);
  if (midiLabelShake)       midiLabelShake.textContent       = midiMappingLabel(midiMappings.shake);
  if (midiLabelZoomPunch)   midiLabelZoomPunch.textContent   = midiMappingLabel(midiMappings.zoomPunch);
  if (midiLabelColorCrush)  midiLabelColorCrush.textContent  = midiMappingLabel(midiMappings.colorCrush);
  if (midiLabelTunnel)      midiLabelTunnel.textContent      = midiMappingLabel(midiMappings.tunnel);
  if (midiLabelRandomText)  midiLabelRandomText.textContent  = midiMappingLabel(midiMappings.randomText);
}

function setLearnMode(target) {
  midiLearnTarget = target;
  const btns = {
    random:          learnRandomBtn,
    generateNew:     learnGenerateBtn,
    sensitivity:     learnSensitivityBtn,
    randomizeParams: learnRandomizeBtn,
    strobe:          learnStrobeBtn,
    blackStrobe:     learnBlackStrobeBtn,
    blackout:        learnBlackoutBtn,
    shake:           learnShakeBtn,
    zoomPunch:       learnZoomPunchBtn,
    colorCrush:      learnColorCrushBtn,
    tunnel:          learnTunnelBtn,
    randomText:      document.getElementById('midi-learn-random-text'),
  };
  Object.entries(btns).forEach(([key, btn]) => {
    if (!btn) return;
    btn.classList.toggle('learning', target === key);
    btn.textContent = target === key ? 'Listening…' : 'Learn';
  });
}

function handleMidiMessage(event) {
  const [status, data1, data2] = event.data;
  const type    = status & 0xF0;
  const channel = status & 0x0F;

  if (midiLearnTarget) {
    if (type === 0x90 && data2 > 0) {
      midiMappings[midiLearnTarget] = { type: 'note', channel, note: data1 };
      config.midiMappings = midiMappings;
      persistConfig();
    } else if (type === 0xB0) {
      midiMappings[midiLearnTarget] = { type: 'cc', channel, cc: data1 };
      config.midiMappings = midiMappings;
      persistConfig();
    } else {
      return; // ignore other message types during learn
    }
    setLearnMode(null);
    updateMidiLabels();
    return;
  }

  // Random preset: note-on or CC (non-zero value)
  const mr = midiMappings.random;
  if (mr && channel === mr.channel && data2 > 0) {
    if ((mr.type === 'note' && type === 0x90 && data1 === mr.note) ||
        (mr.type === 'cc'   && type === 0xB0 && data1 === mr.cc)) {
      randomPreset();
    }
  }

  // Generate new preset: note-on or CC
  const mg = midiMappings.generateNew;
  if (mg && channel === mg.channel && data2 > 0) {
    if ((mg.type === 'note' && type === 0x90 && data1 === mg.note) ||
        (mg.type === 'cc'   && type === 0xB0 && data1 === mg.cc)) {
      sendToViz({ type: 'generate-glitch-preset', mode: 'new', blendTime: Number(blendTime.value) || 2 });
      restartCycleTimer();
      beatCounter = 0;
    }
  }

  // Randomize params: note-on or CC
  const mrp = midiMappings.randomizeParams;
  if (mrp && channel === mrp.channel && data2 > 0) {
    if ((mrp.type === 'note' && type === 0x90 && data1 === mrp.note) ||
        (mrp.type === 'cc'   && type === 0xB0 && data1 === mrp.cc)) {
      sendToViz({ type: 'generate-glitch-preset', mode: 'randomize' });
    }
  }

  // Glitch effects: note-on or CC
  const glitchMap = { strobe: triggerStrobe, blackStrobe: triggerBlackStrobe, blackout: triggerBlackout, shake: triggerShake, zoomPunch: triggerZoomPunch, colorCrush: triggerColorCrush, tunnel: triggerTunnel };
  for (const [key, fn] of Object.entries(glitchMap)) {
    const m = midiMappings[key];
    if (m && channel === m.channel && data2 > 0) {
      if ((m.type === 'note' && type === 0x90 && data1 === m.note) ||
          (m.type === 'cc'   && type === 0xB0 && data1 === m.cc)) {
        fn();
      }
    }
  }

  // Random text: note-on or CC
  const mrt = midiMappings.randomText;
  if (mrt && channel === mrt.channel && data2 > 0) {
    if ((mrt.type === 'note' && type === 0x90 && data1 === mrt.note) ||
        (mrt.type === 'cc'   && type === 0xB0 && data1 === mrt.cc)) {
      fetchAndShow();
    }
  }

  // Sensitivity: CC → map 0–127 to 0–5
  const ms = midiMappings.sensitivity;
  if (ms?.type === 'cc' && type === 0xB0 && channel === ms.channel && data1 === ms.cc) {
    const value = parseFloat(((data2 / 127) * 5).toFixed(1));
    sensitivitySlider.value = value;
    sensitivityVal.textContent = value.toFixed(1);
    config.sensitivity = value;
    sendToViz({ type: 'set-sensitivity', value });
    persistConfig();
  }
}

function attachMidiInputs() {
  midiAccess.inputs.forEach(input => { input.onmidimessage = handleMidiMessage; });
}

async function initMidi() {
  try {
    midiAccess = await navigator.requestMIDIAccess();
    attachMidiInputs();
    midiAccess.onstatechange = attachMidiInputs;
    const count = midiAccess.inputs.size;
    midiStatusEl.textContent = count ? `${count} device${count > 1 ? 's' : ''} connected` : 'No devices';
    midiStatusEl.style.color = count ? '#30d158' : '#6e6e73';
    midiAccess.onstatechange = () => {
      attachMidiInputs();
      const n = midiAccess.inputs.size;
      midiStatusEl.textContent = n ? `${n} device${n > 1 ? 's' : ''} connected` : 'No devices';
      midiStatusEl.style.color = n ? '#30d158' : '#6e6e73';
    };
  } catch (e) {
    midiStatusEl.textContent = 'Not available';
  }
}

learnRandomBtn.addEventListener('click', () => {
  setLearnMode(midiLearnTarget === 'random' ? null : 'random');
});
learnSensitivityBtn.addEventListener('click', () => {
  setLearnMode(midiLearnTarget === 'sensitivity' ? null : 'sensitivity');
});
document.getElementById('midi-clear-random').addEventListener('click', () => {
  delete midiMappings.random;
  config.midiMappings = midiMappings;
  persistConfig();
  updateMidiLabels();
});
document.getElementById('midi-clear-sensitivity').addEventListener('click', () => {
  delete midiMappings.sensitivity;
  config.midiMappings = midiMappings;
  persistConfig();
  updateMidiLabels();
});

if (learnGenerateBtn) {
  learnGenerateBtn.addEventListener('click', () => {
    setLearnMode(midiLearnTarget === 'generateNew' ? null : 'generateNew');
  });
  document.getElementById('midi-clear-generate').addEventListener('click', () => {
    delete midiMappings.generateNew;
    config.midiMappings = midiMappings;
    persistConfig();
    updateMidiLabels();
  });
}

if (learnRandomizeBtn) {
  learnRandomizeBtn.addEventListener('click', () => {
    setLearnMode(midiLearnTarget === 'randomizeParams' ? null : 'randomizeParams');
  });
  document.getElementById('midi-clear-randomize').addEventListener('click', () => {
    delete midiMappings.randomizeParams;
    config.midiMappings = midiMappings;
    persistConfig();
    updateMidiLabels();
  });
}

// Random text MIDI learn/clear
{
  const learnBtn = document.getElementById('midi-learn-random-text');
  const clearBtn = document.getElementById('midi-clear-random-text');
  learnBtn?.addEventListener('click', () => {
    setLearnMode(midiLearnTarget === 'randomText' ? null : 'randomText');
  });
  clearBtn?.addEventListener('click', () => {
    delete midiMappings.randomText;
    config.midiMappings = midiMappings;
    persistConfig();
    updateMidiLabels();
  });
}

// Glitch effect MIDI learn/clear buttons
const glitchMidiKeys = ['strobe', 'blackStrobe', 'blackout', 'shake', 'zoomPunch', 'colorCrush', 'tunnel'];
const glitchMidiIds  = ['strobe', 'black-strobe', 'blackout', 'shake', 'zoom-punch', 'color-crush', 'tunnel'];
glitchMidiKeys.forEach((key, i) => {
  const id = glitchMidiIds[i];
  document.getElementById(`midi-learn-${id}`)?.addEventListener('click', () => {
    setLearnMode(midiLearnTarget === key ? null : key);
  });
  document.getElementById(`midi-clear-${id}`)?.addEventListener('click', () => {
    delete midiMappings[key];
    config.midiMappings = midiMappings;
    persistConfig();
    updateMidiLabels();
  });
});

// ── Performance controls ──────────────────────────────────────────────────────

const fpsCapSelect    = document.getElementById('fps-cap');
const meshQualitySelect = document.getElementById('mesh-quality');
const qualityStatus   = document.getElementById('quality-status');

fpsCapSelect.addEventListener('change', () => {
  const fps = Number(fpsCapSelect.value);
  config.fpsCap = fps;
  sendToViz({ type: 'set-fps-cap', fps });
  updatePerfThresholdLabels();
  persistConfig();
});

meshQualitySelect.addEventListener('change', () => {
  const quality = meshQualitySelect.value;
  config.meshQuality = quality;
  qualityStatus.textContent = 'Applying…';
  sendToViz({ type: 'set-quality', quality });
  persistConfig();
  // Clear status after a moment
  setTimeout(() => { qualityStatus.textContent = ''; }, 1500);
});

// ── Output window visibility + display routing ────────────────────────────────

const vizVisibleCheckbox = document.getElementById('viz-visible');
const displaySelect      = document.getElementById('display-select');

vizVisibleCheckbox.addEventListener('change', () => {
  window.api.setVizVisible(vizVisibleCheckbox.checked);
  config.vizVisible = vizVisibleCheckbox.checked;
  persistConfig();
});

async function populateDisplays() {
  const displays = await window.api.getDisplays();
  displaySelect.innerHTML = '';
  for (const d of displays) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.label;
    if (!d.isPrimary) opt.selected = true; // pre-select secondary
    displaySelect.appendChild(opt);
  }
}

document.getElementById('btn-send-display').addEventListener('click', async () => {
  const id = Number(displaySelect.value);
  await window.api.setVizVisible(true);
  vizVisibleCheckbox.checked = true;
  config.vizVisible = true;
  await window.api.sendToDisplay(id);
  persistConfig();
});

document.getElementById('btn-exit-fullscreen').addEventListener('click', () => {
  window.api.toggleVizFullscreen();
});

// ── Syphon controls ───────────────────────────────────────────────────────────

const syphonCheckbox = document.getElementById('syphon-enabled');
const syphonNameInput = document.getElementById('syphon-name');
const syphonStatusEl = document.getElementById('syphon-status');

async function updateSyphonStatus() {
  const s = await window.api.syphonStatus();
  if (!s.available) {
    syphonStatusEl.textContent = 'Syphon addon not available';
    syphonStatusEl.style.color = '#ff453a';
    syphonCheckbox.disabled = true;
    return;
  }
  if (s.running) {
    syphonStatusEl.textContent = `Broadcasting as "${syphonNameInput.value}"`;
    syphonStatusEl.style.color = '#30d158';
  } else {
    syphonStatusEl.textContent = 'Not running';
    syphonStatusEl.style.color = '#6e6e73';
  }
}

async function startSyphon() {
  const result = await window.api.syphonStart(syphonNameInput.value || 'AV Club VJ');
  if (result.ok) {
    sendToViz({ type: 'syphon-enable' });
  } else {
    syphonStatusEl.textContent = `Error: ${result.error}`;
    syphonStatusEl.style.color = '#ff453a';
    syphonCheckbox.checked = false;
  }
  updateSyphonStatus();
  config.syphonEnabled = syphonCheckbox.checked;
  config.syphonName = syphonNameInput.value;
  persistConfig();
}

syphonCheckbox.addEventListener('change', async () => {
  if (syphonCheckbox.checked) {
    await startSyphon();
  } else {
    sendToViz({ type: 'syphon-disable' });
    await window.api.syphonStop();
    updateSyphonStatus();
    config.syphonEnabled = false;
    persistConfig();
  }
});

// ── Syphon Overlay controls (transparent alpha channel) ───────────────────────

const syphonOverlayCheckbox = document.getElementById('syphon-overlay-enabled');
const syphonOverlayNameInput = document.getElementById('syphon-overlay-name');
const syphonOverlayStatusEl = document.getElementById('syphon-overlay-status');

async function startSyphonOverlay() {
  const name = syphonOverlayNameInput?.value.trim() || 'AV Club VJ Overlay';
  const result = await window.api.syphonOverlayStart?.(name);
  if (!result) return;
  if (result.ok) {
    sendToViz({ type: 'syphon-overlay-enable' });
    syphonOverlayStatusEl.textContent = `Broadcasting as "${name}"`;
    syphonOverlayStatusEl.style.color = '#30d158';
  } else {
    syphonOverlayStatusEl.textContent = `Error: ${result.error}`;
    syphonOverlayStatusEl.style.color = '#ff453a';
    syphonOverlayCheckbox.checked = false;
  }
}

async function stopSyphonOverlay() {
  sendToViz({ type: 'syphon-overlay-disable' });
  await window.api.syphonOverlayStop?.();
  syphonOverlayStatusEl.textContent = 'Off — broadcasts overlays with transparent background';
  syphonOverlayStatusEl.style.color = '#6e6e73';
}

syphonOverlayCheckbox?.addEventListener('change', async () => {
  if (syphonOverlayCheckbox.checked) {
    await startSyphonOverlay();
  } else {
    await stopSyphonOverlay();
  }
  config.syphonOverlayEnabled = syphonOverlayCheckbox.checked;
  config.syphonOverlayName = syphonOverlayNameInput?.value || 'AV Club VJ Overlay';
  persistConfig();
});

// Rename while running: restart overlay server with new name
syphonOverlayNameInput?.addEventListener('change', async () => {
  config.syphonOverlayName = syphonOverlayNameInput.value || 'AV Club VJ Overlay';
  persistConfig();
  if (syphonOverlayCheckbox.checked) {
    await stopSyphonOverlay();
    await startSyphonOverlay();
  }
});

// ── NDI controls ──────────────────────────────────────────────────────────────

const ndiCheckbox   = document.getElementById('ndi-enabled');
const ndiNameInput  = document.getElementById('ndi-name');
const ndiStatusEl   = document.getElementById('ndi-status');

async function updateNdiStatus() {
  const s = await window.api.ndiStatus();
  if (!s.available) {
    ndiStatusEl.textContent = 'NDI addon not available';
    ndiStatusEl.style.color = '#ff453a';
    ndiCheckbox.disabled = true;
    return;
  }
  if (s.running) {
    ndiStatusEl.textContent = `Broadcasting as "${ndiNameInput.value}"`;
    ndiStatusEl.style.color = '#30d158';
  } else {
    ndiStatusEl.textContent = 'Not running';
    ndiStatusEl.style.color = '#6e6e73';
  }
}

async function startNdi() {
  const result = await window.api.ndiStart(ndiNameInput.value || 'AV Club VJ');
  if (!result.ok) {
    ndiStatusEl.textContent = `Error: ${result.error}`;
    ndiStatusEl.style.color = '#ff453a';
    ndiCheckbox.checked = false;
  }
  updateNdiStatus();
  config.ndiEnabled = ndiCheckbox.checked;
  config.ndiName = ndiNameInput.value;
  persistConfig();
}

ndiCheckbox.addEventListener('change', async () => {
  if (ndiCheckbox.checked) {
    await startNdi();
  } else {
    await window.api.ndiStop();
    updateNdiStatus();
    config.ndiEnabled = false;
    persistConfig();
  }
});

// Receive messages from visualizer
window.api.onMessage((msg) => {
  if (msg.type === 'current-preset') {
    currentPresetName = msg.name;
    currentName.textContent = msg.name;
    document.querySelectorAll('.preset-item').forEach(el => {
      el.classList.toggle('active', el.dataset.name === msg.name);
    });
    const saveNameInput = document.getElementById('save-preset-name');
    if (saveNameInput && !saveNameInput.value) saveNameInput.placeholder = `Save as "${msg.name}"…`;
    if (msg.baseVals) updateParamSliders(msg.baseVals);
    // Populate code view and cache originals
    _origFrameEqs = msg.frameEqs || '';
    _origPixelEqs = msg.pixelEqs || '';
    updateCodeView(msg.frameEqs, msg.pixelEqs, msg.initEqs);
  }

  if (msg.type === 'preset-code-update') {
    updateCodeView(msg.frameEqs, msg.pixelEqs);
  }

  if (msg.type === 'brightness-alert') {
    if (!hydraMode) randomPreset();
  }

  if (msg.type === 'darkness-alert') {
    if (!hydraMode) randomPreset();
  }

  if (msg.type === 'perf-update') {
    const { loadPct, actualFps, targetFps } = msg;
    const health = Math.min(1, actualFps / targetFps);
    // Update existing perf bar if present
    if (perfBar) {
      perfBar.style.transform = `scaleX(${health})`;
      perfBar.style.background = health > 0.8 ? 'var(--accent-light)' : health > 0.5 ? '#f0904a' : '#e05050';
    }
    if (perfLabel) perfLabel.textContent = `${actualFps} / ${targetFps} fps`;
    // Header pill
    const dot  = document.getElementById('perf-dot');
    const fps  = document.getElementById('perf-fps');
    if (fps)  fps.textContent = `${actualFps} fps`;
    if (dot) {
      dot.classList.toggle('warn', health <= 0.8 && health > 0.5);
      dot.classList.toggle('crit', health <= 0.5);
    }
  }

  if (msg.type === 'perf-skip') {
    if (!hydraMode) randomPreset();
  }

  if (msg.type === 'audio-levels') {
    lastVURaw.bass    = msg.bass;
    lastVURaw.mid     = msg.mid;
    lastVURaw.treb    = msg.treb;
    lastVURaw.overall = msg.overall;
    applyVUGains();
    // Once we receive audio levels, audio is definitely connected — hide the warning
    const warn = document.getElementById('audio-source-warn');
    if (warn && warn.style.display !== 'none') warn.style.display = 'none';
  }

  if (msg.type === 'beat-tick') {
    if (msg.bpm > 0) updateBpmDisplay(msg.bpm, msg.confidence ?? 0);
    beatCounter++;
    const divisor = Number(beatDivisorSelect?.value) || 4;
    if (beatCounter >= divisor) {
      beatCounter = 0;
      cycleNext();
    }
  }

  if (msg.type === 'bpm-update') {
    if (msg.bpm > 0) updateBpmDisplay(msg.bpm, msg.confidence ?? 0);
  }

  if (msg.type === 'preset-load-error') {
    // Preset failed to load — silently pick another random one (not during Hydra)
    console.warn('[AV Club VJ] Preset failed:', msg.name, '\nReason:', msg.error || '(unknown)');
    if (!hydraMode) randomPreset();
  }

  if (msg.type === 'preset-for-save') {
    const saveNameInput = document.getElementById('save-preset-name');
    const name = (saveNameInput?.value.trim()) || msg.preset?.name || `Preset_${Date.now()}`;
    window.api.saveGeneratedPreset(name, msg.preset).then(savedName => {
      // Add to custom presets list and notify visualizer
      customPresets.push({ name: savedName, filePath: null, ext: '.json' });
      sendToViz({ type: 'register-custom-preset', name: savedName, preset: msg.preset });
      renderList();
      if (saveNameInput) saveNameInput.value = '';
      alert(`Preset saved as "${savedName}" in your Custom tab.`);
    }).catch(e => {
      console.error('Save failed:', e);
      alert('Failed to save preset: ' + e.message);
    });
  }

  // ── Remote control commands ──────────────────────────────────────────────
  if (msg.type === 'remote-random-preset') {
    randomPreset();
    beatCounter = 0;
    restartCycleTimer();
  }

  if (msg.type === 'remote-next-preset') {
    const pool = enabledBuiltin();
    if (!pool.length) return;
    const idx  = pool.indexOf(currentPresetName);
    loadPreset(pool[(idx + 1) % pool.length], false);
  }

  if (msg.type === 'remote-prev-preset') {
    const pool = enabledBuiltin();
    if (!pool.length) return;
    const idx  = pool.indexOf(currentPresetName);
    loadPreset(pool[(idx - 1 + pool.length) % pool.length], false);
  }

  if (msg.type === 'remote-set-cycle') {
    if (cycleEnabled) cycleEnabled.checked = msg.enabled;
    if (cycleInterval && msg.interval) cycleInterval.value = msg.interval;
    restartCycleTimer();
  }

  if (msg.type === 'remote-set-blend') {
    if (blendTime) blendTime.value = msg.blendTime;
  }

  if (msg.type === 'remote-generate-preset') {
    sendToViz({ type: 'generate-glitch-preset', mode: 'new', blendTime: Number(blendTime?.value) || 2 });
    restartCycleTimer();
    beatCounter = 0;
  }

  if (msg.type === 'remote-set-beat-sync') {
    if (beatSyncCheckbox) beatSyncCheckbox.checked = msg.enabled;
    if (beatDivisorSelect && msg.divisor) beatDivisorSelect.value = String(msg.divisor);
  }

  if (msg.type === 'remote-set-sensitivity') {
    if (sensitivitySlider) {
      sensitivitySlider.value = msg.value;
      if (sensitivityVal) sensitivityVal.textContent = Number(msg.value).toFixed(1);
      sendToViz({ type: 'set-sensitivity', value: msg.value });
      applyVUGains();
    }
  }

  if (msg.type === 'remote-set-eq') {
    if (eqBassSlider) eqBassSlider.value = msg.bass;
    if (eqMidSlider)  eqMidSlider.value  = msg.mid;
    if (eqTrebSlider) eqTrebSlider.value = msg.treb;
    sendEQ();
  }

  if (msg.type === 'remote-set-genre') {
    document.querySelectorAll('.btn-genre').forEach(btn => btn.classList.toggle('active', btn.dataset.genre === msg.genre));
    sendToViz({ type: 'set-genre', genre: msg.genre });
  }

  if (msg.type === 'remote-set-imported') {
    if (importedEnabled) importedEnabled.checked = msg.enabled;
    if (importedChance && msg.chance !== undefined) importedChance.value = String(msg.chance);
  }

  if (msg.type === 'remote-set-mix-generated') {
    if (mixGeneratedCheck) mixGeneratedCheck.checked = msg.enabled;
    if (mixGeneratedChance && msg.chance !== undefined) mixGeneratedChance.value = String(msg.chance);
  }

  if (msg.type === 'remote-set-favorites') {
    if (favCycleCheck) favCycleCheck.checked = msg.enabled;
    if (favCycleChance && msg.chance !== undefined) favCycleChance.value = String(msg.chance);
  }

  if (msg.type === 'remote-set-bright-skip') {
    sendToViz({ type: 'set-brightness-skip', enabled: true });
  }

  if (msg.type === 'remote-set-dark-skip') {
    sendToViz({ type: 'set-darkness-skip', enabled: true });
  }

  if (msg.type === 'remote-set-fps-cap') {
    if (fpsCapSelect) { fpsCapSelect.value = String(msg.fps); sendToViz({ type: 'set-fps-cap', fps: msg.fps }); }
  }

  if (msg.type === 'remote-set-mesh-quality') {
    if (meshQualitySelect) { meshQualitySelect.value = msg.quality; sendToViz({ type: 'set-quality', quality: msg.quality }); }
  }

  if (msg.type === 'remote-set-perf-skip') {
    if (perfSkipCheckbox) perfSkipCheckbox.checked = msg.enabled;
    if (perfThresholdSelect && msg.threshold) perfThresholdSelect.value = String(msg.threshold);
    sendToViz({ type: 'set-perf-skip', enabled: msg.enabled, threshold: msg.threshold ?? Number(perfThresholdSelect?.value) });
  }

  if (msg.type === 'qr-overlay-status') {
    const btn        = document.getElementById('btn-audience-qr-overlay');
    const intervalEl = document.getElementById('qr-interval-controls');
    qrOverlayOn = msg.enabled;
    if (btn) {
      btn.textContent = msg.showing
        ? '📺 QR On Screen — click to stop'
        : (msg.enabled ? '📺 QR Scheduled — click to stop' : '📺 Show QR on Screen');
    }
    if (intervalEl) intervalEl.style.display = msg.enabled ? 'block' : 'none';
  }

  if (msg.type === 'trivia-answer') {
    triviaHandleAnswer(msg);
    // Mark team as answered
    if (msg.team && triviaParticipants.has(msg.team)) {
      triviaParticipants.get(msg.team).answeredThisQ = true;
    }
    return;
  }

  if (msg.type === 'trivia-team-reg') {
    if (msg.name && !triviaParticipants.has(msg.name)) {
      triviaParticipants.set(msg.name, { token: msg.token, answeredThisQ: false });
      updateTriviaParticipants();
    }
    return;
  }

  if (msg.type === 'ctrl-theme') {
    applyTheme(msg.light, false); // false = don't re-broadcast
    localStorage.setItem('ctrl_theme', msg.light ? 'light' : 'dark');
    return;
  }

  if (msg.type === 'ctrl-trivia-q') {
    currentTriviaQ = msg.question;
    triviaUpdateQuestionDisplay();
    return;
  }

  if (msg.type === 'ctrl-trivia-scores') {
    triviaScores.clear();
    if (Array.isArray(msg.scores)) msg.scores.forEach(([k, v]) => triviaScores.set(k, v));
    triviaUpdateScoreboard();
    return;
  }

  if (msg.type === 'audience-message') {
    if (msg.approved) {
      // Unmoderated — add to queue directly
      const audienceFeedEnabled = document.getElementById('feed-audience-toggle')?.checked ?? true;
      if (audienceFeedEnabled) sendToViz({ type: 'marquee-queue-add', text: msg.text });
    } else {
      // Moderated — add to approval queue
      addToAudienceQueue(msg.id, msg.text);
    }
  }

  if (msg.type === 'remote-feed-start') {
    const feedIntervalEl = document.getElementById('feed-interval');
    if (feedIntervalEl && msg.interval != null) feedIntervalEl.value = String(msg.interval);
    startFeeds();
  }

  if (msg.type === 'remote-feed-stop') {
    stopFeeds();
    sendToViz({ type: 'marquee-stop' });
  }

  if (msg.type === 'remote-feed-now') {
    const chuckInput = document.getElementById('feed-chuck-name');
    const closeInput = document.getElementById('feed-close-time');
    if (chuckInput && msg.chuckName) chuckInput.value = msg.chuckName;
    if (closeInput && msg.closeTime) closeInput.value = msg.closeTime;
    (async () => {
      let text = null;
      if (msg.feed === 'closetime') {
        text = getCloseTimeText();
      } else {
        const params = {};
        if (msg.feed === 'chuck') params.name = msg.chuckName || chuckInput?.value?.trim() || 'Chuck Norris';
        text = await window.api.fetchFeed(msg.feed, params);
      }
      if (text) sendToViz({ type: 'marquee-play-once', text, config: marqueeConfigFromUI() });
    })();
  }

  if (msg.type === 'remote-set-marquee-config') {
    const { speed, fontSize, color, bgAlpha, position } = msg;
    if (speed !== undefined) { const e = document.getElementById('marquee-speed'); if (e) { e.value = speed; const v = document.getElementById('marquee-speed-val'); if (v) v.textContent = speed; } }
    if (fontSize !== undefined) { const e = document.getElementById('marquee-size'); if (e) { e.value = fontSize; const v = document.getElementById('marquee-size-val'); if (v) v.textContent = fontSize + 'px'; } }
    if (color !== undefined) { const e = document.getElementById('marquee-color'); if (e) e.value = color; }
    if (bgAlpha !== undefined) { const e = document.getElementById('marquee-bg-alpha'); if (e) { e.value = bgAlpha; const v = document.getElementById('marquee-bg-alpha-val'); if (v) v.textContent = Math.round(bgAlpha * 100) + '%'; } }
    if (position !== undefined) { const e = document.getElementById('marquee-position'); if (e) e.value = position; }
    sendMarqueeConfig();
  }

  if (msg.type === 'remote-set-logos-enabled') {
    const e = document.getElementById('logos-enabled');
    if (e) { e.checked = msg.enabled; sendToViz({ type: 'logos-enabled', enabled: msg.enabled }); }
  }

  if (msg.type === 'remote-set-logo-timing') {
    if (msg.duration) { const e = document.getElementById('logo-global-duration'); if (e) e.value = String(msg.duration); }
    if (msg.interval) { const e = document.getElementById('logo-global-interval'); if (e) e.value = String(msg.interval); }
    sendToViz({ type: 'logo-global-config', durationSecs: msg.duration, intervalMins: msg.interval });
  }

  if (msg.type === 'remote-set-custom-messages') {
    customMessages = Array.isArray(msg.messages) ? msg.messages : [];
    renderCustomMsgList();
  }

  if (msg.type === 'remote-set-logo-cfg') {
    const o = venueLogos[msg.id];
    if (o) {
      if (msg.visibility !== null && msg.visibility !== undefined) o.visibility = msg.visibility;
      if (msg.bounce    !== null && msg.bounce    !== undefined) o.bounce = msg.bounce;
      sendToViz({ type: 'logo-update', id: msg.id, cfg: { ...o } });
    }
  }

  if (msg.type === 'remote-trivia-new-question') {
    document.getElementById('btn-trivia-start')?.click();
  }
  if (msg.type === 'remote-trivia-reveal-answer') {
    document.getElementById('btn-trivia-reveal')?.click();
  }
  if (msg.type === 'remote-trivia-show-scores') {
    document.getElementById('btn-trivia-scores')?.click();
  }
  if (msg.type === 'remote-trivia-clear-screen') {
    document.getElementById('btn-trivia-hide')?.click();
  }
  if (msg.type === 'remote-trivia-reset-teams') {
    document.getElementById('btn-trivia-reset-teams')?.click();
  }
  if (msg.type === 'remote-trivia-reset-scores') {
    document.getElementById('btn-trivia-reset')?.click();
  }
  if (msg.type === 'remote-trivia-play-custom') {
    if (msg.question) playCustomTriviaQuestion(msg.question);
  }
  if (msg.type === 'ctrl-custom-trivia-updated') {
    if (Array.isArray(msg.questions)) {
      customTriviaQuestions = msg.questions;
      renderCustomTriviaList();
    }
  }
});

// ── Preset Editor ─────────────────────────────────────────────────────────────

const PARAM_DEFS = [
  // Motion
  { key: 'zoom',          label: 'Zoom',       min: 0.4,  max: 2.0,  step: 0.01,  group: 'Motion' },
  { key: 'rot',           label: 'Rotation',   min: -1.0, max: 1.0,  step: 0.005, group: 'Motion' },
  { key: 'cx',            label: 'Center X',   min: 0,    max: 1,    step: 0.01,  group: 'Motion' },
  { key: 'cy',            label: 'Center Y',   min: 0,    max: 1,    step: 0.01,  group: 'Motion' },
  { key: 'dx',            label: 'Drift X',    min: -0.3, max: 0.3,  step: 0.005, group: 'Motion' },
  { key: 'dy',            label: 'Drift Y',    min: -0.3, max: 0.3,  step: 0.005, group: 'Motion' },
  // Warp
  { key: 'warp',          label: 'Warp',       min: 0,    max: 10,   step: 0.1,   group: 'Warp' },
  { key: 'warpscale',     label: 'Scale',      min: 0.1,  max: 5,    step: 0.05,  group: 'Warp' },
  { key: 'warpanimspeed', label: 'Speed',      min: 0.01, max: 5,    step: 0.05,  group: 'Warp' },
  // Color
  { key: 'decay',         label: 'Decay',      min: 0.7,  max: 1.0,  step: 0.002, group: 'Color' },
  { key: 'gammaadj',      label: 'Gamma',      min: 0.1,  max: 4.0,  step: 0.05,  group: 'Color' },
  // Echo
  { key: 'echo_zoom',     label: 'Echo Zoom',  min: 0.5,  max: 4.0,  step: 0.05,  group: 'Echo' },
  { key: 'echo_alpha',    label: 'Echo Alpha', min: 0,    max: 1,    step: 0.01,  group: 'Echo' },
];

const paramGroups = [...new Set(PARAM_DEFS.map(p => p.group))];
const paramSliders = {}; // key → { slider, valEl }
let paramDebounceTimer = null;

function buildParamUI() {
  const container = document.getElementById('param-groups');
  if (!container) return;
  container.innerHTML = '';

  paramGroups.forEach(group => {
    const groupEl = document.createElement('div');
    groupEl.className = 'param-group';

    const label = document.createElement('div');
    label.className = 'param-group-label';
    label.textContent = group;
    groupEl.appendChild(label);

    PARAM_DEFS.filter(p => p.group === group).forEach(p => {
      const row = document.createElement('div');
      row.className = 'param-row';

      const lbl = document.createElement('span');
      lbl.className = 'param-label';
      lbl.textContent = p.label;

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'param-slider';
      slider.min = p.min;
      slider.max = p.max;
      slider.step = p.step;
      slider.value = (p.min + p.max) / 2;

      const valEl = document.createElement('span');
      valEl.className = 'param-val';
      valEl.textContent = slider.value;

      slider.addEventListener('input', () => {
        valEl.textContent = Number(slider.value).toFixed(3).replace(/\.?0+$/, '');
        clearTimeout(paramDebounceTimer);
        paramDebounceTimer = setTimeout(sendParamUpdate, 80);
      });

      row.appendChild(lbl);
      row.appendChild(slider);
      row.appendChild(valEl);
      groupEl.appendChild(row);

      paramSliders[p.key] = { slider, valEl };
    });

    container.appendChild(groupEl);
  });
}

function updateParamSliders(baseVals) {
  if (!baseVals) return;
  PARAM_DEFS.forEach(p => {
    const entry = paramSliders[p.key];
    if (!entry) return;
    const v = baseVals[p.key];
    if (v != null) {
      entry.slider.value = v;
      entry.valEl.textContent = Number(v).toFixed(3).replace(/\.?0+$/, '');
    }
  });
}

function sendParamUpdate() {
  const baseVals = {};
  PARAM_DEFS.forEach(p => {
    const entry = paramSliders[p.key];
    if (entry) baseVals[p.key] = Number(entry.slider.value);
  });
  sendToViz({ type: 'update-preset-params', baseVals });
}

// ── Glitch effects ────────────────────────────────────────────────────────────

function glitchFlash(id) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.classList.add('glitch-flash');
  setTimeout(() => btn.classList.remove('glitch-flash'), 120);
}

function triggerStrobe() {
  sendToViz({ type: 'strobe' });
  const btn = document.getElementById('btn-strobe');
  if (btn) { btn.classList.add('strobe-flash'); setTimeout(() => btn.classList.remove('strobe-flash'), 120); }
}
function triggerShake()      { sendToViz({ type: 'shake' });       glitchFlash('btn-shake'); }
function triggerZoomPunch()  { sendToViz({ type: 'zoom-punch' });  glitchFlash('btn-zoom-punch'); }
function triggerColorCrush() { sendToViz({ type: 'color-crush' }); glitchFlash('btn-color-crush'); }

function triggerBlackStrobe() { sendToViz({ type: 'black-strobe' }); glitchFlash('btn-strobe-black'); }

let blackoutActive = false;
function triggerBlackout() {
  blackoutActive = !blackoutActive;
  sendToViz({ type: 'blackout', active: blackoutActive });
  const btn = document.getElementById('btn-blackout');
  if (btn) btn.classList.toggle('blackout-active', blackoutActive);
}
function triggerTunnel()     { sendToViz({ type: 'tunnel' });      glitchFlash('btn-tunnel'); }

// Hold-to-strobe: fires every 80ms while held down, single fire on click
(function setupHoldStrobe(btnId, triggerFn) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  let interval = null;
  let didHold = false;
  btn.addEventListener('mousedown', () => {
    didHold = false;
    triggerFn();
    interval = setInterval(() => { didHold = true; triggerFn(); }, 80);
  });
  const stop = () => { clearInterval(interval); interval = null; };
  btn.addEventListener('mouseup',    stop);
  btn.addEventListener('mouseleave', stop);
  // Prevent the click event from double-firing on short press
  btn.addEventListener('click', e => { if (didHold) e.stopImmediatePropagation(); });
})('btn-strobe',       triggerStrobe);
(function setupHoldStrobe(btnId, triggerFn) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  let interval = null;
  let didHold = false;
  btn.addEventListener('mousedown', () => {
    didHold = false;
    triggerFn();
    interval = setInterval(() => { didHold = true; triggerFn(); }, 80);
  });
  const stop = () => { clearInterval(interval); interval = null; };
  btn.addEventListener('mouseup',    stop);
  btn.addEventListener('mouseleave', stop);
  btn.addEventListener('click', e => { if (didHold) e.stopImmediatePropagation(); });
})('btn-strobe-black', triggerBlackStrobe);
document.getElementById('btn-blackout')?.addEventListener('click', triggerBlackout);
document.getElementById('btn-shake')?.addEventListener('click', triggerShake);
document.getElementById('btn-zoom-punch')?.addEventListener('click', triggerZoomPunch);
document.getElementById('btn-color-crush')?.addEventListener('click', triggerColorCrush);
document.getElementById('btn-tunnel')?.addEventListener('click', triggerTunnel);

// Keyboard shortcuts — only when not typing in an input/textarea
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.code === 'Space') { e.preventDefault(); triggerStrobe(); }
  if (e.key === 'x' || e.key === 'X') { e.preventDefault(); triggerBlackStrobe(); }
  if (e.key === 'b' || e.key === 'B') { e.preventDefault(); triggerBlackout(); }
  if (e.key === '1')      { e.preventDefault(); triggerShake(); }
  if (e.key === '2')      { e.preventDefault(); triggerZoomPunch(); }
  if (e.key === '3')      { e.preventDefault(); triggerColorCrush(); }
  if (e.key === '4')      { e.preventDefault(); triggerTunnel(); }
});

// Buttons
document.getElementById('btn-randomize-params')?.addEventListener('click', () => {
  sendToViz({ type: 'generate-glitch-preset', mode: 'randomize' });
});
document.getElementById('btn-generate-preset')?.addEventListener('click', () => {
  sendToViz({ type: 'generate-glitch-preset', mode: 'new', blendTime: Number(blendTime.value) || 2 });
  restartCycleTimer(); // reset auto-cycle timer
  beatCounter = 0;    // reset beat-sync counter
});

// ── Code view ──────────────────────────────────────────────────────────────────

const codeView      = document.getElementById('code-view');
const codeFrameEqs  = document.getElementById('code-frame-eqs');
const codePixelEqs  = document.getElementById('code-pixel-eqs');
const codeInitEqs   = document.getElementById('code-init-eqs');
// Cache the original equations before any param-slider overrides
let _origFrameEqs = '';
let _origPixelEqs = '';

document.getElementById('btn-apply-code')?.addEventListener('click', () => {
  sendToViz({
    type: 'update-preset-code',
    frameEqs: codeFrameEqs.value,
    pixelEqs: codePixelEqs.value,
  });
  _origFrameEqs = codeFrameEqs.value;
  _origPixelEqs = codePixelEqs.value;
});

document.getElementById('btn-reset-code')?.addEventListener('click', () => {
  codeFrameEqs.value = _origFrameEqs;
  codePixelEqs.value = _origPixelEqs;
  sendToViz({
    type: 'update-preset-code',
    frameEqs: _origFrameEqs,
    pixelEqs: _origPixelEqs,
  });
});

function updateCodeView(frameEqs, pixelEqs, initEqs) {
  if (codeFrameEqs) codeFrameEqs.value = frameEqs || '';
  if (codePixelEqs) codePixelEqs.value = pixelEqs || '';
  if (codeInitEqs)  codeInitEqs.value  = initEqs  || '';
}

// Save
document.getElementById('btn-save-preset')?.addEventListener('click', () => {
  sendToViz({ type: 'get-preset-for-save' });
});

// ── Collapsible sections ───────────────────────────────────────────────────────

const DEFAULT_COLLAPSED = ['fx', 'params', 'code', 'scrolltext', 'logooverlay', 'trivia', 'cycle', 'audio', 'genre', 'midi', 'output', 'perf', 'syphon', 'ndi', 'presets', 'venue'];

function initCollapsible(collapsedSections) {
  const POPOUT_SEC = new URLSearchParams(location.search).get('popout');
  document.querySelectorAll('.section-toggle').forEach(toggle => {
    const sec = toggle.dataset.sec;
    const section = document.getElementById(`sec-${sec}`);
    if (!section) return;

    if (POPOUT_SEC) {
      // In popout mode, never collapse sections and don't add toggle listener
      section.classList.remove('collapsed');
      return;
    }

    // Apply saved or default collapsed state
    const isCollapsed = collapsedSections
      ? collapsedSections.includes(sec)
      : DEFAULT_COLLAPSED.includes(sec);
    if (isCollapsed) section.classList.add('collapsed');

    toggle.addEventListener('click', () => {
      section.classList.toggle('collapsed');
      const nowCollapsed = [...document.querySelectorAll('.collapsible-section.collapsed')]
        .map(el => el.id.replace('sec-', ''));
      config.collapsedSections = nowCollapsed;
      window.api.saveConfig(config);
    });
  });
}

// ── Live Text Feeds ────────────────────────────────────────────────────────────

let feedTimer      = null;
let feedRunning    = false;
let customMessages = []; // array of strings

function renderCustomMsgList() {
  const container = document.getElementById('custom-msg-list');
  if (!container) return;
  container.innerHTML = '';
  customMessages.forEach((msg, i) => {
    const row = document.createElement('div');
    row.className = 'custom-msg-row';
    row.innerHTML = `
      <span class="custom-msg-text">${msg.replace(/</g,'&lt;')}</span>
      <button class="custom-msg-now" data-index="${i}" title="Play now">→</button>
      <button class="custom-msg-remove" data-index="${i}" title="Remove">✕</button>
    `;
    container.appendChild(row);
  });
  container.querySelectorAll('.custom-msg-now').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = customMessages[parseInt(btn.dataset.index)];
      if (!text) return;
      setFeedStatus(`↳ ${text.length > 80 ? text.slice(0, 80) + '…' : text}`);
      sendToViz({ type: 'marquee-play-once', text, config: marqueeConfigFromUI() });
    });
  });
  container.querySelectorAll('.custom-msg-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      customMessages.splice(parseInt(btn.dataset.index), 1);
      renderCustomMsgList();
    });
  });
}

function getEnabledFeeds() {
  return [...document.querySelectorAll('.feed-toggle')]
    .filter(el => el.checked)
    .map(el => el.dataset.feed);
}

function getCloseTimeText() {
  const val = document.getElementById('feed-close-time')?.value || '02:00';
  const [closeH, closeM] = val.split(':').map(Number);
  const now = new Date();
  const close = new Date(now);
  close.setHours(closeH, closeM, 0, 0);
  if (close <= now) close.setDate(close.getDate() + 1);
  const diffMins = Math.round((close - now) / 60000);
  const h = Math.floor(diffMins / 60);
  const m = diffMins % 60;
  const timeStr = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (h === 0)      return `It's ${timeStr} — closes in ${m} minute${m !== 1 ? 's' : ''}`;
  if (m === 0)      return `It's ${timeStr} — closes in ${h} hour${h !== 1 ? 's' : ''}`;
  return `It's ${timeStr} — closes in ${h}h ${m}m`;
}

function customMsgsEnabled() {
  const chk = document.getElementById('custom-msgs-enabled');
  return !chk || chk.checked; // default enabled if checkbox missing
}

async function fetchOneFeed() {
  const enabledFeeds = getEnabledFeeds();

  // Build combined pool: audience submissions weighted 3x vs other feeds
  const pool = [];
  for (const f of enabledFeeds) {
    const entry = { type: 'feed', feed: f };
    const weight = f === 'audience' ? 3 : 1;
    for (let i = 0; i < weight; i++) pool.push(entry);
  }
  if (customMsgsEnabled()) {
    for (const t of customMessages) pool.push({ type: 'custom', text: t });
  }
  if (!pool.length) return null;

  // Shuffle and try up to 3 candidates until one returns content
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  for (const entry of shuffled.slice(0, 3)) {
    if (entry.type === 'custom') {
      if (entry.text) return entry.text;
      continue;
    }
    const feed = entry.feed;
    let text = null;
    if (feed === 'closetime') {
      text = getCloseTimeText();
    } else {
      const params = {};
      if (feed === 'chuck') {
        params.name = document.getElementById('feed-chuck-name')?.value?.trim() || 'Chuck Norris';
      }
      text = await window.api.fetchFeed(feed, params);
    }
    if (text) return text;
  }
  return null;
}

function setFeedStatus(msg) {
  const el = document.getElementById('feed-status');
  if (el) el.textContent = msg;
}

async function fetchAndShow() {
  setFeedStatus('Fetching…');
  const text = await fetchOneFeed();
  if (!text) { setFeedStatus('No content returned — check enabled feeds / API keys.'); return; }
  setFeedStatus(`↳ ${text.length > 80 ? text.slice(0, 80) + '…' : text}`);
  sendToViz({ type: 'marquee-play-once', text, config: marqueeConfigFromUI() });
}

async function startFeeds() {
  stopFeeds();
  feedRunning = true;
  const mins = parseFloat(document.getElementById('feed-interval')?.value ?? '5');

  if (mins <= 0) {
    // Continuous mode: pre-fetch a batch of messages and start a looping marquee
    setFeedStatus('Fetching for continuous mode…');
    const texts = [];
    const enabledFeeds = getEnabledFeeds();
    if (customMsgsEnabled()) texts.push(...customMessages);
    for (let i = 0; i < Math.min(5, enabledFeeds.length + 1); i++) {
      const t = await fetchOneFeed();
      if (t && !texts.includes(t)) texts.push(t);
    }
    if (!texts.length) { setFeedStatus('No content for continuous mode.'); return; }
    sendToViz({ type: 'marquee-start', messages: texts, loop: true, intervalMins: 0, config: marqueeConfigFromUI() });
    setFeedStatus('Continuous mode running…');
    return;
  }

  fetchAndShow(); // immediate first fetch
  feedTimer = setInterval(fetchAndShow, mins * 60000);
  setFeedStatus('Feeds running…');
}

function stopFeeds() {
  feedRunning = false;
  if (feedTimer) { clearInterval(feedTimer); feedTimer = null; }
}

document.getElementById('btn-feeds-start')?.addEventListener('click', startFeeds);
document.getElementById('btn-feeds-stop')?.addEventListener('click', () => {
  stopFeeds();
  sendToViz({ type: 'marquee-stop' });
  setFeedStatus('Feeds stopped.');
});

// Custom message add
function addCustomMessage() {
  const input = document.getElementById('custom-msg-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  customMessages.push(text);
  input.value = '';
  renderCustomMsgList();
}
document.getElementById('btn-add-custom-msg')?.addEventListener('click', addCustomMessage);
document.getElementById('custom-msg-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); addCustomMessage(); }
});

// Per-feed instant trigger buttons
document.querySelectorAll('.feed-now-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const feed = btn.dataset.feed;
    setFeedStatus('Fetching…');
    let text = null;
    if (feed === 'closetime') {
      text = getCloseTimeText();
    } else {
      const params = {};
      if (feed === 'chuck') params.name = document.getElementById('feed-chuck-name')?.value?.trim() || 'Chuck Norris';
      text = await window.api.fetchFeed(feed, params);
    }
    if (!text) { setFeedStatus('No content returned.'); return; }
    setFeedStatus(`↳ ${text.length > 80 ? text.slice(0, 80) + '…' : text}`);
    sendToViz({ type: 'marquee-play-once', text, config: marqueeConfigFromUI() });
  });
});

// ── Audience Messages ──────────────────────────────────────────────────────────

let _workerUrl = '';

function audienceSubmissionUrl(topic, submitUrl, workerUrl, ntfyToken) {
  const base = (submitUrl || '').trim() || 'https://corunography.github.io/avclubvj/';
  let url = base.replace(/\/$/, '') + '?t=' + topic;
  if (workerUrl)   url += '&w='  + encodeURIComponent(workerUrl);
  if (ntfyToken)   url += '&ak=' + encodeURIComponent(ntfyToken);
  return url;
}

// Fetch QR image via main process (no CSP restrictions there)
async function fetchQrDataUrl(url) {
  const qrApiUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(url);
  return window.api.fetchAsDataUrl(qrApiUrl);
}

function setupAudienceSection(topic, submitUrl, workerUrl, ntfyToken) {
  _workerUrl  = workerUrl || '';
  const url        = audienceSubmissionUrl(topic, submitUrl, _workerUrl, ntfyToken); // full URL for QR
  const displayUrl = audienceSubmissionUrl(topic, submitUrl, _workerUrl, '');        // no token for display
  // Human-readable label — just the hostname (e.g. "corunography.github.io/avclubvj")
  const labelUrl   = (() => { try { const u = new URL(displayUrl); return u.hostname + u.pathname.replace(/\/$/, ''); } catch(e) { return displayUrl; } })();
  const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=' + encodeURIComponent(url);
  const urlEl  = document.getElementById('audience-url');
  const qrEl   = document.getElementById('audience-qr');
  if (urlEl) { urlEl.textContent = labelUrl; }  // show clean label, no params
  if (qrEl)  { qrEl.src = qrUrl; }
  // Store full url (with token) for QR overlay button
  urlEl && (urlEl.dataset.submitUrl = url);
  if (urlEl) {
    urlEl.onclick = () => {
      window.api.openExternal(displayUrl);
      (navigator.clipboard ? navigator.clipboard.writeText(displayUrl) : Promise.reject())
        .then(() => {
          const tip = document.getElementById('audience-copy-tip');
          if (tip) { tip.style.opacity = '1'; setTimeout(() => { tip.style.opacity = '0'; }, 2000); }
        }).catch(() => {});
    };
  }
}

function updateAudienceCount() {
  const queue = document.getElementById('audience-queue');
  const count = document.getElementById('audience-count');
  const empty = document.getElementById('audience-empty');
  if (!queue || !count) return;
  const n = queue.children.length;
  count.textContent = n;
  if (empty) empty.style.display = n === 0 ? 'block' : 'none';
}

function addToAudienceQueue(id, text) {
  const queue = document.getElementById('audience-queue');
  const wrap  = document.getElementById('audience-queue-wrap');
  if (!queue) return;

  const item = document.createElement('div');
  item.className = 'audience-item';

  const textEl = document.createElement('span');
  textEl.style.cssText = 'flex:1;word-break:break-word;line-height:1.4;font-size:12px';
  textEl.textContent = text;

  const btnApprove = document.createElement('button');
  btnApprove.textContent = '✓';
  btnApprove.title = 'Approve — scroll this message';
  btnApprove.style.cssText = 'background:#34c759;color:#000;border:none;border-radius:5px;padding:4px 8px;font-size:11px;font-weight:700;cursor:pointer;flex-shrink:0';
  btnApprove.addEventListener('click', () => {
    const audienceFeedEnabled = document.getElementById('feed-audience-toggle')?.checked ?? true;
    if (audienceFeedEnabled) {
      sendToViz({ type: 'marquee-queue-add', text });
    }
    item.remove();
    updateAudienceCount();
  });

  const btnReject = document.createElement('button');
  btnReject.textContent = '✕';
  btnReject.title = 'Reject — discard this message';
  btnReject.style.cssText = 'background:#3a3a3c;color:#fff;border:none;border-radius:5px;padding:4px 8px;font-size:11px;font-weight:700;cursor:pointer;flex-shrink:0';
  btnReject.addEventListener('click', () => { item.remove(); updateAudienceCount(); });

  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:4px;flex-shrink:0';
  btns.append(btnApprove, btnReject);
  item.append(textEl, btns);
  queue.appendChild(item);
  updateAudienceCount();
}

// Init audience section
window.api.getVenueInfo().then(info => {
  setupAudienceSection(info.topic, info.submitUrl || '', info.workerUrl || '', info.ntfyToken || '');
  const replayEl = document.getElementById('audience-replay-window');
  if (replayEl && info.replayWindowHours != null) replayEl.value = String(info.replayWindowHours);
  // Photo sharing init
  photoVenueId = info.topic || '';
  const photoModToggle = document.getElementById('photo-moderated-toggle');
  const photoModeLabel = document.getElementById('photo-mode-label');
  const photoQueueWrap = document.getElementById('photo-queue-wrap');
  const moderated = info.photoModerated !== false;
  if (photoModToggle) photoModToggle.checked = moderated;
  if (photoModeLabel) photoModeLabel.textContent = moderated ? 'Photos require approval before display' : 'Photos appear instantly on screen';
  if (photoQueueWrap) photoQueueWrap.style.display = moderated ? 'block' : 'none';
});

document.getElementById('audience-mode')?.addEventListener('change', e => {
  window.api.audienceAction({ action: 'set-mode', mode: e.target.value });
  const wrap = document.getElementById('audience-queue-wrap');
  if (wrap) wrap.style.display = e.target.value === 'moderated' ? 'block' : 'none';
});

document.getElementById('btn-audience-clear')?.addEventListener('click', () => {
  const queue = document.getElementById('audience-queue');
  if (queue) { queue.innerHTML = ''; updateAudienceCount(); }
});

document.getElementById('audience-replay-window')?.addEventListener('change', e => {
  window.api.audienceAction({ action: 'set-replay-window', hours: Number(e.target.value) });
});

document.getElementById('btn-audience-clear-cursor')?.addEventListener('click', () => {
  window.api.audienceAction({ action: 'clear-cursor' });
  const btn = document.getElementById('btn-audience-clear-cursor');
  if (btn) { btn.textContent = 'Done!'; setTimeout(() => { btn.textContent = 'Reset now'; }, 1500); }
});

document.getElementById('btn-audience-open-log')?.addEventListener('click', () => {
  window.api.openAudienceLog();
});

document.getElementById('btn-download-qr')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-download-qr');
  if (btn) { btn.textContent = '⏳ Generating…'; btn.disabled = true; }
  try {
    const urlEl  = document.getElementById('audience-url');
    const submUrl = urlEl?.dataset?.submitUrl?.trim() || '';
    if (!submUrl) throw new Error('No URL');
    // Fetch a high-res version (1000×1000) suitable for printing
    const qrApiUrl  = 'https://api.qrserver.com/v1/create-qr-code/?size=1000x1000&margin=20&data=' + encodeURIComponent(submUrl);
    const dataUrl   = await window.api.fetchAsDataUrl(qrApiUrl);
    // Trigger download
    const a = document.createElement('a');
    a.href     = dataUrl;
    a.download = 'avclubvj-qr.png';
    a.click();
    if (btn) { btn.textContent = '✓ Downloaded!'; setTimeout(() => { btn.textContent = '⬇ Download QR Code'; btn.disabled = false; }, 2000); }
  } catch(e) {
    if (btn) { btn.textContent = '✗ Failed'; setTimeout(() => { btn.textContent = '⬇ Download QR Code'; btn.disabled = false; }, 2000); }
  }
});

// Live labels + real-time position update for QR position sliders
function _sendQrPositionUpdate() {
  if (!qrOverlayOn) return;
  const x     = parseFloat(document.getElementById('qr-pos-x')?.value  ?? 50);
  const y     = parseFloat(document.getElementById('qr-pos-y')?.value  ?? 50);
  const scale = parseFloat(document.getElementById('qr-scale')?.value  ?? 1.0);
  sendToViz({ type: 'qr-update-position', x, y, scale });
}
['qr-pos-x', 'qr-pos-y'].forEach(id => {
  const el  = document.getElementById(id);
  const val = document.getElementById(id + '-val');
  if (el && val) el.addEventListener('input', () => { val.textContent = el.value + '%'; _sendQrPositionUpdate(); });
});
const qrScaleEl  = document.getElementById('qr-scale');
const qrScaleVal = document.getElementById('qr-scale-val');
if (qrScaleEl && qrScaleVal) qrScaleEl.addEventListener('input', () => { qrScaleVal.textContent = parseFloat(qrScaleEl.value).toFixed(1) + '×'; _sendQrPositionUpdate(); });

let qrOverlayOn = false;
document.getElementById('btn-audience-qr-overlay')?.addEventListener('click', async () => {
  qrOverlayOn = !qrOverlayOn;
  const btn         = document.getElementById('btn-audience-qr-overlay');
  const intervalEl  = document.getElementById('qr-interval-controls');
  if (btn) btn.textContent = qrOverlayOn ? '📺 Hide QR from Screen' : '📺 Show QR on Screen';
  if (intervalEl) intervalEl.style.display = qrOverlayOn ? 'block' : 'none';

  if (qrOverlayOn) {
    const urlEl     = document.getElementById('audience-url');
    const submUrl   = urlEl?.dataset?.submitUrl?.trim() || urlEl?.textContent?.trim() || '';
    const showSec     = parseInt(document.getElementById('qr-show-sec')?.value || '15', 10);
    const intervalMin = parseInt(document.getElementById('qr-interval-min')?.value || '5', 10);
    const position    = document.getElementById('qr-position')?.value || 'center';
    const qrX     = parseFloat(document.getElementById('qr-pos-x')?.value ?? 50);
    const qrY     = parseFloat(document.getElementById('qr-pos-y')?.value ?? 50);
    const qrScale = parseFloat(document.getElementById('qr-scale')?.value ?? 1.0);
    try {
      const dataUrl = await fetchQrDataUrl(submUrl);
      sendToViz({ type: 'audience-qr-overlay', show: true, dataUrl, label: 'Scan to send a message to the screen!', showSec, intervalMin, position, x: qrX, y: qrY, scale: qrScale });
    } catch (e) {
      console.warn('[QR overlay] Failed to fetch QR image:', e);
      sendToViz({ type: 'audience-qr-overlay', show: false });
      qrOverlayOn = false;
      if (btn) btn.textContent = '📺 Show QR on Screen';
      if (intervalEl) intervalEl.style.display = 'none';
    }
  } else {
    sendToViz({ type: 'audience-qr-overlay', show: false });
  }
});

// ── Photo Sharing ─────────────────────────────────────────────────────────────

let pendingPhotos   = []; // { id, dataUrl, caption, ts }
let photoVenueId    = ''; // filled in from getVenueInfo

function renderPhotoQueue() {
  const queue    = document.getElementById('photo-queue');
  const empty    = document.getElementById('photo-empty');
  const countEl  = document.getElementById('photo-count');
  const queueWrap = document.getElementById('photo-queue-wrap');
  if (!queue) return;

  if (countEl) countEl.textContent = pendingPhotos.length;

  if (!pendingPhotos.length) {
    queue.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  queue.innerHTML = '';
  pendingPhotos.forEach((photo, i) => {
    const item = document.createElement('div');
    item.style.cssText = 'background:#1c1c1e;border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:6px';
    const preview = document.createElement('img');
    preview.src = photo.dataUrl;
    preview.style.cssText = 'width:100%;max-height:180px;object-fit:contain;border-radius:6px;background:#000;cursor:zoom-in';
    preview.title = 'Click to preview';
    preview.addEventListener('click', () => openPhotoLightbox(photo));
    item.appendChild(preview);
    if (photo.caption) {
      const cap = document.createElement('div');
      cap.style.cssText = 'font-size:11px;color:#aaa;font-style:italic;text-align:center;padding:0 4px';
      cap.textContent = photo.caption;
      item.appendChild(cap);
    }
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:5px';
    const approveBtn = document.createElement('button');
    approveBtn.className = 'btn-venue-go';
    approveBtn.style.cssText = 'flex:1;font-size:12px;padding:7px 0';
    approveBtn.textContent = '✓ Display on Screen';
    approveBtn.addEventListener('click', () => approvePhoto(i));
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn-venue-stop';
    rejectBtn.style.cssText = 'flex:1;font-size:12px;padding:7px 0';
    rejectBtn.textContent = '✕ Reject';
    rejectBtn.addEventListener('click', () => rejectPhoto(i));
    btns.appendChild(approveBtn);
    btns.appendChild(rejectBtn);
    item.appendChild(btns);
    queue.appendChild(item);
  });
}

async function approvePhoto(idx) {
  const photo = pendingPhotos[idx];
  if (!photo) return;
  const duration = parseInt(document.getElementById('photo-display-duration')?.value || '12', 10);
  sendToViz({ type: 'photo-display', dataUrl: photo.dataUrl, caption: photo.caption, duration });
  window.api.photoSaveHistory({ dataUrl: photo.dataUrl, caption: photo.caption, ts: photo.ts });
  await window.api.photoDelete(photo.id);
  pendingPhotos.splice(idx, 1);
  renderPhotoQueue();
  document.getElementById('btn-photo-kill').style.display = 'block';
}

async function rejectPhoto(idx) {
  const photo = pendingPhotos[idx];
  if (!photo) return;
  await window.api.photoDelete(photo.id);
  pendingPhotos.splice(idx, 1);
  renderPhotoQueue();
}

// Photo kill switch
document.getElementById('btn-photo-kill')?.addEventListener('click', () => {
  sendToViz({ type: 'photo-kill' });
  document.getElementById('btn-photo-kill').style.display = 'none';
});

// Photo lightbox
function openPhotoLightbox(photo) {
  const lb  = document.getElementById('photo-lightbox');
  const img = document.getElementById('photo-lightbox-img');
  const cap = document.getElementById('photo-lightbox-caption');
  if (!lb || !img) return;
  img.src = photo.dataUrl;
  cap.textContent = photo.caption || '';
  cap.style.display = photo.caption ? 'block' : 'none';
  lb.style.display = 'flex';
}

function closePhotoLightbox() {
  const lb = document.getElementById('photo-lightbox');
  if (lb) lb.style.display = 'none';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closePhotoLightbox();
});

// Photo moderation toggle
document.getElementById('photo-moderated-toggle')?.addEventListener('change', e => {
  const moderated = e.target.checked;
  window.api.audienceAction({ action: 'set-photo-moderated', moderated });
  const label = document.getElementById('photo-mode-label');
  const queueWrap = document.getElementById('photo-queue-wrap');
  if (label) label.textContent = moderated ? 'Photos require approval before display' : 'Photos appear instantly on screen';
  if (queueWrap) queueWrap.style.display = moderated ? 'block' : 'none';
});

// Photo history buttons
document.getElementById('btn-photo-open-history')?.addEventListener('click', () => {
  window.api.photoOpenHistory();
});

document.getElementById('btn-photo-clear-history')?.addEventListener('click', async () => {
  if (!confirm('Clear all saved photo history from your computer? This cannot be undone.')) return;
  await window.api.photoClearHistory();
  const btn = document.getElementById('btn-photo-clear-history');
  if (btn) { btn.textContent = '✓ Cleared'; setTimeout(() => { btn.textContent = '🗑 Clear History'; }, 2000); }
});

// Handle messages from main process for photos
window.api.onMessage((msg) => {
  if (msg.type === 'pending-photos-update') {
    pendingPhotos = msg.photos || [];
    renderPhotoQueue();
  }
  if (msg.type === 'photo-killed') {
    document.getElementById('btn-photo-kill').style.display = 'none';
  }
  if (msg.type === 'photo-moderated-changed') {
    const toggle = document.getElementById('photo-moderated-toggle');
    const label  = document.getElementById('photo-mode-label');
    const wrap   = document.getElementById('photo-queue-wrap');
    if (toggle) toggle.checked = !!msg.moderated;
    if (label)  label.textContent = msg.moderated ? 'Photos require approval before display' : 'Photos appear instantly on screen';
    if (wrap)   wrap.style.display = msg.moderated ? 'block' : 'none';
  }
});

// ── Venue Overlay ─────────────────────────────────────────────────────────────

let venueLogos = {}; // id → config

function marqueeConfigFromUI() {
  return {
    speed:    parseFloat(document.getElementById('marquee-speed')?.value ?? 3),
    fontSize: parseInt(document.getElementById('marquee-size')?.value ?? 52),
    color:    document.getElementById('marquee-color')?.value ?? '#ffffff',
    bgAlpha:  parseFloat(document.getElementById('marquee-bg-alpha')?.value ?? 0.65),
    bgColor:  '#000000',
    position: document.getElementById('marquee-position')?.value ?? 'bottom',
  };
}

function sendMarqueeConfig() {
  sendToViz({ type: 'marquee-config', config: marqueeConfigFromUI() });
}

// Live config sync for marquee sliders
['marquee-speed','marquee-size','marquee-color','marquee-bg-alpha','marquee-position'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => {
    // Update display labels
    if (id === 'marquee-speed')    document.getElementById('marquee-speed-val').textContent   = el.value;
    if (id === 'marquee-size')     document.getElementById('marquee-size-val').textContent    = el.value + 'px';
    if (id === 'marquee-bg-alpha') document.getElementById('marquee-bg-alpha-val').textContent = Math.round(el.value * 100) + '%';
    sendMarqueeConfig();
  });
});

// ── Logo manager ──────────────────────────────────────────────────────────────

function renderLogoList() {
  const container = document.getElementById('logo-list');
  if (!container) return;
  container.innerHTML = '';
  for (const logo of Object.values(venueLogos)) {
    // Migrate legacy 'mode' field to separate visibility + bounce fields
    const legacyMode = logo.mode ?? null;
    const vis      = logo.visibility ?? (legacyMode === 'sequence' ? 'sequence' : 'always-on');
    const isBounce = logo.bounce     ?? (legacyMode === 'bounce');

    const item = document.createElement('div');
    item.className = 'logo-item';
    item.dataset.id = logo.id;
    item.innerHTML = `
      <img class="logo-preview" src="${logo.dataUrl}" alt="">
      <div class="logo-controls">
        <div class="logo-name">${logo.name}</div>
        <div class="logo-row">
          <label>Show</label>
          <select class="logo-visibility" style="grid-column:span 2;font-size:10px">
            <option value="sequence"  ${vis==='sequence' ?'selected':''}>Sequence</option>
            <option value="always-on" ${vis==='always-on'?'selected':''}>Always On</option>
          </select>
        </div>
        <div class="logo-row">
          <label style="grid-column:span 3;display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" class="logo-bounce-check" ${isBounce?'checked':''}> Bounce (DVD mode)
          </label>
        </div>
        <div class="logo-row logo-xy-rows" style="${isBounce ? 'display:none' : ''}">
          <label>X Pos</label>
          <input type="range" class="logo-xpct" min="0" max="100" value="${logo.xPct ?? 90}" step="1">
          <span class="logo-xpct-val">${logo.xPct ?? 90}%</span>
        </div>
        <div class="logo-row logo-xy-rows" style="${isBounce ? 'display:none' : ''}">
          <label>Y Pos</label>
          <input type="range" class="logo-ypct" min="0" max="100" value="${logo.yPct ?? 90}" step="1">
          <span class="logo-ypct-val">${logo.yPct ?? 90}%</span>
        </div>
        <div class="logo-row">
          <label>Size</label>
          <input type="range" class="logo-size" min="5" max="60" value="${logo.sizePct}" step="1">
          <span class="logo-size-val">${logo.sizePct}%</span>
        </div>
        <div class="logo-row">
          <label>Opacity</label>
          <input type="range" class="logo-opacity" min="0.1" max="1" value="${logo.opacity}" step="0.05">
          <span class="logo-opacity-val">${Math.round(logo.opacity*100)}%</span>
        </div>
        <div class="logo-row logo-bounce-row" style="${isBounce ? '' : 'display:none'}">
          <label>Speed</label>
          <input type="range" class="logo-bspeed" min="0.3" max="5" value="${logo.bounceSpeed ?? 1.5}" step="0.1">
          <span class="logo-bspeed-val">${logo.bounceSpeed ?? 1.5}</span>
        </div>
        <div class="logo-actions">
          <button class="btn-show-now" style="${vis !== 'sequence' ? 'display:none' : ''}">▶ Show Now</button>
          <button class="btn-remove">✕ Remove</button>
        </div>
      </div>`;

    // Wire up controls
    const id = logo.id;

    // Visibility selector (when to show: sequence vs always-on)
    item.querySelector('.logo-visibility').addEventListener('change', e => {
      const v = e.target.value;
      venueLogos[id].visibility = v;
      item.querySelector('.btn-show-now').style.display = v === 'sequence' ? '' : 'none';
      sendToViz({ type: 'logo-update', id, cfg: { visibility: v } });
    });

    // Bounce checkbox (how to move: physics vs static X/Y)
    item.querySelector('.logo-bounce-check').addEventListener('change', e => {
      const isB = e.target.checked;
      venueLogos[id].bounce = isB;
      item.querySelectorAll('.logo-xy-rows').forEach(r => r.style.display = isB ? 'none' : '');
      item.querySelector('.logo-bounce-row').style.display = isB ? '' : 'none';
      sendToViz({ type: 'logo-update', id, cfg: { bounce: isB } });
    });

    item.querySelector('.logo-bspeed').addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      venueLogos[id].bounceSpeed = v;
      item.querySelector('.logo-bspeed-val').textContent = v;
      sendToViz({ type: 'logo-update', id, cfg: { bounceSpeed: v } });
    });
    item.querySelector('.logo-xpct').addEventListener('input', e => {
      const v = parseInt(e.target.value);
      venueLogos[id].xPct = v;
      item.querySelector('.logo-xpct-val').textContent = v + '%';
      sendToViz({ type: 'logo-update', id, cfg: { xPct: v } });
    });
    item.querySelector('.logo-ypct').addEventListener('input', e => {
      const v = parseInt(e.target.value);
      venueLogos[id].yPct = v;
      item.querySelector('.logo-ypct-val').textContent = v + '%';
      sendToViz({ type: 'logo-update', id, cfg: { yPct: v } });
    });
    item.querySelector('.logo-size').addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      venueLogos[id].sizePct = v;
      item.querySelector('.logo-size-val').textContent = v + '%';
      sendToViz({ type: 'logo-update', id, cfg: { sizePct: v } });
    });
    item.querySelector('.logo-opacity').addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      venueLogos[id].opacity = v;
      item.querySelector('.logo-opacity-val').textContent = Math.round(v * 100) + '%';
      sendToViz({ type: 'logo-update', id, cfg: { opacity: v } });
    });
    item.querySelector('.btn-show-now').addEventListener('click', () => {
      sendToViz({ type: 'logo-trigger', id });
    });
    item.querySelector('.btn-remove').addEventListener('click', () => {
      delete venueLogos[id];
      sendToViz({ type: 'logo-remove', id });
      renderLogoList();
    });

    container.appendChild(item);
  }
}

// Global logo sequence config
['logo-global-interval','logo-global-duration'].forEach(eid => {
  document.getElementById(eid)?.addEventListener('change', () => {
    sendToViz({
      type: 'logo-global-config',
      intervalMins: parseInt(document.getElementById('logo-global-interval')?.value ?? '5'),
      durationSecs: parseInt(document.getElementById('logo-global-duration')?.value ?? '10'),
    });
  });
});

document.getElementById('logos-enabled')?.addEventListener('change', e => {
  sendToViz({ type: 'logos-enabled', enabled: e.target.checked });
});

document.getElementById('btn-add-logo')?.addEventListener('click', async () => {
  const result = await window.api.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','gif','webp','svg'] }],
  });
  if (!result || result.canceled || !result.filePaths?.[0]) return;
  const filePath = result.filePaths[0];
  const dataUrl  = await window.api.readFileAsDataUrl(filePath);
  const name     = filePath.split('/').pop();
  const id       = Date.now().toString();
  const logo = { id, name, dataUrl, xPct: 90, yPct: 90, sizePct: 20, opacity: 0.9, visibility: 'sequence', bounce: false, bounceSpeed: 1.5 };
  venueLogos[id] = logo;
  renderLogoList();
  sendToViz({ type: 'logo-add', logo });
  pushLogoStateToRemote();
});

function pushLogoStateToRemote() {
  window.api.sendToControl({
    type: 'remote-state-update',
    state: {
      logos: Object.values(venueLogos).map(o => ({
        id: o.id, name: o.name, visibility: o.visibility ?? 'sequence', bounce: !!o.bounce
      })),
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  try {
    config = await window.api.getConfig();
  } catch (e) {
    config = {};
    console.warn('Could not load config, using defaults:', e.message);
  }

  try {
    customPresets = await window.api.getCustomPresets();
  } catch (e) {
    customPresets = [];
  }

  // Pre-collapse all categories by default
  collapsedCategories.add('__classic__');
  for (const p of customPresets) {
    if (p.category) collapsedCategories.add(p.category);
    if (p.category && p.subcategory) collapsedCategories.add(`${p.category}/${p.subcategory}`);
  }

  // Build preset editor param sliders
  buildParamUI();

  // Init collapsible sections (uses saved state or defaults)
  initCollapsible(config.collapsedSections);

  // Apply config to UI
  cycleEnabled.checked          = config.cycleEnabled ?? true;
  cycleInterval.value           = config.cycleInterval ?? 15;
  importedEnabled.checked       = config.importedEnabled ?? true;
  importedChance.value          = config.importedChance ?? '0.20';
  mixGeneratedCheck.checked     = config.mixGenerated ?? false;
  mixGeneratedChance.value      = config.mixGeneratedChance || '0.20';
  if (favCycleCheck)  favCycleCheck.checked  = config.favCycleEnabled ?? false;
  if (favCycleChance) favCycleChance.value   = config.favCycleChance  ?? '0.20';
  updateCycleWeighting();
  blendTime.value      = config.blendTime ?? 2;
  const savedSensitivity = config.sensitivity ?? 1.0;
  sensitivitySlider.value = savedSensitivity;
  sensitivityVal.textContent = savedSensitivity.toFixed(1);
  sendToViz({ type: 'set-sensitivity', value: savedSensitivity });

  // Restore EQ settings
  const savedGenre = config.activeGenre;
  if (savedGenre && GENRE_PRESETS[savedGenre]) {
    applyGenrePreset(savedGenre);
  } else {
    eqBassSlider.value = config.eqBass ?? 0;
    eqMidSlider.value  = config.eqMid  ?? 0;
    eqTrebSlider.value = config.eqTreb ?? 0;
    sendEQ(); // updates labels and sends to viz
    // Mark active genre button if values match
    genreBtns.forEach(b => {
      const p = GENRE_PRESETS[b.dataset.genre];
      const matches = p && p.bass === Number(eqBassSlider.value)
        && p.mid  === Number(eqMidSlider.value)
        && p.treb === Number(eqTrebSlider.value);
      b.classList.toggle('active', !!matches);
    });
  }

  // Restore performance settings
  fpsCapSelect.value = String(config.fpsCap ?? 60);
  meshQualitySelect.value = config.meshQuality ?? 'high';
  sendToViz({ type: 'set-fps-cap', fps: Number(fpsCapSelect.value) });
  sendToViz({ type: 'set-quality', quality: meshQualitySelect.value });
  updatePerfThresholdLabels();

  // Brightness / darkness skip — always on
  sendToViz({ type: 'set-brightness-skip', enabled: true });
  sendToViz({ type: 'set-darkness-skip',   enabled: true });

  // Restore GPU perf skip
  if (perfSkipCheckbox) {
    perfSkipCheckbox.checked = config.perfSkip ?? false;
    if (perfThresholdSelect) perfThresholdSelect.value = config.perfThreshold ?? '150';
    sendToViz({ type: 'set-perf-skip', enabled: perfSkipCheckbox.checked, threshold: Number(perfThresholdSelect?.value ?? 150) });
  }

  // Restore beat sync
  if (beatSyncCheckbox) {
    beatSyncCheckbox.checked = config.beatSyncEnabled ?? false;
    if (beatDivisorSelect) beatDivisorSelect.value = config.beatDivisor ?? '4';
    if (config.beatSyncEnabled) sendToViz({ type: 'beat-sync-enable' });
  }

  // Restore viz window visibility
  const vizVisible = config.vizVisible ?? false;
  vizVisibleCheckbox.checked = vizVisible;
  window.api.setVizVisible(vizVisible);

  // Restore Syphon name
  if (config.syphonName) syphonNameInput.value = config.syphonName;

  // Restore NDI name
  if (config.ndiName) ndiNameInput.value = config.ndiName;

  // Restore MIDI mappings
  midiMappings = config.midiMappings || {};
  updateMidiLabels();
  initMidi();

  // Render preset list first so it's visible immediately
  renderList();

  // Check Syphon availability, then auto-start if it was enabled
  updateSyphonStatus();
  if ((config.syphonEnabled ?? true) && (await window.api.syphonStatus()).available) {
    syphonCheckbox.checked = true;
    await startSyphon();
  }

  // Auto-start Syphon overlay channel if it was previously enabled
  if (syphonOverlayNameInput && config.syphonOverlayName) {
    syphonOverlayNameInput.value = config.syphonOverlayName;
  }
  if (config.syphonOverlayEnabled && window.api.syphonOverlayStatus) {
    const s = await window.api.syphonOverlayStatus();
    if (s.available) {
      syphonOverlayCheckbox.checked = true;
      await startSyphonOverlay();
    }
  }

  // Check NDI availability, then auto-start if it was enabled
  updateNdiStatus();
  if (config.ndiEnabled && (await window.api.ndiStatus()).available) {
    ndiCheckbox.checked = true;
    await startNdi();
  }

  // Populate audio devices and display list (non-blocking)
  populateAudioDevices().catch(e => console.warn('Audio setup error:', e));
  populateDisplays().catch(e => console.warn('Display enumeration error:', e));

  // Start cycle timer
  restartCycleTimer();

  // Unlock persistConfig and do one clean save with the fully-restored UI state
  isInitialized = true;
  persistConfig();

  // Push full initial state to the remote control server
  window.api.sendToControl({
    type: 'remote-state-update',
    state: {
      cycleEnabled:       cycleEnabled?.checked ?? false,
      cycleInterval:      Number(cycleInterval?.value) || 15,
      blendTime:          Number(blendTime?.value) || 2,
      beatSyncEnabled:    beatSyncCheckbox?.checked ?? false,
      beatDivisor:        Number(beatDivisorSelect?.value) || 4,
      importedEnabled:    importedEnabled?.checked ?? true,
      importedChance:     Number(importedChance?.value) || 0.20,
      mixGenerated:       mixGeneratedCheck?.checked ?? false,
      mixGeneratedChance: Number(mixGeneratedChance?.value) || 0.20,
      favCycleEnabled:    favCycleCheck?.checked ?? false,
      favCycleChance:     Number(favCycleChance?.value) || 0.20,
      brightSkip:         true,
      darkSkip:           true,
      fpsCap:             Number(fpsCapSelect?.value) || 60,
      meshQuality:        meshQualitySelect?.value ?? 'high',
      perfSkipEnabled:    perfSkipCheckbox?.checked ?? false,
      perfThreshold:      Number(perfThresholdSelect?.value) || 150,
      sensitivity:        Number(sensitivitySlider?.value) || 1,
      eqBass:             Number(eqBassSlider?.value) || 0,
      eqMid:              Number(eqMidSlider?.value) || 0,
      eqTreb:             Number(eqTrebSlider?.value) || 0,
      logos: Object.values(venueLogos).map(o => ({
        id: o.id, name: o.name, visibility: o.visibility ?? 'sequence', bounce: !!o.bounce
      })),
    }
  });

  // Load first enabled preset on startup
  const pool = enabledBuiltin();
  if (pool.length) {
    setTimeout(() => loadPreset(pool[0], false), 1000);
  }

  // Populate remote control URL + QR — defer to tunnel check first
  // so if internet access is already active we show the cloud URL, not local IP
  const tipEl = document.getElementById('remote-copy-tip');
  Promise.all([window.api.getRemoteUrl(), window.api.tunnelStatus?.()]).then(([localUrl, tunnelState]) => {
    if (tunnelState?.status === 'connected' && tunnelState?.url) {
      // Tunnel already active — applyTunnelStatus will set the cloud URL
      return;
    }
    const urlEl = document.getElementById('remote-url');
    const qrEl  = document.getElementById('remote-qr');
    if (urlEl) {
      urlEl.textContent = localUrl;
      urlEl.addEventListener('click', () => {
        window.api.openExternal(localUrl);
        (navigator.clipboard ? navigator.clipboard.writeText(localUrl) : Promise.reject())
          .then(() => {
            if (tipEl) { tipEl.style.opacity = 1; setTimeout(() => { tipEl.style.opacity = 0; }, 1500); }
          }).catch(() => {});
      });
    }
    if (qrEl) qrEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(localUrl)}`;
  });
})();

// ── Cloudflare Tunnel + Remote Password ───────────────────────────────────────

let tunnelActive = false;
const WORKER_BASE = 'https://avclubvj.corunography.workers.dev';

function applyTunnelStatus(status, tunnelUrl) {
  const dot    = document.getElementById('tunnel-status-dot');
  const label  = document.getElementById('tunnel-status-label');
  const btn    = document.getElementById('btn-tunnel-toggle');

  if (status === 'connected' && tunnelUrl) {
    tunnelActive = true;
    if (dot)   dot.style.background = '#34c759';
    if (label) label.textContent = 'Connected — QR code works from anywhere';
    if (btn)   { btn.textContent = '🌐 Disable Internet Access'; btn.disabled = false; }

    window.api.getVenueInfo().then(info => {
      const publicUrl   = `${WORKER_BASE}/remote?venueId=${encodeURIComponent(info.topic)}`;
      const mainUrlEl   = document.getElementById('remote-url');
      const mainQrEl    = document.getElementById('remote-qr');
      const mainLabel   = document.getElementById('remote-url-label');
      const mainQrLabel = document.getElementById('remote-qr-label');
      const localWrap   = document.getElementById('remote-local-wrap');
      const localUrlEl  = document.getElementById('remote-local-url');

      if (mainLabel)   mainLabel.textContent = 'Bookmark this on your iPad — works from anywhere:';
      if (mainQrLabel) mainQrLabel.textContent = 'Scan from anywhere — no venue Wi-Fi needed';
      if (mainUrlEl) {
        mainUrlEl.textContent = publicUrl;
        mainUrlEl.onclick = () => {
          navigator.clipboard.writeText(publicUrl).catch(() => {});
          mainUrlEl.style.color = '#34c759';
          setTimeout(() => { mainUrlEl.style.color = '#3a7bd5'; }, 1500);
        };
      }
      if (mainQrEl) mainQrEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(publicUrl)}`;

      window.api.getRemoteUrl().then(localUrl => {
        if (localWrap)  localWrap.style.display = 'block';
        if (localUrlEl) {
          localUrlEl.textContent = localUrl;
          localUrlEl.onclick = () => navigator.clipboard.writeText(localUrl).catch(() => {});
        }
      });
    });
  } else if (status === 'starting') {
    tunnelActive = false;
    if (dot)   dot.style.background = '#ff9500';
    if (label) label.textContent = 'Starting tunnel…';
    if (btn)   { btn.textContent = '⏳ Starting…'; btn.disabled = true; }
  } else if (status === 'error') {
    tunnelActive = false;
    if (dot)   dot.style.background = '#ff453a';
    if (label) label.textContent = 'Error starting tunnel — please try again.';
    if (btn)   { btn.textContent = '🌐 Enable Internet Access'; btn.disabled = false; }
  } else {
    // offline
    tunnelActive = false;
    if (dot)   dot.style.background = '#555';
    if (label) label.textContent = 'Off — click to create a public URL';
    if (btn)   { btn.textContent = '🌐 Enable Internet Access'; btn.disabled = false; }
    // Restore local IP as main URL
    const mainLabel   = document.getElementById('remote-url-label');
    const mainQrLabel = document.getElementById('remote-qr-label');
    const mainUrlEl   = document.getElementById('remote-url');
    const mainQrEl    = document.getElementById('remote-qr');
    const localWrap   = document.getElementById('remote-local-wrap');
    if (mainLabel)   mainLabel.textContent = 'Open this URL on any device on the same Wi-Fi network:';
    if (mainQrLabel) mainQrLabel.textContent = 'Scan to open on a phone';
    if (localWrap)   localWrap.style.display = 'none';
    window.api.getRemoteUrl().then(localUrl => {
      if (mainUrlEl) mainUrlEl.textContent = localUrl;
      if (mainQrEl)  mainQrEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(localUrl)}`;
    });
  }
}

// Load initial tunnel state
window.api.tunnelStatus?.().then(s => applyTunnelStatus(s.status, s.url));

// Load saved password
window.api.getRemotePassword?.().then(pw => {
  const el = document.getElementById('tunnel-password');
  if (el && pw) el.value = pw;
});

document.getElementById('btn-tunnel-toggle')?.addEventListener('click', () => {
  if (tunnelActive) {
    window.api.tunnelStop?.();
    applyTunnelStatus('offline');
  } else {
    window.api.tunnelStart?.();
    applyTunnelStatus('starting');
  }
});

document.getElementById('btn-tunnel-pw-save')?.addEventListener('click', async () => {
  const pw  = document.getElementById('tunnel-password')?.value || '';
  const btn = document.getElementById('btn-tunnel-pw-save');
  await window.api.setRemotePassword?.(pw);
  if (btn) { btn.textContent = 'Saved!'; setTimeout(() => { btn.textContent = 'Save'; }, 1500); }
});

// Handle tunnel status updates pushed from main process
window.api.onMessage((msg) => {
  if (msg.type === 'tunnel-status') applyTunnelStatus(msg.status, msg.url);
});

// ── Bar Trivia ────────────────────────────────────────────────────────────────

const triviaScores        = new Map(); // team → score
const triviaAnsweredTokens = new Set(); // token → already answered this question
let currentTriviaQ  = null;
let triviaActive    = false;
let triviaAutoTimer = null;

async function fetchTriviaQuestion() {
  const category   = document.getElementById('trivia-category-sel')?.value || '';
  const difficulty = document.getElementById('trivia-difficulty-sel')?.value || '';
  let url = 'https://opentdb.com/api.php?amount=1&type=multiple&encode=url3986';
  if (category)   url += '&category='   + category;
  if (difficulty) url += '&difficulty=' + difficulty;
  const res  = await fetch(url);
  const data = await res.json();
  if (data.response_code !== 0 || !data.results?.length) throw new Error('No questions returned');
  const q       = data.results[0];
  const decode  = s => decodeURIComponent(s);
  const correct = decode(q.correct_answer);
  const options = [...q.incorrect_answers.map(decode), correct].sort(() => Math.random() - 0.5);
  return {
    id:           Math.random().toString(36).slice(2),
    question:     decode(q.question),
    options,
    correctIndex: options.indexOf(correct),
    correct,
    category:     decode(q.category),
    difficulty:   q.difficulty,
    timeLimit:    parseInt(document.getElementById('trivia-timer-sel')?.value || '30', 10),
  };
}

function triviaUpdateQuestionDisplay() {
  if (!currentTriviaQ) return;
  const wrap = document.getElementById('trivia-current-wrap');
  const qEl  = document.getElementById('trivia-ctrl-question');
  const oEl  = document.getElementById('trivia-ctrl-options');
  const aEl  = document.getElementById('trivia-ctrl-answer');
  if (wrap) wrap.style.display = 'block';
  if (qEl)  qEl.textContent = currentTriviaQ.question;
  if (oEl)  oEl.innerHTML = currentTriviaQ.options.map((o, i) => {
    const isCorrect = i === currentTriviaQ.correctIndex;
    const cls = isCorrect ? 'trivia-opt-correct' : 'trivia-opt';
    return `<div class="${cls}" style="font-size:13px">${['A','B','C','D'][i]}. ${o}</div>`;
  }).join('');
  if (aEl)  aEl.textContent = currentTriviaQ.correct;
  const respWrap = document.getElementById('trivia-responses-wrap');
  const respCount = document.getElementById('trivia-response-count');
  if (respWrap)  respWrap.style.display  = 'block';
  if (respCount) respCount.textContent   = '0';
}

function triviaUpdateScoreboard() {
  const el = document.getElementById('trivia-scoreboard-ctrl');
  if (!el) return;
  if (triviaScores.size === 0) {
    el.innerHTML = '<div style="font-size:11px;color:#555;text-align:center;padding:6px">No scores yet</div>';
    return;
  }
  const sorted = [...triviaScores.entries()].sort((a, b) => b[1] - a[1]);
  el.innerHTML = sorted.map(([team, score], i) => `
    <div style="display:flex;justify-content:space-between;align-items:center;background:#1c1c1e;border-radius:6px;padding:5px 10px;font-size:11px">
      <span style="color:#888">${i + 1}. ${team}</span>
      <span style="color:#fff;font-weight:700">${score} pt${score !== 1 ? 's' : ''}</span>
    </div>
  `).join('');
  triviaSaveCurrentScores();
}

function triviaSaveCurrentScores() {
  if (triviaScores.size === 0) return;
  const scores = [...triviaScores.entries()].sort((a, b) => b[1] - a[1]).map(([team, score]) => ({ team, score }));
  window.api.triviaSaveScores?.(scores);
  window.api.triviaPushScores?.(scores);
}

const triviaParticipants = new Map(); // name → { token, answeredThisQ }

function updateTriviaParticipants() {
  const el = document.getElementById('trivia-participants-ctrl');
  if (!el) return;
  if (triviaParticipants.size === 0) {
    el.innerHTML = '<div style="font-size:11px;color:#555;text-align:center;padding:6px">No teams registered yet</div>';
    return;
  }
  el.innerHTML = [...triviaParticipants.entries()].map(([name, info]) => `
    <div style="display:flex;justify-content:space-between;align-items:center;background:#1c1c1e;border-radius:6px;padding:5px 10px;font-size:11px">
      <span style="color:${info.answeredThisQ ? '#34c759' : '#aaa'}">${name}</span>
      <span style="font-size:10px;color:#555">${info.answeredThisQ ? '✓ answered' : '…'}</span>
    </div>
  `).join('');
}

function triviaHandleAnswer(msg) {
  if (!triviaActive || !currentTriviaQ) return;
  if (msg.qid !== currentTriviaQ.id) return; // stale answer from old round
  // Token dedup: same device can't answer twice for the same question
  if (msg.token) {
    if (triviaAnsweredTokens.has(msg.token)) return;
    triviaAnsweredTokens.add(msg.token);
  }
  const countEl = document.getElementById('trivia-response-count');
  if (countEl) countEl.textContent = parseInt(countEl.textContent || '0') + 1;
  // Auto-register team if their TEAM-REG message was missed
  if (msg.team && !triviaParticipants.has(msg.team)) {
    triviaParticipants.set(msg.team, { token: msg.token, answeredThisQ: false });
  }
  // Mark team as having answered this question
  const teamInfo = triviaParticipants.get(msg.team);
  if (teamInfo) teamInfo.answeredThisQ = true;
  if (msg.answerIndex === currentTriviaQ.correctIndex) {
    triviaScores.set(msg.team, (triviaScores.get(msg.team) || 0) + 1);
    triviaUpdateScoreboard();
    window.api.broadcastCtrlState?.({ type: 'ctrl-trivia-scores', scores: [...triviaScores] });
  }
  // Update participants panel to show who has answered
  updateTriviaParticipants();
}

function triviaRevealAnswer() {
  if (!currentTriviaQ) return;
  if (triviaAutoTimer) { clearTimeout(triviaAutoTimer); triviaAutoTimer = null; }
  triviaActive = false;
  sendToViz({ type: 'trivia-reveal', correctIndex: currentTriviaQ.correctIndex });
  window.api.triviaPublishReveal(currentTriviaQ.correctIndex);
  document.getElementById('btn-trivia-reveal')?.setAttribute('disabled', '');
  document.getElementById('btn-trivia-scores')?.removeAttribute('disabled');
}

function triviaShowScoresOnScreen() {
  if (triviaScores.size === 0) return;
  const scores = [...triviaScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([team, score]) => ({ team, score }));
  sendToViz({ type: 'trivia-scoreboard', scores });
}

async function startTriviaQuestion() {
  const startBtn = document.getElementById('btn-trivia-start');
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Fetching…'; }
  try {
    currentTriviaQ = await fetchTriviaQuestion();
    triviaActive   = true;
    triviaAnsweredTokens.clear(); // reset dedup for new question
    // Reset answered-this-Q flag for all teams
    triviaParticipants.forEach(info => { info.answeredThisQ = false; });
    updateTriviaParticipants();
    triviaUpdateQuestionDisplay();
    window.api.broadcastCtrlState?.({ type: 'ctrl-trivia-q', question: currentTriviaQ });
    // Fetch QR first, then show question + QR together so they fade in simultaneously
    const urlEl     = document.getElementById('audience-url');
    const fullUrl   = urlEl?.dataset?.submitUrl?.trim() || '';
    const triviaUrl = fullUrl ? fullUrl + '&mode=trivia' : '';
    const sendQuestion = (qrDataUrl) => {
      sendToViz({ type: 'trivia-question', ...currentTriviaQ, qrDataUrl: qrDataUrl || null });
    };
    if (triviaUrl) {
      fetchQrDataUrl(triviaUrl).then(sendQuestion).catch(() => sendQuestion(null));
    } else {
      sendQuestion(null);
    }
    // Publish to ntfy so submit page can receive it
    window.api.triviaPublishQuestion({
      id: currentTriviaQ.id, question: currentTriviaQ.question,
      options: currentTriviaQ.options, category: currentTriviaQ.category,
      timeLimit: currentTriviaQ.timeLimit,
      correctIndex: currentTriviaQ.correctIndex, // stripped from ntfy payload in main.js; used for remote display only
    });
    // Enable reveal; disable scores
    document.getElementById('btn-trivia-reveal')?.removeAttribute('disabled');
    document.getElementById('btn-trivia-scores')?.setAttribute('disabled', '');
    // Auto-reveal when timer expires
    if (triviaAutoTimer) clearTimeout(triviaAutoTimer);
    triviaAutoTimer = setTimeout(triviaRevealAnswer, currentTriviaQ.timeLimit * 1000);
  } catch (e) {
    console.warn('[Trivia] Fetch failed:', e);
  }
  if (startBtn) { startBtn.disabled = false; startBtn.textContent = '▶ New Question'; }
}

document.getElementById('btn-trivia-start')?.addEventListener('click',  startTriviaQuestion);
document.getElementById('btn-trivia-reveal')?.addEventListener('click', triviaRevealAnswer);
document.getElementById('btn-trivia-scores')?.addEventListener('click', triviaShowScoresOnScreen);

document.getElementById('btn-trivia-clear-scores')?.addEventListener('click', () => {
  if (triviaScores.size === 0) return;
  const msg = '⚠️ Clear all trivia scores?\n\nThis cannot be undone and scores cannot be re-added. The current scores will be saved to your score log before clearing.';
  if (!confirm(msg)) return;
  window.api.triviaClearScores?.();
  triviaScores.clear();
  triviaParticipants.clear();
  triviaAnsweredTokens.clear();
  triviaUpdateScoreboard();
  updateTriviaParticipants();
});

document.getElementById('btn-trivia-open-log')?.addEventListener('click', () => {
  window.api.openTriviaScoreLog?.();
});

document.getElementById('btn-trivia-hide')?.addEventListener('click',   () => {
  if (triviaAutoTimer) { clearTimeout(triviaAutoTimer); triviaAutoTimer = null; }
  triviaActive = false;
  sendToViz({ type: 'trivia-hide' });
  window.api.triviaPublishEnd();
  document.getElementById('btn-trivia-reveal')?.setAttribute('disabled', '');
});
document.getElementById('btn-trivia-reset')?.addEventListener('click', () => {
  triviaScores.clear();
  triviaUpdateScoreboard();
  window.api.broadcastCtrlState?.({ type: 'ctrl-trivia-scores', scores: [...triviaScores] });
});

document.getElementById('btn-trivia-reset-teams')?.addEventListener('click', () => {
  triviaParticipants.clear();
  updateTriviaParticipants();
  window.api.triviaResetTeams();
});

// ── Custom Trivia Questions ───────────────────────────────────────────────────

let customTriviaQuestions = [];

function renderCustomTriviaList() {
  const el = document.getElementById('custom-trivia-list-ctrl');
  if (!el) return;
  if (!customTriviaQuestions.length) {
    el.innerHTML = '<div style="font-size:11px;color:#555;text-align:center;padding:6px">No custom questions yet</div>';
    return;
  }
  const letters = ['A','B','C','D'];
  el.innerHTML = '';
  customTriviaQuestions.forEach((q, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'background:var(--surface);border:1px solid #2a2a2e;border-radius:8px;padding:10px 12px';
    const opts = q.options.map((o, oi) => {
      const correct = oi === q.correctIndex;
      return `<span style="font-size:11px;padding:2px 7px;border-radius:4px;background:${correct ? 'rgba(52,199,89,0.18)' : 'transparent'};color:${correct ? '#34c759' : 'var(--text-muted)'};border:1px solid ${correct ? '#34c759' : 'transparent'}">${letters[oi]}. ${o}</span>`;
    }).join('');
    row.innerHTML = `
      <div style="font-size:12px;font-weight:600;margin-bottom:6px;line-height:1.4;color:var(--text)">${q.question}</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">${opts}</div>
      <div style="display:flex;gap:5px">
        <button class="btn-venue-go" data-cq-play="${i}" style="flex:1;font-size:11px;padding:5px 8px">▶ Play</button>
        <button class="btn" data-cq-del="${q.id}" style="font-size:11px;padding:5px 8px;color:#ff453a;border-color:#ff453a;background:rgba(255,69,58,0.08)">✕</button>
      </div>`;
    el.appendChild(row);
  });
  el.querySelectorAll('[data-cq-play]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.cqPlay);
      if (customTriviaQuestions[idx]) playCustomTriviaQuestion(customTriviaQuestions[idx]);
    });
  });
  el.querySelectorAll('[data-cq-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this custom question?')) return;
      const updated = await window.api.triviaDeleteCustom?.(btn.dataset.cqDel);
      if (updated) {
        customTriviaQuestions = updated;
        renderCustomTriviaList();
        window.api.broadcastCtrlState?.({ type: 'ctrl-custom-trivia-updated', questions: customTriviaQuestions });
      }
    });
  });
}

async function playCustomTriviaQuestion(q) {
  const timer = parseInt(document.getElementById('trivia-timer-sel')?.value || '30');
  const fullQ = { ...q, timeLimit: timer, category: 'Custom', difficulty: 'custom' };
  currentTriviaQ = fullQ;
  triviaActive   = true;
  triviaAnsweredTokens.clear();
  triviaParticipants.forEach(info => { info.answeredThisQ = false; });
  updateTriviaParticipants();
  triviaUpdateQuestionDisplay();
  window.api.broadcastCtrlState?.({ type: 'ctrl-trivia-q', question: currentTriviaQ });
  const urlEl   = document.getElementById('audience-url');
  const fullUrl = urlEl?.dataset?.submitUrl?.trim() || '';
  const triviaUrl = fullUrl ? fullUrl + '&mode=trivia' : '';
  const sendQuestion = (qrDataUrl) => {
    sendToViz({ type: 'trivia-question', ...currentTriviaQ, qrDataUrl: qrDataUrl || null });
  };
  if (triviaUrl) {
    fetchQrDataUrl(triviaUrl).then(sendQuestion).catch(() => sendQuestion(null));
  } else {
    sendQuestion(null);
  }
  window.api.triviaPublishQuestion({
    id: currentTriviaQ.id, question: currentTriviaQ.question,
    options: currentTriviaQ.options, category: currentTriviaQ.category,
    timeLimit: currentTriviaQ.timeLimit,
    correctIndex: currentTriviaQ.correctIndex,
  });
  document.getElementById('btn-trivia-reveal')?.removeAttribute('disabled');
  document.getElementById('btn-trivia-scores')?.setAttribute('disabled', '');
  if (triviaAutoTimer) clearTimeout(triviaAutoTimer);
  triviaAutoTimer = setTimeout(triviaRevealAnswer, currentTriviaQ.timeLimit * 1000);
}

document.getElementById('btn-cq-add')?.addEventListener('click', async () => {
  const question = document.getElementById('cq-question-ctrl')?.value.trim();
  const a = document.getElementById('cq-a-ctrl')?.value.trim();
  const b = document.getElementById('cq-b-ctrl')?.value.trim();
  const c = document.getElementById('cq-c-ctrl')?.value.trim();
  const d = document.getElementById('cq-d-ctrl')?.value.trim();
  const correctIndex = parseInt(document.getElementById('cq-correct-ctrl')?.value || '0');
  if (!question || !a || !b || !c || !d) {
    alert('Please fill in the question and all four answers.');
    return;
  }
  const newQ = { id: 'custom_' + Date.now(), question, options: [a, b, c, d], correctIndex };
  const updated = await window.api.triviaSaveCustom?.(newQ);
  if (updated) {
    customTriviaQuestions = updated;
    renderCustomTriviaList();
    window.api.broadcastCtrlState?.({ type: 'ctrl-custom-trivia-updated', questions: customTriviaQuestions });
    ['cq-question-ctrl','cq-a-ctrl','cq-b-ctrl','cq-c-ctrl','cq-d-ctrl'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  }
});

// Load custom questions on init
(async () => {
  try {
    customTriviaQuestions = (await window.api.triviaGetCustom?.()) || [];
    renderCustomTriviaList();
  } catch(e) { console.warn('[CustomTrivia] load failed', e); }
})();

// ── Light / Dark theme toggle ────────────────────────────────────────────────
function applyTheme(light, broadcast = true) {
  document.body.classList.toggle('light', light);
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = light ? '🌙' : '☀️';
  btn?.setAttribute('title', light ? 'Switch to dark mode' : 'Switch to light mode');
  if (broadcast) {
    window.api.broadcastCtrlState?.({ type: 'ctrl-theme', light });
  }
}
(function initTheme() {
  const saved = localStorage.getItem('ctrl_theme');
  applyTheme(saved === 'light');
})();
document.getElementById('btn-theme')?.addEventListener('click', () => {
  const isLight = !document.body.classList.contains('light');
  applyTheme(isLight);
  localStorage.setItem('ctrl_theme', isLight ? 'light' : 'dark');
});

// ── Pop-out windows ──────────────────────────────────────────────────────────
// Use addEventListener (not inline onclick) so stopPropagation reliably
// prevents the parent section-toggle collapse handler from firing.
document.querySelectorAll('.btn-popout').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const sec = btn.dataset.sec;
    if (sec) window.api.popoutSection?.(sec);
  });
});

// Pop-out mode: if loaded with ?popout=<sec>, show only that section
(function initPopoutMode() {
  const sec = new URLSearchParams(location.search).get('popout');
  if (!sec) return;
  // Hide the sticky top bar (sensitivity, random preset) to save space
  const stickyTop = document.getElementById('sticky-top');
  if (stickyTop) stickyTop.style.display = 'none';
  // Hide unrelated sections
  document.querySelectorAll('.collapsible-section').forEach(el => {
    if (el.id !== `sec-${sec}`) el.style.display = 'none';
  });
  // Ensure target section is expanded
  const target = document.getElementById(`sec-${sec}`);
  if (target) target.classList.remove('collapsed');
  // Hide popout buttons inside the popout window
  document.querySelectorAll('.btn-popout').forEach(b => b.style.display = 'none');
  // Set window title via document title
  const titles = { fx: '⚡ Visual Effects', params: 'Parameters', scrolltext: '📜 Scrolling Text', trivia: '🧠 Bar Trivia' };
  document.title = titles[sec] || 'AV Club VJ';
})();
