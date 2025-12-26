#!/usr/bin/env node
// 01-login-y-interaccion-mejorado_delsud_manual_print.js
// Versión modificada: Modo manual-only. NO genera archivos de salida.
// Imprime en terminal (console.table) los resultados de CADA búsqueda (no acumulativo).
// Diagnósticos (DIAG=1) siguen activos si los necesitás.
// **** MODIFICADO: Emite resultados usando `@@@PILLIGENCE_TABLE@@@` + JSON ****

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const child_process = require('child_process');

/// =========== Config / envs ===========
const EMAIL = process.env.DELSUD_USER;
const PASS = process.env.DELSUD_PASS;
const STATE_FILE = process.env.STATE_FILE || path.resolve(__dirname, 'state-delsud.json');
const CHROME_PATH = process.env.CHROME_PATH || process.env.CHROME_EXE || null;
const REMOTE_DEBUG_PORT = process.env.REMOTE_DEBUG_PORT || '';
const PLAYWRIGHT_HEADLESS = (process.env.PLAYWRIGHT_HEADLESS === '1' || process.env.PLAYWRIGHT_HEADLESS === 'true') ? true : false;
const ENABLE_DIAG = (process.env.DIAG === '1');
const DIAG_DIR = path.resolve(__dirname, 'diagnostics');

const MAX_PAGES = parseInt(process.env.MAX_PAGES || '5', 10);

const LOGIN_URL = 'https://pedidos.delsud.com.ar/login';
const SEARCH_INPUT_SELECTOR = '#topnav-searchbox';
const SEARCH_INPUT_PLACEHOLDER_PART = 'Ingres';

// timing params
// MODIFICADO: Reducción de tiempos para que la escritura sea más rápida
// **** GEMINI: Modificado para ser aún más rápido (0-1ms) ****
const CHAR_DELAY_MIN = parseInt(process.env.CHAR_DELAY_MIN || '0', 10);
const CHAR_DELAY_MAX = parseInt(process.env.CHAR_DELAY_MAX || '1', 10);
const BACKSPACE_DELAY_MIN = parseInt(process.env.BACKSPACE_DELAY_MIN || '0', 10);
const BACKSPACE_DELAY_MAX = parseInt(process.env.BACKSPACE_DELAY_MAX || '1', 10);
const POST_SEARCH_WAIT_MS = parseInt(process.env.POST_SEARCH_WAIT_MS || '250', 10);
const PAGE_WAIT_TIMEOUT = parseInt(process.env.PAGE_WAIT_TIMEOUT || '6500', 10);
const MAX_BACKSPACES = parseInt(process.env.MAX_BACKSPACES || '300', 10);

// tiempo para mostrar la primera página al inicio (en ms). configurable via env VIEW_FIRST_PAGE_MS
const VIEW_FIRST_PAGE_MS = parseInt(process.env.VIEW_FIRST_PAGE_MS || '3000', 10);

const PRODUCT_ITEM_SELECTOR = '.product-item, .product, .product-card, .search-result-item';
const PRODUCT_NAME_SELECTORS = ['.product-name', '.name', '.title', 'h2', '.product-title'];
const PRODUCT_PRICE_SELECTORS = ['.product-price', '.price', '.product__price', '.price-tag'];
const PRODUCT_STOCK_SELECTORS = ['.stock', '.availability', '.availability-text', '.product-availability'];
const PRODUCT_SKU_SELECTORS = ['.sku', '.product-sku', '[data-sku]'];
const PAGINATION_NEXT_SELECTORS = ['a.next', 'button[aria-label*="Siguiente"]', 'a[rel="next"]', 'a:has-text("Siguiente")', 'button:has-text("Siguiente")'];

/// =========== util ===========
function nowStamp() { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function rndMs(min = CHAR_DELAY_MIN, max = CHAR_DELAY_MAX) { return Math.floor(min + Math.random() * (max - min)); }
function rndMsBack(min = BACKSPACE_DELAY_MIN, max = BACKSPACE_DELAY_MAX) { return Math.floor(min + Math.random() * (max - min)); }
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
// Helpers de scraping / parsing
// ================================================================
function extractCurrencyAll(text) {
  if (!text) return [];
  const re = /[\$\€]\s?[\d\.\,]+|(?:\d{1,3}(?:[\.\,]\d{3})+|\d+)(?:[\.\,]\d+)?/g;
  const m = String(text).match(re);
  if (!m) return [];
  return m.map(x => x.trim());
}
function extractCurrency(text) {
  const all = extractCurrencyAll(text);
  return all.length > 0 ? all[0] : null;
}
function extractPercent(text) {
  if (!text) return null;
  const m = text.match(/\d{1,3}[\,\.]?\d{0,2}\s*%/);
  if (m) return m[0].replace(/\s+/g, '').replace('.', ',');
  return null;
}
function extractEan(text) {
  if (!text) return null;
  const m = text.match(/\b\d{8,14}\b/);
  return m ? m[0] : null;
}
function looksLikeLab(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 2) return false;
  const lettersOnly = t.replace(/[^A-ZÑÁÉÍÓÚÜ ]/g, '');
  const uppercaseRatio = (lettersOnly.length) / Math.max(1, t.replace(/\s+/g, '').length);
  if (uppercaseRatio > 0.5 && t.split(' ').length <= 5 && /[A-Z]/.test(t)) return true;
  return false;
}
function parseCurrencyToNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  const m = s.match(/[-\d\.\,]+/);
  if (!m) return null;
  let num = m[0].trim();
  if (num.indexOf('.') !== -1 && num.indexOf(',') !== -1) {
    // If both '.' and ',' are present, assume '.' is thousand separator and ',' is decimal
    num = num.replace(/\./g, '').replace(/,/g, '.');
  } else if (num.indexOf(',') !== -1 && num.indexOf('.') === -1) {
    // If only ',' is present, assume it's the decimal separator
    num = num.replace(/,/g, '.');
  }
  // Remove any remaining non-digit characters except for '.' and '-'
  num = num.replace(/[^\d\.\-]/g, '');
  const f = parseFloat(num);
  if (Number.isNaN(f)) return null;
  return f;
}

async function pickFirstText(el, selectors) {
  for (const s of selectors) {
    try {
      const cnt = await el.locator(s).count();
      if (cnt > 0) {
        const txt = await el.locator(s).first().innerText().catch(() => null);
        if (txt) return safeTrim(txt);
      }
    } catch (e) { }
  }
  try {
    const txt = await el.innerText().catch(() => null);
    if (txt) return safeTrim(txt.split('\n')[0] || txt);
  } catch (e) { }
  return null;
}

async function clickMaybe(page, selectors) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel);
      if (await loc.count() > 0) {
        await loc.first().scrollIntoViewIfNeeded();
        try { await loc.first().click({ timeout: 3000 }); }
        catch (e) { await loc.first().click({ force: true }); }
        return { ok: true, used: sel };
      }
    } catch (e) { }
  }
  return { ok: false };
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
        await page.waitForTimeout(80);
      }
    } catch (e) { }
  }
}

async function ensureFocusAndType(page, selector, text, opts = { charDelay: CHAR_DELAY_MIN }) {
  try { await page.waitForSelector(selector, { timeout: Math.max(1000, PAGE_WAIT_TIMEOUT) }); } catch (e) { }
  try { await page.focus(selector); } catch (e) { try { await page.evaluate(sel => { const el = document.querySelector(sel); if (el) { el.focus(); return true; } return false; }, selector); } catch (e2) { } }
  try { await page.evaluate(sel => { const el = document.querySelector(sel); if (!el) return false; if ('value' in el) el.value = ''; return true; }, selector); } catch (e) { }
  // MODIFICADO: Uso de opts.charDelay para asegurar la velocidad
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

async function clearInputByBackspace(page, selector) {
  try {
    await page.waitForSelector(selector, { timeout: Math.max(500, PAGE_WAIT_TIMEOUT) }).catch(() => null);
    try { await page.focus(selector); } catch (e) { }
    const len = await page.evaluate(sel => {
      const el = document.querySelector(sel);
      if (!el) return 0;
      if ('value' in el) return (el.value || '').length;
      if (el.isContentEditable) return (el.innerText || '').length;
      return 0;
    }, selector).catch(() => 0);
    if (!len || len <= 0) return true;
    const toPress = Math.min(len, MAX_BACKSPACES);
    // MODIFICADO: Uso de rndMsBack() para el retardo de borrado, que ahora es más rápido
    for (let i = 0; i < toPress; i++) {
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(rndMsBack());
    }
    if (len > MAX_BACKSPACES) {
      try {
        const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.down(mod);
        await page.keyboard.press('a');
        await page.keyboard.up(mod);
        await page.keyboard.press('Backspace');
      } catch (e) { }
    }
    const remaining = await page.evaluate(sel => {
      const el = document.querySelector(sel);
      if (!el) return '';
      if ('value' in el) return el.value || '';
      if (el.isContentEditable) return el.innerText || '';
      return '';
    }, selector).catch(() => '');
    if (remaining && remaining.length > 0) { try { await page.fill(selector, ''); } catch (e) { } }
    return true;
  } catch (err) {
    console.warn('[clearInputByBackspace] fallo:', err && err.message);
    try { await page.fill(selector, ''); } catch (e) { }
    return false;
  }
}

// ================================================================
// Determinar disponibilidad (si/no) a partir del elemento / texto
// ================================================================
async function detectAvailabilityFromElementHandle(handle) {
  try {
    const info = await handle.evaluate(node => {
      const txt = (node.innerText || '').trim();
      const cls = (node.className || '').toString();
      const style = window.getComputedStyle(node);
      const bg = style.backgroundColor || '';
      const color = style.color || '';
      return { txt, cls, bg, color };
    });
    const txt = (info.txt || '').trim();
    const textLower = txt.toLowerCase();

    // Si el texto es una "D" (la D dentro del circulito verde en DelSud), consideramos disponible
    if (txt === 'D' || txt === 'd') return 'si';

    // Text checks
    if (/sin stock|agotad|agotado|no disponible|no hay|no stock|no hay stock/i.test(txt)) return 'no';
    if (/disponible|stock|si |sí |en stock|hay/i.test(txt)) return 'si';

    // class-based heuristics
    if (/green|verde|success|available|disponible/i.test(info.cls || '')) return 'si';
    if (/red|rojo|danger|unavailable|no-disponible/i.test(info.cls || '')) return 'no';

    // revisar color/bg: si el componente usa background-color: rgb(...), evaluar componente G dominante
    const pickColor = info.bg || info.color || '';
    const m = pickColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) {
      const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
      if (g > r + 20 && g > b + 20) return 'si';
      if (r > g + 20 && r > b + 20) return 'no';
    }

    // fallback por texto corto
    if (textLower && textLower.length > 0) {
      if (/no|sin|agotad/i.test(textLower)) return 'no';
      if (/si|sí|disponibl|ok|hay|verde|d\b/i.test(textLower)) return 'si';
    }
  } catch (e) { }
  return 'no'; // default a no si no sabemos
}

// ================================================================
// SCRAPING: detecta tablas o cards y extrae registros, incluyendo precio_c_desc, availability y min_offer
// ================================================================
async function scrapeProductsFromPage(page, query) {
  const products = [];
  const seen = new Set();

  try {
    try { await page.waitForSelector('[role="row"], table, .row, ' + PRODUCT_ITEM_SELECTOR, { timeout: PAGE_WAIT_TIMEOUT }); } catch (e) { }

    let rows = await page.$$('[role="row"]');
    if (!rows || rows.length === 0) {
      rows = await page.$$('table tr');
    }

    if (!rows || rows.length === 0) {
      // fallback cards
      const nodes = page.locator(PRODUCT_ITEM_SELECTOR);
      const count = await nodes.count();
      if (count > 0) {
        for (let i = 0; i < count; i++) {
          try {
            const el = nodes.nth(i);
            const name = await pickFirstText(el, PRODUCT_NAME_SELECTORS) || '';
            const price = await pickFirstText(el, PRODUCT_PRICE_SELECTORS) || '';
            const stock = await pickFirstText(el, PRODUCT_STOCK_SELECTORS) || '';
            let sku = '';
            for (const s of PRODUCT_SKU_SELECTORS) {
              try {
                if (await el.locator(s).count() > 0) {
                  sku = await el.locator(s).first().innerText().catch(() => '') || '';
                  if (sku) break;
                }
              } catch (e) { }
            }
            try { const ds = await el.getAttribute('data-sku').catch(() => null); if (ds) sku = sku || ds; } catch (e) { }
            const href = await el.locator('a').first().getAttribute('href').catch(() => null);
            const url = href ? new URL(href, await page.url()).toString() : '';

            // precio c/ desc heurístico: si hay dos monedas en price pick second
            const priceMatches = extractCurrencyAll(price);
            let precio_c_desc = '';
            if (priceMatches.length >= 2) precio_c_desc = priceMatches[1];
            else precio_c_desc = priceMatches[0] || '';

            // availability from stock text
            let availability = 'no';
            if (stock && stock.length > 0) {
              availability = (/sin stock|agotad|no disponible|no hay/i.test(stock)) ? 'no' : 'si';
            }

            // Heurística para min_offer en cards: buscar un número corto en el texto del card
            let min_offer = '';
            const cardText = (await el.innerText().catch(() => '')) || '';
            const shortNum = cardText.match(/\b(\d{1,3})\b/);
            // Ensure the short number isn't just part of the price or SKU
            const numericPrice = parseCurrencyToNumber(price);
            const numericPriceCDesc = parseCurrencyToNumber(precio_c_desc);
            if (shortNum && shortNum[1] && Number(shortNum[1]) > 0 && Number(shortNum[1]) <= 999) {
              const potentialMin = Number(shortNum[1]);
              if (numericPrice !== potentialMin && numericPriceCDesc !== potentialMin && sku !== shortNum[1]) {
                min_offer = shortNum[1];
              }
            }


            const rec = {
              timestamp: new Date().toISOString(),
              query,
              // **** RENOMBRADO: description -> producto ****
              producto: safeTrim(name),
              pvp: safeTrim(price),
              precio_c_desc: safeTrim(precio_c_desc),
              stock: safeTrim(stock), // **** RENOMBRADO: stockText -> stock ****
              availability, // **** MANTENIDO: 'si'/'no' ****
              sku: safeTrim(sku),
              url,
              // unit_price: ya no se usa directamente
              min: min_offer || '', // **** RENOMBRADO: min_offer -> min ****
            };
            const key = (rec.sku || rec.url || (rec.producto + '|' + rec.pvp)).trim(); // **** USAR rec.producto ****
            if (!key) continue;
            if (seen.has(key)) continue;
            // filter out rows that are summary text
            if (/mostrando|resultado|resultados|no hay productos|sin resultados/i.test(rec.producto.toLowerCase())) continue; // **** USAR rec.producto ****
            seen.add(key);
            products.push(rec);
          } catch (e) { }
        }
      }
      if (products.length === 0) await saveDiagnostic(page, `scrape-empty-${String(query).replace(/\s+/g, '_').slice(0, 30)}`);
      return products;
    }

    // row header detection
    let headerIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      const t = (await rows[i].innerText().catch(() => '')) || '';
      if (/pvp|precio|precio c|precio_c|precio con desc|precio c\/desc|descripcion|descrip|producto|nombre|cant|cantidad|stock|min|min\.|min Oferta|min oferta|min offer/i.test(t)) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx === -1) {
      const firstTxt = (await rows[0].innerText().catch(() => '')) || '';
      if (/pvp|precio|descripcion|producto|nombre/i.test(firstTxt)) headerIdx = 0;
      else headerIdx = -1;
    }

    let headerMap = {};
    if (headerIdx >= 0 && rows[headerIdx]) {
      const headerRow = rows[headerIdx];
      const headerCells = await headerRow.$$('[role="columnheader"], [role="cell"], th, td');
      if (headerCells.length === 0) {
        const raw = (await headerRow.innerText().catch(() => '')) || '';
        const parts = raw.split(/\t| {2,}|,/).map(p => safeTrim(p)).filter(Boolean);
        parts.forEach((p, idx) => { headerMap[p.toLowerCase()] = idx; });
      } else {
        for (let i = 0; i < headerCells.length; i++) {
          try {
            const txt = safeTrim((await headerCells[i].innerText().catch(() => '')) || '').toLowerCase();
            if (txt) headerMap[txt] = i;
          } catch (e) { }
        }
      }
    }

    function findHeaderIndexByRegex(regexList) {
      for (const key of Object.keys(headerMap)) {
        for (const rx of regexList) {
          if ((new RegExp(rx, 'i')).test(key)) return headerMap[key];
        }
      }
      return -1;
    }

    const pvpIdxCandidates = ['pvp', 'precio', 'precio c', 'precio_c', 'p\\.v\\.p', 'p\\/v', 'valor', 'price'];
    const descIdxCandidates = ['descrip', 'producto', 'nombre', 'detalle', 'descripcion', 'denominacion'];
    const qtyIdxCandidates = ['cant', 'cantidad', 'unidades', 'qty', 'cantidad solicitada'];
    const precioCDescCandidates = ['c\\/desc', 'c desc', 'precio c\\/desc', 'precio c desc', 'precio con desc', 'precio cdesc', 'precio c\\.desc', 'precio c con', 'precio c/desc'];
    const minOfferCandidates = ['\\bmin\\b', 'min\\.?\\s*of', 'min\\.?\\s*ofer', 'min\\.?\\s*oferta', 'min\\.?\\s*offer', 'min\\.?\\s*ofr']; // regex-ish patterns

    const pvpIndexFromHeader = findHeaderIndexByRegex(pvpIdxCandidates);
    const descIndexFromHeader = findHeaderIndexByRegex(descIdxCandidates);
    const qtyIndexFromHeader = findHeaderIndexByRegex(qtyIdxCandidates); // Not used for output, kept for potential future use
    const precioCDescIndex = findHeaderIndexByRegex(precioCDescCandidates);
    const minIndexFromHeader = findHeaderIndexByRegex(minOfferCandidates);

    const startRow = (headerIdx >= 0) ? headerIdx + 1 : 0;

    for (let i = startRow; i < rows.length; i++) {
      try {
        const r = rows[i];
        const rowText = (await r.innerText().catch(() => '')) || '';
        // ignore very header-like lines
        if (/DESCRIP|DESCRIPCIÓN|RESULTADOS|DESCRIPCION|LABORATORIO/i.test(rowText) && i !== startRow) {
          continue;
        }

        const cellEls = await r.$$('[role="cell"], td, th');
        let cellTexts = [];
        if (cellEls && cellEls.length > 0) {
          for (const ce of cellEls) {
            try {
              const raw = (await ce.innerText().catch(() => '')) || '';
              cellTexts.push(raw.replace(/\s+/g, ' ').trim());
            } catch (e) {
              cellTexts.push('');
            }
          }
        } else {
          cellTexts = rowText.split(/\t| {2,}|,/).map(s => safeTrim(s)).filter(Boolean);
        }
        if (!cellTexts || cellTexts.length === 0) continue;

        // sku heuristics (kept internal, not directly outputted unless needed)
        let sku = '';
        try {
          if (cellEls && cellEls.length > 0) {
            const att = await cellEls[0].getAttribute('data-sku').catch(() => null);
            if (att) sku = safeTrim(att);
          }
        } catch (e) { }
        if (!sku && cellTexts[0]) sku = safeTrim(cellTexts[0]);
        sku = (sku || '').replace(/[^\w]/g, '').trim();
        if (!sku || sku.length < 3) {
          const m = rowText.match(/\d{6,14}/);
          if (m) sku = m[0];
        }

        // description -> producto
        let producto = ''; // **** RENOMBRADO ****
        if (descIndexFromHeader >= 0 && cellTexts[descIndexFromHeader]) producto = cellTexts[descIndexFromHeader];
        else {
          for (let j = cellTexts.length - 1; j >= 0; j--) {
            const t = cellTexts[j] || '';
            if (!t) continue;
            if (!(/^[\d\.\,]+$/.test(t)) && !extractCurrency(t)) {
              producto = t;
              break;
            }
          }
          if (!producto) producto = cellTexts[cellTexts.length - 1] || cellTexts[0] || '';
        }
        // filter out rows that are page summaries
        if (/mostrando|resultado|resultados|no hay productos|sin resultados/i.test(producto.toLowerCase())) continue; // **** USAR producto ****

        // pvp
        let pvp = '';
        if (pvpIndexFromHeader >= 0 && cellTexts[pvpIndexFromHeader]) pvp = cellTexts[pvpIndexFromHeader];
        else {
          for (const ct of cellTexts) {
            const c = extractCurrency(ct);
            if (c) { pvp = c; break; }
          }
        }
        if (!pvp && cellEls && cellEls.length > 0) {
          for (const ce of cellEls) {
            try {
              const dp = await ce.getAttribute('data-price').catch(() => null) || await ce.getAttribute('data-pvp').catch(() => null);
              if (dp) { pvp = dp; break; }
            } catch (e) { }
          }
        }

        // precio_c_desc -> con_desc
        let con_desc = ''; // **** RENOMBRADO ****
        if (precioCDescIndex >= 0 && cellTexts[precioCDescIndex]) {
          const matches = extractCurrencyAll(cellTexts[precioCDescIndex]);
          if (matches.length > 0) con_desc = matches[0];
        }
        if (!con_desc) {
          let found = false;
          // Find second currency value in the same cell as pvp, or the first currency in another cell
          let pvpCellIndex = -1;
          for (let k = 0; k < cellTexts.length; k++) {
            if (extractCurrency(cellTexts[k]) === pvp) {
              pvpCellIndex = k;
              break;
            }
          }

          if (pvpCellIndex !== -1) {
            const pvpCellMatches = extractCurrencyAll(cellTexts[pvpCellIndex]);
            if (pvpCellMatches.length >= 2) {
              con_desc = pvpCellMatches[1];
              found = true;
            }
          }

          if (!found) {
            for (let k = 0; k < cellTexts.length; k++) {
              if (k === pvpCellIndex) continue; // Skip the pvp cell if we didn't find the second price there
              const matches = extractCurrencyAll(cellTexts[k]);
              if (matches.length >= 1) {
                con_desc = matches[0];
                found = true;
                break;
              }
            }
          }
        }
        if (!con_desc) con_desc = pvp || ''; // Fallback to pvp if no discount price found

        // stock / availability -> stock ('si'/'no')
        let availability = 'no';
        let stockText = ''; // Keep original text for debug/context if needed, but output 'si'/'no'

        // 1) Si hay una celda dedicada que contenga "D" o texto claro, priorizarla:
        if (cellEls && cellEls.length > 0) {
          for (const ce of cellEls) {
            try {
              const raw = (await ce.innerText().catch(() => '')) || '';
              const rawTrim = raw.trim();
              if (rawTrim === 'D' || rawTrim === 'd') {
                availability = await detectAvailabilityFromElementHandle(ce);
                stockText = rawTrim; // Store original text
                break;
              }
              if (/disponible|en stock|hay stock|stock/i.test(rawTrim)) {
                stockText = rawTrim;
                availability = await detectAvailabilityFromElementHandle(ce);
                break;
              }
              if (/sin stock|agotad|agotado|no disponible|no hay/i.test(rawTrim)) {
                stockText = rawTrim;
                availability = 'no';
                break;
              }
            } catch (e) { }
          }
        }

        // 2) Si no detectamos nada, intentar heurística por texto en toda la fila
        if (!stockText) {
          for (const ct of cellTexts) {
            if (/sin stock|agotad|agotado|no dispo|no disponible/i.test(ct)) { stockText = ct; availability = 'no'; break; }
            if (/disponible|en stock|hay stock|stock/i.test(ct)) { stockText = ct; availability = 'si'; break; }
          }
        }

        // 3) Última heurística: inspeccionar nodos con iconos/badges para color verde (D)
        if (availability === 'no' && cellEls && cellEls.length > 0) {
          for (const ce of cellEls) {
            try {
              // Broaden the search for potential stock indicators
              const possible = await ce.$('svg, i, .icon, .badge, .circle, .MuiAvatar-root, .MuiChip-root, [class*="stock"], [class*="availab"], [style*="green"], [style*="rgb(0"], [style*="#0"], [style*="lime"]').catch(() => null);
              if (possible) {
                const av = await detectAvailabilityFromElementHandle(ce);
                if (av === 'si') { availability = 'si'; stockText = stockText || (await ce.innerText().catch(() => '')); break; }
              }
            } catch (e) { }
          }
        }
        // Ensure availability is strictly 'si' or 'no'
        availability = (availability === 'si' ? 'si' : 'no');

        // Detectar min_offer -> min
        let min = ''; // **** RENOMBRADO ****
        if (minIndexFromHeader >= 0 && cellTexts[minIndexFromHeader]) {
          const mm = (cellTexts[minIndexFromHeader] || '').match(/\d+/);
          if (mm) min = mm[0];
          else min = safeTrim(cellTexts[minIndexFromHeader]);
        }

        if (!min && cellEls && cellEls.length > 0) {
          // revisar atributos de cada celda (ej. data-min, data-min-offer, etc.)
          for (const ce of cellEls) {
            try {
              const att = await ce.getAttribute('data-min').catch(() => null) || await ce.getAttribute('data-min-offer').catch(() => null) || await ce.getAttribute('data-minoffer').catch(() => null);
              if (att && /\d+/.test(att)) { min = att.match(/\d+/)[0]; break; }
            } catch (e) { }
          }
        }

        if (!min) {
          // heurística: buscar la primera celda con número corto (1-3 dígitos) que no sea currency y que no parezca sku largo
          for (const ct of cellTexts) {
            const t = (ct || '').replace(/\s+/g, '').replace(/\./g, ''); // limpiar
            if (/^[0-9]{1,3}$/.test(t)) {
              const num = parseInt(t, 10);
              if (!Number.isNaN(num) && num > 0 && num <= 999) {
                const pvpNum = parseCurrencyToNumber(pvp);
                const conDescNum = parseCurrencyToNumber(con_desc);
                // Check if it matches exactly either price (unlikely for min) or if it's the SKU
                if ((pvpNum != null && Math.abs(pvpNum - num) < 0.001) ||
                  (conDescNum != null && Math.abs(conDescNum - num) < 0.001) ||
                  (sku === String(num))) {
                  // ignore if it matches price or sku
                } else {
                  min = String(num);
                  break;
                }
              }
            }
          }
        }

        // url (kept internal, not directly outputted unless needed)
        let url = '';
        try {
          const a = await r.$('a[href]');
          if (a) { const h = await a.getAttribute('href').catch(() => null); if (h) url = new URL(h, await page.url()).toString(); }
        } catch (e) { }

        // **** Crear objeto con nombres de campo esperados por normDelsudRow ****
        const rec = {
          timestamp: new Date().toISOString(),
          query: query || '',
          producto: producto || '',
          pvp: pvp || '',
          con_desc: con_desc || '',
          stock: availability, // **** USAR 'si'/'no' ****
          min: min || '', // **** USAR nombre 'min' ****
          sku: sku || '', // Mantener sku por si acaso para la key
          url: url || '', // Mantener url por si acaso para la key
        };

        const key = (rec.sku || rec.url || (rec.producto + '|' + rec.pvp)).trim(); // **** USAR rec.producto ****
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        products.push(rec);

      } catch (e) {
        // continue on row errors
      }
    }

    if (products.length === 0) {
      await saveDiagnostic(page, `scrape-empty-${String(query).replace(/\s+/g, '_').slice(0, 30)}`);
    }

  } catch (e) {
    console.warn('[SCRAPE] error scraping page:', e && (e.stack || e.message));
    await saveDiagnostic(page, `scrape-error-${String(query).replace(/\s+/g, '_').slice(0, 30)}`);
  }

  return products;
}

function unitSafeNumber(maybeCurrencyText) { // No longer directly used for output, kept as helper
  try {
    if (!maybeCurrencyText) return null;
    const n = parseCurrencyToNumber(maybeCurrencyText);
    return n;
  } catch (e) { return null; }
}

async function tryClickNext(page) {
  for (const sel of PAGINATION_NEXT_SELECTORS) {
    try {
      const loc = page.locator(sel);
      if (await loc.count() > 0) {
        const el = loc.first();
        try { if (await el.isDisabled()) return false; } catch (e) { }
        await el.scrollIntoViewIfNeeded();
        try { await el.click({ timeout: 3000 }); } catch (e) { await el.click({ force: true }); }
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { });
        return true;
      }
    } catch (e) { }
  }
  return false;
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
// IMPRIMIR SOLO LOS RESULTADOS DE LA BÚSQUEDA ACTUAL (NO ACUMULATIVO)
// **** MODIFICADO: Esta función ya no se usará. Los resultados se envían vía JSON hook ****
// ================================================================
// function printSearchResultsForConsole(products){
//   // ... (Código anterior comentado o eliminado) ...
// }

// ================================================================
// MAIN flow (login + focus search + modo manual interactivo)
// ================================================================
(async () => {
  console.log('=== 01-login-y-interaccion-mejorado (DELSUD) modo MANUAL-only ===');
  console.log('EMAIL:', EMAIL);
  console.log('HEADLESS:', PLAYWRIGHT_HEADLESS ? 'true' : 'false');
  console.log('DIAG:', ENABLE_DIAG ? '1' : '0');
  console.log('PAGE_WAIT_TIMEOUT:', PAGE_WAIT_TIMEOUT, 'POST_SEARCH_WAIT_MS:', POST_SEARCH_WAIT_MS);

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
    context = await browser.newContext();
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
          // MODIFICADO: ensureFocusAndType ahora usa CHAR_DELAY_MIN para la velocidad de tipeo
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
          // MODIFICADO: ensureFocusAndType ahora usa CHAR_DELAY_MIN para la velocidad de tipeo
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

    try { await page.waitForLoadState('networkidle', { timeout: 200 }); } catch (e) { }
    await saveDiagnostic(page, 'after-submit');
    try { await context.storageState({ path: STATE_FILE }); } catch (e) { console.warn("[STATE] can't save state:", e && e.message); }

    // focus initial search input if posible
    try {
      await page.waitForSelector(SEARCH_INPUT_SELECTOR, { timeout: Math.max(800, PAGE_WAIT_TIMEOUT) }).catch(() => null);
      try { await page.click(SEARCH_INPUT_SELECTOR, { force: true, timeout: 1500 }); } catch (e) {
        const alt = `input[placeholder*="${SEARCH_INPUT_PLACEHOLDER_PART}"]`;
        if (await page.locator(alt).count() > 0) {
          await page.locator(alt).first().click({ force: true });
        } else {
          await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) { el.focus(); el.click(); } }, SEARCH_INPUT_SELECTOR).catch(() => null);
        }
      }
    } catch (e) { }

    // === MODO MANUAL OBLIGATORIO ===
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
    console.log('Arrancando modo manual de búsquedas. Escribí cada búsqueda y presioná Enter. Escribí "exit" para salir.');
    rl.setPrompt('Buscar> '); // Este prompt no se mostrará si terminal:false, pero se mantiene la lógica
    //rl.prompt(); // No llamar a prompt() si no es terminal interactivo

    // **** MODIFICADO: runSingleSearch ahora emite JSON en lugar de imprimir tabla ****
    async function runSingleSearch(query, requestedQty = 1) { // requestedQty no se usa actualmente
      console.log(`[SCRAPE] Iniciando scraping para la búsqueda: "${query}"...`);
      let inputSelector = SEARCH_INPUT_SELECTOR;
      try {
        if (await page.locator(SEARCH_INPUT_SELECTOR).count() === 0) {
          const altSel = `input[placeholder*="${SEARCH_INPUT_PLACEHOLDER_PART}"]`;
          if (await page.locator(altSel).count() > 0) inputSelector = altSel;
        }
      } catch (e) { }
      // clearInputByBackspace usa los nuevos valores rndMsBack (más rápidos)
      await clearInputByBackspace(page, inputSelector);
      // Escritura usa los nuevos valores rndMs (más rápidos)
      for (const ch of String(query)) { await page.keyboard.type(ch, { delay: rndMs() }); }
      await page.keyboard.press('Enter');
      await page.waitForTimeout(POST_SEARCH_WAIT_MS);

      const allProducts = [];
      for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx++) {
        console.log(`[SCRAPE] Extrayendo datos de la página ${pageIdx + 1}`);
        await saveDiagnostic(page, `after-search_p${pageIdx + 1}_${String(query).replace(/\s+/g, '_').slice(0, 30)}`);
        const prods = await scrapeProductsFromPage(page, query);
        if (prods.length > 0) {
          allProducts.push(...prods); // Acumular productos
        } else {
          if (pageIdx === 0) { console.log(`[SCRAPE] No se encontraron productos para "${query}".`); }
          break;
        }
        const clickedNext = await tryClickNext(page);
        if (!clickedNext) { console.log('[SCRAPE] No hay más páginas de resultados.'); break; }
        if (pageIdx === MAX_PAGES - 1) { console.log('[SCRAPE] Límite de MAX_PAGES alcanzado.'); }
      }

      // **** MODIFICADO: Emitir JSON en lugar de llamar a printSearchResultsForConsole ****
      if (allProducts.length > 0) {
        console.log('@@@PILLIGENCE_TABLE@@@' + JSON.stringify({ data: allProducts }));
      } else {
        console.log('@@@PILLIGENCE_TABLE@@@' + JSON.stringify({ data: [] })); // Emitir tabla vacía si no hay resultados
        console.log(`[SCRAPE] No se extrajo nada para "${query}".`);
      }
      // **** FIN MODIFICACIÓN ****

      console.log(`[SCRAPE] Finalizado para "${query}". Productos extraídos (raw): ${allProducts.length}.`);
      return allProducts.length;
    }

    rl.on('line', async (line) => {
      const query = String(line || '').trim();
      if (query.toLowerCase() === 'exit') {
        console.log('Comando "exit" recibido — guardando estado y cerrando el programa...');
        try { await context.storageState({ path: STATE_FILE }); } catch (e) { console.warn('[STATE] no se pudo guardar:', e && e.message); }
        try { await browser.close(); } catch (e) { console.warn('[EXIT] error cerrando navegador:', e && e.message); }
        process.exit(0);
      }
      if (query === '') {
        // Si recibimos una línea vacía (puede pasar con stdin pipe), simplemente la ignoramos y esperamos la siguiente.
        // No volvemos a llamar a rl.prompt()
        return;
      }
      try {
        await runSingleSearch(query);
      } catch (err) {
        console.error('[INTERACT] error en búsqueda manual:', err && (err.message || err));
        await saveDiagnostic(page, `error_manual_${nowStamp()}`);
      } finally {
        // No llamar a rl.prompt() aquí tampoco. Esperar la siguiente línea.
      }
    });

    rl.on('close', () => { console.log('Readline cerrado. La ventana del navegador permanece abierta si KEEP_BROWSER_OPEN=1.'); });

    process.on('SIGINT', async () => {
      console.log('\nSIGINT recibido — cerrando correctamente (guardando estado).');
      try { await context.storageState({ path: STATE_FILE }); } catch (e) { console.warn('[STATE] no se pudo guardar:', e && e.message); }
      try { await browser.close(); } catch (e) { console.warn('[EXIT] error cerrando navegador:', e && e.message); }
      process.exit(0);
    });

  } catch (err) {
    console.error('[ERROR] flujo principal:', err && (err.stack || err.message || err));
    try { if (page) await saveDiagnostic(page, `fatal-error-${nowStamp()}`); } catch (e) { }
    try { if (browser) await browser.close(); } catch (e) { }
    process.exit(1);
  }
})();