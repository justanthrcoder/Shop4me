// preload.js — Ascend
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  runQuery: (term) => ipcRenderer.invoke('query:run', term),
  runBatch: (terms) => ipcRenderer.invoke('batch:run', terms),

  saveTxt: (payload) => ipcRenderer.invoke('save:txt', payload),

  loadDB: () => ipcRenderer.invoke('db:load'),

  submitCaptcha: (code) => ipcRenderer.invoke('monroe:captcha-submit', code),

  // **** Funciones de Configuración ****
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  loadSettings: () => ipcRenderer.invoke('settings:load'),

  // --- Función para abrir el selector de archivos ---
  selectChromePath: () => ipcRenderer.invoke('settings:select-chrome-path'),

  // --- NUEVO: Control manual de scrapers ---
  stopScraper: (scraperName) => ipcRenderer.invoke('scraper:stop', scraperName),

  // Listeners
  onLine: (cb) => ipcRenderer.on('scraper:line', (_e, payload) => cb(payload)),
  onTable: (cb) => ipcRenderer.on('scraper:table', (_e, payload) => cb(payload)),
  onCompareUpdate: (cb) => ipcRenderer.on('compare:update', (_e, payload) => cb(payload)),

  // Listener para resultados parciales del batch
  onScraperResult: (cb) => ipcRenderer.on('scraper:result', (_e, payload) => cb(payload)),

  onStatus: (cb) => ipcRenderer.on('batch:status', (_e, payload) => cb(payload)),
  onProgress: (cb) => ipcRenderer.on('batch:progress', (_e, payload) => cb(payload)),

  onCaptchaRequired: (cb) => ipcRenderer.on('monroe:captcha-required', (_e, payload) => cb(payload)),

  onScraperVisible: (cb) => ipcRenderer.on('ui:scraper-visible', (_e, visible) => cb(visible)),

  // --- NUEVO: Estado individual de scrapers (Idle/Running) ---
  onScraperStatus: (cb) => ipcRenderer.on('scraper:status', (_e, payload) => cb(payload)),
});