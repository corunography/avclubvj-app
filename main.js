const { app, BrowserWindow, ipcMain, dialog, shell, systemPreferences, desktopCapturer } = require('electron');
const path  = require('path');
const fs    = require('fs');
const http  = require('http');
const https = require('https');
const os    = require('os');

app.setName('AV Club VJ');

// ── Native addons ─────────────────────────────────────────────────────────────
let syphon = null;
try {
  syphon = require('./build/Release/syphon_addon');
  console.log('Syphon addon loaded');
} catch (e) {
  console.warn('Syphon addon not available:', e.message);
}

let ndi = null;
try {
  ndi = require('./build/Release/ndi_addon');
  console.log('NDI addon loaded');
} catch (e) {
  console.warn('NDI addon not available:', e.message);
}

let vizWindow = null;
let controlWindow = null;

const userDataPath = app.getPath('userData');
const configPath = path.join(userDataPath, 'preset-config.json');
const customPresetsPath = path.join(userDataPath, 'custom-presets');

// ── Venue / Audience Submission ───────────────────────────────────────────────
const crypto       = require('crypto');
const venueFile    = path.join(userDataPath, 'venue.json');
const audienceLog  = path.join(userDataPath, 'audience-messages.log');
let venueData      = {};
try { venueData = JSON.parse(fs.readFileSync(venueFile, 'utf8')); } catch(e) {}
// Migrate old "butterchurn-" prefix → "avclubvj-", or generate fresh topic
if (!venueData.topic || venueData.topic.startsWith('butterchurn-')) {
  const suffix = venueData.topic ? venueData.topic.slice('butterchurn-'.length) : crypto.randomBytes(4).toString('hex');
  venueData.topic = 'avclubvj-' + suffix;
}

// Determine starting cursor for ntfy polling.
// If the last-seen message was received within the replay window, resume from there
// (new messages only, no repeats). Otherwise start fresh — clean slate.
const REPLAY_WINDOW_MS = (venueData.replayWindowHours ?? 8) * 60 * 60 * 1000;
const timeSinceLast    = venueData.ntfyLastIdTime ? Date.now() - venueData.ntfyLastIdTime : Infinity;
let   ntfyLastId       = (timeSinceLast < REPLAY_WINDOW_MS && venueData.ntfyLastId) ? venueData.ntfyLastId : null;

// If using the Cloudflare Worker, old ntfy.sh IDs (e.g. "phLiGlS2x8Mj") are
// incompatible with Worker IDs (e.g. "1742755200000_abc12").  String comparison
// puts numbers BEFORE letters, so every Worker message gets filtered out.
// Detect this mismatch and reset the cursor so we start fresh.
if (venueData.workerUrl && ntfyLastId && !/^\d/.test(String(ntfyLastId))) {
  ntfyLastId               = null;
  venueData.ntfyLastId     = null;
  venueData.ntfyLastIdTime = null;
}

// Persist ntfy auth token (stored in venue.json, never in source)
// Set your ntfy.sh auth token in userData/venue.json: { "ntfyToken": "tk_..." }
if (!venueData.ntfyToken) {
  venueData.ntfyToken = '';
}
const ntfyToken = venueData.ntfyToken;

// Persist Cloudflare Worker URL — routes polls through Cloudflare IPs to avoid home-IP rate limits
if (!venueData.workerUrl) {
  venueData.workerUrl = 'https://avclubvj.corunography.workers.dev';
}

// Remote access password (empty = no auth required)
if (venueData.remotePassword === undefined) venueData.remotePassword = '';

function saveVenueData() {
  try { fs.writeFileSync(venueFile, JSON.stringify(venueData), 'utf8'); } catch(e) {}
}
saveVenueData(); // write any migration + token

const venueTopic      = venueData.topic;
let   audienceModerated = true;
let   photoModerated    = venueData.photoModerated !== false; // default: moderated
let   audienceMsgId     = 0;
const popoutWindows = [];
function allCtrlWindows() {
  return [controlWindow, ...popoutWindows].filter(w => w && !w.isDestroyed());
}
let   ntfyPollTimer     = null;

function logAudienceMessage(text) {
  const ts   = new Date().toISOString();
  const line = JSON.stringify({ time: ts, text }) + '\n';
  try { fs.appendFileSync(audienceLog, line, 'utf8'); } catch(e) {}
}

function handleAudienceMessage(text) {
  if (!text || !text.trim()) return;
  const id    = ++audienceMsgId;
  const clean = text.trim().slice(0, 300);
  logAudienceMessage(clean);
  allCtrlWindows().forEach(w => w.webContents.send('message', {
    type: 'audience-message', id, text: clean, approved: !audienceModerated,
  }));
  if (!audienceModerated && vizWindow) {
    vizWindow.webContents.send('message', { type: 'audience-message', text: clean });
  }
  // Also push to remote page SSE for moderated messages
  if (audienceModerated) {
    if (!remoteState.pendingAudienceMessages) remoteState.pendingAudienceMessages = [];
    remoteState.pendingAudienceMessages.push({ id, text: clean });
    pushSSE({ type: 'state', ...remoteState });
  }
}

// Build poll URL — routes through Cloudflare Worker when configured
// (avoids home-IP rate limits; Worker adds auth server-side)
function ntfyPollOptions(topic, since) {
  let workerBase = (venueData.workerUrl || '').replace(/\/$/, '');
  if (workerBase && !workerBase.startsWith('http')) workerBase = 'https://' + workerBase;
  if (workerBase) {
    const wUrl = new URL(workerBase);
    return {
      hostname: wUrl.hostname,
      path:     `/${topic}/json?poll=1&since=${since}`,
      headers:  { 'Accept-Encoding': 'identity' }, // Worker adds Bearer token
    };
  }
  return {
    hostname: 'ntfy.sh',
    path:     `/${topic}/json?poll=1&since=${since}`,
    headers:  { 'Accept-Encoding': 'identity', ...(ntfyToken ? { 'Authorization': 'Bearer ' + ntfyToken } : {}) },
  };
}

// Poll ntfy's JSON endpoint — simpler and more reliable than SSE in Node.js.
// Returns newline-delimited JSON of new messages since the last seen ID.
function pollNtfy() {
  if (ntfyPollTimer) { clearTimeout(ntfyPollTimer); ntfyPollTimer = null; }
  const since = ntfyLastId || 'all';
  const opts = ntfyPollOptions(venueTopic, since);
  console.log('[poll] GET', opts.hostname + opts.path, '| since:', since);
  const req = https.request(
    opts,
    res => {
      res.setEncoding('utf8');
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        console.log('[poll] status:', res.statusCode, '| raw:', data.slice(0, 300) || '(empty)');
        const lines = data.split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            console.log('[poll] parsed msg:', JSON.stringify(msg).slice(0, 200));
            if (msg.event === 'message' && msg.message) {
              ntfyLastId = msg.id;
              venueData.ntfyLastId     = ntfyLastId;
              venueData.ntfyLastIdTime = Date.now();
              saveVenueData();
              handleAudienceMessage(msg.message);
            } else if (msg.id) {
              ntfyLastId = msg.id;
            }
          } catch(e) { console.log('[poll] parse error:', e.message, '| line:', line.slice(0, 100)); }
        }
        ntfyPollTimer = setTimeout(pollNtfy, 4000);
      });
      res.on('error', e => { console.log('[poll] res error:', e.message); ntfyPollTimer = setTimeout(pollNtfy, 10000); });
    }
  );
  req.on('error', e => { console.log('[poll] req error:', e.message); ntfyPollTimer = setTimeout(pollNtfy, 10000); });
  req.end();
}

// ── Persistence ─────────────────────────────────────────────────────────────

function ensureDirs() {
  if (!fs.existsSync(customPresetsPath)) {
    fs.mkdirSync(customPresetsPath, { recursive: true });
  }
}

function loadConfig() {
  if (fs.existsSync(configPath)) {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
  }
  return {
    disabledPresets: [],   // built-in preset names to hide
    cycleEnabled: true,
    cycleInterval: 15,     // seconds
    blendTime: 2,          // seconds
    audioSource: 'mic',    // 'mic' | device id string
    outputWidth: 1280,
    outputHeight: 720,
  };
}

function saveConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// ── Windows ──────────────────────────────────────────────────────────────────

function createVizWindow(config) {
  const vizW = config.outputWidth  || 1280;
  const vizH = config.outputHeight || 720;
  vizWindow = new BrowserWindow({
    width: vizW,
    height: vizH,
    useContentSize: true,
    x: config.vizX ?? undefined,
    y: config.vizY ?? undefined,
    backgroundColor: '#000000',
    title: 'AV Club VJ — Output',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  vizWindow.loadFile('src/visualizer.html');
  // Persist position when moved
  vizWindow.on('moved', () => {
    const [x, y] = vizWindow.getPosition();
    const cfg = loadConfig(); cfg.vizX = x; cfg.vizY = y; saveConfig(cfg);
  });
  vizWindow.on('closed', () => { vizWindow = null; app.quit(); });
}

function createControlWindow(config) {
  const ctrlW = config.ctrlW ?? 500;
  const ctrlH = config.ctrlH ?? 820;
  // Default: place controls to the right of the viz window
  let ctrlX = config.ctrlX ?? undefined;
  let ctrlY = config.ctrlY ?? undefined;
  if (ctrlX === undefined && vizWindow) {
    const [vx, vy] = vizWindow.getPosition();
    const [vw]     = vizWindow.getSize();
    ctrlX = vx + vw + 8;
    ctrlY = vy;
  }
  controlWindow = new BrowserWindow({
    width: ctrlW,
    height: ctrlH,
    x: ctrlX,
    y: ctrlY,
    minWidth: 420,
    title: 'AV Club VJ — Controls',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  controlWindow.loadFile('src/controls.html');
  if (!app.isPackaged) controlWindow.webContents.openDevTools({ mode: 'detach' });
  // Persist position and size on move or resize
  const saveCtrlBounds = () => {
    const [x, y] = controlWindow.getPosition();
    const [w, h] = controlWindow.getSize();
    const cfg = loadConfig();
    cfg.ctrlX = x; cfg.ctrlY = y; cfg.ctrlW = w; cfg.ctrlH = h;
    saveConfig(cfg);
  };
  controlWindow.on('moved',  saveCtrlBounds);
  controlWindow.on('resize', saveCtrlBounds);
  controlWindow.on('closed', () => { controlWindow = null; app.quit(); });
}

// ── App lifecycle ────────────────────────────────────────────────────────────

// Expiry gate — temporary until auth is in place. Remove when ready to ship.
const EXPIRY_DATE = new Date('2026-05-01');

app.whenReady().then(async () => {
  if (new Date() >= EXPIRY_DATE) {
    await dialog.showMessageBox({
      type: 'warning',
      title: 'AV Club VJ',
      message: 'This preview version has expired.',
      detail: 'Please visit avclubvisuals.com for an updated version.',
      buttons: ['OK'],
    });
    app.quit();
    return;
  }

  ensureDirs();

  // Grant microphone permission inside Electron renderer windows
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'mediaKeySystem' || permission === 'midi' || permission === 'midiSysex') {
      callback(true);
    } else {
      callback(false);
    }
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media' || permission === 'midi') return true;
    return null;
  });

  // System audio capture via ScreenCaptureKit (macOS 13+)
  // Intercepts getDisplayMedia() calls from the renderer and auto-selects
  // the first screen with loopback audio — no picker dialog shown to user
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then(sources => {
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => callback({}));
  });

  // Ask macOS for microphone permission (required on macOS 10.14+)
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'not-determined') {
      await systemPreferences.askForMediaAccess('microphone');
    }
  }

  const config = loadConfig();
  createVizWindow(config);
  createControlWindow(config);
  startRemoteServer();
  scheduleMessagePoll(5000); // audience text messages via Cloudflare Worker R2
  pollTriviaAnswers();
  schedulePhotoPoll(5000); // photo submissions via Cloudflare Worker R2
});

app.on('window-all-closed', () => app.quit());

// ── Bar Trivia — ntfy polling + publish ──────────────────────────────────────
const triviaQTopic   = venueTopic + '-q'; // app publishes questions here
const triviaATopic   = venueTopic + '-a'; // app receives answers here
let   triviaALastId  = null;
const triviaTeamNames = []; // ordered list of registered team names

function broadcastTeamList() {
  ntfyPost(triviaQTopic, JSON.stringify({ type: 'teams', teams: triviaTeamNames }));
  remoteState.triviaTeams = [...triviaTeamNames];
  pushSSE({ type: 'state', ...remoteState });
}

function pollTriviaAnswers() {
  const since = triviaALastId || 'all';
  https.request(ntfyPollOptions(triviaATopic, since), res => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', d => { buf += d; });
    res.on('end', () => {
      buf.trim().split('\n').filter(Boolean).forEach(line => {
        try {
          const ev = JSON.parse(line);
          if (ev.id) triviaALastId = ev.id;
          if (ev.event !== 'message' || !ev.message) return;
          const parts = ev.message.split('|');

          // Team registration: TEAM-REG|teamName|token
          if (parts[0] === 'TEAM-REG' && parts.length >= 3) {
            const [, teamName, teamToken] = parts;
            if (teamName && !triviaTeamNames.includes(teamName)) {
              triviaTeamNames.push(teamName);
              broadcastTeamList(); // push updated list to all phones
            }
            allCtrlWindows().forEach(w => w.webContents.send('message', {
              type: 'trivia-team-reg', name: teamName, token: teamToken,
            }));
            return;
          }

          // Answer submission: TRIVIA|qid|team|token|answerIndex (5 parts)
          //                 or TRIVIA|qid|team|answerIndex       (4 parts, legacy)
          if (parts[0] !== 'TRIVIA' || parts.length < 4) return;
          let qid, team, token, answerIndex;
          if (parts.length >= 5) {
            [, qid, team, token, answerIndex] = parts;
          } else {
            [, qid, team, answerIndex] = parts;
            token = null;
          }
          allCtrlWindows().forEach(w => w.webContents.send('message', {
            type: 'trivia-answer', qid, team, token,
            answerIndex: parseInt(answerIndex, 10),
          }));
          // Update response count on remote control page
          remoteState.triviaResponseCount = (remoteState.triviaResponseCount || 0) + 1;
          pushSSE({ type: 'state', ...remoteState });
        } catch(e) {}
      });
    });
  }).on('error', () => {}).end();
  setTimeout(pollTriviaAnswers, 4000);
}

// Post a message through the Cloudflare Worker → KV (no ntfy.sh dependency)
function ntfyPost(topic, body) {
  return new Promise(resolve => {
    let workerBase = (venueData.workerUrl || '').replace(/\/$/, '');
    if (workerBase && !workerBase.startsWith('http')) workerBase = 'https://' + workerBase;
    if (!workerBase) { console.warn('[worker] No workerUrl set'); return resolve(false); }
    const buf     = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const wUrl    = new URL(`${workerBase}/${topic}`);
    const req     = https.request({
      hostname: wUrl.hostname,
      path:     wUrl.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'text/plain', 'Content-Length': buf.length },
    }, res => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => {
        if (res.statusCode >= 400) console.warn(`[worker] POST /${topic} → ${res.statusCode}:`, out.slice(0, 200));
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      });
    });
    req.on('error', () => resolve(false));
    req.write(buf);
    req.end();
  });
}

ipcMain.handle('trivia-publish-question', (_, data) => {
  // Strip correctIndex before posting to ntfy (don't leak answer to players)
  const { correctIndex, ...ntfyData } = data;
  remoteState.triviaQuestion     = data.question  || '';
  remoteState.triviaOptions      = data.options   || [];
  remoteState.triviaCorrectIndex = correctIndex   ?? -1;
  remoteState.triviaActive       = true;
  remoteState.triviaResponseCount = 0;
  pushSSE({ type: 'state', ...remoteState });
  return ntfyPost(triviaQTopic, JSON.stringify({ ...ntfyData, active: true }));
});

ipcMain.handle('trivia-publish-end', () => {
  remoteState.triviaActive       = false;
  remoteState.triviaQuestion     = '';
  remoteState.triviaOptions      = [];
  remoteState.triviaCorrectIndex = -1;
  remoteState.triviaResponseCount = 0;
  pushSSE({ type: 'state', ...remoteState });
  return ntfyPost(triviaQTopic, JSON.stringify({ active: false }));
});

ipcMain.handle('trivia-publish-reveal', (_, correctIndex) =>
  ntfyPost(triviaQTopic, JSON.stringify({ type: 'reveal', correctIndex })));

ipcMain.handle('trivia-get-topics', () => ({ qTopic: triviaQTopic, aTopic: triviaATopic }));

ipcMain.on('trivia-reset-teams', () => {
  triviaTeamNames.length = 0;
  remoteState.triviaTeams = [];
  broadcastTeamList();
});

// ── IPC: config ──────────────────────────────────────────────────────────────

ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', (_, config) => { saveConfig(config); return true; });

// ── Audience submission IPC ───────────────────────────────────────────────────
const DEFAULT_SUBMIT_URL = 'https://corunography.github.io/avclubvj/';
ipcMain.handle('get-venue-info', () => ({
  topic:             venueTopic,
  submitUrl:         venueData.submitUrl || DEFAULT_SUBMIT_URL,
  replayWindowHours: venueData.replayWindowHours ?? 8,
  workerUrl:         'https://avclubvj.corunography.workers.dev',
  ntfyToken:         ntfyToken || '',
  photoModerated:    venueData.photoModerated !== false,
}));
ipcMain.on('audience-action', (_, data) => {
  if (data.action === 'approve' && vizWindow) {
    vizWindow.webContents.send('message', { type: 'audience-message', text: data.text });
  }
  if (data.action === 'set-mode') {
    audienceModerated = data.mode === 'moderated';
  }
  if (data.action === 'set-submit-url') {
    venueData.submitUrl = data.submitUrl || '';
    saveVenueData();
  }
  if (data.action === 'set-replay-window') {
    venueData.replayWindowHours = Number(data.hours);
    saveVenueData();
  }
  if (data.action === 'set-worker-url') {
    venueData.workerUrl = (data.workerUrl || '').trim().replace(/\/$/, '');
    saveVenueData();
  }
  if (data.action === 'set-photo-moderated') {
    photoModerated = !!data.moderated;
    venueData.photoModerated = photoModerated;
    saveVenueData();
    remoteState.photoModerated = photoModerated;
    pushSSE({ type: 'state', ...remoteState });
  }
  if (data.action === 'clear-cursor') {
    // Force clean slate on next restart
    venueData.ntfyLastId     = null;
    venueData.ntfyLastIdTime = null;
    ntfyLastId = null;
    saveVenueData();
  }
});
ipcMain.handle('open-audience-log', () => {
  // Ensure file exists before opening
  if (!fs.existsSync(audienceLog)) fs.writeFileSync(audienceLog, '', 'utf8');
  require('electron').shell.openPath(audienceLog);
});

const triviaScoreFile = path.join(userDataPath, 'trivia-scores.json');

ipcMain.handle('trivia-save-scores', (_, scores) => {
  try {
    // scores is an array of {team, score}
    const entry = { time: new Date().toISOString(), scores };
    const log = (() => { try { return JSON.parse(fs.readFileSync(triviaScoreFile, 'utf8')); } catch(e) { return []; } })();
    log.push(entry);
    fs.writeFileSync(triviaScoreFile, JSON.stringify(log.slice(-100), null, 2), 'utf8');
    return true;
  } catch(e) { return false; }
});

ipcMain.handle('trivia-push-scores', (_, scores) => {
  remoteState.triviaScores = scores || [];
  pushSSE({ type: 'state', ...remoteState });
  return true;
});

ipcMain.handle('trivia-clear-scores', () => {
  try {
    // Log current scores before clearing
    const log = (() => { try { return JSON.parse(fs.readFileSync(triviaScoreFile, 'utf8')); } catch(e) { return []; } })();
    log.push({ time: new Date().toISOString(), event: 'cleared' });
    fs.writeFileSync(triviaScoreFile, JSON.stringify(log.slice(-100), null, 2), 'utf8');
    return true;
  } catch(e) { return false; }
});

ipcMain.handle('open-trivia-score-log', () => {
  if (!fs.existsSync(triviaScoreFile)) fs.writeFileSync(triviaScoreFile, '[]', 'utf8');
  require('electron').shell.openPath(triviaScoreFile);
});

// ── IPC: custom trivia questions ──────────────────────────────────────────────

const customTriviaFile = path.join(userDataPath, 'custom-trivia.json');

function loadCustomTrivia() {
  try { return JSON.parse(fs.readFileSync(customTriviaFile, 'utf8')); } catch(e) { return []; }
}
function saveCustomTrivia(questions) {
  fs.writeFileSync(customTriviaFile, JSON.stringify(questions, null, 2), 'utf8');
}

ipcMain.handle('trivia-get-custom', () => loadCustomTrivia());

ipcMain.handle('trivia-save-custom', (_, question) => {
  const questions = loadCustomTrivia();
  const idx = questions.findIndex(q => q.id === question.id);
  if (idx >= 0) questions[idx] = question; else questions.push(question);
  saveCustomTrivia(questions);
  remoteState.customTriviaQuestions = questions;
  pushSSE({ type: 'state', ...remoteState });
  return questions;
});

ipcMain.handle('trivia-delete-custom', (_, id) => {
  const questions = loadCustomTrivia().filter(q => q.id !== id);
  saveCustomTrivia(questions);
  remoteState.customTriviaQuestions = questions;
  pushSSE({ type: 'state', ...remoteState });
  return questions;
});

// ── Audience Messages — Cloudflare R2 polling ─────────────────────────────────

let messagePollTimer = null;
let knownMessageIds  = new Set();

function scheduleMessagePoll(delayMs = 10000) {
  if (messagePollTimer) { clearTimeout(messagePollTimer); messagePollTimer = null; }
  messagePollTimer = setTimeout(pollMessages, delayMs);
}

function pollMessages() {
  const url = `${PHOTO_WORKER_URL}/messages?venueId=${encodeURIComponent(venueTopic)}`;
  httpGet(url).then(data => {
    if (!Array.isArray(data)) return;
    const newMsgs = data.filter(m => m && m.id && !knownMessageIds.has(m.id));
    for (const m of newMsgs) {
      knownMessageIds.add(m.id);
      handleAudienceMessage(m.text || '');
      // Delete immediately — app now owns the message
      httpDelete(`${PHOTO_WORKER_URL}/messages/${encodeURIComponent(m.id)}?venueId=${encodeURIComponent(venueTopic)}`).catch(() => {});
    }
  }).catch(() => {}).finally(() => { scheduleMessagePoll(5000); });
}

// ── Photo Sharing — Cloudflare R2 polling ─────────────────────────────────────

let photoPollTimer   = null;
let knownPhotoIds    = new Set();
let pendingPhotoList = []; // { id, dataUrl, caption, ts }

const PHOTO_WORKER_URL = 'https://avclubvj.corunography.workers.dev';

function schedulePhotoPoll(delayMs = 10000) {
  if (photoPollTimer) { clearTimeout(photoPollTimer); photoPollTimer = null; }
  photoPollTimer = setTimeout(pollPhotos, delayMs);
}

function pollPhotos() {
  const workerUrl = PHOTO_WORKER_URL;
  const venueId = venueTopic;
  const url = `${workerUrl}/photos?venueId=${encodeURIComponent(venueId)}`;
  httpGet(url).then(data => {
    if (!Array.isArray(data)) return;
    // Find photos not yet seen
    const newPhotos = data.filter(p => p && p.id && !knownPhotoIds.has(p.id));
    if (newPhotos.length > 0) {
      for (const p of newPhotos) knownPhotoIds.add(p.id);
      if (!photoModerated) {
        // Unmoderated — auto-display each photo, save to history, delete from R2
        const duration = 12;
        for (const p of newPhotos) {
          if (vizWindow) vizWindow.webContents.send('message', { type: 'photo-display', dataUrl: p.dataUrl, caption: p.caption || '', duration });
          try {
            if (!fs.existsSync(photoHistoryDir)) fs.mkdirSync(photoHistoryDir, { recursive: true });
            const date  = new Date(p.ts || Date.now());
            const stamp = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const imgFile = 'photo-' + stamp + '.jpg';
            fs.writeFileSync(path.join(photoHistoryDir, imgFile), Buffer.from(p.dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
            const logPath = path.join(photoHistoryDir, 'history.json');
            const log = (() => { try { return JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch(e) { return []; } })();
            log.push({ file: imgFile, caption: p.caption || '', ts: date.toISOString() });
            fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
          } catch(e) {}
          httpDelete(`${PHOTO_WORKER_URL}/photos/${encodeURIComponent(p.id)}?venueId=${encodeURIComponent(venueTopic)}`).catch(() => {});
        }
      } else {
        // Moderated — add to pending queue
        const existingIds = new Set(pendingPhotoList.map(p => p.id));
        for (const p of newPhotos) {
          if (!existingIds.has(p.id)) pendingPhotoList.push(p);
        }
        remoteState.pendingPhotos = pendingPhotoList.map(p => ({ id: p.id, dataUrl: p.dataUrl, caption: p.caption, ts: p.ts }));
        pushSSE({ type: 'state', ...remoteState });
        allCtrlWindows().forEach(w => w.webContents.send('message', {
          type: 'pending-photos-update', photos: pendingPhotoList,
        }));
      }
    }
  }).catch(() => {}).finally(() => { schedulePhotoPoll(10000); });
}

function httpDelete(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const req = client.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'DELETE',
      headers:  { 'Content-Length': 0 },
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

ipcMain.handle('photo-delete', async (_, id) => {
  if (id) {
    const url = `${PHOTO_WORKER_URL}/photos/${encodeURIComponent(id)}?venueId=${encodeURIComponent(venueTopic)}`;
    await httpDelete(url).catch(() => {});
  }
  knownPhotoIds.delete(id);
  pendingPhotoList = pendingPhotoList.filter(p => p.id !== id);
  return true;
});

// ── Photo History ─────────────────────────────────────────────────────────────

const photoHistoryDir = path.join(userDataPath, 'photo-history');

ipcMain.handle('photo-save-history', (_, { dataUrl, caption, ts }) => {
  try {
    if (!fs.existsSync(photoHistoryDir)) fs.mkdirSync(photoHistoryDir, { recursive: true });
    const date  = new Date(ts || Date.now());
    const stamp = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    // Write JPEG file
    const base64   = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const imgFile  = `photo-${stamp}.jpg`;
    const imgPath  = path.join(photoHistoryDir, imgFile);
    fs.writeFileSync(imgPath, Buffer.from(base64, 'base64'));
    // Append to metadata log
    const logPath = path.join(photoHistoryDir, 'history.json');
    const log = (() => { try { return JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch(e) { return []; } })();
    log.push({ file: imgFile, caption: caption || '', ts: date.toISOString() });
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
    return true;
  } catch(e) { console.error('[photo-history] save failed:', e); return false; }
});

ipcMain.handle('photo-open-history', () => {
  if (!fs.existsSync(photoHistoryDir)) fs.mkdirSync(photoHistoryDir, { recursive: true });
  require('electron').shell.openPath(photoHistoryDir);
});

ipcMain.handle('photo-clear-history', () => {
  try {
    if (!fs.existsSync(photoHistoryDir)) return true;
    const files = fs.readdirSync(photoHistoryDir);
    for (const f of files) fs.unlinkSync(path.join(photoHistoryDir, f));
    return true;
  } catch(e) { return false; }
});

// ── IPC: bonus presets (extra resources — loaded from disk, not bundled) ─────

const bonusPresetsPath = app.isPackaged
  ? path.join(process.resourcesPath, 'bonus-presets')
  : path.join(__dirname, 'tens-of-thousands-milkdrop-presets-for-butterchurn-master', 'BONUS_milkdrop-presets-for-butterchurn');

ipcMain.handle('get-bonus-preset-names', () => {
  if (!fs.existsSync(bonusPresetsPath)) return [];
  const names = [];
  function scan(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(e) { return; }
    for (const e of entries) {
      if (e.isDirectory()) { scan(path.join(dir, e.name)); }
      else if (e.name.endsWith('.json')) {
        names.push(e.name.replace(/\.json$/, ''));
      }
    }
  }
  scan(bonusPresetsPath);
  return names;
});

ipcMain.handle('load-bonus-preset', (_, name) => {
  // Search the bonus presets directory for a file matching the name
  if (!fs.existsSync(bonusPresetsPath)) return null;
  let found = null;
  function scan(dir) {
    if (found) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(e) { return; }
    for (const e of entries) {
      if (found) return;
      if (e.isDirectory()) { scan(path.join(dir, e.name)); }
      else if (e.name === name + '.json') {
        try { found = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8')); } catch(e2) {}
      }
    }
  }
  scan(bonusPresetsPath);
  return found;
});

// ── IPC: custom presets ──────────────────────────────────────────────────────

ipcMain.handle('get-custom-presets', () => {
  const results = [];
  const EXTS = new Set(['.json', '.milk']);

  function scan(dir, category, subcategory) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!category)         scan(fullPath, entry.name, null);
        else if (!subcategory) scan(fullPath, category, entry.name);
        // max 2 levels deep
      } else if (EXTS.has(path.extname(entry.name))) {
        const baseName = path.basename(entry.name, path.extname(entry.name));
        const idParts  = [category, subcategory, baseName].filter(Boolean);
        results.push({
          name:        baseName,
          id:          idParts.join('/'),
          filePath:    fullPath,
          ext:         path.extname(entry.name),
          category:    category    || null,
          subcategory: subcategory || null,
        });
      }
    }
  }

  scan(customPresetsPath, null, null);
  return results;
});

ipcMain.handle('import-presets', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'MilkDrop Presets', extensions: ['json', 'milk'] }],
  });
  if (canceled) return [];
  const imported = [];
  for (const src of filePaths) {
    const dest = path.join(customPresetsPath, path.basename(src));
    fs.copyFileSync(src, dest);
    imported.push(path.basename(src, path.extname(src)));
  }
  return imported;
});

ipcMain.handle('save-generated-preset', (_, { name, preset }) => {
  const safeName = name.replace(/[^a-z0-9 _\-().]/gi, '_').trim() || `Generated_${Date.now()}`;
  const fp = path.join(customPresetsPath, safeName + '.json');
  fs.writeFileSync(fp, JSON.stringify(preset, null, 2));
  return safeName;
});

// ── IPC: hydra preset saving ──────────────────────────────────────────────────
const hydraPresetsPath = path.join(__dirname, 'src', 'hydra-presets');

ipcMain.handle('save-hydra-preset', (_, { id, name, code }) => {
  // id is the webpack key like "./color-wash.json" for overwrites, null for new
  const safeName  = name.replace(/[^a-z0-9 _\-().]/gi, '_').trim() || `Hydra_${Date.now()}`;
  const fileName  = id ? path.basename(id) : safeName.replace(/ /g, '-').toLowerCase() + '.json';
  const filePath  = path.join(hydraPresetsPath, fileName);
  const data      = { name, code };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return { id: `./${fileName}`, name, code };
});

ipcMain.handle('delete-custom-preset', (_, filePath) => {
  if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); return true; }
  return false;
});

ipcMain.handle('read-preset-file', (_, filePath) => {
  return fs.readFileSync(filePath, 'utf8');
});

// ── IPC: low-FPS preset logging ──────────────────────────────────────────────

const lowFpsLogPath = path.join(userDataPath, 'low-fps-presets.log');

ipcMain.on('log-low-fps-preset', (_, { name, fps }) => {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `${ts} | ${fps}fps | ${name}\n`;
  fs.appendFileSync(lowFpsLogPath, line);
});

ipcMain.on('open-low-fps-log', () => {
  if (!fs.existsSync(lowFpsLogPath)) {
    fs.writeFileSync(lowFpsLogPath, '# Low-FPS Preset Log\n# Presets that dropped below 25fps will appear here.\n');
  }
  require('electron').shell.openPath(lowFpsLogPath);
});

// ── IPC: venue overlay helpers ────────────────────────────────────────────────

ipcMain.handle('show-open-dialog', async (_, opts) => {
  const win = controlWindow || vizWindow;
  return dialog.showOpenDialog(win, opts);
});

ipcMain.handle('read-file-as-data-url', async (_, filePath) => {
  const data = fs.readFileSync(filePath);
  const ext  = path.extname(filePath).toLowerCase().slice(1);
  const mime = ext === 'jpg' ? 'image/jpeg'
             : ext === 'png' ? 'image/png'
             : ext === 'gif' ? 'image/gif'
             : ext === 'webp' ? 'image/webp'
             : ext === 'svg' ? 'image/svg+xml'
             : 'image/png';
  return `data:${mime};base64,${data.toString('base64')}`;
});

// ── IPC: cross-window messaging ──────────────────────────────────────────────

// Controls → Visualizer
ipcMain.on('to-viz', (_, msg) => {
  if (vizWindow) vizWindow.webContents.send('message', msg);
});

// Visualizer → Controls (e.g. current preset name for display)
ipcMain.on('to-control', (_, msg) => {
  allCtrlWindows().forEach(w => w.webContents.send('message', msg));
  if (msg.type === 'current-preset') {
    remoteState.presetName = msg.name;
    pushSSE({ type: 'state', ...remoteState });
  }
  if (msg.type === 'perf-update') {
    remoteState.fps = msg.actualFps ?? 0;
    remoteState.gpuLoad = msg.loadPct ?? 0;
    pushSSE({ type: 'state', ...remoteState });
  }
  if (msg.type === 'bpm-update' || msg.type === 'beat-tick') {
    if (msg.bpm > 0) {
      remoteState.bpm = msg.bpm;
      remoteState.bpmConfidence = msg.confidence ?? 0;
      pushSSE({ type: 'state', ...remoteState });
    }
  }
  if (msg.type === 'remote-state-update') {
    Object.assign(remoteState, msg.state);
    pushSSE({ type: 'state', ...remoteState });
  }
});

// ── IPC: window management ───────────────────────────────────────────────────

ipcMain.handle('set-viz-size', (_, { width, height }) => {
  if (vizWindow) vizWindow.setContentSize(width, height);
  return true;
});

ipcMain.handle('toggle-viz-fullscreen', () => {
  if (vizWindow) vizWindow.setSimpleFullScreen(!vizWindow.isSimpleFullScreen());
  return true;
});

ipcMain.handle('get-displays', () => {
  const { screen } = require('electron');
  return screen.getAllDisplays().map(d => ({
    id: d.id,
    label: `${d.size.width}×${d.size.height}${d.isPrimary ? ' (Primary)' : ''}`,
    bounds: d.bounds,
    isPrimary: d.isPrimary,
  }));
});

ipcMain.handle('send-to-display', async (_, displayId) => {
  if (!vizWindow) return false;
  const { screen } = require('electron');
  const display = screen.getAllDisplays().find(d => d.id === displayId);
  if (!display) return false;

  // Exit any fullscreen mode first (both kinds), synchronously
  if (vizWindow.isSimpleFullScreen()) {
    vizWindow.setSimpleFullScreen(false);
  }
  if (vizWindow.isFullScreen()) {
    await new Promise(resolve => {
      vizWindow.once('leave-full-screen', resolve);
      vizWindow.setFullScreen(false);
    });
  }

  // Move to the target display then use simpleFullScreen — it's synchronous
  // and respects the display the window is currently on, unlike the macOS
  // Spaces-based fullscreen which can ignore setBounds.
  vizWindow.setBounds(display.bounds);
  vizWindow.show();
  vizWindow.setSimpleFullScreen(true);
  return true;
});

ipcMain.handle('set-viz-visible', (_, visible) => {
  if (!vizWindow) return false;
  if (visible) vizWindow.show(); else vizWindow.hide();
  return true;
});

ipcMain.handle('get-viz-visible', () => {
  return vizWindow ? vizWindow.isVisible() : false;
});

// ── IPC: Syphon ───────────────────────────────────────────────────────────────

ipcMain.handle('syphon-start', (_, name) => {
  if (!syphon) return { ok: false, error: 'Syphon addon not loaded' };
  try {
    const serverName = syphon.startServer(name || 'AV Club VJ');
    return { ok: true, name: serverName };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('syphon-stop', () => {
  if (syphon) syphon.stopServer();
  return true;
});

ipcMain.handle('syphon-status', () => ({
  available: syphon != null,
  running: syphon ? syphon.isRunning() : false,
}));

// Pixel frame from renderer — fan out to both Syphon and NDI
ipcMain.on('syphon-frame', (event, width, height, pixels) => {
  if (syphon && syphon.isRunning()) {
    try { syphon.publishFrame(pixels, width, height); } catch (e) {
      console.error('Syphon publishFrame error:', e.message);
    }
  }
  if (ndi && ndi.isRunning()) {
    try { ndi.publishFrame(pixels, width, height); } catch (e) {
      console.error('NDI publishFrame error:', e.message);
    }
  }
});

// ── IPC: Syphon Overlay (transparent alpha channel) ───────────────────────────

ipcMain.handle('syphon-overlay-start', (_, name) => {
  if (!syphon) return { ok: false, error: 'Syphon addon not loaded' };
  try {
    const serverName = syphon.startOverlayServer(name || 'AV Club VJ Overlay');
    return { ok: true, name: serverName };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('syphon-overlay-stop', () => {
  if (syphon) syphon.stopOverlayServer();
  return true;
});

ipcMain.handle('syphon-overlay-status', () => ({
  available: syphon != null,
  running: syphon ? syphon.isOverlayRunning() : false,
}));

ipcMain.on('syphon-overlay-frame', (event, width, height, pixels) => {
  if (syphon && syphon.isOverlayRunning()) {
    try { syphon.publishOverlayFrame(pixels, width, height); } catch (e) {
      console.error('Syphon overlay publishFrame error:', e.message);
    }
  }
});

// ── IPC: NDI ──────────────────────────────────────────────────────────────────

ipcMain.handle('ndi-start', (_, name) => {
  if (!ndi) return { ok: false, error: 'NDI addon not loaded' };
  try {
    const senderName = ndi.startSender(name || 'AV Club VJ');
    return { ok: true, name: senderName };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('ndi-stop', () => {
  if (ndi) ndi.stopSender();
  return true;
});

ipcMain.handle('ndi-status', () => ({
  available: ndi != null,
  running: ndi ? ndi.isRunning() : false,
}));

// ── IPC: Live Text Feed fetcher ───────────────────────────────────────────────
// Runs in the main process to avoid CORS / CSP issues in the renderer.

function httpGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'AV-Club-VJ/1.0', ...extraHeaders },
    }, (res) => {
      // Follow up to 3 redirects
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
        return httpGet(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

ipcMain.handle('fetch-feed', async (_, { feed, params = {} }) => {
  try {
    switch (feed) {
      case 'dadjokes': {
        const d = await httpGet('https://icanhazdadjoke.com/');
        return d.joke || null;
      }
      case 'advice': {
        const d = await httpGet('https://api.adviceslip.com/advice');
        return d?.slip?.advice || null;
      }
      case 'ronswanson': {
        const d = await httpGet('https://ron-swanson-quotes.herokuapp.com/v2/quotes');
        return Array.isArray(d) ? d[0] : null;
      }
      case 'chuck': {
        const d = await httpGet('https://api.chucknorris.io/jokes/random');
        let joke = d?.value || null;
        const name = (params.name || '').trim();
        if (joke && name && name !== 'Chuck Norris') {
          joke = joke.replace(/Chuck Norris/g, name);
        }
        return joke;
      }
      case 'kanye': {
        const d = await httpGet('https://api.kanye.rest');
        return d?.quote ? `"${d.quote}" — Kanye West` : null;
      }
      case 'bored': {
        // Try the newer endpoint first, fall back to original
        let d;
        try { d = await httpGet('https://bored-api.appbrewery.com/random'); }
        catch (_) { d = await httpGet('https://www.boredapi.com/api/activity'); }
        return d?.activity ? `Tonight's suggestion: ${d.activity}` : null;
      }
      case 'wikipedia': {
        const now = new Date();
        const month = now.getMonth() + 1;
        const day   = now.getDate();
        const d = await httpGet(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${day}`);
        const events = d?.events;
        if (!Array.isArray(events) || !events.length) return null;
        const ev = events[Math.floor(Math.random() * Math.min(events.length, 15))];
        return `On this day in ${ev.year}: ${ev.text}`;
      }
      case 'trivia': {
        const d = await httpGet('https://opentdb.com/api.php?amount=1&type=multiple');
        const item = d?.results?.[0];
        if (!item) return null;
        const q = item.question.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
        const ans = item.correct_answer.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&');
        return `Trivia: ${q} — Answer: ${ans}`;
      }
      case 'uselessfacts': {
        const d = await httpGet('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en');
        return d?.text || null;
      }
      case 'catfacts': {
        const d = await httpGet('https://catfact.ninja/fact');
        return d?.fact ? '🐱 ' + d.fact : null;
      }
      case 'evilinsults': {
        // Try primary, fall back to secondary
        try {
          const d = await httpGet('https://evilinsult.com/generate_insult.php?lang=en&type=json');
          const insult = typeof d === 'string' ? d.trim() : d?.insult;
          if (insult) return '😈 ' + insult;
        } catch (_) {}
        try {
          const d2 = await httpGet('https://insult.mattbas.org/api/insult');
          const insult2 = typeof d2 === 'string' ? d2.trim() : null;
          if (insult2) return '😈 ' + insult2;
        } catch (_) {}
        return null;
      }
      case 'showerthoughts': {
        const d = await httpGet('https://www.reddit.com/r/Showerthoughts/top.json?limit=50&t=week');
        const posts = d?.data?.children;
        if (!Array.isArray(posts) || !posts.length) return null;
        const pick = posts[Math.floor(Math.random() * posts.length)];
        const title = pick?.data?.title;
        return title ? '🚿 ' + title : null;
      }
      case 'corporatebs': {
        const _BS_FALLBACK = [
          'leverage agile frameworks to provide robust synergy','override the digital divide with additional clickthroughs',
          'nanotechnology immersion along the information highway','bring to the table win-win survival strategies',
          'capitalize on low-hanging fruit to identify ballpark value','iterate on core competencies to foster collaborative thinking',
          'disrupt emerging deliverables via integrated networks','conceptualize distinctive niches for high-value vertical markets',
          'synergize cross-platform deliverables with best-of-breed convergence','orchestrate holistic content to improve overarching bandwidth',
          'visualize B2C e-tailers for impactful stakeholder ecosystems','strategize next-generation ROI via cloud-enabled paradigms',
          'productize scalable workflows to architect 360-degree experiences','ideate mission-critical metrics for proactive deliverables',
          'transform bleeding-edge methodologies into omnichannel touch-points',
        ];
        try {
          const d = await httpGet('https://corporatebs-generator.sameerkumar.website/');
          const phrase = d?.phrase || (typeof d === 'string' ? d.trim() : null);
          if (phrase) return '💼 ' + phrase;
        } catch (_) {}
        return '💼 ' + _BS_FALLBACK[Math.floor(Math.random() * _BS_FALLBACK.length)];
      }
      case 'dirtyjokes': {
        const d = await httpGet('https://v2.jokeapi.dev/joke/Dark,Spooky,Misc?type=single&blacklistFlags=racist,sexist');
        return (d?.error === false && d?.joke) ? d.joke : (d?.joke || null);
      }
      case 'weather': {
        const { city, apiKey } = params;
        if (!city || !apiKey) return null;
        const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=imperial`;
        const d = await httpGet(url);
        if (!d?.main) return null;
        const desc = d.weather?.[0]?.description || 'unknown conditions';
        const temp = Math.round(d.main.temp);
        const feel = Math.round(d.main.feels_like);
        return `${d.name || city}: ${temp}°F (feels like ${feel}°F), ${desc}`;
      }
      default:
        return null;
    }
  } catch (e) {
    console.warn('[Feed] Error fetching', feed, '—', e.message);
    return null;
  }
});

// ── Remote Control Server ─────────────────────────────────────────────────────

const REMOTE_PORT = 3131;
let remoteState = {
  presetName: '—',
  cycleEnabled: false, cycleInterval: 15, blendTime: 2,
  beatSyncEnabled: false, beatDivisor: 4, bpm: 0, bpmConfidence: 0,
  sensitivity: 1, eqBass: 0, eqMid: 0, eqTreb: 0, genre: 'flat',
  importedEnabled: true, importedChance: 0.20,
  mixGenerated: false, mixGeneratedChance: 0.20,
  favCycleEnabled: false, favCycleChance: 0.20,
  brightSkip: true, darkSkip: true,
  fpsCap: 60, meshQuality: 'high', perfSkipEnabled: false, perfThreshold: 150,
  fps: 0, gpuLoad: 0,
  feedRunning: false, feedInterval: 0,
  marqueeSpeed: 3, marqueeSize: 52, marqueeColor: '#ffffff', marqueeBgAlpha: 0.65, marqueePosition: 'bottom',
  logosEnabled: true, logoGlobalDuration: 10, logoGlobalInterval: 5,
  triviaQuestion: '', triviaOptions: [], triviaCorrectIndex: -1, triviaResponseCount: 0, triviaActive: false, triviaScores: [], triviaTeams: [],
  pendingAudienceMessages: [],
  customTriviaQuestions: loadCustomTrivia(),
  pendingPhotos: [],
  photoModerated: venueData.photoModerated !== false,
};
let sseClients  = [];

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function pushSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(res => {
    try { res.write(payload); return true; } catch (_) { return false; }
  });
}

function handleRemoteCmd(cmd) {
  const toViz  = msg => { if (vizWindow) vizWindow.webContents.send('message', msg); };
  const toCtrl = msg => allCtrlWindows().forEach(w => w.webContents.send('message', msg));
  switch (cmd.type) {
    case 'random-preset':
      toCtrl({ type: 'remote-random-preset' });
      break;
    case 'next-preset':
      toCtrl({ type: 'remote-next-preset' });
      break;
    case 'prev-preset':
      toCtrl({ type: 'remote-prev-preset' });
      break;
    case 'generate-preset':
      toCtrl({ type: 'remote-generate-preset' });
      break;
    case 'randomize-params':
      toViz({ type: 'generate-glitch-preset', mode: 'randomize' });
      break;
    case 'strobe':        toViz({ type: 'strobe' });        break;
    case 'black-strobe':  toViz({ type: 'black-strobe' });  break;
    case 'shake':         toViz({ type: 'shake' });         break;
    case 'zoom-punch':    toViz({ type: 'zoom-punch' });    break;
    case 'color-crush':   toViz({ type: 'color-crush' });   break;
    case 'tunnel':        toViz({ type: 'tunnel' });        break;
    case 'reset-bpm':     toViz({ type: 'reset-bpm' });     break;
    case 'blackout':
      toViz({ type: 'blackout', active: cmd.active });
      break;
    case 'marquee-play-once':
      toViz({ type: 'marquee-play-once', text: cmd.text, config: cmd.config || {} });
      break;
    case 'marquee-stop':
      toViz({ type: 'marquee-stop' });
      break;
    case 'set-cycle':
      remoteState.cycleEnabled  = cmd.enabled;
      remoteState.cycleInterval = cmd.interval ?? remoteState.cycleInterval;
      toCtrl({ type: 'remote-set-cycle', enabled: cmd.enabled, interval: cmd.interval });
      pushSSE({ type: 'state', ...remoteState });
      break;
    case 'set-blend':
      remoteState.blendTime = cmd.blendTime;
      toCtrl({ type: 'remote-set-blend', blendTime: cmd.blendTime });
      pushSSE({ type: 'state', ...remoteState });
      break;
    case 'set-beat-sync':
      remoteState.beatSyncEnabled = cmd.enabled;
      if (cmd.divisor) remoteState.beatDivisor = cmd.divisor;
      toCtrl({ type: 'remote-set-beat-sync', enabled: cmd.enabled, divisor: cmd.divisor });
      break;
    case 'set-sensitivity':
      remoteState.sensitivity = cmd.value;
      toCtrl({ type: 'remote-set-sensitivity', value: cmd.value });
      break;
    case 'set-eq':
      remoteState.eqBass = cmd.bass; remoteState.eqMid = cmd.mid; remoteState.eqTreb = cmd.treb;
      toCtrl({ type: 'remote-set-eq', bass: cmd.bass, mid: cmd.mid, treb: cmd.treb });
      break;
    case 'set-genre':
      remoteState.genre = cmd.genre;
      toCtrl({ type: 'remote-set-genre', genre: cmd.genre });
      break;
    case 'set-imported':
      remoteState.importedEnabled = cmd.enabled;
      if (cmd.chance !== undefined) remoteState.importedChance = cmd.chance;
      toCtrl({ type: 'remote-set-imported', enabled: cmd.enabled, chance: cmd.chance });
      break;
    case 'set-mix-generated':
      remoteState.mixGenerated = cmd.enabled;
      if (cmd.chance !== undefined) remoteState.mixGeneratedChance = cmd.chance;
      toCtrl({ type: 'remote-set-mix-generated', enabled: cmd.enabled, chance: cmd.chance });
      break;
    case 'set-favorites':
      remoteState.favCycleEnabled = cmd.enabled;
      if (cmd.chance !== undefined) remoteState.favCycleChance = cmd.chance;
      toCtrl({ type: 'remote-set-favorites', enabled: cmd.enabled, chance: cmd.chance });
      break;
    case 'set-bright-skip':
      remoteState.brightSkip = cmd.enabled;
      toCtrl({ type: 'remote-set-bright-skip', enabled: cmd.enabled });
      break;
    case 'set-dark-skip':
      remoteState.darkSkip = cmd.enabled;
      toCtrl({ type: 'remote-set-dark-skip', enabled: cmd.enabled });
      break;
    case 'set-fps-cap':
      remoteState.fpsCap = cmd.fps;
      toCtrl({ type: 'remote-set-fps-cap', fps: cmd.fps });
      break;
    case 'set-mesh-quality':
      remoteState.meshQuality = cmd.quality;
      toCtrl({ type: 'remote-set-mesh-quality', quality: cmd.quality });
      break;
    case 'set-perf-skip':
      remoteState.perfSkipEnabled = cmd.enabled;
      if (cmd.threshold) remoteState.perfThreshold = cmd.threshold;
      toCtrl({ type: 'remote-set-perf-skip', enabled: cmd.enabled, threshold: cmd.threshold });
      break;
    case 'feed-start':
      remoteState.feedRunning = true;
      remoteState.feedInterval = cmd.interval ?? remoteState.feedInterval;
      toCtrl({ type: 'remote-feed-start', interval: cmd.interval });
      pushSSE({ type: 'state', ...remoteState });
      break;
    case 'feed-stop':
      remoteState.feedRunning = false;
      toCtrl({ type: 'remote-feed-stop' });
      pushSSE({ type: 'state', ...remoteState });
      break;
    case 'feed-now':
      toCtrl({ type: 'remote-feed-now', feed: cmd.feed, chuckName: cmd.chuckName, closeTime: cmd.closeTime });
      break;
    case 'set-marquee-config':
      Object.assign(remoteState, {
        marqueeSpeed: cmd.speed ?? remoteState.marqueeSpeed,
        marqueeSize: cmd.fontSize ?? remoteState.marqueeSize,
        marqueeColor: cmd.color ?? remoteState.marqueeColor,
        marqueeBgAlpha: cmd.bgAlpha ?? remoteState.marqueeBgAlpha,
        marqueePosition: cmd.position ?? remoteState.marqueePosition,
      });
      // Send directly to viz so live-playing marquee updates immediately
      toViz({ type: 'marquee-config', config: {
        speed: cmd.speed ?? remoteState.marqueeSpeed,
        fontSize: cmd.fontSize ?? remoteState.marqueeSize,
        color: cmd.color ?? remoteState.marqueeColor,
        bgAlpha: cmd.bgAlpha ?? remoteState.marqueeBgAlpha,
        bgColor: '#000000',
        position: cmd.position ?? remoteState.marqueePosition,
      }});
      toCtrl({ type: 'remote-set-marquee-config', ...cmd });
      break;
    case 'set-custom-messages':
      toCtrl({ type: 'remote-set-custom-messages', messages: cmd.messages });
      break;
    case 'set-logos-enabled':
      remoteState.logosEnabled = cmd.enabled;
      toCtrl({ type: 'remote-set-logos-enabled', enabled: cmd.enabled });
      break;
    case 'set-logo-timing':
      if (cmd.duration) remoteState.logoGlobalDuration = cmd.duration;
      if (cmd.interval) remoteState.logoGlobalInterval = cmd.interval;
      toCtrl({ type: 'remote-set-logo-timing', duration: cmd.duration, interval: cmd.interval });
      break;
    case 'set-logo-cfg':
      toCtrl({ type: 'remote-set-logo-cfg', id: cmd.id, visibility: cmd.visibility, bounce: cmd.bounce });
      break;
    case 'trivia-new-question':
      toCtrl({ type: 'remote-trivia-new-question' });
      break;
    case 'trivia-reveal-answer':
      toCtrl({ type: 'remote-trivia-reveal-answer' });
      break;
    case 'trivia-show-scores':
      toCtrl({ type: 'remote-trivia-show-scores' });
      break;
    case 'trivia-clear-screen':
      toCtrl({ type: 'remote-trivia-clear-screen' });
      break;
    case 'trivia-reset-teams':
      toCtrl({ type: 'remote-trivia-reset-teams' });
      break;
    case 'trivia-reset-scores':
      toCtrl({ type: 'remote-trivia-reset-scores' });
      break;
    case 'trivia-play-custom':
      toCtrl({ type: 'remote-trivia-play-custom', question: cmd.question });
      break;
    case 'trivia-add-custom': {
      const qs = loadCustomTrivia();
      const nq = { ...cmd.question, id: cmd.question.id || 'custom_' + Date.now() };
      const ni = qs.findIndex(x => x.id === nq.id);
      if (ni >= 0) qs[ni] = nq; else qs.push(nq);
      saveCustomTrivia(qs);
      remoteState.customTriviaQuestions = qs;
      pushSSE({ type: 'state', ...remoteState });
      toCtrl({ type: 'ctrl-custom-trivia-updated', questions: qs });
      break;
    }
    case 'trivia-delete-custom': {
      const dqs = loadCustomTrivia().filter(q => q.id !== cmd.id);
      saveCustomTrivia(dqs);
      remoteState.customTriviaQuestions = dqs;
      pushSSE({ type: 'state', ...remoteState });
      toCtrl({ type: 'ctrl-custom-trivia-updated', questions: dqs });
      break;
    }
    case 'photo-kill':
      toViz({ type: 'photo-kill' });
      allCtrlWindows().forEach(w => w.webContents.send('message', { type: 'photo-killed' }));
      break;
    case 'set-photo-moderated':
      photoModerated = !!cmd.moderated;
      venueData.photoModerated = photoModerated;
      saveVenueData();
      remoteState.photoModerated = photoModerated;
      pushSSE({ type: 'state', ...remoteState });
      allCtrlWindows().forEach(w => w.webContents.send('message', { type: 'photo-moderated-changed', moderated: photoModerated }));
      break;
    case 'photo-approve': {
      const paIdx = pendingPhotoList.findIndex(p => p.id === cmd.id);
      if (paIdx === -1) break;
      const photo = pendingPhotoList[paIdx];
      const dur = cmd.duration || 12;
      // Send to visualizer
      toViz({ type: 'photo-display', dataUrl: photo.dataUrl, caption: photo.caption || '', duration: dur });
      // Save to history
      try {
        if (!fs.existsSync(photoHistoryDir)) fs.mkdirSync(photoHistoryDir, { recursive: true });
        const date  = new Date(photo.ts || Date.now());
        const stamp = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const imgFile = 'photo-' + stamp + '.jpg';
        fs.writeFileSync(path.join(photoHistoryDir, imgFile), Buffer.from(photo.dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
        const logPath = path.join(photoHistoryDir, 'history.json');
        const log = (() => { try { return JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch(e) { return []; } })();
        log.push({ file: imgFile, caption: photo.caption || '', ts: date.toISOString() });
        fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
      } catch(e) {}
      // Delete from R2 + remove from lists
      httpDelete(`${PHOTO_WORKER_URL}/photos/${encodeURIComponent(cmd.id)}?venueId=${encodeURIComponent(venueTopic)}`).catch(() => {});
      pendingPhotoList.splice(paIdx, 1);
      knownPhotoIds.delete(cmd.id);
      remoteState.pendingPhotos = pendingPhotoList.map(p => ({ id: p.id, dataUrl: p.dataUrl, caption: p.caption, ts: p.ts }));
      pushSSE({ type: 'state', ...remoteState });
      allCtrlWindows().forEach(w => w.webContents.send('message', { type: 'pending-photos-update', photos: pendingPhotoList }));
      break;
    }
    case 'photo-reject': {
      const prIdx = pendingPhotoList.findIndex(p => p.id === cmd.id);
      if (prIdx === -1) break;
      httpDelete(`${PHOTO_WORKER_URL}/photos/${encodeURIComponent(cmd.id)}?venueId=${encodeURIComponent(venueTopic)}`).catch(() => {});
      pendingPhotoList.splice(prIdx, 1);
      knownPhotoIds.delete(cmd.id);
      remoteState.pendingPhotos = pendingPhotoList.map(p => ({ id: p.id, dataUrl: p.dataUrl, caption: p.caption, ts: p.ts }));
      pushSSE({ type: 'state', ...remoteState });
      allCtrlWindows().forEach(w => w.webContents.send('message', { type: 'pending-photos-update', photos: pendingPhotoList }));
      break;
    }
    case 'audience-approve': {
      if (!remoteState.pendingAudienceMessages) break;
      const idx = remoteState.pendingAudienceMessages.findIndex(m => m.id === cmd.id);
      if (idx !== -1) {
        const msg = remoteState.pendingAudienceMessages.splice(idx, 1)[0];
        pushSSE({ type: 'state', ...remoteState });
        if (vizWindow) vizWindow.webContents.send('message', { type: 'audience-message', text: msg.text });
      }
      break;
    }
    case 'audience-reject': {
      if (!remoteState.pendingAudienceMessages) break;
      const idx2 = remoteState.pendingAudienceMessages.findIndex(m => m.id === cmd.id);
      if (idx2 !== -1) {
        remoteState.pendingAudienceMessages.splice(idx2, 1);
        pushSSE({ type: 'state', ...remoteState });
      }
      break;
    }
  }
}

function buildRemotePage(ip) {
  const url = `http://${ip}:${REMOTE_PORT}`;
  const qr  = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>AV Club VJ Remote</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0d0f;color:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:12px 16px 40px;width:100%}
h1{font-size:17px;font-weight:700;margin-bottom:2px}
.subtitle{font-size:11px;color:#6e6e73;margin-bottom:14px;display:flex;align-items:center;gap:6px}
.dot{width:8px;height:8px;border-radius:50%;background:#ff4444;display:inline-block;transition:background .3s;flex-shrink:0}
.dot.live{background:#34c759}
.card{background:#1c1c1e;border-radius:12px;padding:14px;margin-bottom:10px}
.card-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#6e6e73;margin-bottom:10px}
.preset-name{font-size:14px;font-weight:600;color:#fff;padding:8px 10px;background:#2c2c2e;border-radius:8px;margin-bottom:10px;word-break:break-word;min-height:36px}
.btn-row{display:flex;gap:6px;margin-bottom:6px}
.btn{flex:1;padding:13px 6px;border:none;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .12s;-webkit-tap-highlight-color:transparent}
.btn:active{opacity:.65}
.btn-primary{background:#c0392b;color:#fff}
.btn-secondary{background:#2c2c2e;color:#f5f5f7}
.btn-sec{background:#2c2c2e;color:#f5f5f7}
.btn-full{width:100%;padding:13px;border:none;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .12s;background:#2c2c2e;color:#f5f5f7;margin-top:6px;display:block;-webkit-tap-highlight-color:transparent}
.btn-full:active{opacity:.65}
.btn-strobe{background:#f5f5f7;color:#000;flex:1;padding:13px 6px;border:none;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent}
.btn-strobe:active{opacity:.65}
.btn-bstrobe{background:#1a1a1a;color:#f5f5f7;border:1px solid #444}
.glitch-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px}
.btn-glitch{padding:12px 6px;border:none;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent}
.btn-glitch:active{opacity:.65}
.g-shake{background:#4a2020;color:#ff8080}
.g-zoom{background:#1a3a4a;color:#80d0ff}
.g-crush{background:#3a2a4a;color:#c080ff}
.g-blur{background:#1a3a2a;color:#80ffb0}
.blackout-btn{width:100%;padding:14px;border:none;border-radius:9px;font-size:14px;font-weight:700;cursor:pointer;margin-top:6px;-webkit-tap-highlight-color:transparent}
.blackout-off{background:#2c2c2e;color:#888}
.blackout-on{background:#3a0a0a;color:#ff4444;box-shadow:0 0 18px rgba(255,60,60,.3)}
.row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.row:last-child{margin-bottom:0}
.lbl{font-size:12px;color:#aaa;flex-shrink:0;min-width:72px}
.lbl-sm{font-size:11px;color:#aaa;flex-shrink:0}
input[type=range]{flex:1;accent-color:#c0392b;height:28px}
input[type=number]{width:64px;background:#2c2c2e;border:1px solid #3a3a3e;color:#fff;border-radius:6px;padding:6px 8px;font-size:12px;text-align:center}
input[type=text]{flex:1;background:#2c2c2e;border:1px solid #3a3a3e;color:#fff;border-radius:8px;padding:9px 10px;font-size:13px;font-family:inherit;outline:none}
input[type=text]:focus{border-color:#c0392b}
input[type=color]{height:28px;width:44px;border:none;background:none;cursor:pointer;padding:0}
input[type=time]{background:#2c2c2e;border:1px solid #3a3a3e;color:#fff;border-radius:6px;padding:5px 7px;font-size:12px}
select{flex:1;background:#2c2c2e;border:1px solid #3a3a3e;color:#fff;border-radius:6px;padding:7px 8px;font-size:12px}
.val{font-size:11px;color:#888;min-width:34px;text-align:right;flex-shrink:0}
.toggle-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.toggle{position:relative;width:42px;height:25px;flex-shrink:0}
.toggle input{opacity:0;width:0;height:0}
.sl{position:absolute;inset:0;background:#3a3a3e;border-radius:25px;transition:.25s;cursor:pointer}
.sl:before{content:'';position:absolute;width:19px;height:19px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.25s}
.toggle input:checked+.sl{background:#c0392b}
.toggle input:checked+.sl:before{transform:translateX(17px)}
.divider{border:none;border-top:1px solid #2c2c2e;margin:10px 0}
.genre-row{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}
.btn-genre{padding:7px 10px;border:1px solid #3a3a3e;border-radius:20px;background:#2c2c2e;color:#aaa;font-size:11px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent}
.btn-genre.active{background:#c0392b;border-color:#c0392b;color:#fff}
.feed-row{display:flex;align-items:center;gap:6px;margin-bottom:5px}
.feed-row label{flex:1;font-size:12px;color:#ccc;cursor:pointer;display:flex;align-items:center;gap:6px}
.feed-row input[type=checkbox]{width:16px;height:16px;accent-color:#c0392b;flex-shrink:0}
.feed-trigger{padding:4px 10px;border:1px solid #3a3a3e;border-radius:6px;background:#2c2c2e;color:#ccc;font-size:11px;cursor:pointer;flex-shrink:0}
.sub-title{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#555;margin:10px 0 6px}
.fps-display{font-size:26px;font-weight:700;color:#f5f5f7;text-align:center;padding:8px 0 4px;font-variant-numeric:tabular-nums}
.bpm-display{font-size:13px;font-weight:600;text-align:center;margin-bottom:8px}
.qr-box{text-align:center;padding:4px 0}
.qr-url{font-size:11px;color:#6e6e73;margin-top:8px;font-family:monospace;word-break:break-all;cursor:pointer}
.copy-tip{font-size:10px;color:#34c759;opacity:0;transition:opacity .3s;margin-top:4px;display:block}
.card-title{cursor:pointer;user-select:none;display:flex;justify-content:space-between;align-items:center}
.card-title::after{content:'▾';font-size:12px;transition:transform .2s}
.card.collapsed .card-title::after{transform:rotate(-90deg)}
.card-body{overflow:hidden;transition:max-height .25s ease}
.card.collapsed .card-body{max-height:0!important}
body.light{background:#f2f2f7;color:#1c1c1e}
body.light .card{background:#fff;border:1px solid #e0e0e5}
body.light .card-title{color:#1c1c1e}
body.light .preset-name{background:#e5e5ea;color:#1c1c1e}
body.light .lbl,body.light .lbl-sm{color:#3a3a3c}
body.light .val{color:#1c1c1e}
body.light .divider{border-color:#d1d1d6}
body.light .sub-title{color:#3a3a3c}
body.light .bpm-display{color:#1c1c1e}
body.light .fps-display{color:#1c1c1e}
body.light .qr-url{color:#3a3a3c}
body.light .feed-row label{color:#1c1c1e}
body.light .feed-trigger{background:#e5e5ea;border-color:#c7c7cc;color:#3a3a3c}
body.light .btn-genre{background:#e5e5ea;border-color:#c7c7cc;color:#3a3a3c}
body.light .btn-genre.active{background:#c0392b;border-color:#c0392b;color:#fff}
body.light input[type=text]{background:#e5e5ea;border-color:#c7c7cc;color:#1c1c1e}
body.light input[type=time]{background:#e5e5ea;border-color:#c7c7cc;color:#1c1c1e}
body.light input[type=number]{background:#e5e5ea;border-color:#c7c7cc;color:#1c1c1e}
body.light select,body.light input[type=range]{background:#e5e5ea;border-color:#c7c7cc;color:#1c1c1e}
body.light .btn-sec,body.light .btn-full,body.light .btn-secondary{background:#e5e5ea;color:#1c1c1e}
body.light .sl{background:#c7c7cc}
body.light #trivia-q-remote{background:#e5e5ea;color:#1c1c1e!important}
body.light #trivia-scores-remote div,body.light #trivia-opts-remote div{color:#1c1c1e!important;background:#e5e5ea!important}
body.light #trivia-card input,body.light #trivia-card select{background:#e5e5ea!important;border-color:#c7c7cc!important;color:#1c1c1e!important}
body.light .custom-q-row{background:#e5e5ea!important;color:#1c1c1e!important}
.audience-pending-item{background:#2c2c2e;border-radius:8px;padding:10px 12px;display:flex;flex-direction:row;align-items:center;gap:10px}
body.light .audience-pending-item{background:#e5e5ea;color:#1c1c1e}
#login-overlay{position:fixed;inset:0;z-index:9999;background:#0d0d0f;display:flex;align-items:center;justify-content:center;padding:32px}
#login-box{width:100%;max-width:360px;display:flex;flex-direction:column;gap:14px;text-align:center}
#login-box h2{font-size:22px;font-weight:700}
#login-box p{font-size:14px;color:#888;line-height:1.5}
#login-pw{width:100%;background:#1c1c1e;border:1.5px solid #333;border-radius:12px;color:#fff;font-size:17px;font-family:inherit;padding:14px 16px;outline:none;text-align:center;letter-spacing:.08em}
#login-pw:focus{border-color:#3a7bd5}
#login-btn{width:100%;padding:15px;background:#3a7bd5;color:#fff;border:none;border-radius:12px;font-size:17px;font-weight:700;font-family:inherit;cursor:pointer}
#login-btn:active{opacity:.8}
#login-err{font-size:13px;color:#ff453a;min-height:18px}
</style>
</head>
<body>
<!-- Login overlay — hidden when no password set or already authenticated -->
<div id="login-overlay" style="display:none">
  <div id="login-box">
    <div style="font-size:48px">🎛️</div>
    <h2>AV Club VJ Remote</h2>
    <p>Enter the password to access controls</p>
    <form onsubmit="doLogin();return false;">
      <input type="text" name="username" autocomplete="username" value="avclubvj" style="position:absolute;opacity:0;pointer-events:none;height:1px;width:1px;left:-9999px" tabindex="-1" aria-hidden="true">
      <input type="password" id="login-pw" placeholder="Password" autocomplete="current-password"
        onkeydown="if(event.key==='Enter')doLogin()">
      <button id="login-btn" type="submit">Unlock</button>
    </form>
    <div id="login-err"></div>
  </div>
</div>
<div id="main-content">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
<h1>🎛 AV Club VJ Remote</h1>
<button onclick="toggleTheme()" id="theme-btn" style="background:none;border:1px solid #444;color:#aaa;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer">☀️ Light</button>
</div>
<p class="subtitle"><span class="dot" id="dot"></span><span id="conn-lbl">Connecting…</span></p>

<!-- Preset controls -->
<div class="card">
  <div class="card-body">
  <div class="preset-name" id="remote-preset-name">—</div>
  <div class="btn-row">
    <button class="btn btn-primary" onclick="cmd('random-preset')">🎲 Random Preset</button>
  </div>
  <div class="btn-row">
    <button class="btn btn-sec" onclick="cmd('generate-preset')">✨ Generate New</button>
    <button class="btn btn-sec" onclick="cmd('randomize-params')">🔀 Randomize Params</button>
  </div>
  <button class="blackout-btn blackout-off" id="blackout-btn" onclick="toggleBlackout()">⬛ Blackout</button>
  </div>
</div>

<!-- SENSITIVITY -->
<div class="card">
  <div class="card-title">Sensitivity</div>
  <div class="card-body">
  <div class="row">
    <span class="lbl">Sensitivity</span>
    <input type="range" id="sens-sl" min="0" max="5" step="0.1" value="1" oninput="setSens()">
    <span class="val" id="sens-val">1.0</span>
  </div>
  </div>
</div>

<!-- SCROLLING TEXT -->
<div class="card">
  <div class="card-title">Scrolling Text</div>
  <div class="card-body">
  <div class="btn-row" style="margin-bottom:8px">
    <button class="btn btn-primary" id="feed-start-btn" onclick="startFeeds()">▶ Start Scrolling Text</button>
    <button class="btn btn-sec" onclick="stopFeeds()">■ Stop</button>
  </div>
  <div class="row">
    <span class="lbl-sm">Show every</span>
    <select id="feed-int">
      <option value="0" selected>Continuous</option>
      <option value="0.25">15 sec</option>
      <option value="0.5">30 sec</option>
      <option value="1">1 min</option>
      <option value="2">2 min</option>
      <option value="5">5 min</option>
      <option value="10">10 min</option>
      <option value="15">15 min</option>
      <option value="30">30 min</option>
    </select>
  </div>
  <hr class="divider">
  <div class="sub-title">Custom Messages</div>
  <div style="display:flex;gap:6px;margin-bottom:8px">
    <input type="text" id="marquee-txt" placeholder="Type a message…" style="flex:1">
    <button class="btn btn-primary" onclick="addMsg()" style="flex:0 0 auto;padding:9px 14px">+ Add</button>
  </div>
  <div id="msg-list" style="display:flex;flex-direction:column;gap:5px;margin-bottom:8px"></div>
  <div class="btn-row">
    <button class="btn btn-primary" onclick="sendRandomMsg()" style="flex:2">▶ Send Random</button>
    <button class="btn btn-sec" onclick="cmd('marquee-stop')">■ Stop</button>
  </div>
  <hr class="divider">
  <div class="sub-title">Live Feeds</div>
  <div class="feed-row"><label><input type="checkbox" class="ftog" data-feed="dadjokes" checked>😂 Dad Jokes</label><button class="feed-trigger" onclick="feedNow('dadjokes')">→</button></div>
  <div class="feed-row"><label><input type="checkbox" class="ftog" data-feed="advice" checked>💭 Random Advice</label><button class="feed-trigger" onclick="feedNow('advice')">→</button></div>
  <div class="feed-row"><label><input type="checkbox" class="ftog" data-feed="ronswanson" checked>🥩 Ron Swanson</label><button class="feed-trigger" onclick="feedNow('ronswanson')">→</button></div>
  <div class="feed-row"><label><input type="checkbox" class="ftog" data-feed="kanye" checked>🎤 Kanye Quotes</label><button class="feed-trigger" onclick="feedNow('kanye')">→</button></div>
  <div class="feed-row"><label><input type="checkbox" class="ftog" data-feed="bored" checked>🎲 Random Activity</label><button class="feed-trigger" onclick="feedNow('bored')">→</button></div>
  <div class="feed-row"><label><input type="checkbox" class="ftog" data-feed="wikipedia" checked>📚 On This Day</label><button class="feed-trigger" onclick="feedNow('wikipedia')">→</button></div>
  <div class="feed-row"><label><input type="checkbox" class="ftog" data-feed="trivia" checked>🧠 Trivia</label><button class="feed-trigger" onclick="feedNow('trivia')">→</button></div>
  <div class="feed-row"><label><input type="checkbox" class="ftog" data-feed="chuck" checked>🥊 Chuck Norris</label><button class="feed-trigger" onclick="feedNow('chuck')">→</button></div>
  <div class="feed-row"><label><input type="checkbox" class="ftog" data-feed="uselessfacts" checked>🪲 Useless Facts</label><button class="feed-trigger" onclick="feedNow('uselessfacts')">→</button></div>
  <div class="feed-row"><label><input type="checkbox" class="ftog" data-feed="catfacts" checked>🐱 Cat Facts</label><button class="feed-trigger" onclick="feedNow('catfacts')">→</button></div>
  <div class="feed-row"><label><input type="checkbox" class="ftog" data-feed="evilinsults" checked>😈 Evil Insults</label><button class="feed-trigger" onclick="feedNow('evilinsults')">→</button></div>
  <div class="feed-row"><label><input type="checkbox" class="ftog" data-feed="showerthoughts" checked>🚿 Shower Thoughts</label><button class="feed-trigger" onclick="feedNow('showerthoughts')">→</button></div>
  <div class="feed-row"><label><input type="checkbox" class="ftog" data-feed="corporatebs" checked>💼 Corporate BS</label><button class="feed-trigger" onclick="feedNow('corporatebs')">→</button></div>
  <div class="feed-row"><label><input type="checkbox" class="ftog" data-feed="dirtyjokes" checked>🔞 Dirty Jokes</label><button class="feed-trigger" onclick="feedNow('dirtyjokes')">→</button></div>
  <div class="row" style="margin-left:22px;margin-bottom:6px">
    <span class="lbl-sm" style="flex-shrink:0;margin-right:6px">Name:</span>
    <input type="text" id="chuck-name" value="Chuck Norris" style="font-size:11px;padding:5px 8px">
  </div>
  <div class="feed-row"><label><input type="checkbox" class="ftog" data-feed="closetime">🕐 Hours Until Close</label><button class="feed-trigger" onclick="feedNow('closetime')">→</button></div>
  <div class="row" style="margin-left:22px;margin-bottom:6px">
    <span class="lbl-sm" style="flex-shrink:0;margin-right:6px">Close time:</span>
    <input type="time" id="close-time" value="02:00">
  </div>
  <hr class="divider">
  <div class="sub-title">Style</div>
  <div class="row">
    <span class="lbl">Speed</span>
    <input type="range" id="mq-speed" min="1" max="12" step="0.5" value="3" oninput="sendMarqueeConfig()">
    <span class="val" id="mq-speed-val">3</span>
  </div>
  <div class="row">
    <span class="lbl">Font</span>
    <input type="range" id="mq-size" min="24" max="120" step="2" value="52" oninput="sendMarqueeConfig()">
    <span class="val" id="mq-size-val">52px</span>
  </div>
  <div class="row">
    <span class="lbl">Color</span>
    <input type="color" id="mq-color" value="#ffffff" oninput="sendMarqueeConfig()">
  </div>
  <div class="row">
    <span class="lbl">Strip</span>
    <input type="range" id="mq-alpha" min="0" max="1" step="0.05" value="0.65" oninput="sendMarqueeConfig()">
    <span class="val" id="mq-alpha-val">65%</span>
  </div>
  <div class="row">
    <span class="lbl">Position</span>
    <select id="mq-pos" onchange="sendMarqueeConfig()">
      <option value="bottom">Bottom</option>
      <option value="top">Top</option>
      <option value="center">Center</option>
    </select>
  </div>
  </div>
</div>

<!-- AUDIENCE MESSAGES (pending approval) -->
<div class="card" id="audience-card">
  <div class="card-title">📨 Audience Messages</div>
  <div class="card-body">
    <div id="audience-queue-remote" style="display:flex;flex-direction:column;gap:6px">
      <div style="font-size:12px;color:#888;text-align:center;padding:8px">No pending messages</div>
    </div>
  </div>
</div>

<!-- PHOTO QUEUE -->
<div class="card" id="photo-queue-card">
  <div class="card-title">📸 Photo Queue <span id="photo-queue-badge" style="background:#c0392b;color:#fff;border-radius:99px;font-size:10px;padding:2px 7px;margin-left:4px;display:none"></span></div>
  <div class="card-body">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div>
        <div style="font-size:12px;font-weight:600">Moderation</div>
        <div style="font-size:11px;color:#888" id="remote-photo-mode-label">Require approval</div>
      </div>
      <label class="toggle" style="flex-shrink:0">
        <input type="checkbox" id="remote-photo-moderated" checked onchange="setPhotoModerated(this.checked)">
        <span class="sl"></span>
      </label>
    </div>
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px" id="remote-photo-queue-controls">
      <span style="font-size:11px;color:#888;flex-shrink:0">Display for</span>
      <select id="remote-photo-duration" style="flex:1;font-size:11px;background:#2c2c2e;border:1px solid #3a3a3e;color:#fff;border-radius:6px;padding:5px 7px">
        <option value="8">8 seconds</option>
        <option value="12" selected>12 seconds</option>
        <option value="18">18 seconds</option>
        <option value="25">25 seconds</option>
        <option value="40">40 seconds</option>
      </select>
    </div>
    <button class="btn btn-primary" id="remote-photo-kill" onclick="killPhoto()" style="width:100%;margin-bottom:8px;display:none;background:#c0392b;font-size:13px;font-weight:700;padding:12px">⏭ Skip Photo</button>
    <div id="photo-queue-remote" style="display:flex;flex-direction:column;gap:8px">
      <div style="font-size:12px;color:#888;text-align:center;padding:8px">No pending photos</div>
    </div>
  </div>
</div>

<!-- BAR TRIVIA -->
<div class="card" id="trivia-card">
  <div class="card-title">🎯 Bar Trivia</div>
  <div class="card-body">
    <div class="preset-name" id="trivia-q-remote" style="min-height:48px;font-size:14px;line-height:1.5;font-weight:600;color:#fff;margin-bottom:8px">No active question</div>
    <div id="trivia-opts-remote" style="display:flex;flex-direction:column;gap:5px;margin-bottom:10px"></div>
    <div id="trivia-responses-remote" style="font-size:11px;color:#6e6e73;text-align:center;margin-bottom:10px"></div>
    <div class="btn-row">
      <button class="btn btn-primary" onclick="cmd('trivia-new-question')">🎲 New Question</button>
    </div>
    <div class="btn-row">
      <button class="btn btn-secondary" onclick="cmd('trivia-reveal-answer')" id="btn-reveal-remote">✅ Reveal Answer</button>
      <button class="btn btn-secondary" onclick="cmd('trivia-show-scores')" id="btn-scores-remote">🏆 Show Scores</button>
    </div>
    <div class="btn-row">
      <button class="btn" style="flex:1;background:#3a1010;color:#ff453a;border:1px solid #ff453a" onclick="cmd('trivia-clear-screen')">✖ Clear Screen</button>
    </div>
    <hr style="border:none;border-top:1px solid #2c2c2e;margin:12px 0">
    <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">✏️ Custom Questions</div>
    <div id="custom-trivia-list"></div>
    <hr style="border:none;border-top:1px solid #2c2c2e;margin:12px 0">
    <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">Add Custom Question</div>
    <input id="cq-question" type="text" placeholder="Question" style="width:100%;background:#2c2c2e;border:1px solid #3a3a3c;border-radius:8px;color:#f5f5f7;padding:9px 12px;font-size:13px;margin-bottom:6px">
    <input id="cq-a" type="text" placeholder="Answer A" style="width:100%;background:#2c2c2e;border:1px solid #3a3a3c;border-radius:8px;color:#f5f5f7;padding:8px 12px;font-size:12px;margin-bottom:5px">
    <input id="cq-b" type="text" placeholder="Answer B" style="width:100%;background:#2c2c2e;border:1px solid #3a3a3c;border-radius:8px;color:#f5f5f7;padding:8px 12px;font-size:12px;margin-bottom:5px">
    <input id="cq-c" type="text" placeholder="Answer C" style="width:100%;background:#2c2c2e;border:1px solid #3a3a3c;border-radius:8px;color:#f5f5f7;padding:8px 12px;font-size:12px;margin-bottom:5px">
    <input id="cq-d" type="text" placeholder="Answer D" style="width:100%;background:#2c2c2e;border:1px solid #3a3a3c;border-radius:8px;color:#f5f5f7;padding:8px 12px;font-size:12px;margin-bottom:8px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="font-size:12px;color:#aaa">Correct:</span>
      <select id="cq-correct" style="background:#2c2c2e;border:1px solid #3a3a3c;border-radius:8px;color:#f5f5f7;padding:7px 10px;font-size:13px">
        <option value="0">A</option><option value="1">B</option><option value="2">C</option><option value="3">D</option>
      </select>
    </div>
    <button class="btn-full" onclick="addCustomQ()">+ Add Question</button>
    <hr style="border:none;border-top:1px solid #2c2c2e;margin:12px 0">
    <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Scoreboard</div>
    <div id="trivia-scores-remote" style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px">
      <div style="font-size:11px;color:#555;text-align:center;padding:6px">No scores yet</div>
    </div>
    <div class="btn-row">
      <button class="btn btn-secondary" onclick="cmd('trivia-reset-scores')">↺ Reset Scores</button>
    </div>
    <hr style="border:none;border-top:1px solid #2c2c2e;margin:12px 0">
    <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Registered Teams</div>
    <div id="trivia-teams-remote" style="display:flex;flex-direction:column;gap:3px;margin-bottom:10px">
      <div style="font-size:11px;color:#555;text-align:center;padding:6px">No teams yet</div>
    </div>
    <div class="btn-row">
      <button class="btn" style="flex:1;background:#3a1010;color:#ff453a;border:1px solid #ff453a" onclick="cmd('trivia-reset-teams')">✖ Clear Teams</button>
    </div>
  </div>
</div>

<!-- LOGO OVERLAYS -->
<div class="card">
  <div class="card-title">Logo / Image Overlays</div>
  <div class="card-body">
  <div class="toggle-row">
    <span class="lbl-sm">Graphics On</span>
    <label class="toggle"><input type="checkbox" id="logos-chk" checked onchange="cmd('set-logos-enabled',{enabled:this.checked})"><span class="sl"></span></label>
  </div>
  <hr class="divider">
  <div class="sub-title">Sequence Timing</div>
  <div class="row">
    <span class="lbl">Show each for</span>
    <select id="logo-dur" onchange="sendLogoTiming()">
      <option value="5">5s</option>
      <option value="10" selected>10s</option>
      <option value="15">15s</option>
      <option value="20">20s</option>
      <option value="30">30s</option>
      <option value="60">60s</option>
    </select>
  </div>
  <div class="row">
    <span class="lbl">Then wait</span>
    <select id="logo-int" onchange="sendLogoTiming()">
      <option value="0.083">5 sec</option>
      <option value="0.25">15 sec</option>
      <option value="0.5">30 sec</option>
      <option value="1">1 min</option>
      <option value="2">2 min</option>
      <option value="5" selected>5 min</option>
      <option value="10">10 min</option>
      <option value="15">15 min</option>
      <option value="30">30 min</option>
      <option value="60">60 min</option>
    </select>
  </div>
  <hr class="divider">
  <div id="logo-list-remote"></div>
  </div>
</div>

<!-- PERFORMANCE -->
<div class="card">
  <div class="card-title">Performance</div>
  <div class="card-body">
  <div class="fps-display" id="fps-disp">— fps</div>
  <div style="text-align:center;font-size:11px;color:#6e6e73;margin-bottom:12px" id="gpu-disp">GPU Load —</div>
  <div class="row">
    <span class="lbl">FPS Cap</span>
    <select id="fps-cap" onchange="cmd('set-fps-cap',{fps:parseInt(this.value)})">
      <option value="60">60 fps</option>
      <option value="30">30 fps</option>
      <option value="15">15 fps</option>
    </select>
  </div>
  <div class="row">
    <span class="lbl">Mesh Quality</span>
    <select id="mesh-qual" onchange="cmd('set-mesh-quality',{quality:this.value})">
      <option value="high">High</option>
      <option value="medium">Medium</option>
      <option value="low">Low</option>
      <option value="ultralow">Ultra-Low</option>
    </select>
  </div>
  </div>
</div>

<!-- QR CODE / URL -->
<div class="card">
  <div class="card-title">This Remote's URL</div>
  <div class="card-body">
  <div class="qr-box">
    <img id="remote-page-qr" src="${qr}" width="180" height="180" alt="QR Code" style="border-radius:8px;border:2px solid #2c2c2e">
    <div class="qr-url" id="qr-url" onclick="copyUrl()">${url}</div>
    <span class="copy-tip" id="copy-tip">Copied!</span>
  </div>
  </div>
</div>

<script>
let blackoutActive = false;
let st = {};
let _lastAudienceQueueFP = null;
let _lastPhotoQueueFP    = null;

// Update QR + URL label to match the actual URL being used
// (local IP is baked in at build time, but cloud/tunnel URL differs)
(function() {
  const actual = window.location.origin;
  const baked  = '${url}';
  if (actual !== baked) {
    const qrEl  = document.getElementById('remote-page-qr');
    const urlEl = document.getElementById('qr-url');
    if (qrEl)  qrEl.src = 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + encodeURIComponent(actual + '/');
    if (urlEl) urlEl.textContent = actual + '/';
  }
})();

const es = new EventSource('/events');
es.onopen  = () => {
  document.getElementById('dot').className='dot live';
  document.getElementById('conn-lbl').textContent='Connected';
  // Re-request full state on every (re)connect — Cloudflare Tunnel can drop
  // SSE connections silently; this ensures fps + state refresh immediately
  fetch('/status').then(r=>r.json()).then(d=>{
    st = {...st, ...d};
    applyAll();
  }).catch(()=>{});
};
es.onerror = () => { document.getElementById('dot').className='dot'; document.getElementById('conn-lbl').textContent='Reconnecting\u2026'; };
es.onmessage = e => {
  try {
    const d = JSON.parse(e.data);
    if (d.type === 'state') {
      const first = !Object.keys(st).length;
      st = {...st, ...d};
      if (first) applyAll(); else applyLive();
    }
  } catch(err) {
    console.error('[remote] state update error:', err);
  }
};

function applyAll() {
  el('sens-sl').value               = st.sensitivity ?? 1;
  el('sens-val').textContent        = (st.sensitivity ?? 1).toFixed(1);
  el('fps-cap').value               = String(st.fpsCap || 60);
  el('mesh-qual').value             = st.meshQuality || 'high';
  el('logos-chk').checked           = st.logosEnabled !== false;
  el('logo-dur').value              = String(st.logoGlobalDuration || 10);
  el('logo-int').value              = String(st.logoGlobalInterval || 5);
  el('mq-speed').value              = st.marqueeSpeed ?? 3;
  el('mq-speed-val').textContent    = st.marqueeSpeed ?? 3;
  el('mq-size').value               = st.marqueeSize ?? 52;
  el('mq-size-val').textContent     = (st.marqueeSize ?? 52) + 'px';
  el('mq-color').value              = st.marqueeColor || '#ffffff';
  el('mq-alpha').value              = st.marqueeBgAlpha ?? 0.65;
  el('mq-alpha-val').textContent    = Math.round((st.marqueeBgAlpha ?? 0.65) * 100) + '%';
  el('mq-pos').value                = st.marqueePosition || 'bottom';
  el('feed-int').value              = String(st.feedInterval ?? 0);
  renderLogoList();
  applyLive();
}

// ── Photo Queue ──
function renderPhotoQueue() {
  const qEl    = el('photo-queue-remote');
  const badge  = el('photo-queue-badge');
  if (!qEl) return;
  const photos = st.pendingPhotos || [];
  if (badge) {
    badge.textContent  = photos.length;
    badge.style.display = photos.length ? 'inline' : 'none';
  }
  // Only rebuild DOM when photo list changes — prevents approve button being
  // destroyed mid-tap due to SSE updates firing every second
  const pqFP = photos.map(p => p.id).join(',');
  if (pqFP === _lastPhotoQueueFP) return;
  _lastPhotoQueueFP = pqFP;
  if (!photos.length) {
    qEl.innerHTML = '<div style="font-size:12px;color:#888;text-align:center;padding:8px">No pending photos</div>';
    return;
  }
  qEl.innerHTML = '';
  photos.forEach(function(photo, i) {
    var item = document.createElement('div');
    item.style.cssText = 'background:#2c2c2e;border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:6px';
    var img = document.createElement('img');
    img.src = photo.dataUrl;
    img.style.cssText = 'width:100%;max-height:220px;object-fit:contain;border-radius:6px;background:#000';
    item.appendChild(img);
    if (photo.caption) {
      var cap = document.createElement('div');
      cap.style.cssText = 'font-size:12px;color:#aaa;font-style:italic;text-align:center;padding:0 4px';
      cap.textContent = photo.caption;
      item.appendChild(cap);
    }
    var btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px';
    var approveBtn = document.createElement('button');
    approveBtn.className = 'btn btn-primary';
    approveBtn.style.cssText = 'flex:1;font-size:12px;padding:10px 0';
    approveBtn.textContent = '✓ Display';
    approveBtn.onclick = (function(idx){ return function() { approveRemotePhoto(idx); }; })(i);
    var rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn btn-secondary';
    rejectBtn.style.cssText = 'flex:1;font-size:12px;padding:10px 0';
    rejectBtn.textContent = '✕ Reject';
    rejectBtn.onclick = (function(idx){ return function() { rejectRemotePhoto(idx); }; })(i);
    btns.appendChild(approveBtn);
    btns.appendChild(rejectBtn);
    item.appendChild(btns);
    qEl.appendChild(item);
  });
}

function killPhoto() {
  cmd('photo-kill', {});
  var killBtn = el('remote-photo-kill');
  if (killBtn) killBtn.style.display = 'none';
}

function setPhotoModerated(moderated) {
  cmd('set-photo-moderated', { moderated });
  var label   = el('remote-photo-mode-label');
  var qCtrl   = el('remote-photo-queue-controls');
  var qEl     = el('photo-queue-remote');
  if (label)  label.textContent = moderated ? 'Require approval' : 'Auto-display instantly';
  if (qCtrl)  qCtrl.style.display = moderated ? 'flex' : 'none';
  if (qEl)    qEl.style.display   = moderated ? 'flex' : 'none';
}

function approveRemotePhoto(idx) {
  var photo = (st.pendingPhotos || [])[idx];
  if (!photo) return;
  var dur = parseInt((el('remote-photo-duration') || {}).value || '12', 10);
  cmd('photo-approve', { id: photo.id, duration: dur });
  var killBtn = el('remote-photo-kill');
  if (killBtn) killBtn.style.display = 'block';
}

function rejectRemotePhoto(idx) {
  var photo = (st.pendingPhotos || [])[idx];
  if (!photo) return;
  if (!confirm('Reject this photo?')) return;
  cmd('photo-reject', { id: photo.id });
}

function applyLive() {
  // Pending audience messages — only rebuild DOM when content changes to prevent
  // click targets being destroyed mid-tap (perf-update SSE fires every second)
  const aqEl = el('audience-queue-remote');
  if (aqEl && Array.isArray(st.pendingAudienceMessages)) {
    const aqFP = st.pendingAudienceMessages.map(m => m.id + ':' + m.text).join('|');
    if (aqFP !== _lastAudienceQueueFP) {
      _lastAudienceQueueFP = aqFP;
      if (!st.pendingAudienceMessages.length) {
        aqEl.innerHTML = '<div style="font-size:12px;color:#888;text-align:center;padding:8px">No pending messages</div>';
      } else {
        aqEl.innerHTML = st.pendingAudienceMessages.map(m =>
          '<div class="audience-pending-item">' +
          '<span style="flex:1;word-break:break-word;font-size:14px;line-height:1.4">' + m.text.replace(/</g,'&lt;') + '</span>' +
          '<div style="display:flex;gap:5px;flex-shrink:0;margin-left:auto">' +
          '<button onclick="approveMsg(' + m.id + ')" style="background:#34c759;color:#000;border:none;border-radius:6px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent">✓ Approve</button>' +
          '<button onclick="rejectMsg(' + m.id + ')" style="background:#3a3a3c;color:#fff;border:none;border-radius:6px;padding:8px 14px;font-size:13px;cursor:pointer;-webkit-tap-highlight-color:transparent">✕</button>' +
          '</div></div>'
        ).join('');
      }
    }
  }
  const pnEl = el('remote-preset-name');
  if (pnEl) pnEl.textContent = st.presetName || '—';
  const fps = st.fps > 0 ? st.fps + ' fps' : '\u2014 fps';
  el('fps-disp').textContent = fps;
  const gpu = st.gpuLoad > 0 ? 'GPU Load ' + Math.round(st.gpuLoad) + '%' : 'GPU Load \u2014';
  el('gpu-disp').textContent = gpu;
  // Trivia state
  el('trivia-q-remote').textContent = st.triviaQuestion || 'No active question';
  const optsEl = el('trivia-opts-remote');
  if (optsEl) {
    if (st.triviaOptions && st.triviaOptions.length) {
      const letters = ['A','B','C','D'];
      const correctLetter = letters[st.triviaCorrectIndex] || '?';
      const correctText   = st.triviaOptions[st.triviaCorrectIndex] || '';
      const answerLine = st.triviaCorrectIndex >= 0
        ? '<div style="background:rgba(52,199,89,0.15);border:1px solid #34c759;border-radius:8px;padding:8px 12px;font-size:13px;color:#34c759;font-weight:700;margin-bottom:6px">✅ Answer: ' + correctLetter + '. ' + correctText.replace(/</g,'&lt;') + '</div>'
        : '';
      optsEl.innerHTML = answerLine + st.triviaOptions.map((o, i) => {
        const isCorrect = i === st.triviaCorrectIndex;
        return '<div style="background:' + (isCorrect ? 'rgba(52,199,89,0.22)' : '#2c2c2e') + ';' +
          'border:1px solid ' + (isCorrect ? '#34c759' : 'transparent') + ';' +
          'border-radius:8px;padding:8px 12px;font-size:12px;' +
          'color:' + (isCorrect ? '#34c759' : '#aaa') + ';' +
          'font-weight:' + (isCorrect ? '700' : '400') + '">' +
          letters[i] + '. ' + o.replace(/</g,'&lt;') +
          (isCorrect ? ' ✓' : '') + '</div>';
      }).join('');
    } else {
      optsEl.innerHTML = '';
    }
  }
  const respEl = el('trivia-responses-remote');
  if (respEl) respEl.textContent = st.triviaResponseCount ? st.triviaResponseCount + ' response' + (st.triviaResponseCount === 1 ? '' : 's') + ' received' : '';
  const scoresEl = el('trivia-scores-remote');
  if (scoresEl) {
    if (st.triviaScores && st.triviaScores.length) {
      scoresEl.innerHTML = st.triviaScores.map((s, i) =>
        '<div style="display:flex;justify-content:space-between;align-items:center;background:#1c1c1e;border-radius:6px;padding:6px 10px;font-size:12px">' +
        '<span style="color:' + (i === 0 ? '#ffd60a' : i === 1 ? '#aaa' : i === 2 ? '#cd7f32' : '#666') + ';font-weight:' + (i < 3 ? '700' : '400') + '">' +
        (i === 0 ? '🥇 ' : i === 1 ? '🥈 ' : i === 2 ? '🥉 ' : (i+1) + '. ') + s.team.replace(/</g,'&lt;') + '</span>' +
        '<span style="color:#fff;font-weight:700">' + s.score + ' pt' + (s.score !== 1 ? 's' : '') + '</span></div>'
      ).join('');
    } else {
      scoresEl.innerHTML = '<div style="font-size:11px;color:#555;text-align:center;padding:6px">No scores yet</div>';
    }
  }
  const teamsEl = el('trivia-teams-remote');
  if (teamsEl) {
    if (st.triviaTeams && st.triviaTeams.length) {
      teamsEl.innerHTML = st.triviaTeams.map((t, i) =>
        '<div style="background:#1c1c1e;border-radius:6px;padding:5px 10px;font-size:12px;color:#ccc">' +
        (i+1) + '. ' + t.replace(/</g,'&lt;') + '</div>'
      ).join('');
    } else {
      teamsEl.innerHTML = '<div style="font-size:11px;color:#555;text-align:center;padding:6px">No teams yet</div>';
    }
  }
  renderCustomTrivia();
  renderPhotoQueue();
  // Sync photo moderation toggle
  var pmToggle = el('remote-photo-moderated');
  var pmLabel  = el('remote-photo-mode-label');
  var pmQCtrl  = el('remote-photo-queue-controls');
  var pmQEl    = el('photo-queue-remote');
  if (pmToggle && st.photoModerated !== undefined) {
    pmToggle.checked = !!st.photoModerated;
    if (pmLabel) pmLabel.textContent = st.photoModerated ? 'Require approval' : 'Auto-display instantly';
    if (pmQCtrl) pmQCtrl.style.display = st.photoModerated ? 'flex' : 'none';
    if (pmQEl)   pmQEl.style.display   = st.photoModerated ? 'flex' : 'none';
  }
}

function el(id) { return document.getElementById(id); }

async function cmd(type, extra={}) {
  try { await fetch('/cmd', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({type,...extra}) }); }
  catch(e) { console.warn('cmd failed', e); }
}

function approveMsg(id) { cmd('audience-approve', { id }); }
function rejectMsg(id)  { cmd('audience-reject',  { id }); }

// ── Custom Trivia ──
function renderCustomTrivia() {
  const el = document.getElementById('custom-trivia-list');
  if (!el) return;
  const qs = (st.customTriviaQuestions || []);
  if (!qs.length) {
    el.innerHTML = '<div style="font-size:12px;color:#555;text-align:center;padding:8px">No custom questions yet</div>';
    return;
  }
  const letters = ['A','B','C','D'];
  el.innerHTML = qs.map((q, i) =>
    '<div class="custom-q-row" style="background:#2c2c2e;border-radius:8px;padding:10px 12px;margin-bottom:6px">' +
    '<div style="font-size:13px;font-weight:600;margin-bottom:6px;line-height:1.4">' + q.question.replace(/</g,'&lt;') + '</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">' +
    q.options.map((o, oi) =>
      '<span style="font-size:11px;padding:3px 8px;border-radius:5px;background:' + (oi === q.correctIndex ? 'rgba(52,199,89,0.2)' : '#1c1c1e') + ';color:' + (oi === q.correctIndex ? '#34c759' : '#aaa') + ';border:1px solid ' + (oi === q.correctIndex ? '#34c759' : 'transparent') + '">' +
      letters[oi] + '. ' + o.replace(/</g,'&lt;') + '</span>'
    ).join('') +
    '</div>' +
    '<div style="display:flex;gap:6px">' +
    '<button onclick="playCustomQ(' + i + ')" style="flex:1;background:#c0392b;color:#fff;border:none;border-radius:7px;padding:8px;font-size:12px;font-weight:600;cursor:pointer">▶ Play</button>' +
    '<button onclick="deleteCustomQ(' + i + ')" style="background:#3a3a3c;color:#aaa;border:none;border-radius:7px;padding:8px 12px;font-size:12px;cursor:pointer">✕</button>' +
    '</div></div>'
  ).join('');
}

function playCustomQ(idx) {
  const q = (st.customTriviaQuestions || [])[idx];
  if (q) cmd('trivia-play-custom', { question: q });
}

function addCustomQ() {
  const question = el('cq-question')?.value.trim();
  const a = el('cq-a')?.value.trim();
  const b = el('cq-b')?.value.trim();
  const c = el('cq-c')?.value.trim();
  const d = el('cq-d')?.value.trim();
  const correctIndex = parseInt(el('cq-correct')?.value || '0');
  if (!question || !a || !b || !c || !d) {
    alert('Please fill in the question and all four answers.');
    return;
  }
  const newQ = { id: 'custom_' + Date.now(), question, options: [a, b, c, d], correctIndex };
  cmd('trivia-add-custom', { question: newQ });
  ['cq-question','cq-a','cq-b','cq-c','cq-d'].forEach(id => { if (el(id)) el(id).value = ''; });
}

function deleteCustomQ(idx) {
  const q = (st.customTriviaQuestions || [])[idx];
  if (!q || !confirm('Delete this custom question?')) return;
  cmd('trivia-delete-custom', { id: q.id });
}

function toggleBlackout() {
  blackoutActive = !blackoutActive;
  const btn = el('blackout-btn');
  btn.className = 'blackout-btn ' + (blackoutActive ? 'blackout-on' : 'blackout-off');
  btn.textContent = blackoutActive ? '\u2b1b Blackout ON \u2014 tap to restore' : '\u2b1b Blackout';
  cmd('blackout', { active: blackoutActive });
}

function setSens() {
  const v = parseFloat(el('sens-sl').value);
  el('sens-val').textContent = v.toFixed(1);
  cmd('set-sensitivity', { value: v });
}

function startFeeds() {
  cmd('feed-start', { interval: parseFloat(el('feed-int').value) });
  el('feed-start-btn').style.opacity = '0.5';
}
function stopFeeds() {
  cmd('feed-stop');
  el('feed-start-btn').style.opacity = '1';
}

function feedNow(feed) {
  const chuckName = el('chuck-name') ? el('chuck-name').value.trim() || 'Chuck Norris' : 'Chuck Norris';
  const closeTime = el('close-time') ? el('close-time').value || '02:00' : '02:00';
  cmd('feed-now', { feed, chuckName, closeTime });
}

// ── Custom message list ──
let customMsgs = [];
function renderMsgList() {
  const list = el('msg-list');
  if (!list) return;
  list.innerHTML = '';
  customMsgs.forEach((msg, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;background:#2c2c2e;border-radius:8px;padding:7px 10px';
    row.innerHTML = '<span style="flex:1;font-size:12px;color:#f5f5f7;word-break:break-word">' + msg.replace(/</g,'&lt;') + '</span>'
      + '<button onclick="sendMsg(' + i + ')" style="border:none;background:#c0392b;color:#fff;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px">▶</button>'
      + '<button onclick="removeMsg(' + i + ')" style="border:none;background:#3a3a3e;color:#aaa;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px">✕</button>';
    list.appendChild(row);
  });
}
function addMsg() {
  const inp = el('marquee-txt');
  const txt = inp.value.trim();
  if (!txt) return;
  customMsgs.push(txt);
  inp.value = '';
  renderMsgList();
  cmd('set-custom-messages', { messages: customMsgs });
}
function removeMsg(i) {
  customMsgs.splice(i, 1);
  renderMsgList();
  cmd('set-custom-messages', { messages: customMsgs });
}
function sendMsg(i) {
  if (customMsgs[i]) cmd('marquee-play-once', { text: customMsgs[i] });
}
function sendRandomMsg() {
  if (!customMsgs.length) return;
  const txt = customMsgs[Math.floor(Math.random() * customMsgs.length)];
  cmd('marquee-play-once', { text: txt });
}
el('marquee-txt').addEventListener('keydown', e => { if (e.key === 'Enter') addMsg(); });

function sendMarqueeConfig() {
  const speed    = parseFloat(el('mq-speed').value);
  const fontSize = parseInt(el('mq-size').value);
  const bgAlpha  = parseFloat(el('mq-alpha').value);
  el('mq-speed-val').textContent = speed;
  el('mq-size-val').textContent  = fontSize + 'px';
  el('mq-alpha-val').textContent = Math.round(bgAlpha * 100) + '%';
  cmd('set-marquee-config', { speed, fontSize, color: el('mq-color').value, bgAlpha, position: el('mq-pos').value });
}

function sendLogoTiming() {
  cmd('set-logo-timing', { duration: parseInt(el('logo-dur').value), interval: parseFloat(el('logo-int').value) });
}

function renderLogoList() {
  const container = el('logo-list-remote');
  if (!container || !st.logos || !st.logos.length) {
    if (container) container.innerHTML = '<div style="font-size:11px;color:#555;text-align:center;padding:8px 0">No images added yet</div>';
    return;
  }
  container.innerHTML = '';
  st.logos.forEach(logo => {
    const div = document.createElement('div');
    div.style.cssText = 'background:#2c2c2e;border-radius:8px;padding:10px;margin-bottom:8px';
    div.dataset.logoId = logo.id;
    div.innerHTML = '<div style="font-size:12px;font-weight:600;color:#f5f5f7;margin-bottom:8px">' + logo.name.replace(/</g,'&lt;') + '</div>'
      + '<div class="row" style="margin-bottom:6px"><span class="lbl-sm">Visibility</span>'
      + '<select data-lid="' + logo.id + '" onchange="setLogoCfg(this.dataset.lid,this.value,null)" style="flex:1;background:#3a3a3e;border:1px solid #555;color:#fff;border-radius:6px;padding:5px 8px;font-size:12px">'
      + '<option value="sequence"' + (logo.visibility==='sequence'?' selected':'') + '>Sequence</option>'
      + '<option value="always-on"' + (logo.visibility==='always-on'?' selected':'') + '>Always On</option>'
      + '<option value="off"' + (logo.visibility==='off'?' selected':'') + '>Off</option>'
      + '</select></div>'
      + '<div class="toggle-row"><span class="lbl-sm">Bounce</span>'
      + '<label class="toggle"><input type="checkbox" data-lid="' + logo.id + '"' + (logo.bounce?' checked':'') + ' onchange="setLogoCfg(this.dataset.lid,null,this.checked)"><span class="sl"></span></label></div>';
    container.appendChild(div);
  });
}

function setLogoCfg(id, visibility, bounce) {
  cmd('set-logo-cfg', { id, visibility, bounce });
  // Update local state
  const logo = st.logos && st.logos.find(l => l.id === id);
  if (logo) {
    if (visibility !== null) logo.visibility = visibility;
    if (bounce    !== null) logo.bounce = bounce;
  }
}

function copyUrl() {
  navigator.clipboard.writeText('${url}').then(() => {
    const t = el('copy-tip'); t.style.opacity = 1;
    setTimeout(() => { t.style.opacity = 0; }, 1500);
  });
}

// ── Collapsible cards ──
document.querySelectorAll('.card-title').forEach(title => {
  title.addEventListener('click', () => {
    title.closest('.card').classList.toggle('collapsed');
  });
});

// ── Theme toggle ──
function toggleTheme() {
  const isLight = document.body.classList.toggle('light');
  localStorage.setItem('theme','light mode: ' + (isLight ? 'light' : 'dark'));
  el('theme-btn').textContent = isLight ? '\u{1F319} Dark' : '\u2600\uFE0F Light';
}
// Restore theme
if (localStorage.getItem('theme') === 'light mode: light') { document.body.classList.add('light'); el('theme-btn').textContent = '\u{1F319} Dark'; }

// ── Remote auth ───────────────────────────────────────────────────────────────
(async function initAuth() {
  const overlay = document.getElementById('login-overlay');
  const main    = document.getElementById('main-content');

  function showLogin() {
    overlay.style.display = 'flex';
    main.style.display    = 'none';
    setTimeout(() => document.getElementById('login-pw')?.focus(), 100);
  }
  function hideLogin() {
    overlay.style.display = 'none';
    main.style.display    = 'block';
  }

  window.doLogin = async function() {
    const pw  = document.getElementById('login-pw').value;
    const err = document.getElementById('login-err');
    const btn = document.getElementById('login-btn');
    btn.disabled = true; btn.textContent = 'Checking…';
    err.textContent = '';
    try {
      const res  = await fetch('/auth', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ password: pw }) });
      if (res.ok) {
        const { token } = await res.json();
        localStorage.setItem('remote-session', token);
        hideLogin();
      } else {
        err.textContent = 'Incorrect password — try again.';
        document.getElementById('login-pw').value = '';
        document.getElementById('login-pw').focus();
      }
    } catch(e) {
      err.textContent = 'Connection error — try again.';
    }
    btn.disabled = false; btn.textContent = 'Unlock';
  };

  // Check if a session token already exists
  const stored = localStorage.getItem('remote-session');
  if (stored) {
    try {
      const res = await fetch('/auth-check', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ token: stored }) });
      if (res.ok && (await res.json()).ok) { hideLogin(); return; }
    } catch(_) {}
    localStorage.removeItem('remote-session');
  }
  // Check if password is required
  try {
    const res = await fetch('/auth-check', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ token: '' }) });
    if (res.ok && (await res.json()).ok) { hideLogin(); return; } // no password set
  } catch(_) {}
  showLogin();
})();
</script>
</div><!-- #main-content -->
</body>
</html>`;
}

// ── Remote password session token ─────────────────────────────────────────────
// Derived from password — deterministic so it survives app restarts
function getSessionToken() {
  const pw = venueData.remotePassword || '';
  return require('crypto').createHash('sha256').update(pw + venueTopic).digest('hex');
}

// ── Cloudflare Tunnel ─────────────────────────────────────────────────────────
let tunnelProcess   = null;
let currentTunnelUrl = null;

function broadcastTunnelStatus(status, url) {
  allCtrlWindows().forEach(w => w.webContents.send('message', { type: 'tunnel-status', status, url: url || null }));
}

function getCloudflaredBin() {
  const { bin } = require('cloudflared');
  // When packaged in asar, fix path to point to the unpacked location
  return bin.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
}

function startTunnel() {
  if (tunnelProcess) return;
  broadcastTunnelStatus('starting');

  const { spawn } = require('child_process');
  const args = ['tunnel', '--url', `http://localhost:${REMOTE_PORT}`, '--no-autoupdate'];
  const proc = spawn(getCloudflaredBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  tunnelProcess = proc;

  const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

  function onData(chunk) {
    const text = chunk.toString();
    const match = text.match(urlPattern);
    if (match && !currentTunnelUrl) {
      currentTunnelUrl = match[0];
      broadcastTunnelStatus('connected', currentTunnelUrl);
      // Register with Cloudflare Worker so /remote?venueId=xxx redirects here
      const regUrl = `${PHOTO_WORKER_URL}/remote-url?venueId=${encodeURIComponent(venueTopic)}`;
      httpPost(regUrl, { tunnelUrl: currentTunnelUrl }).catch(() => {});
    }
  }

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', () => {
    tunnelProcess = null;
    if (currentTunnelUrl) {
      // Deregister
      const regUrl = `${PHOTO_WORKER_URL}/remote-url?venueId=${encodeURIComponent(venueTopic)}`;
      httpDelete(regUrl).catch(() => {});
      currentTunnelUrl = null;
    }
    broadcastTunnelStatus('offline');
  });

  proc.on('error', () => {
    tunnelProcess = null;
    currentTunnelUrl = null;
    broadcastTunnelStatus('error');
  });
}

function stopTunnel() {
  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
  }
}

function httpPost(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const parsed = new URL(url);
    const client = url.startsWith('https') ? https : http;
    const req = client.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

ipcMain.handle('tunnel-start', () => { startTunnel(); return true; });
ipcMain.handle('tunnel-stop',  () => { stopTunnel();  return true; });
ipcMain.handle('tunnel-status', () => ({
  status: tunnelProcess ? (currentTunnelUrl ? 'connected' : 'starting') : 'offline',
  url: currentTunnelUrl,
}));
ipcMain.handle('set-remote-password', (_, password) => {
  venueData.remotePassword = (password || '').trim();
  saveVenueData();
  return true;
});
ipcMain.handle('get-remote-password', () => venueData.remotePassword || '');

// Deregister tunnel on quit
app.on('before-quit', () => { stopTunnel(); });

function startRemoteServer() {
  const server = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0];

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders(); // ensure headers reach the browser before any data
      res.write(': ok\n\n'); // initial comment so browser confirms SSE connection
      res.write(`data: ${JSON.stringify({ type: 'state', ...remoteState })}\n\n`);
      sseClients.push(res);
      // Keepalive ping every 15s — prevents Cloudflare Tunnel from closing the connection
      const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch(_) { clearInterval(ka); } }, 15000);
      req.on('close', () => {
        clearInterval(ka);
        sseClients = sseClients.filter(c => c !== res);
      });
      // Ask viz to broadcast current preset name so remote page shows it immediately
      if (vizWindow && !vizWindow.isDestroyed()) {
        vizWindow.webContents.send('message', { type: 'request-current-preset' });
      }
      return;
    }

    if (pathname === '/cmd' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          handleRemoteCmd(JSON.parse(body));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(remoteState));
      return;
    }

    // ── Auth endpoints ─────────────────────────────────────────────────────────
    // POST /auth { password } → { token } or 401
    if (pathname === '/auth' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const { password } = JSON.parse(body);
          const stored = venueData.remotePassword || '';
          if (!stored || password === stored) {
            const token = getSessionToken();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ token }));
          } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Incorrect password' }));
          }
        } catch(e) {
          res.writeHead(400); res.end('{}');
        }
      });
      return;
    }

    // POST /auth-check { token } → { ok: true } or 401
    if (pathname === '/auth-check' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const { token } = JSON.parse(body);
          const ok = !!venueData.remotePassword && token === getSessionToken();
          // If no password set, always ok
          const allowed = !venueData.remotePassword || ok;
          res.writeHead(allowed ? 200 : 401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: allowed }));
        } catch(e) {
          res.writeHead(400); res.end('{}');
        }
      });
      return;
    }

    if (pathname === '/') {
      const html = buildRemotePage(getLocalIP());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  server.listen(REMOTE_PORT, '0.0.0.0', () => {
    console.log(`[Remote] http://${getLocalIP()}:${REMOTE_PORT}`);
  });

  server.on('error', e => console.warn('[Remote] Server error:', e.message));
  return server;
}

ipcMain.handle('get-remote-url', () => `http://${getLocalIP()}:${REMOTE_PORT}`);

// Fetch a remote URL and return it as a base64 data URL (bypasses renderer CSP)
ipcMain.handle('fetch-as-data-url', (_, url) => {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf  = Buffer.concat(chunks);
        const mime = res.headers['content-type'] || 'image/png';
        resolve(`data:${mime};base64,${buf.toString('base64')}`);
      });
      res.on('error', reject);
    }).on('error', reject);
  });
});

// Open a URL in the system default browser
ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

// Broadcast a state message to all control windows except the sender
ipcMain.handle('broadcast-ctrl-state', (event, msg) => {
  allCtrlWindows().forEach(w => {
    if (!w.isDestroyed() && w.webContents.id !== event.sender.id) {
      w.webContents.send('message', msg);
    }
  });
});

// Pop-out a section of the control panel into its own window
ipcMain.handle('popout-section', (_, sec) => {
  const cfg    = loadConfig();
  const bounds = (cfg.popoutBounds || {})[sec] || {};
  const titles = { fx: '⚡ Visual Effects', params: 'Parameters', scrolltext: '📜 Scrolling Text', trivia: '🧠 Bar Trivia' };
  const win = new BrowserWindow({
    width:  bounds.w || 420,
    height: bounds.h || 700,
    x: bounds.x,
    y: bounds.y,
    title: titles[sec] || 'AV Club VJ',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('src/controls.html', { query: { popout: sec } });
  if (!app.isPackaged) win.webContents.openDevTools({ mode: 'detach' });
  popoutWindows.push(win);
  win.on('closed', () => {
    const i = popoutWindows.indexOf(win);
    if (i !== -1) popoutWindows.splice(i, 1);
  });
  const saveBounds = () => {
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    const c = loadConfig();
    if (!c.popoutBounds) c.popoutBounds = {};
    c.popoutBounds[sec] = { x, y, w, h };
    saveConfig(c);
  };
  win.on('moved',  saveBounds);
  win.on('resize', saveBounds);
});
