#!/usr/bin/env node
// 01-login-y-descargar-maestros.js
// Versión modificada: Login, navegación a Catálogos, click en Descargar.
// Inicia sesión, espera 3s, navega a catálogos, clickea "Descargar" (Maestros),
// espera la descarga y guarda el archivo en disco, y se mantiene abierto.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
// const readline = require('readline'); // Eliminado
// const child_process = require('child_process'); // Eliminado

/// =========== Config / envs ===========
const EMAIL = process.env.DELSUD_USER || 'acesar.selma@gmail.com';
const PASS = process.env.DELSUD_PASS || 'Platense11';
const STATE_FILE = process.env.STATE_FILE || path.resolve(__dirname, 'state-delsud.json');
const CHROME_PATH = process.env.CHROME_PATH || process.env.CHROME_EXE || null;
const REMOTE_DEBUG_PORT = process.env.REMOTE_DEBUG_PORT || '';
const PLAYWRIGHT_HEADLESS = (process.env.PLAYWRIGHT_HEADLESS === '1' || process.env.PLAYWRIGHT_HEADLESS === 'true') ? true : false;
const ENABLE_DIAG = (process.env.DIAG === '1');
const DIAG_DIR = path.resolve(__dirname, 'diagnostics');

// Directorio donde se guardará el .txt/.xlsx de maestros
const DOWNLOAD_DIR = process.env.DELSUD_DOWNLOAD_DIR || path.resolve(__dirname, 'downloads');

// const MAX_PAGES = parseInt(process.env.MAX_PAGES || '5', 10); // Eliminado

const LOGIN_URL = 'https://pedidos.delsud.com.ar/login';
const CATALOGUES_URL = 'https://pedidos.delsud.com.ar/catalogues'; // URL de destino
// const SEARCH_INPUT_SELECTOR = '#topnav-searchbox'; // Ya no es necesario
// const SEARCH_INPUT_PLACEHOLDER_PART = 'Ingres'; // Ya no es necesario

// timing params
// MODIFICADO: Reducción de tiempos para que la escritura sea más rápida
// **** GEMINI: Modificado para ser aún más rápido (0-1ms) ****
const CHAR_DELAY_MIN = parseInt(process.env.CHAR_DELAY_MIN || '0', 10);
const CHAR_DELAY_MAX = parseInt(process.env.CHAR_DELAY_MAX || '1', 10);
// const BACKSPACE_DELAY_MIN = parseInt(process.env.BACKSPACE_DELAY_MIN || '0', 10); // Eliminado
// const BACKSPACE_DELAY_MAX = parseInt(process.env.BACKSPACE_DELAY_MAX || '1', 10); // Eliminado
// const POST_SEARCH_WAIT_MS = parseInt(process.env.POST_SEARCH_WAIT_MS || '250', 10); // Eliminado
const PAGE_WAIT_TIMEOUT = parseInt(process.env.PAGE_WAIT_TIMEOUT || '6500', 10);
// const MAX_BACKSPACES = parseInt(process.env.MAX_BACKSPACES || '300', 10); // Eliminado

// tiempo para mostrar la primera página al inicio (en ms). configurable via env VIEW_FIRST_PAGE_MS
const VIEW_FIRST_PAGE_MS = parseInt(process.env.VIEW_FIRST_PAGE_MS || '3000', 10);

/// =========== util ===========
function nowStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// function rndMs(min=CHAR_DELAY_MIN,max=CHAR_DELAY_MAX){ return Math.floor(min + Math.random()*(max-min)); } // Eliminado
// function rndMsBack(min=BACKSPACE_DELAY_MIN,max=BACKSPACE_DELAY_MAX){ return Math.floor(min + Math.random()*(max-min)); } // Eliminado
function safeTrim(s) { if (s === null || s === undefined) return ''; return String(s).replace(/\s+/g, ' ').trim(); }

// ================================================================
// DIAGNÓSTICOS
// ================================================================
async function saveDiagnostic(page, namePrefix) {
  if (!ENABLE_DIAG) return;
  try {
    if (!fs.existsSync(DIAG_DIR)) fs.mkdirSync(DIAG_DIR, { recursive: true });
    const stamp = nowStamp();
    const png = path.join(DIAG_DIR, `${namePrefix}_${stamp}.png`);
    const html = path.join(DIAG_DIR, `${namePrefix}_${stamp}.html`);
    await page.screenshot({ path: png, fullPage: true }).catch(() => { });
    fs.writeFileSync(html, await page.content(), 'utf8');
    console.log('[DIAG] saved:', png, html);
  } catch (e) { console.warn('[DIAG] failed:', e && e.message); }
}

// ================================================================
// Helpers
// ================================================================
async function tryCloseCookieBanners(page) {
  const banners = [
    'button:has-text("Aceptar")',
    'button:has-text("Aceptar todo")',
    'button:has-text("Aceptar cookies")',
    'button:has-text("Acepto")',
    'button[aria-label*="Cerrar"]',
    'button[title*="Cerrar"]',
    '.cookie-banner button',
    '.qc-cmp2-summary-buttons .qc-cmp2-summary-buttons__button--accept'
  ];
  for (const s of banners) {
    try {
      const el = page.locator(s);
      if (await el.count() > 0) {
        try { await el.first().click({ force: true, timeout: 2000 }); } catch (e) { try { await el.first().click({ force: true }); } catch (_) { } }
        await page.waitForTimeout(80);
      }
    } catch (e) { }
  }
}

async function ensureFocusAndType(page, selector, text, opts = { charDelay: CHAR_DELAY_MIN }) {
  try { await page.waitForSelector(selector, { timeout: Math.max(1000, PAGE_WAIT_TIMEOUT) }); } catch (e) { }
  try { await page.focus(selector); } catch (e) { try { await page.evaluate(sel => { const el = document.querySelector(sel); if (el) { el.focus(); return true; } return false; }, selector); } catch (e2) { } }
  try { await page.evaluate(sel => { const el = document.querySelector(sel); if (!el) return false; if ('value' in el) el.value = ''; return true; }, selector); } catch (e) { }
  for (const ch of String(text)) { await page.keyboard.type(ch, { delay: opts.charDelay }); }
  await page.waitForTimeout(30);
  try {
    const val = await page.evaluate(sel => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return el.value || el.getAttribute('value') || null;
    }, selector);
    if (val && String(val).length > 0) return true;
    await page.fill(selector, String(text));
    await page.waitForTimeout(30);
    const val2 = await page.evaluate(sel => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return el.value || el.getAttribute('value') || null;
    }, selector);
    return !!(val2 && String(val2).length > 0);
  } catch (e) {
    try { await page.fill(selector, String(text)); return true; } catch (e2) { return false; }
  }
}

function candidateChromePaths() {
  const envPath = CHROME_PATH;
  return [
    envPath,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
}

// ================================================================
// MAIN flow (login y navegación a catálogos)
// ================================================================
(async () => {
  console.log('=== 01-login-y-descargar-maestros (DELSUD) ===');
  console.log('EMAIL:', EMAIL);
  console.log('HEADLESS:', PLAYWRIGHT_HEADLESS ? 'true' : 'false');
  console.log('DIAG:', ENABLE_DIAG ? '1' : '0');
  console.log('PAGE_WAIT_TIMEOUT:', PAGE_WAIT_TIMEOUT);
  console.log('DOWNLOAD_DIR:', DOWNLOAD_DIR);

  // Asegurar que exista el directorio de descargas
  try {
    if (!fs.existsSync(DOWNLOAD_DIR)) {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
      console.log('[INIT] Creado DOWNLOAD_DIR:', DOWNLOAD_DIR);
    }
  } catch (e) {
    console.warn('[INIT] No se pudo crear DOWNLOAD_DIR:', e && e.message);
  }

  let browser = null, context = null, page = null;
  let chosenExe = null;
  for (const p of candidateChromePaths()) {
    try { if (p && fs.existsSync(p)) { chosenExe = p; break; } } catch (e) { }
  }

  try {
    const args = [];
    if (REMOTE_DEBUG_PORT) args.push(`--remote-debugging-port=${REMOTE_DEBUG_PORT}`);
    args.push('--no-first-run', '--no-default-browser-check');
    if (chosenExe) {
      browser = await chromium.launch({ headless: PLAYWRIGHT_HEADLESS, executablePath: chosenExe, args });
    } else {
      browser = await chromium.launch({ headless: PLAYWRIGHT_HEADLESS, args });
    }
  } catch (e) {
    console.error('[LAUNCH] failed to launch browser:', e && (e.stack || e.message || e));
    process.exit(2);
  }

  try {
    // IMPORTANTE: aceptar descargas
    context = await browser.newContext({
      acceptDownloads: true
    });
    page = await context.newPage();

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await saveDiagnostic(page, 'page-loaded');
    await tryCloseCookieBanners(page);

    // mostrar la primera página unos ms para que el usuario la vea
    try {
      if (VIEW_FIRST_PAGE_MS > 0) {
        console.log(`[UI] mostrando la primera página durante ${VIEW_FIRST_PAGE_MS} ms...`);
        await page.waitForTimeout(VIEW_FIRST_PAGE_MS);
      }
    } catch (e) { /* ignore */ }

    // LOGIN
    const emailCandidates = [
      'input[placeholder="Ingresá tu correo electrónico"]',
      'input[placeholder*="correo"]',
      'input[type="email"]',
      'input[name*="email"]',
      'input[id*="email"]',
      'input[aria-label*="correo"]',
      'form input'
    ];
    let emailOk = false;
    for (const sel of emailCandidates) {
      try {
        if (await page.locator(sel).count() > 0) {
          await page.locator(sel).first().scrollIntoViewIfNeeded();
          await page.locator(sel).first().click({ force: true }).catch(() => { });
          emailOk = await ensureFocusAndType(page, sel, EMAIL, { charDelay: CHAR_DELAY_MIN });
          if (emailOk) break;
        }
      } catch (e) { }
    }
    if (!emailOk) { await saveDiagnostic(page, 'email-failed'); console.warn('No se pudo setear email (se continua).'); }

    const passCandidates = [
      'input[placeholder="Ingresá tu contraseña"]',
      'input[placeholder*="contrase"]',
      'input[type="password"]',
      'input[name*="pass"]',
      'input[id*="pass"]',
      'input[aria-label*="contrase"]'
    ];
    let passOk = false;
    for (const sel of passCandidates) {
      try {
        if (await page.locator(sel).count() > 0) {
          await page.locator(sel).first().scrollIntoViewIfNeeded();
          await page.locator(sel).first().click({ force: true }).catch(() => { });
          passOk = await ensureFocusAndType(page, sel, PASS, { charDelay: CHAR_DELAY_MIN });
          if (passOk) break;
        }
      } catch (e) { }
    }
    if (!passOk) { await saveDiagnostic(page, 'pass-failed'); console.warn('No se pudo setear password (se continua).'); }

    const submitCandidates = [
      'button:has-text("Ingresar")',
      'button:has-text("Iniciar")',
      'button[type="submit"]',
      'button.btn-primary',
      'button.btn',
      'text="Ingresar"',
      'text="Iniciar sesión"'
    ];
    let submitted = false;
    for (const sel of submitCandidates) {
      try {
        if (await page.locator(sel).count() > 0) {
          await page.locator(sel).first().scrollIntoViewIfNeeded();
          try { await page.locator(sel).first().click({ force: true, timeout: 3000 }); } catch (e) { await page.locator(sel).first().click({ force: true }); }
          submitted = true;
          break;
        }
      } catch (e) { }
    }
    if (!submitted) {
      try {
        const pw = page.locator('input[type="password"]');
        if (await pw.count() > 0) { await pw.first().press('Enter'); submitted = true; }
        else { await page.keyboard.press('Enter'); submitted = true; }
      } catch (e) { }
    }

    try { await page.waitForLoadState('networkidle', { timeout: 2000 }); } catch (e) { }
    await saveDiagnostic(page, 'after-submit');
    try { await context.storageState({ path: STATE_FILE }); } catch (e) { console.warn("[STATE] can't save state:", e && e.message); }

    // Esperar un poco después del login
    console.log('[ACTION] Login completado. Esperando 3 segundos...');
    await sleep(3000);

    // Navegar a Catálogos
    console.log(`[ACTION] Navegando a ${CATALOGUES_URL}...`);
    try {
      await page.goto(CATALOGUES_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log('[ACTION] Navegación a Catálogos completada.');
      try { await page.waitForLoadState('networkidle', { timeout: 2000 }); } catch (e) { }
      await saveDiagnostic(page, 'after-catalogues-nav');
    } catch (e) {
      console.error(`[ACTION] Falló la navegación a ${CATALOGUES_URL}:`, e.message);
      await saveDiagnostic(page, 'catalogues-nav-failed');
    }

    // Click en "Descargar" y esperar el archivo
    console.log('[ACTION] Buscando el botón "Descargar" (Maestros)...');
    const descargarButtonSelectors = [
      'button.MuiButton-containedPrimary:has-text("Descargar")',
      'button:has-text("Descargar")'
    ];

    let descargarClicked = false;
    let downloadedPath = null;

    for (const sel of descargarButtonSelectors) {
      try {
        const button = page.locator(sel).first();
        const count = await button.count();
        if (count > 0) {
          console.log(`[ACTION] Botón "Descargar" encontrado con selector: ${sel}`);
          await button.scrollIntoViewIfNeeded();

          // Esperar el evento de descarga al hacer click
          console.log('[ACTION] Haciendo click y esperando download...');
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 30000 }),
            button.click({ force: true })
          ]);

          const suggested = download.suggestedFilename();
          const finalName = `${nowStamp()}_${suggested || 'maestros_delsud.dat'}`;
          const destPath = path.join(DOWNLOAD_DIR, finalName);

          await download.saveAs(destPath);
          downloadedPath = destPath;
          descargarClicked = true;

          console.log('[DOWNLOAD] Archivo descargado y guardado en:', destPath);
          break;
        }
      } catch (e) {
        console.warn(`[ACTION] Falló el intento de click/descarga con selector: ${sel}`, e.message);
      }
    }

    if (!descargarClicked) {
      console.warn('[ACTION] No se pudo encontrar o clickear el botón "Descargar" o no se generó ningún download.');
      await saveDiagnostic(page, 'descargar-click-failed');
    } else {
      await saveDiagnostic(page, 'after-descargar-click');
    }

    console.log('Login, navegación a Catálogos y manejo de descarga completados.');
    if (downloadedPath) {
      console.log(`[INFO] Archivo disponible en: ${downloadedPath}`);
    }
    console.log('El script permanecerá abierto. Presioná Ctrl+C para salir y guardar el estado.');

    process.on('SIGINT', async () => {
      console.log('\nSIGINT recibido — cerrando correctamente (guardando estado).');
      try { await context.storageState({ path: STATE_FILE }); } catch (e) { console.warn('[STATE] no se pudo guardar:', e && e.message); }
      try { await browser.close(); } catch (e) { console.warn('[EXIT] error cerrando navegador:', e && e.message); }
      process.exit(0);
    });

    // Mantener el script vivo indefinidamente para que el navegador no se cierre
    await new Promise(() => { });

  } catch (err) {
    console.error('[ERROR] flujo principal:', err && (err.stack || err.message || err));
    try { if (page) await saveDiagnostic(page, `fatal-error-${nowStamp()}`); } catch (e) { }
    try { if (browser) await browser.close(); } catch (e) { }
    process.exit(1);
  }
})();
