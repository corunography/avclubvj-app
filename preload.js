const { contextBridge, ipcRenderer, desktopCapturer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),

  // Bonus presets (extra resources — 14k+ presets loaded from disk, not bundled)
  getBonusPresetNames: ()     => ipcRenderer.invoke('get-bonus-preset-names'),
  loadBonusPreset:     (name) => ipcRenderer.invoke('load-bonus-preset', name),

  // Custom presets
  getCustomPresets: () => ipcRenderer.invoke('get-custom-presets'),
  importPresets: () => ipcRenderer.invoke('import-presets'),
  deleteCustomPreset: (name) => ipcRenderer.invoke('delete-custom-preset', name),
  readPresetFile: (filePath) => ipcRenderer.invoke('read-preset-file', filePath),
  saveGeneratedPreset: (name, preset) => ipcRenderer.invoke('save-generated-preset', { name, preset }),

  // Cross-window messaging
  sendToViz: (msg) => ipcRenderer.send('to-viz', msg),
  sendToControl: (msg) => ipcRenderer.send('to-control', msg),
  onMessage: (cb) => {
    const handler = (_, msg) => cb(msg);
    ipcRenderer.on('message', handler);
    return () => ipcRenderer.removeListener('message', handler);
  },

  // Window management
  setVizSize: (w, h) => ipcRenderer.invoke('set-viz-size', { width: w, height: h }),
  toggleVizFullscreen: () => ipcRenderer.invoke('toggle-viz-fullscreen'),
  setVizVisible: (v) => ipcRenderer.invoke('set-viz-visible', v),
  getVizVisible: () => ipcRenderer.invoke('get-viz-visible'),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  sendToDisplay: (id) => ipcRenderer.invoke('send-to-display', id),

  // Syphon
  syphonStart: (name) => ipcRenderer.invoke('syphon-start', name),
  syphonStop: () => ipcRenderer.invoke('syphon-stop'),
  syphonStatus: () => ipcRenderer.invoke('syphon-status'),
  // Send pixel data via regular IPC (structured clone)
  syphonSendFrame: (buffer, width, height) =>
    ipcRenderer.send('syphon-frame', width, height, new Uint8Array(buffer)),

  // Syphon Overlay — transparent alpha channel (marquee/logos/photos/trivia/QR)
  syphonOverlayStart:  (name) => ipcRenderer.invoke('syphon-overlay-start', name),
  syphonOverlayStop:   ()     => ipcRenderer.invoke('syphon-overlay-stop'),
  syphonOverlayStatus: ()     => ipcRenderer.invoke('syphon-overlay-status'),
  syphonOverlaySendFrame: (buffer, width, height) =>
    ipcRenderer.send('syphon-overlay-frame', width, height, new Uint8Array(buffer)),

  // NDI
  ndiStart: (name) => ipcRenderer.invoke('ndi-start', name),
  ndiStop: () => ipcRenderer.invoke('ndi-stop'),
  ndiStatus: () => ipcRenderer.invoke('ndi-status'),

  // Hydra preset saving
  saveHydraPreset: (data) => ipcRenderer.invoke('save-hydra-preset', data),

  // Low-FPS preset logging
  logLowFpsPreset: (name, fps) => ipcRenderer.send('log-low-fps-preset', { name, fps }),
  openLowFpsLog: () => ipcRenderer.send('open-low-fps-log'),

  // Venue overlay — file picker + image loading
  showOpenDialog: (opts) => ipcRenderer.invoke('show-open-dialog', opts),
  readFileAsDataUrl: (filePath) => ipcRenderer.invoke('read-file-as-data-url', filePath),

  // Live text feeds (fetched in main process to avoid CORS)
  fetchFeed: (feed, params) => ipcRenderer.invoke('fetch-feed', { feed, params }),

  // System audio capture (macOS 13+ / ScreenCaptureKit)
  getDesktopSources: (opts) => desktopCapturer.getSources(opts),

  // Remote control server URL
  getRemoteUrl: () => ipcRenderer.invoke('get-remote-url'),

  // Audience submission
  getVenueInfo:    () => ipcRenderer.invoke('get-venue-info'),
  audienceAction:  (data) => ipcRenderer.send('audience-action', data),
  openAudienceLog: () => ipcRenderer.invoke('open-audience-log'),

  // Utility
  fetchAsDataUrl: (url) => ipcRenderer.invoke('fetch-as-data-url', url),
  openExternal:   (url) => ipcRenderer.invoke('open-external', url),
  popoutSection:      (sec) => ipcRenderer.invoke('popout-section', sec),
  broadcastCtrlState: (msg) => ipcRenderer.invoke('broadcast-ctrl-state', msg),

  // Bar Trivia
  triviaPublishQuestion: (data) => ipcRenderer.invoke('trivia-publish-question', data),
  triviaPublishEnd:      ()     => ipcRenderer.invoke('trivia-publish-end'),
  triviaPublishReveal:   (correctIndex) => ipcRenderer.invoke('trivia-publish-reveal', correctIndex),
  triviaResetTeams:      () => ipcRenderer.send('trivia-reset-teams'),
  triviaGetTopics:       ()     => ipcRenderer.invoke('trivia-get-topics'),
  triviaSaveScores:     (scores) => ipcRenderer.invoke('trivia-save-scores', scores),
  triviaClearScores:    ()       => ipcRenderer.invoke('trivia-clear-scores'),
  openTriviaScoreLog:   ()       => ipcRenderer.invoke('open-trivia-score-log'),
  triviaPushScores:     (scores) => ipcRenderer.invoke('trivia-push-scores', scores),

  // Custom trivia questions
  triviaGetCustom:    ()           => ipcRenderer.invoke('trivia-get-custom'),
  triviaSaveCustom:   (question)   => ipcRenderer.invoke('trivia-save-custom', question),
  triviaDeleteCustom: (id)         => ipcRenderer.invoke('trivia-delete-custom', id),

  // Photo sharing
  photoDelete:       (id)   => ipcRenderer.invoke('photo-delete', id),
  photoSaveHistory:  (data) => ipcRenderer.invoke('photo-save-history', data),
  photoOpenHistory:  ()     => ipcRenderer.invoke('photo-open-history'),
  photoClearHistory: ()     => ipcRenderer.invoke('photo-clear-history'),

  // Cloudflare Tunnel + remote password
  tunnelStart:         ()         => ipcRenderer.invoke('tunnel-start'),
  tunnelStop:          ()         => ipcRenderer.invoke('tunnel-stop'),
  tunnelStatus:        ()         => ipcRenderer.invoke('tunnel-status'),
  setRemotePassword:   (password) => ipcRenderer.invoke('set-remote-password', password),
  getRemotePassword:   ()         => ipcRenderer.invoke('get-remote-password'),
});
