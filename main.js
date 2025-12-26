// main.js — Ascend
const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// === Configuración de Logs y AutoUpdater ===
log.transports.file.level = 'info';
autoUpdater.logger = log;

// === Ajustes generales ===
const SMART_FALLBACK = true;
const DEFAULT_HEADLESS = { monroe: false, delsud: false, suizo: false };
const isDev = !app.isPackaged || process.env.NODE_ENV === 'development';

// **** Variables de configuración ****
let isIntenseMode = false;
let appSettings = {};
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

// **** Cache para Cross-Linking (Del Sud -> Suizo) ****
let delSudCache = new Map(); // Mapa: Termino/Nombre -> EAN

if (process.platform === 'win32') {
  try { app.setAppUserModelId('ar.ascend.app'); } catch { }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

let mainWindow = null;

function basePath(...segments) {
  return path.join(app.isPackaged ? process.resourcesPath : __dirname, ...segments);
}

function send(ch, payload) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload); }
function emitLine(scraper, line) { send('scraper:line', { scraper, line: String(line) }); }
function emitTable(scraper, rows) { send('scraper:table', { scraper, rows }); }
function emitCompare(term) { send('compare:update', { monroe: lastTables.monroe, delsud: lastTables.delsud, suizo: lastTables.suizo, term: term || '' }); }
function emitStatus(payload) { send('batch:status', payload); }
function emitProgress(progress) { send('batch:progress', progress); }

// **** Cargar configuración ****
async function loadSettingsFromFile() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const settingsData = await fsp.readFile(SETTINGS_FILE, 'utf8');
      appSettings = JSON.parse(settingsData);
      isIntenseMode = appSettings?.experimental?.intensiveMode || false;
      console.log('[Settings] Configuración cargada desde', SETTINGS_FILE);
      emitLine('app', `[APP] Configuración cargada desde archivo.`);
    } else {
      console.log('[Settings] No se encontró archivo de configuración, usando defaults.');
      emitLine('app', `[APP] No se encontró archivo de configuración, usando defaults.`);
      appSettings = {
        credentials: {
          delsud_user: '',
          delsud_pass: '',
          delsud_client: '',
          suizo_user: '',
          suizo_pass: '',
          suizo_client: '',
          monroe_user: '',
          monroe_pass: '',
          monroe_client: '',
        },
        experimental: { intensiveMode: false }
      };
    }
  } catch (err) {
    console.error('[Settings] Error al cargar configuración:', err.message);
    emitLine('app', `[APP] Error al cargar config: ${err.message}. Usando defaults.`);
    appSettings = {
      credentials: {
        delsud_user: '',
        delsud_pass: '',
        delsud_client: '',
        suizo_user: '',
        suizo_pass: '',
        suizo_client: '',
        monroe_user: '',
        monroe_pass: '',
        monroe_client: '',
      },
      experimental: { intensiveMode: false }
    };
    isIntenseMode = false;
  }
}

ipcMain.handle('settings:load', async () => {
  return appSettings;
});

ipcMain.handle('settings:save', async (_evt, settings) => {
  try {
    const settingsData = JSON.stringify(settings, null, 2);
    await fsp.writeFile(SETTINGS_FILE, settingsData, 'utf8');
    appSettings = settings;
    isIntenseMode = appSettings?.experimental?.intensiveMode || false;
    console.log('[Settings] Configuración guardada en', SETTINGS_FILE);
    emitLine('app', `[APP] Configuración guardada.`);
    buildMenu();
    return { ok: true };
  } catch (err) {
    console.error('[Settings] Error al guardar configuración:', err.message);
    emitLine('app', `[APP] Error al guardar config: ${err.message}.`);
    return { ok: false, error: err.message };
  }
});

/**
 * db:load (FIX)
 * - No rompe nombres con comas decimales (3,5 / 1,25 / etc.)
 * - Limpia BOM
 * - Normaliza EAN (8..14 dígitos)
 * - Reconstruye nombre desde el campo posterior al "0" (formato común del maestro)
 */
ipcMain.handle('db:load', async () => {
  const dbPath = basePath('maestros_convertido.txt');
  emitLine('app', `[APP] Cargando base de datos desde: ${dbPath}`);

  const stripBom = (s) => String(s || '').replace(/^\uFEFF/, '');
  const extractEAN = (raw) => {
    const s = stripBom(raw).trim();
    const m = s.match(/\b(\d{8,14})\b/);
    if (m) return m[1];
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 14) return digits;
    return '';
  };

  try {
    const fileContent = await fsp.readFile(dbPath, 'utf8');
    const lines = fileContent.split(/\r?\n/);

    const db = {};
    let skipped = 0;

    for (const rawLine of lines) {
      const line = stripBom(rawLine).trim();
      if (!line) continue;

      const parts = line.split(',');

      const ean = extractEAN(parts[0]);
      if (!ean) { skipped++; continue; }

      // Busca un "0" (frecuente en maestros: EAN,0,NOMBRE...)
      const idx0 = parts.findIndex((p, i) => i > 0 && String(p).trim() === '0');

      let name = '';
      if (idx0 >= 0 && idx0 < parts.length - 1) {
        name = parts.slice(idx0 + 1).join(',').trim();
      } else {
        name = parts.slice(1).join(',').trim();
      }

      name = stripBom(name).replace(/\s+/g, ' ').trim();
      if (!name) { skipped++; continue; }

      db[ean] = name;
    }

    emitLine('app', `[APP] Base de datos cargada con ${Object.keys(db).length} productos. (Saltados: ${skipped})`);
    return db;
  } catch (err) {
    emitLine('app', `[APP] ERROR al cargar la base de datos: ${err.message}`);
    console.error('Error loading product DB:', err);
    return {};
  }
});

ipcMain.handle('save:txt', async (_evt, { defaultPath, content }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Guardar archivo',
    defaultPath: defaultPath || 'archivo.txt',
    filters: [{ name: 'Archivo de texto', extensions: ['txt'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation']
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  await fsp.writeFile(res.filePath, content ?? '', 'utf8');
  return { ok: true, path: res.filePath };
});

ipcMain.handle('monroe:captcha-submit', async (_evt, captchaCode) => {
  const child = children.monroe;
  if (child && child.stdin && !child.stdin.destroyed) {
    try {
      child.stdin.write(String(captchaCode || '') + '\n');
      emitLine('monroe', `[APP] Enviando código CAPTCHA al scraper...`);
      return { ok: true };
    } catch (e) {
      emitLine('monroe', `[APP] Error al enviar CAPTCHA a stdin: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }
  emitLine('monroe', `[APP] No se pudo enviar CAPTCHA (proceso no existe o stdin cerrado).`);
  return { ok: false, error: 'Scraper process not available' };
});

const SCRAPERS_DIR = basePath('scrapers');
const HOOK_PATH = path.resolve(basePath('hooks'), 'console-tap.js');

const listScrapersDir = () => {
  try { return fs.readdirSync(SCRAPERS_DIR).map(n => path.join(SCRAPERS_DIR, n)); }
  catch { return []; }
};
const firstExistingPath = (cands) => {
  for (const p of cands) { try { if (p && fs.existsSync(p)) return p; } catch { } }
  return null;
};
function resolveScraperPath(preferred, fallbacks = []) {
  const candidates = [
    preferred && path.resolve(SCRAPERS_DIR, preferred),
    ...fallbacks.map(f => path.resolve(SCRAPERS_DIR, f)),
    path.resolve(SCRAPERS_DIR, 'DelSudSCRAPER.js'),
    path.resolve(SCRAPERS_DIR, 'SuizoSCRAPER.js'),
    path.resolve(SCRAPERS_DIR, 'MonroeSCRAPER.js'),
    path.resolve(SCRAPERS_DIR, 'MonroeSCRAPERFILE.js'),
    path.resolve(SCRAPERS_DIR, 'DelSudSCRAPERFILE.js'),
    path.resolve(SCRAPERS_DIR, 'SuizoSCRAPERFILE.js')
  ].filter(Boolean);
  return firstExistingPath(candidates);
}

const PATHS = {
  monroe: resolveScraperPath('MonroeSCRAPER.js'),
  delsud: resolveScraperPath('DelSudSCRAPER.js'),
  suizo: resolveScraperPath('SuizoSCRAPER.js'),
};

// Orden de ejecución solicitado: Delsud -> Monroe -> Suizo
function enabledOrder() { return ['delsud', 'monroe', 'suizo'].filter(n => PATHS[n]); }

function logResolvedPaths() {
  emitLine('app', '--- Resolución de scrapers ---');
  Object.keys(PATHS).forEach(k => emitLine('app', `  ${k}: ${PATHS[k] || '(NO ENCONTRADO)'}`));
  if (!PATHS.monroe || !PATHS.delsud || !PATHS.suizo) {
    emitLine('app', 'Archivos en ./scrapers detectados:');
    listScrapersDir().forEach(p => emitLine('app', '  - ' + p));
    emitLine('app', `resourcesPath: ${process.resourcesPath}`);
  }
}

const READY_PATTERNS = {
  monroe: /MODO BÚSQUEDA INTERACTIVA|Arrancando modo manual de búsquedas/i,
  delsud: /Arrancando modo manual de búsquedas|DELSUD.+modo MANUAL|@@@READY@@@/i,
  suizo: /Arrancando modo manual de búsquedas|@@@READY@@@/i,
};
const DONE_PATTERNS = {
  monroe: /Finalizado para "/i,
  delsud: /Finalizado para "|Productos extraídos \(raw\):/i,
  suizo: /--- FIN BUSQUEDA ---|Productos extraídos \(raw\):/i,
};

const children = { monroe: null, delsud: null, suizo: null };
const buffers = { monroe: '', delsud: '', suizo: '' };
const isReady = { monroe: false, delsud: false, suizo: false };
const isDone = { monroe: false, delsud: false, suizo: false };
const lastTables = { monroe: [], delsud: [], suizo: [] };

// --- Normalizadores ---
function firstNonEmpty(obj, keys, def = '') {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return def;
}

function normMonroeRow(r) {
  return {
    producto: firstNonEmpty(r, ['producto', 'product', 'productName']),
    precio: firstNonEmpty(r, ['precio_publico', 'publico', 'precio_sin_descuento', 'publicPrice']),
    con_desc: firstNonEmpty(r, ['precio_unitario', 'unitario', 'unitPrice']),
    stock: firstNonEmpty(r, ['stock', 'levelStock']),
    min: firstNonEmpty(r, ['mult_min', 'min', 'discountMin']),
    ean: firstNonEmpty(r, ['ean', 'sku', 'extractedEAN', 'ean_linked']), // Agregado ean_linked
    oferta: '',
    sitio: 'Monroe'
  };
}

function normDelsudRow(r) {
  return {
    producto: firstNonEmpty(r, ['producto', 'Producto', 'description', 'nombre']),
    pvp: firstNonEmpty(r, ['pvp', 'PVP', 'price', 'precio']),
    con_desc: firstNonEmpty(r, ['con_desc', 'precio_c_desc', 'Precio c/ desc', 'price_with_discount']),
    oferta: firstNonEmpty(r, ['oferta', 'descuento', 'offer']),
    min: firstNonEmpty(r, ['min', 'min_ofer', 'minimo']),
    stock: firstNonEmpty(r, ['stock', 'Stock', 'disponible']),
    ean: firstNonEmpty(r, ['sku', 'ean', 'codigo', 'ean_linked']),
    sitio: 'DelSud'
  };
}

function normSuizoRow(r) {
  let stockVal = '1';
  if (r.faltas !== undefined && r.faltas !== null && String(r.faltas).trim() !== '') {
    stockVal = '0';
  } else if (r.stock !== undefined) {
    stockVal = r.stock;
  }

  return {
    producto: firstNonEmpty(r, ['nombreProducto', 'product', 'producto', 'descripcion']),
    precio: firstNonEmpty(r, ['suPrecio', 'price', 'precio', 'pvp']),
    con_desc: firstNonEmpty(r, ['precioConDescuento', 'price_with_discount', 'con_desc']),
    stock: stockVal,
    oferta: firstNonEmpty(r, ['ofertaValor', 'ofertaTexto', 'oferta']),
    ean: firstNonEmpty(r, ['ean', 'sku', 'matchedEan']),
    sitio: 'Suizo'
  };
}

// --- Parsers ---
function parseArrowLine(line) {
  const rx = /product='([^']*)'[^]*?\bprice='([^']*)'[^]*?\bprice_with_discount='([^']*)'[^]*?\bstock='([^']*)'(?:[^]*?\bdiscount='([^']*)')?(?:[^]*?\bdiscount_pct='([^']*)')?(?:[^]*?\boferta='([^']*)')?(?:[^]*?\bmin='([^']*)')?/i;
  const m = String(line).match(rx);
  if (!m) return null;
  return {
    product: m[1] || '',
    price: m[2] || '',
    price_with_discount: m[3] || '',
    stock: m[4] || '',
    discount_raw: m[5] || '',
    discount_pct: m[6] || '',
    oferta: m[7] || '',
    min: m[8] || ''
  };
}

function parseMonroeCsvLine(line) {
  try {
    const trimmedLine = String(line).trim();
    if (!trimmedLine.startsWith('"')) return null;
    const match = trimmedLine.match(/^"([^"]*)",([^,]*),([^,]*),([^,]*),([^,]*),"([^"]*)",([^,]*)(?:,"([^"]*)")?$/);
    if (!match) {
      const fallbackMatch = trimmedLine.match(/^"([^"]*)",([^,]*),([^,]*),([^,]*),([^,]*),"?([^"]*)"?,([^,]*)$/);
      if (!fallbackMatch) return null;
      return {
        product: fallbackMatch[1].replace(/""/g, '"') || '',
        precio_unitario: fallbackMatch[2] || '',
        precio_sin_descuento: fallbackMatch[3] || '',
        precio_publico: fallbackMatch[4] || '',
        stock: fallbackMatch[5] || '',
        mult_min: fallbackMatch[6].replace(/""/g, '"') || '',
        tiene_descuento: fallbackMatch[7] || ''
      };
    }
    return {
      product: match[1].replace(/""/g, '"') || '',
      precio_unitario: match[2] || '',
      precio_sin_descuento: match[3] || '',
      precio_publico: match[4] || '',
      stock: match[5] || '',
      mult_min: match[6].replace(/""/g, '"') || '',
      tiene_descuento: match[7] || '',
      ean: match[8] ? match[8].replace(/""/g, '"') : ''
    };
  } catch (e) {
    emitLine('monroe', `[APP] Error parseando CSV Monroe: ${e?.message || e}`);
    return null;
  }
}

let expectMonroeCsv = false;

function spawnScraper(name, { headless } = {}) {
  if (children[name]) return children[name];

  let scriptPath = PATHS[name];

  if (name === 'monroe' && appSettings?.experimental?.monroeFileAlgorithm) {
    const fileScriptPath = resolveScraperPath('MonroeSCRAPERFILE.js');
    if (fileScriptPath) {
      scriptPath = fileScriptPath;
      emitLine(name, `[APP] MODO EXPERIMENTAL: Usando MonroeSCRAPERFILE.js`);
    }
  }

  if (name === 'delsud' && appSettings?.experimental?.delsudFileAlgorithm) {
    const fileScriptPath = resolveScraperPath('DelSudSCRAPERFILE.js');
    if (fileScriptPath) {
      scriptPath = fileScriptPath;
      emitLine(name, `[APP] MODO EXPERIMENTAL: Usando DelSudSCRAPERFILE.js`);
    }
  }

  if (name === 'suizo' && appSettings?.experimental?.suizoFileAlgorithm) {
    const fileScriptPath = resolveScraperPath('SuizoSCRAPERFILE.js');
    if (fileScriptPath) {
      scriptPath = fileScriptPath;
      emitLine(name, `[APP] MODO EXPERIMENTAL: Usando SuizoSCRAPERFILE.js`);
    }
  }

  if (!scriptPath) { emitLine(name, `[APP] No se encontró el script de ${name}. Se omite.`); return null; }
  emitLine(name, `[APP] Usando script: ${scriptPath}`);

  const defaultHeadless =
    (typeof headless === 'boolean')
      ? headless
      : (DEFAULT_HEADLESS[name] !== undefined ? DEFAULT_HEADLESS[name] : true);

  const runner = process.execPath;
  const args = [];

  if (name !== 'monroe' && fs.existsSync(HOOK_PATH)) {
    args.push('-r', HOOK_PATH);
    emitLine(name, `[APP] Hook de consola inyectado: ${HOOK_PATH}`);
  } else if (name !== 'monroe') {
    emitLine(name, `[APP] Hook de consola NO encontrado (ruta esperada: ${HOOK_PATH}).`);
  }

  args.push(scriptPath);

  const shouldForceBatch =
    (name === 'suizo' && appSettings?.experimental?.suizoFileAlgorithm) ||
    (name === 'delsud' && appSettings?.experimental?.delsudFileAlgorithm) ||
    (name === 'monroe' && appSettings?.experimental?.monroeFileAlgorithm);

  const creds = appSettings?.credentials || {};

  // === SANITIZED CREDENTIALS BLOCK ===
  // Note: All hardcoded defaults have been removed.
  // The app will now only use what is in settings.json or env variables.
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    HEADLESS: defaultHeadless ? '1' : '0',
    PUPPETEER_HEADLESS: defaultHeadless ? 'new' : 'false',
    PLAYWRIGHT_HEADLESS: defaultHeadless ? '1' : '0',
    PWDEBUG: '0',
    KEEP_BROWSER_OPEN: '0',
    START_MINIMIZED: defaultHeadless ? '0' : '1',
    SCRAPER_MODE: shouldForceBatch ? 'BATCH' : 'MANUAL',

    DELSUD_USER: creds.delsud_user || process.env.DELSUD_USER || '',
    DELSUD_PASS: creds.delsud_pass || process.env.DELSUD_PASS || '',
    DELSUD_CLIENT: creds.delsud_client || process.env.DELSUD_CLIENT || '',
    SUIZO_USER: creds.suizo_user || process.env.SUIZO_USER || '',
    SUIZO_PASS: creds.suizo_pass || process.env.SUIZO_PASS || '',
    SUIZO_CLIENT: creds.suizo_client || process.env.SUIZO_CLIENT || '',
    MONROE_USER: creds.monroe_user || process.env.MONROE_USER || '',
    MONROE_PASS: creds.monroe_pass || process.env.MONROE_PASS || '',
    MONROE_CLIENT: creds.monroe_client || process.env.MONROE_CLIENT || '',
  };

  const child = spawn(runner, args, {
    cwd: path.dirname(scriptPath),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false
  });

  child.stdin.on('error', (err) => {
    if (err.code !== 'EPIPE') {
      emitLine(name, `[stdin error] ${err.message}`);
    }
  });

  children[name] = child; buffers[name] = ''; isReady[name] = false; isDone[name] = false;
  expectMonroeCsv = false;

  const handleStdLine = (raw) => {
    emitLine(name, raw);
    const trimmedRaw = raw.trim();

    if (name === 'monroe' && trimmedRaw.startsWith('@@@CAPTCHA_REQUIRED@@@')) {
      try {
        const payload = JSON.parse(trimmedRaw.replace('@@@CAPTCHA_REQUIRED@@@', '').trim());
        emitLine('monroe', '[APP] CAPTCHA requerido. Enviando a UI...');
        send('monroe:captcha-required', payload);
        isReady[name] = false;
      } catch (e) {
        emitLine('monroe', `[APP] Error parseando payload de CAPTCHA: ${e?.message || e}`);
      }
      return;
    }

    if (trimmedRaw.startsWith('@@@PILLIGENCE_TABLE@@@')) {
      try {
        const payload = JSON.parse(trimmedRaw.replace('@@@PILLIGENCE_TABLE@@@', '').trim());
        const rows = Array.isArray(payload.data) ? payload.data
          : (payload.data && typeof payload.data === 'object' ? Object.values(payload.data) : []);

        if (name === 'monroe') {
          lastTables.monroe = rows.map(normMonroeRow);
          emitTable('monroe', lastTables.monroe);
        } else if (name === 'delsud') {
          const normRows = rows.map(normDelsudRow);
          lastTables.delsud = normRows;
          emitTable('delsud', normRows);

          // === CACHE DEL SUD EANs ===
          // Guardamos los EANs encontrados por DelSud para pasárselos a Suizo
          let cacheCount = 0;
          normRows.forEach(row => {
            const ean = row.ean;
            if (ean && /^\d{8,14}$/.test(ean)) {
              // Clave por nombre normalizado (para búsqueda inexacta)
              const cleanName = String(row.producto || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
              if (cleanName) {
                delSudCache.set(cleanName, ean);
                cacheCount++;
              }
              // También guardamos por término exacto si es posible
              if (row.query) {
                delSudCache.set(row.query.trim().toUpperCase(), ean);
              }
            }
          });
          if (cacheCount > 0) {
            emitLine('app', `[APP] DelSud Bridge: ${cacheCount} EANs cacheados para uso en Suizo.`);
          }

        } else if (name === 'suizo') {
          lastTables.suizo = rows.map(normSuizoRow);
          emitTable('suizo', lastTables.suizo);
        } else {
          lastTables[name] = rows;
          emitTable(name, lastTables[name]);
        }
      } catch (e) {
        emitLine(name, `[APP] Error parseando PILLIGENCE_TABLE: ${e?.message || e}`);
      }
      return;
    }

    if (name === 'monroe') {
      if (trimmedRaw.startsWith('CSV output (product,')) {
        expectMonroeCsv = true;
        return;
      }
      if (expectMonroeCsv && trimmedRaw.startsWith('"')) {
        const parsedRow = parseMonroeCsvLine(trimmedRaw);
        if (parsedRow) {
          lastTables.monroe = [normMonroeRow(parsedRow)];
          emitTable('monroe', lastTables.monroe);
          emitLine('monroe', '[APP] Datos CSV parseados y emitidos.');
        } else {
          emitLine('monroe', '[APP] Se esperaba CSV pero no se pudo parsear la línea.');
        }
      }
    } else {
      if (trimmedRaw.startsWith('@@@PILLIGENCE_ARROW@@@')) {
        try {
          const obj = JSON.parse(trimmedRaw.replace('@@@PILLIGENCE_ARROW@@@', '').trim());
          if (name === 'suizo') {
            lastTables[name] = [normSuizoRow(obj)];
          }
          emitTable(name, lastTables[name]);
        } catch (e) { emitLine(name, `[APP] Error parseando flecha hook: ${e?.message || e}`); }
        return;
      }
      if (name === 'suizo' && trimmedRaw.startsWith('-> product=')) {
        const obj = parseArrowLine(trimmedRaw);
        if (obj) {
          lastTables.suizo = [normSuizoRow(obj)];
          emitTable('suizo', lastTables.suizo);
        }
      }
    }

    if (!isReady[name] && READY_PATTERNS[name].test(raw)) {
      emitLine(name, `[APP] ${name} está LISTO.`);
      isReady[name] = true;
    }
    if (DONE_PATTERNS[name].test(raw)) {
      emitLine(name, `[APP] ${name} terminó la búsqueda.`);
      isDone[name] = true;
      expectMonroeCsv = false;
    }
  };

  child.stdout.on('data', chunk => {
    const text = chunk.toString();
    buffers[name] += text;
    const lines = buffers[name].split(/\r?\n/);
    buffers[name] = lines.pop() || '';
    for (const line of lines) handleStdLine(String(line));
  });
  child.stderr.on('data', chunk => {
    const t = String(chunk.toString()).split(/\r?\n/);
    t.forEach(line => line && handleStdLine('[stderr] ' + line));
  });
  child.on('error', err => emitLine(name, `[spawn error] ${err?.message || err}`));
  child.on('exit', (code, signal) => {
    emitLine(name, `Proceso ${name} terminó (code=${code}, signal=${signal})`);
    children[name] = null; isReady[name] = false; isDone[name] = false;
    expectMonroeCsv = false;
  });

  return child;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function ensureReady(name, timeoutMs = 120000) {
  if (!children[name]) { const c = spawnScraper(name); if (!c) return false; }
  if (isReady[name]) return true;

  const start = Date.now();
  while (!isReady[name] && children[name] && Date.now() - start < timeoutMs) { await sleep(150); }

  if (!isReady[name] && SMART_FALLBACK && DEFAULT_HEADLESS[name]) {
    emitLine(name, `[APP] ${name}: headless no respondió a tiempo, reintentando con UI…`);
    try { children[name]?.kill('SIGKILL'); } catch { }
    children[name] = null;
    spawnScraper(name, { headless: false });
    const t0 = Date.now();
    while (!isReady[name] && children[name] && Date.now() - t0 < timeoutMs) { await sleep(150); }
  }

  await sleep(250);
  return !!isReady[name];
}

async function waitDone(name, timeoutMs = 240000) {
  const start = Date.now();
  while (!isDone[name] && children[name] && Date.now() - start < timeoutMs) { await sleep(180); }
  return !!isDone[name];
}

let PROG = { completed: 0, total: 0 };
function updateWindowsProgress() {
  if (!mainWindow) return;
  const frac = PROG.total ? (PROG.completed / PROG.total) : 0;
  mainWindow.setProgressBar(frac);
}
function resetProgress(totalUnits) {
  PROG = { completed: 0, total: totalUnits || 0 };
  updateWindowsProgress();
  emitProgress({ completedUnits: PROG.completed, totalUnits: PROG.total });
  emitStatus({ phase: 'progress', completedUnits: PROG.completed, totalUnits: PROG.total });
}
function bumpProgress() {
  PROG.completed += 1;
  updateWindowsProgress();
  emitProgress({ completedUnits: PROG.completed, totalUnits: PROG.total });
  emitStatus({ phase: 'progress', completedUnits: PROG.completed, totalUnits: PROG.total });
}

async function runOneTermAcrossAll(term) {
  lastTables.monroe = [];
  lastTables.delsud = [];
  lastTables.suizo = [];

  const scrapersToRun = enabledOrder();

  const runSingleScraper = async (name) => {
    const ok = await ensureReady(name);
    if (!ok) {
      emitLine(name, `[APP] ${name}: no listo (o sin script). Se omite.`);
      bumpProgress();
      return;
    }

    isDone[name] = false;
    if (name === 'monroe') expectMonroeCsv = false;

    emitLine(name, `\n[APP] Enviando término: ${term}\n`);
    try {
      if (children[name].stdin && !children[name].stdin.destroyed) {
        children[name].stdin.write(term + '\n');
      }
    } catch (e) {
      emitLine(name, `[APP] Error enviando término: ${e?.message || e}`);
    }

    await waitDone(name);
    bumpProgress();
  };

  if (isIntenseMode) {
    emitLine('app', '[APP] Intense Mode activado: ejecutando scrapers en paralelo.');
    await Promise.all(scrapersToRun.map(name => runSingleScraper(name)));
  } else {
    emitLine('app', '[APP] Intense Mode desactivado: ejecutando scrapers secuencialmente.');
    for (const name of scrapersToRun) {
      await runSingleScraper(name);
      await killScraper(name);
      await sleep(500);
    }
  }

  await sleep(1000);
  emitCompare(term);
}

async function runOneTermOnOneScraper(term, name) {
  if (!isReady[name] || !children[name]) {
    emitLine(name, `[APP] ${name}: no está listo. Omitiendo término ${term}.`);
    bumpProgress();
    return;
  }

  lastTables[name] = [];
  isDone[name] = false;
  if (name === 'monroe') expectMonroeCsv = false;

  emitLine(name, `\n[APP] Enviando término: ${term}\n`);
  try {
    if (children[name].stdin && !children[name].stdin.destroyed) {
      children[name].stdin.write(term + '\n');
    }
  } catch (e) {
    emitLine(name, `[APP] Error enviando término: ${e?.message || e}`);
    bumpProgress();
    return;
  }

  await waitDone(name, 240000);
  send('scraper:result', { scraper: name, term: term, data: lastTables[name] });
  bumpProgress();
}

async function killScraper(name) {
  if (!children[name]) return;
  emitLine(name, `[APP] Cerrando scraper ${name}...`);

  try {
    if (children[name] && !children[name].killed && children[name].stdin && !children[name].stdin.destroyed) {
      children[name].stdin.write('exit\n');
    }
  } catch (_) { }

  const start = Date.now();
  while (children[name] && Date.now() - start < 3000) { await sleep(200); }

  if (children[name]) {
    emitLine(name, `[APP] Forzando cierre de ${name}...`);
    try { children[name].kill('SIGKILL'); } catch (_) { }
    children[name] = null;
  }
  isReady[name] = false;
  isDone[name] = false;
}

async function closeAllScrapers() {
  const names = Object.keys(children);
  for (const n of names) {
    if (children[n]) {
      try {
        if (!children[n].killed && children[n].stdin && !children[n].stdin.destroyed) {
          children[n].stdin.write('exit\n');
        }
      } catch (_) { }
    }
  }
  const start = Date.now();
  while (names.some(n => children[n])) { await sleep(200); if (Date.now() - start > 8000) break; }
  for (const n of names) {
    if (children[n]) {
      try { children[n].kill('SIGKILL'); } catch (_) { }
      children[n] = null;
    }
  }
}

// ==== BRIDGE FUNCTION ====
// Inyecta EANs encontrados por DelSud en los items de Suizo que no tengan EAN
function enrichQueueWithDelSudEans(queue) {
  let enriched = 0;
  queue.forEach(item => {
    // Si el item ya tiene EAN válido, lo dejamos.
    if (item.ean && /^\d{8,14}$/.test(item.ean)) return;

    // Intentamos buscar por nombre limpio en el cache de DelSud
    const cleanName = String(item.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const foundEan = delSudCache.get(cleanName);

    if (foundEan) {
      item.ean = foundEan;
      enriched++;
    }
  });
  if (enriched > 0) {
    emitLine('app', `[APP] Bridge Suizo: Se inyectaron ${enriched} EANs desde DelSud.`);
  }
  return queue;
}

ipcMain.handle('query:run', async (_evt, term) => {
  const t = (term || '').trim(); if (!t) return;
  const units = enabledOrder().length;
  resetProgress(units);
  emitStatus({ phase: 'start', total: 1, totalUnits: units });
  await runOneTermAcrossAll(t);
  await closeAllScrapers();
  emitStatus({ phase: 'done' });
  if (mainWindow) mainWindow.setProgressBar(-1);
});

ipcMain.handle('batch:run', async (_evt, terms) => {
  const queue = Array.isArray(terms) ? terms.map(t => {
    if (typeof t === 'string') return { ean: t.trim(), name: 'Busqueda Auto' };
    return { ean: (t.ean || '').trim(), name: (t.name || 'Busqueda Auto').trim() };
  }).filter(t => t.ean || t.name) : []; // Allow name-only items if we hope for fuzzy matching

  if (!queue.length) return;

  const scrapersToRun = enabledOrder();
  const perTerm = scrapersToRun.length;
  resetProgress(queue.length * perTerm);
  emitStatus({ phase: 'start', total: queue.length, totalUnits: queue.length * perTerm });

  for (const name of scrapersToRun) {
    emitLine('app', `[APP] --- Iniciando scraper: ${name} ---`);
    const ok = await ensureReady(name);

    if (!ok) {
      emitLine(name, `[APP] ${name}: no pudo iniciarse (o sin script). Se omiten ${queue.length} términos.`);
      PROG.completed += queue.length;
      updateWindowsProgress();
      emitProgress({ completedUnits: PROG.completed, totalUnits: PROG.total });
      emitStatus({ phase: 'progress', completedUnits: PROG.completed, totalUnits: PROG.total });
      emitStatus({ phase: 'progress', completedUnits: PROG.completed, totalUnits: PROG.total });
      continue;
    }

    const isMonroeFile = (name === 'monroe' && appSettings?.experimental?.monroeFileAlgorithm);
    const isDelsudFile = (name === 'delsud' && appSettings?.experimental?.delsudFileAlgorithm);
    const isSuizoFile = (name === 'suizo' && appSettings?.experimental?.suizoFileAlgorithm);

    if (isMonroeFile || isDelsudFile || isSuizoFile) {
      emitLine(name, `[APP] Ejecutando LOTE COMPLETO en modo Archivo (${queue.length} items)...`);

      let batchCommand = "";

      // === SUIZO BRIDGE LOGIC ===
      if (name === 'suizo') {
        // Enriquecer la cola con EANs de DelSud si existen
        enrichQueueWithDelSudEans(queue);
      }

      if (name === 'delsud' || name === 'suizo' || name === 'monroe') {
        batchCommand = "BATCH_JSON:" + JSON.stringify(queue);
      } else {
        // Legacy fallback
        const eanList = queue.map(item => item.ean).filter(Boolean);
        batchCommand = "BATCH:" + eanList.join(",");
      }

      try {
        if (children[name].stdin && !children[name].stdin.destroyed) {
          children[name].stdin.write(batchCommand + '\n');
        }
      } catch (e) {
        emitLine(name, `[APP] Error enviando lote: ${e.message}`);
      }

      await waitDone(name, 600000);

      PROG.completed += queue.length;
      updateWindowsProgress();
      emitProgress({ completedUnits: PROG.completed, totalUnits: PROG.total });
      emitStatus({ phase: 'progress', completedUnits: PROG.completed, totalUnits: PROG.total });

    } else {
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        const term = item.ean || item.name;
        emitStatus({ phase: 'running', index: i + 1, total: queue.length, term: `${term} (en ${name})` });
        await runOneTermOnOneScraper(term, name);
        if (!isIntenseMode) await sleep(250);
      }
    }

    await killScraper(name);
    emitLine('app', `[APP] --- Scraper ${name} finalizado ---`);
  }

  emitStatus({ phase: 'done' });
  if (mainWindow) mainWindow.setProgressBar(-1);
});

function buildMenu() {
  const viewItems = [
    { label: 'Mostrar pestaña Scraper', type: 'checkbox', checked: false, click: (item) => send('ui:scraper-visible', item.checked) },
    { type: 'separator' },
    {
      label: 'Intense Mode (Paralelo)',
      type: 'checkbox',
      checked: isIntenseMode,
      click: (item) => {
        isIntenseMode = item.checked;
        emitLine('app', `[APP] Intense Mode ${isIntenseMode ? 'activado' : 'desactivado'}.`);
        if (!appSettings.experimental) appSettings.experimental = {};
        appSettings.experimental.intensiveMode = isIntenseMode;
        fsp.writeFile(SETTINGS_FILE, JSON.stringify(appSettings, null, 2), 'utf8')
          .then(() => console.log('[Settings] Modo Intensivo guardado desde menú.'))
          .catch(e => console.error('[Settings] Falló al guardar Modo Intensivo desde menú:', e));
      }
    },
    { type: 'separator' },
    ...(isDev ? [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }] : []),
    { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }
  ];

  const template = [
    ...(process.platform === 'darwin'
      ? [{ label: 'Shop4me', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }]
      : []),
    { label: 'Archivo', submenu: [{ role: 'quit', label: 'Salir' }] },
    { label: 'Ver', submenu: viewItems },
    { role: 'help', submenu: [{ label: 'Acerca de Shop4me', click() { /* noop */ } }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 900,
    title: 'Shop4me',
    icon: path.join(__dirname, 'logo.png'),
    webPreferences: {
      preload: path.resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.resolve(__dirname, 'index.html'));
}

// ==== EVENTOS AUTOUPDATER ====
autoUpdater.on('checking-for-update', () => {
  emitLine('app', '[AutoUpdater] Buscando actualizaciones...');
});
autoUpdater.on('update-available', (info) => {
  emitLine('app', `[AutoUpdater] Actualización disponible: ${info.version}`);
});
autoUpdater.on('update-not-available', () => {
  emitLine('app', '[AutoUpdater] No hay actualizaciones pendientes.');
});
autoUpdater.on('error', (err) => {
  emitLine('app', `[AutoUpdater] Error: ${err.message}`);
});
autoUpdater.on('download-progress', (progressObj) => {
  let logMessage = `[AutoUpdater] Descargando: ${Math.round(progressObj.percent)}%`;
  emitLine('app', logMessage);
});
autoUpdater.on('update-downloaded', () => {
  emitLine('app', '[AutoUpdater] Descarga completada. Instalando ahora...');
  // Force quit and install immediately
  autoUpdater.quitAndInstall();
});

app.whenReady().then(async () => {
  await loadSettingsFromFile();
  createWindow();
  buildMenu();
  logResolvedPaths();

  // Trigger check 5 seconds after launch to avoid slowing down startup
  setTimeout(() => {
    if (!isDev) {
      emitLine('app', '[AutoUpdater] Iniciando comprobación...');
      autoUpdater.checkForUpdatesAndNotify();
    }
  }, 5000);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) { createWindow(); buildMenu(); } });

if (isDev) {
  try {
    process.on('SIGTERM', () => app.quit());
    process.on('SIGINT', () => app.quit());
  } catch { }
}