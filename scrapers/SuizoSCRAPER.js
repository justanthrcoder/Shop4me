#!/usr/bin/env node
// 01-login-y-interaccion-mejorado-suizo_manual_only.noexport.js
// Versión modificada (sin columna 'cantidad').
// *** MODIFICADO: ya NO exporta CSV. La funcionalidad de exportación ha sido desactivada. ***
// Delay configurable después de cada búsqueda para dar tiempo a que carguen los resultados.
// NUEVO: soporte de rango aleatorio entre búsquedas: SEARCH_DELAY_MIN_MS / SEARCH_DELAY_MAX_MS
// MODIFICADO: Añadida la extracción de la columna 'Oferta'.
// CORREGIDO: Se extraen y muestran tanto "Su Precio" como "Su Precio con Dto.".
//
// === MODIFICACIÓN (14/11/2025) ===
// 1. Flujo de búsqueda: Usa el modal "Buscar con escaner" (a#buscarCB).
// 2. Corrección de UI: Detecta y cierra el popup de ofertas "Super Ofertas" (a#cerrar-modal-1).
// 3. AJUSTE CRÍTICO: Localización directa del input del escáner #cbinput dentro de #interfazcb.
// 4. AJUSTE NUEVO: NO se reabre el modal luego de cada búsqueda; sólo se re-focaliza #cbinput.
// ==================================

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

/// =========== Config / envs ===========
const SUIZO_USER = process.env.SUIZO_USER;
const SUIZO_PASS = process.env.SUIZO_PASS;

const STATE_FILE = process.env.STATE_FILE || path.resolve(__dirname, 'state-suizo.json');
const CHROME_PATH = process.env.CHROME_PATH || process.env.CHROME_EXE || null;
const PLAYWRIGHT_HEADLESS = (process.env.PLAYWRIGHT_HEADLESS === '1' || process.env.PLAYWRIGHT_HEADLESS === 'true') ? true : false;
const KEEP_BROWSER_OPEN = (process.env.KEEP_BROWSER_OPEN === '0' || process.env.KEEP_BROWSER_OPEN === 'false') ? false : true;
const PAGE_WAIT_TIMEOUT = parseInt(process.env.PAGE_WAIT_TIMEOUT || '6500', 10);

const ENABLE_DIAG = (process.env.DIAG === '1');
const DIAG_DIR = path.resolve(__dirname, 'diagnostics');

const LOGIN_URL = 'https://web1.suizoargentina.com/login';

// >>> Constantes relacionadas con CSV (se mantienen por compatibilidad, pero no se usan)
const OUTPUT_DIR = path.resolve(__dirname, 'Scrapeados');
const CSV_FILE_PATH = path.join(OUTPUT_DIR, 'suizoEXPORT.csv');
// <<< FIN

// Delay DESPUÉS de buscar y ANTES de leer la tabla.
const POST_SEARCH_DELAY_MS = parseInt(process.env.POST_SEARCH_DELAY_MS || '2000', 10);

// Rango aleatorio adicional entre búsquedas.
let SEARCH_DELAY_MIN_MS = parseInt(process.env.SEARCH_DELAY_MIN_MS || String(POST_SEARCH_DELAY_MS), 10);
let SEARCH_DELAY_MAX_MS = parseInt(process.env.SEARCH_DELAY_MAX_MS || String(POST_SEARCH_DELAY_MS), 10);
if (isNaN(SEARCH_DELAY_MIN_MS)) SEARCH_DELAY_MIN_MS = POST_SEARCH_DELAY_MS;
if (isNaN(SEARCH_DELAY_MAX_MS)) SEARCH_DELAY_MAX_MS = POST_SEARCH_DELAY_MS;
if (SEARCH_DELAY_MIN_MS > SEARCH_DELAY_MAX_MS) {
  const tmp = SEARCH_DELAY_MIN_MS; SEARCH_DELAY_MIN_MS = SEARCH_DELAY_MAX_MS; SEARCH_DELAY_MAX_MS = tmp;
}

const POST_LOGIN_NAV_DELAY_MS = parseInt(process.env.POST_LOGIN_NAV_DELAY_MS || '50', 10);
const CODE_INPUT_CANDIDATES = [
  'input[type="search"]',
  'input[placeholder*="Código" i]',
  'input[name*="codigo" i]',
  'input[id*="codigo" i]',
  'input[placeholder*="Código a buscar" i]',
  '#codigo',
  '#cod',
  'input[id*="cod" i]',
  'input[aria-label*="codigo" i]',
  'input[aria-label*="cod" i]',
  'input[type="text"]'
];

function exportToCsv(dataMap) {
  try {
    console.log('[CSV] Exportación deshabilitada por configuración. Skipping write to', CSV_FILE_PATH);
  } catch (e) {
    console.warn('[CSV] Error en stub exportToCsv:', e && e.message);
  }
}

/// =========== util ===========
function nowStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
}

async function saveDiagnostic(page, namePrefix) {
  if (!ENABLE_DIAG) return;
  try {
    if (!fs.existsSync(DIAG_DIR)) fs.mkdirSync(DIAG_DIR, { recursive: true });
    const png = path.join(DIAG_DIR, `${namePrefix}_${nowStamp()}.png`);
    await page.screenshot({ path: png, fullPage: true }).catch(() => { });
    console.log('[DIAG] saved:', png);
  } catch (e) {
    console.warn('[DIAG] failed:', e && e.message);
  }
}

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
        await page.waitForTimeout(200);
      }
    } catch (e) { }
  }
}

async function ensureFocusAndType(page, selector, text, opts = { charDelay: 8 }) {
  try { await page.waitForSelector(selector, { timeout: Math.max(1000, PAGE_WAIT_TIMEOUT) }); } catch (e) { }
  try { await page.focus(selector); } catch (e) { try { await page.evaluate(sel => { const el = document.querySelector(sel); if (el) { el.focus(); return true; } return false; }, selector); } catch (e2) { } }
  try { await page.evaluate(sel => { const el = document.querySelector(sel); if (!el) return false; if ('value' in el) el.value = ''; return true; }, selector); } catch (e) { }
  for (const ch of String(text)) { await page.keyboard.type(ch, { delay: opts.charDelay }); }
  await page.waitForTimeout(200);
  try {
    const val = await page.evaluate(sel => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return el.value || el.getAttribute('value') || null;
    }, selector);
    if (val && String(val).length > 0) return true;
    await page.fill(selector, String(text));
    await page.waitForTimeout(200);
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

async function clickMaybe(page, selectors, options = {}) {
  const delay = options.delay === undefined ? 200 : options.delay;
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel);
      if (await loc.count() > 0) {
        await loc.first().scrollIntoViewIfNeeded();
        try { await loc.first().click({ timeout: 3000 }); }
        catch (e) { await loc.first().click({ force: true }); }
        if (delay > 0) {
          await page.waitForTimeout(delay);
        }
        return { ok: true, used: sel };
      }
    } catch (e) { }
  }
  return { ok: false };
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// ========== NUEVO: localizador del input del escáner (Código de barras) ==========
// Se basa en que el input es: <input type="text" name="cbinput" id="cbinput"> dentro de #interfazcb
async function findScannerInput(page) {
  const selectors = [
    '#interfazcb input#cbinput',
    '#interfazcb input[name="cbinput"]',
    'input#cbinput',
    'input[name="cbinput"]'
  ];

  for (const sel of selectors) {
    try {
      const loc = page.locator(sel);
      const count = await loc.count().catch(() => 0);
      if (count > 0) {
        console.log('[SCANNER] Usando selector de input de escaner:', sel);
        return loc.first();
      }
    } catch (e) { }
  }

  // Fallback: cualquier input dentro del modal #interfazcb
  try {
    const cont = page.locator('#interfazcb');
    if (await cont.count().catch(() => 0) > 0) {
      const anyInput = cont.locator('input[type="text"], input[type="search"], input');
      if (await anyInput.count().catch(() => 0) > 0) {
        console.log('[SCANNER] Fallback: usando primer input visible dentro de #interfazcb.');
        return anyInput.first();
      }
    }
  } catch (e) { }

  console.warn('[SCANNER] No se encontró input de escaner (#cbinput) en el modal.');
  return null;
}

// =================== scrapear tabla de resultados ===================
async function scrapeStockTable(page) {
  try {
    const tables = await page.$$('table');
    for (const t of tables) {
      const text = (await t.evaluate(node => node.innerText || '')).toLowerCase();
      if (!/nombre|producto|su precio|precio|stock/i.test(text)) continue;
      const rows = await t.$$('tr');
      if (!rows || rows.length === 0) continue;
      let headerIdx = 0;
      for (let i = 0; i < Math.min(3, rows.length); i++) {
        const inner = (await rows[i].evaluate(r => r.innerText || '')).toLowerCase();
        if (/nombre|producto|precio|pvp|su precio|stock/i.test(inner)) { headerIdx = i; break; }
      }
      const headerCells = await rows[headerIdx].$$('th, td');
      const headers = [];
      for (const hc of headerCells) {
        try { headers.push((await hc.innerText()).trim()); } catch (e) { headers.push(''); }
      }
      function findHeader(regex) {
        for (let i = 0; i < headers.length; i++) {
          if (new RegExp(regex, 'i').test(headers[i])) return i;
        }
        return -1;
      }

      const idxName = findHeader('nombre|producto|descrip');
      let idxPrecio = findHeader('^su precio$');
      if (idxPrecio === -1) idxPrecio = findHeader('precio|pvp');

      let idxPrecioCon = findHeader('su precio con dto|su precio con|precio con dto|con dto|con descuento|precio con');
      let idxStock = findHeader('^stock$|stock disponible|disponible|existencia|stock|stock\\b');
      let idxOferta = findHeader('^oferta$');

      let idxDiscount = findHeader('%\\s*dto|%\\s*descuento|%|dto|descuento|% Dto|% Dto|% Dto S|% Dto S/Pub|% Dto S/Pub');
      if (idxDiscount === -1) {
        idxDiscount = findHeader('pub|púb|público|s/pub|s/púb');
      }

      const results = [];
      for (let r = headerIdx + 1; r < rows.length; r++) {
        try {
          const cells = await rows[r].$$('td, th');
          if (!cells || cells.length === 0) continue;
          const getCellText = async (i) => {
            if (i < 0 || i >= cells.length) return '';
            try {
              const inp = await cells[i].$('input');
              if (inp) {
                const v = (await inp.getAttribute('value')) || (await inp.inputValue().catch(() => null));
                if (v) return String(v).trim();
              }
              const txt = await cells[i].innerText();
              return String(txt || '').trim();
            } catch (e) { return ''; }
          };

          const product = await getCellText(idxName) || await getCellText(0);
          const precio = await getCellText(idxPrecio) || '';
          const precioCon = await getCellText(idxPrecioCon) || '';
          const oferta = await getCellText(idxOferta) || '';

          // ---------- EXTRAER DESCUENTO ----------
          let discountRaw = '';
          let discountPct = null;
          if (idxDiscount >= 0) {
            discountRaw = await getCellText(idxDiscount) || '';
          }
          if (!discountRaw || discountRaw.trim().length === 0) {
            for (let i = 0; i < cells.length && (!discountRaw || discountRaw.trim().length === 0); i++) {
              try {
                const ctxt = (await cells[i].innerText() || '').trim();
                if (!ctxt) continue;
                const mPct = ctxt.match(/-?\d{1,3}(?:[.,]\d{1,3})?\s*%/);
                if (mPct) { discountRaw = mPct[0]; break; }
                const mPub = ctxt.match(/(PUB[^0-9\-]*)?-?\d{1,3}(?:[.,]\d{1,3})?\s*%/i);
                if (mPub) { discountRaw = mPub[0]; break; }
                if (/^\d{1,3}[.,]\d{1,3}$/.test(ctxt) && /%|dto|descuento|pub/i.test(headers.join(' '))) {
                  discountRaw = ctxt + '%';
                  break;
                }
                if (idxDiscount === -1 && /\d+[.,]\d+/.test(ctxt) && headers.some(h => /\%/.test(h))) {
                  discountRaw = ctxt + (/%/.test(ctxt) ? '' : '%');
                  break;
                }
              } catch (e) { }
            }
          }
          if (discountRaw && discountRaw.trim().length > 0) {
            try {
              const m = String(discountRaw).match(/(-?\d{1,3}(?:[.,]\d{1,3})?)/);
              if (m && m[1]) {
                discountPct = m[1].replace(',', '.');
                if (!isNaN(Number(discountPct))) {
                  discountPct = String(Number(discountPct));
                } else {
                  discountPct = null;
                }
              }
            } catch (e) { discountPct = null; }
          }

          // --- ESTRECHA BÚSQUEDA DE STOCK ---
          let stockVal = '';
          if (idxStock >= 0) stockVal = (await getCellText(idxStock)) || '';
          if (!stockVal) {
            for (let i = 0; i < cells.length && !stockVal; i++) {
              try {
                const ctxt = (await cells[i].innerText() || '').trim();
                if (!ctxt) continue;
                if (/\b(sin stock|agotado|agotados|no disponible|no hay stock|0 unidades|0 uds)\b/i.test(ctxt)) { stockVal = 'No'; break; }
                if (/\b(disponible|en stock|stock\b|hay stock|si\b|sí\b|1 unidad|1 uds)\b/i.test(ctxt)) { stockVal = 'Si'; break; }
                const mNum = ctxt.match(/\b([0-9]{1,3})\b/);
                if (mNum && Number(mNum[1]) >= 0) { stockVal = mNum[1]; break; }
                if (/^\s*(Si|Sí|No)\s*$/i.test(ctxt)) { stockVal = ctxt.trim(); break; }
                const imgs = await cells[i].$$('img');
                for (const im of imgs) {
                  try {
                    const alt = (await im.getAttribute('alt')) || '';
                    const t = (await im.getAttribute('title')) || '';
                    const s = `${alt} ${t}`.trim();
                    if (/\b(agotad|sin stock|no stock)\b/i.test(s)) { stockVal = 'No'; break; }
                    if (/\b(disponible|stock|ok|si)\b/i.test(s)) { stockVal = 'Si'; break; }
                  } catch (e) { }
                }
              } catch (e) { }
            }
          }
          if (!stockVal) {
            const rowText = (await rows[r].evaluate(rr => rr.innerText || '') || '').trim();
            const mStock = rowText.match(/stock[:\s]*([^\n\r\t]+)/i);
            if (mStock && mStock[1]) stockVal = mStock[1].trim();
            else {
              const mNo = rowText.match(/\b(No|Sin stock|Agotado|0 uds|0 unidades)\b/i);
              if (mNo) stockVal = mNo[0];
              else {
                const mNum = rowText.match(/\b([0-9]{1,4})\b/);
                if (mNum) stockVal = mNum[0];
              }
            }
          }
          if (!stockVal) {
            try {
              const stockCandidate = await rows[r].$(' [class*="stock"], [class*="disponible"], [data-stock], [aria-label*="stock"]');
              if (stockCandidate) {
                const stxt = (await stockCandidate.evaluate(e => e.innerText || e.getAttribute('title') || e.getAttribute('alt') || '') || '').trim();
                if (stxt) stockVal = stxt;
              }
            } catch (e) { }
          }

          if (!product || product.length === 0) continue;

          results.push({
            product,
            precio: precio.trim(),
            precio_con_desc: (precioCon || '').trim(),
            stock: (stockVal || '').trim(),
            discount_raw: (discountRaw || '').trim(),
            discount_pct: (discountPct !== null ? String(discountPct) : ''),
            oferta: (oferta || '').trim()
          });
        } catch (e) { }
      }
      if (results.length > 0) return results;
    }
  } catch (e) {
    console.warn('[SCRAPE-TABLE] error:', e && e.message);
  }
  return [];
}

// actualizar acumulador global de productos (sin cantidad)
const accumulatedMap = new Map();

function accumulateScrapedResults(results) {
  let firstResult = null;

  for (const r of results) {
    const key = (r.product || '').trim();
    if (!key) continue;

    const priceVal = (r.precio || '').trim();
    const priceWithDiscountVal = (r.precio_con_desc || '').trim();
    const stockVal = (typeof r.stock !== 'undefined' && r.stock !== null) ? String(r.stock).trim() : '';
    const discountRaw = (typeof r.discount_raw !== 'undefined' && r.discount_raw !== null) ? String(r.discount_raw).trim() : '';
    const discountPct = (typeof r.discount_pct !== 'undefined' && r.discount_pct !== null) ? String(r.discount_pct).trim() : '';
    const ofertaVal = (typeof r.oferta !== 'undefined' && r.oferta !== null) ? String(r.oferta).trim() : '';

    if (!firstResult) {
      firstResult = {
        product: key,
        price: priceVal,
        price_with_discount: priceWithDiscountVal,
        stock: stockVal,
        discount_raw: discountRaw,
        discount_pct: discountPct,
        oferta: ofertaVal
      };
    }

    if (accumulatedMap.has(key)) {
      const prev = accumulatedMap.get(key);
      if (priceVal) prev.precio = priceVal;
      if (priceWithDiscountVal) prev.precio_con_desc = priceWithDiscountVal;
      if (stockVal) prev.stock = stockVal;
      if (discountRaw) prev.discount_raw = discountRaw;
      if (discountPct) prev.discount_pct = discountPct;
      if (ofertaVal) prev.oferta = ofertaVal;
    } else {
      accumulatedMap.set(key, {
        product: key,
        precio: priceVal,
        precio_con_desc: priceWithDiscountVal,
        stock: stockVal,
        discount_raw: discountRaw,
        discount_pct: discountPct,
        oferta: ofertaVal
      });
    }
  }

  if (firstResult) {
    const p = String(firstResult.product).replace(/'/g, '’').trim();
    const pr = String(firstResult.price || '').replace(/'/g, '’').trim();
    const prd = String(firstResult.price_with_discount || '').replace(/'/g, '’').trim();
    const s = String(firstResult.stock || '').replace(/'/g, '’').trim();
    const dr = String(firstResult.discount_raw || '').replace(/'/g, '’').trim();
    const dp = String(firstResult.discount_pct || '').replace(/'/g, '’').trim();
    const o = String(firstResult.oferta || '').replace(/'/g, '’').trim();
    console.log(`-> product='${p}' price='${pr}' price_with_discount='${prd}' stock='${s}' discount='${dr}' discount_pct='${dp}' oferta='${o}'`);
  } else {
    console.log(`-> No results found.`);
  }

  console.log('[CSV] Exportación deshabilitada por configuración — no se escribirá archivo suizoEXPORT.csv.');
}

async function clickStockAndRefocusCode(page) {
  try {
    const stockSelectors = [
      'a:has-text("Stock")',
      'text=Stock',
      'nav >> text=Stock',
      'li:has-text("Stock")',
      'button:has-text("Stock")',
      'a[href*="stock"]',
      'a[title*="Stock" i]'
    ];
    await clickMaybe(page, stockSelectors).catch(() => null);

    const buscarCodigoSelectors = [
      'text="Buscar por Código"',
      'legend:has-text("Buscar por Código")',
      'h3:has-text("Buscar por Código")',
      'label:has-text("Buscar por Código")',
      'div:has-text("Buscar por Código")',
      'a:has-text("Buscar por Código")',
      'button:has-text("Buscar por Código")'
    ];
    await clickMaybe(page, buscarCodigoSelectors).catch(() => null);

    for (const s of CODE_INPUT_CANDIDATES) {
      try {
        const loc = page.locator(s);
        if (await loc.count() > 0) {
          const first = loc.first();
          try { await first.scrollIntoViewIfNeeded(); } catch (e) { }
          try { await first.click({ force: true }); } catch (e) { }
          try { await first.focus(); } catch (e) { }
          try {
            if (await first.isVisible() && !(await first.isDisabled().catch(() => false))) {
              await page.waitForTimeout(200);
              return first;
            }
          } catch (e) { }
        }
      } catch (e) { }
    }

    const inputs = await page.$$('input');
    for (const inp of inputs) {
      try {
        const visible = await inp.isVisible().catch(() => false);
        const disabled = await inp.isDisabled().catch(() => false);
        if (!visible || disabled) continue;
        const attrs = (await inp.getAttribute('placeholder') || '') + ' ' + (await inp.getAttribute('name') || '') + ' ' + (await inp.getAttribute('id') || '') + ' ' + (await inp.getAttribute('aria-label') || '');
        if (/cod|codigo|buscar/i.test(attrs)) {
          try { await inp.scrollIntoViewIfNeeded(); } catch (e) { }
          try { await inp.click({ force: true }); } catch (e) { }
          try { await inp.focus(); } catch (e) { }
          await page.waitForTimeout(150);
          return inp;
        }
      } catch (e) { }
    }

    for (const inp of inputs) {
      try {
        if (await inp.isVisible().catch(() => false) && !(await inp.isDisabled().catch(() => false))) {
          try { await inp.scrollIntoViewIfNeeded(); } catch (e) { }
          try { await inp.click({ force: true }); } catch (e) { }
          try { await inp.focus(); } catch (e) { }
          await page.waitForTimeout(150);
          return inp;
        }
      } catch (e) { }
    }

  } catch (e) { }
  return null;
}

// ------------------ MAIN: login + Stock + "Buscar con escaner" + loop manual =================
(async () => {
  console.log('=== 01-login-y-interaccion-mejorado-suizo (modo MANUAL only) - CSV export disabled ===');
  console.log('USER:', SUIZO_USER);
  console.log('HEADLESS:', PLAYWRIGHT_HEADLESS ? 'true' : 'false');
  console.log('KEEP_BROWSER_OPEN:', KEEP_BROWSER_OPEN ? '1' : '0');
  console.log(`[DELAY CONFIG] POST_SEARCH_DELAY_MS=${POST_SEARCH_DELAY_MS} SEARCH_DELAY_MIN_MS=${SEARCH_DELAY_MIN_MS} SEARCH_DELAY_MAX_MS=${SEARCH_DELAY_MAX_MS}`);

  accumulatedMap.clear();

  let browser = null;
  let context = null;
  let page = null;
  let chosenExe = null;
  let searchInputLocator = null;

  for (const p of candidateChromePaths()) {
    try { if (p && fs.existsSync(p)) { chosenExe = p; break; } } catch (e) { }
  }

  try {
    const args = ['--no-first-run', '--no-default-browser-check'];
    if (chosenExe) {
      browser = await chromium.launch({ headless: PLAYWRIGHT_HEADLESS, executablePath: chosenExe, args });
    } else {
      browser = await chromium.launch({ headless: PLAYWRIGHT_HEADLESS, args });
    }
  } catch (e) {
    console.error('[LAUNCH] fallo al lanzar navegador:', e && (e.stack || e.message || e));
    process.exit(2);
  }

  try {
    context = await browser.newContext();
    page = await context.newPage();

    console.log('[FLOW] navegando a login:', LOGIN_URL);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(err => { console.warn('[NAV] goto fallo:', err && err.message); });
    await saveDiagnostic(page, 'login_page');

    try { await tryCloseCookieBanners(page); } catch (e) { }

    const userCandidates = [
      'input[aria-label="Usuario"]',
      'input[aria-label*="usuario" i]',
      'input[name*="user" i]',
      'input[id*="user" i]',
      'input[placeholder*="Usuario" i]',
      'input[placeholder*="usuario" i]',
      'input[type="text"]'
    ];

    const passCandidates = [
      'input[aria-label*="contrase" i]',
      'input[placeholder*="contrase" i]',
      'input[type="password"]',
      'input[name*="pass" i]',
      'input[id*="pass" i]'
    ];

    let userOk = false;
    for (const sel of userCandidates) {
      try {
        const loc = page.locator(sel);
        if (await loc.count() > 0) {
          await loc.first().scrollIntoViewIfNeeded();
          await loc.first().click({ force: true }).catch(() => { });
          userOk = await ensureFocusAndType(page, sel, SUIZO_USER, { charDelay: 8 });
          if (userOk) { console.log('[LOGIN] usuario seteado con selector:', sel); break; }
        }
      } catch (e) { }
    }
    if (!userOk) console.warn('[LOGIN] no se detectó input de usuario o no se pudo setear.');

    let passOk = false;
    for (const sel of passCandidates) {
      try {
        const loc = page.locator(sel);
        if (await loc.count() > 0) {
          await loc.first().scrollIntoViewIfNeeded();
          await loc.first().click({ force: true }).catch(() => { });
          passOk = await ensureFocusAndType(page, sel, SUIZO_PASS, { charDelay: 8 });
          if (passOk) { console.log('[LOGIN] password seteado con selector:', sel); break; }
        }
      } catch (e) { }
    }
    if (!passOk) console.warn('[LOGIN] no se detectó input de password o no se pudo setear.');

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
        const loc = page.locator(sel);
        if (await loc.count() > 0) {
          await loc.first().scrollIntoViewIfNeeded();
          try { await loc.first().click({ force: true, timeout: 3000 }); } catch (e) { await loc.first().click({ force: true }); }
          submitted = true;
          console.log('[LOGIN] submit click con selector:', sel);
          break;
        }
      } catch (e) { }
    }
    if (!submitted) {
      try {
        const pw = page.locator('input[type="password"]');
        if (await pw.count() > 0) { await pw.first().press('Enter'); submitted = true; console.log('[LOGIN] submit via Enter en password'); }
        else { await page.keyboard.press('Enter'); submitted = true; console.log('[LOGIN] submit via Enter global'); }
      } catch (e) { console.warn('[LOGIN] intento de submit por Enter falló'); }
    }

    try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch (e) { }

    await page.waitForTimeout(200);
    await saveDiagnostic(page, 'after_submit');

    // Cerrar modal de Super Ofertas si aparece
    try {
      console.log('[FLOW] Verificando si hay anuncio/modal publicitario (Super Ofertas) post-login...');
      const closeModalSelector = 'a#cerrar-modal-1';
      const modalCloseBtn = page.locator(closeModalSelector).first();

      if (await modalCloseBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
        console.log('[FLOW] Detectado modal publicitario. Cerrando...');
        await modalCloseBtn.click({ force: true });
        await page.waitForTimeout(1000);
      } else {
        console.log('[FLOW] No se detectó modal publicitario (o no es visible).');
      }
    } catch (e) {
      console.warn('[FLOW] Error intentando cerrar modal:', e.message);
    }

    // Ir a Stock y abrir modal de escáner
    try {
      console.log('[FLOW] intentando localizar y clickear "Stock" (modo rápido)...');
      const stockSelectors = [
        'a:has-text("Stock")',
        'text=Stock',
        'nav >> text=Stock',
        'li:has-text("Stock")',
        'button:has-text("Stock")',
        'a[href*="stock"]',
        'a[title*="Stock" i]'
      ];
      const res = await clickMaybe(page, stockSelectors, { delay: POST_LOGIN_NAV_DELAY_MS });
      if (res.ok) {
        console.log(`[FLOW] click en "Stock" realizado (selector usado: ${res.used}).`);
        await saveDiagnostic(page, 'after_click_stock');

        try {
          console.log('[FLOW] Intentando localizar y clickear "Buscar con escaner"...');
          const escanerSelectors = [
            'a#buscarCB',
            'a:has-text("Buscar con escaner")',
            'a.btnAmarillo:has-text("escaner")'
          ];
          const resEscaner = await clickMaybe(page, escanerSelectors, { delay: 1500 });

          if (resEscaner.ok) {
            console.log(`[FLOW] Click en "Buscar con escaner" realizado (selector: ${resEscaner.used}).`);
            await saveDiagnostic(page, 'after_click_escaner');

            console.log('[FLOW] Buscando input de código de barras (#cbinput) en el modal...');
            searchInputLocator = await findScannerInput(page);
            if (searchInputLocator) {
              try { await searchInputLocator.click({ force: true }).catch(() => { }); } catch (e) { }
              try { await searchInputLocator.focus().catch(() => { }); } catch (e) { }
              console.log('[FLOW] Input de escaner localizado y enfocado (cbinput).');
            } else {
              console.warn('[FLOW] No se pudo localizar el input de escaner después de abrir el modal.');
            }

          } else {
            console.warn('[FLOW] No se pudo encontrar/clickear "Buscar con escaner" en el flujo inicial.');
          }
        } catch (e) {
          console.warn('[FLOW] Error al intentar clickear "Buscar con escaner":', e && e.message);
        }

      } else {
        console.warn('[FLOW] no se encontró/ pudo cliquear "Stock" con los selectores intentados.');
        await saveDiagnostic(page, 'stock_not_found');
      }
    } catch (e) {
      console.warn('[FLOW] error intentando click en Stock:', e && (e.message || e));
    }

    try {
      await context.storageState({ path: STATE_FILE });
      console.log(`[STATE] storageState guardado en: ${STATE_FILE}`);
    } catch (e) {
      console.warn('[STATE] no se pudo guardar storageState:', e && e.message);
    }

    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });

    function questionAsync(q, defaultVal) {
      return new Promise(resolve => {
        rl.question(q, answer => {
          if ((typeof answer === 'string' && answer.trim().length === 0) && typeof defaultVal !== 'undefined') resolve(defaultVal);
          else resolve(answer);
        });
      });
    }

    console.log('Arrancando modo manual de búsquedas. Escribí cada búsqueda y presioná Enter. Escribí "exit" para salir.');
    rl.setPrompt('Buscar (Escaner)> ');
    rl.prompt();

    // ========== Localizador en tiempo de búsqueda (siempre prioriza cbinput) ==========
    async function locateSearchInputAtSearchTime() {
      try {
        if (searchInputLocator) {
          const count = await searchInputLocator.count().catch(() => 0);
          if (count > 0) {
            try { await searchInputLocator.click({ force: true }).catch(() => { }); } catch (e) { }
            try { await searchInputLocator.focus().catch(() => { }); } catch (e) { }
            return searchInputLocator;
          }
          searchInputLocator = null;
        }
      } catch (e) {
        console.warn('[LOCATE] Fallo al validar searchInputLocator previo:', e.message);
        searchInputLocator = null;
      }

      console.log('[LOCATE] Input no válido o perdido. Reintentando localizar (modal escaner / cbinput)...');

      // 1) Intentar localizar directamente el input cbinput
      let loc = await findScannerInput(page);
      if (loc) {
        searchInputLocator = loc;
        try { await searchInputLocator.click({ force: true }).catch(() => { }); } catch (e) { }
        try { await searchInputLocator.focus().catch(() => { }); } catch (e) { }
        return searchInputLocator;
      }

      // 2) Re-clickear "Buscar con escaner" y volver a intentar
      try {
        console.log('[LOCATE] No se encontró cbinput, intentando re-clickear "Buscar con escaner"...');
        const escanerSelectors = [
          'a#buscarCB',
          'a:has-text("Buscar con escaner")',
          'a.btnAmarillo:has-text("escaner")'
        ];
        const resEscaner = await clickMaybe(page, escanerSelectors, { delay: 1500 });

        if (resEscaner.ok) {
          console.log('[LOCATE] Click en "Buscar con escaner" realizado (reintento).');
          await page.waitForTimeout(1000);
          loc = await findScannerInput(page);
          if (loc) {
            searchInputLocator = loc;
            try { await searchInputLocator.click({ force: true }).catch(() => { }); } catch (e) { }
            try { await searchInputLocator.focus().catch(() => { }); } catch (e) { }
            return searchInputLocator;
          }
        }
      } catch (e) {
        console.warn('[LOCATE] Error intentando localizar input de escaner tras re-click:', e.message);
      }

      console.warn('[LOCATE] Fallback: No se pudo encontrar input cbinput. Buscando input original de stock...');

      // 3) Fallback al código original (buscar input principal)
      try {
        const locFallback = await clickStockAndRefocusCode(page);
        if (locFallback) {
          console.log('[LOCATE] Fallback: Encontrado input principal vía clickStockAndRefocusCode.');
          searchInputLocator = locFallback;
          return locFallback;
        }
      } catch (e) { }

      try {
        const prefer = ['input[type="search"]', 'input[placeholder*="codigo" i]', 'input[name*="codigo" i]', 'input[id*="codigo" i]', 'input[type="text"]'];
        for (const s of prefer) {
          try {
            const loc2 = page.locator(s).first();
            if (await loc2.count() > 0 && await loc2.isVisible().catch(() => false) && !(await loc2.isDisabled().catch(() => false))) {
              searchInputLocator = loc2;
              try { await loc2.click({ force: true }).catch(() => { }); } catch (e) { }
              try { await loc2.focus().catch(() => { }); } catch (e) { }
              console.log('[LOCATE] Fallback: Encontrado input principal por selector:', s);
              return loc2;
            }
          } catch (e) { }
        }

        const inputs = await page.$$('input');
        for (const inp of inputs) {
          try {
            if (await inp.isVisible().catch(() => false) && !(await inp.isDisabled().catch(() => false))) {
              searchInputLocator = inp;
              try { await inp.click({ force: true }).catch(() => { }); } catch (e) { }
              try { await inp.focus().catch(() => { }); } catch (e) { }
              console.log('[LOCATE] Fallback: Encontrado primer input visible.');
              return inp;
            }
          } catch (e) { }
        }

      } catch (e) { }

      console.error('[LOCATE] Fallback: No se encontró NINGÚN input de búsqueda.');
      return null;
    }

    async function doSearchAndWait(query) {
      try {
        const inputLocator = await locateSearchInputAtSearchTime();
        if (!inputLocator) {
          console.error(`[SEARCH] No se detectó ningún input para realizar la búsqueda. Se skipea: "${query}"`);
          return false;
        }
        try { await inputLocator.fill(''); } catch (e) { }
        try { await inputLocator.type(String(query), { delay: 8 }); } catch (e) {
          await page.evaluate((q, el) => { el.value = q; el.dispatchEvent(new Event('input', { bubbles: true })); }, query, await inputLocator.elementHandle());
        }
        try {
          await inputLocator.press('Enter');
        } catch (e) {
          await page.keyboard.press('Enter').catch(() => { });
        }

        console.log(`[DELAY] Esperando base ${POST_SEARCH_DELAY_MS}ms para que carguen los resultados...`);
        await page.waitForTimeout(POST_SEARCH_DELAY_MS);

        const randomExtra = (SEARCH_DELAY_MAX_MS === SEARCH_DELAY_MIN_MS)
          ? SEARCH_DELAY_MIN_MS
          : Math.floor(Math.random() * (SEARCH_DELAY_MAX_MS - SEARCH_DELAY_MIN_MS + 1)) + SEARCH_DELAY_MIN_MS;
        const effectiveExtra = Math.max(0, randomExtra - POST_SEARCH_DELAY_MS);
        if (effectiveExtra > 0) {
          console.log(`[DELAY] Esperando adicional aleatorio de ${effectiveExtra}ms (total objetivo ${randomExtra}ms) antes de raspar resultados...`);
          await page.waitForTimeout(effectiveExtra);
        } else {
          console.log(`[DELAY] No se requiere espera adicional (objetivo ${randomExtra}ms, base ${POST_SEARCH_DELAY_MS}ms).`);
        }

        await saveDiagnostic(page, `after_manual_search_${String(query).replace(/\s+/g, '_').slice(0, 30)}`);
        return true;
      } catch (e) {
        console.warn(`[SEARCH] Fallo durante la búsqueda para "${query}".`, e && e.message);
        return false;
      }
    }

    rl.on('line', async (line) => {
      const query = String(line || '').trim();
      if (query.toLowerCase() === 'exit') {
        console.log('Comando "exit" recibido — guardando estado y cerrando el programa...');
        try { await context.storageState({ path: STATE_FILE }); } catch (e) { }
        if (!KEEP_BROWSER_OPEN) {
          try { await browser.close(); } catch (e) { }
          process.exit(0);
        } else {
          console.log('[EXIT] KEEP_BROWSER_OPEN=1 -> el navegador queda abierto. Cierra manualmente cuando quieras.');
          rl.close();
          return;
        }
      }
      if (query === '') { console.log('Línea vacía — intenta de nuevo.'); rl.prompt(); return; }
      try {
        const performed = await doSearchAndWait(query);
        if (performed) {
          const scraped = await scrapeStockTable(page);
          accumulateScrapedResults(scraped);
          console.log('--- FIN BUSQUEDA ---');
        } else {
          console.log('[SEARCH] búsqueda no ejecutada (no se encontró input).');
        }

        // NOTA: Ya NO reabrimos el modal aquí.
        // Para la próxima búsqueda, locateSearchInputAtSearchTime()
        // volverá a clickear y enfocar cbinput reutilizando searchInputLocator.

      } catch (err) {
        console.error('[INTERACT] error en búsqueda manual:', err && (err.message || err));
        await saveDiagnostic(page, `error_manual_${nowStamp()}`);
      } finally {
        rl.prompt();
      }
    });

    rl.on('close', () => { console.log('Prompt cerrado. La ventana del navegador permanece abierta.'); });

    process.on('SIGINT', async () => {
      console.log('\nSIGINT recibido — cerrando correctamente (guardando estado).');
      try { await context.storageState({ path: STATE_FILE }); } catch (e) { }
      if (!KEEP_BROWSER_OPEN) {
        try { await browser.close(); } catch (e) { }
        process.exit(0);
      } else {
        console.log('[EXIT] KEEP_BROWSER_OPEN=1 -> el navegador queda abierto. Cierra manualmente cuando quieras.');
      }
    });

  } catch (err) {
    console.error('[ERROR] flujo principal:', err && (err.stack || err.message || err));
    try { if (context) await context.storageState({ path: STATE_FILE }); } catch (e) { }
    try { if (browser && !KEEP_BROWSER_OPEN) await browser.close(); } catch (e) { }
    process.exit(1);
  }
})();
