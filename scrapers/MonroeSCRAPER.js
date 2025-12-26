#!/usr/bin/env node
console.log('@@@READY@@@ [prelogin]');
/**
 * MonroeSCRAPER.js
 *
 * Cambios claves:
 * - (NUEVO) Detecta el modal de CAPTCHA después del login.
 * - (NUEVO) Si hay CAPTCHA, extrae la imagen (base64) y la imprime a stdout con un prefijo especial.
 * - (NUEVO) Pausa y espera un código CAPTCHA por stdin.
 * - (NUEVO) Al recibir el código, lo ingresa y reintenta el login.
 * - Lee búsquedas por stdin con rl.on('line') (terminal:false) → ahora recibe lo que manda Electron.
 * - Señal de listo: imprime "MODO BÚSQUEDA INTERACTIVA" y la línea guía.
 * - Señal de fin por búsqueda: imprime `Finalizado para "<término>"`.
 * - Lanzador robusto: ya no fuerza channel:"chrome" (funciona con Chromium de Playwright por defecto).
 * - Mantenemos el scraping y heurísticas originales.
 *
 * MODIFICACIÓN:
 * - Se cambió `humanTypeOnLocator` para usar `locator.fill()` en lugar de un bucle
 * de tipeo carácter por carácter, para que la escritura sea instantánea.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const URL = 'https://www.monroeamericana.com.ar/apps/login/ext/index.html';

const USERNAME = process.env.MONROE_USER;
const PASSWORD = process.env.MONROE_PASS;
const CHROME_PATH = process.env.CHROME_PATH || null;
const HEADLESS = (process.env.HEADLESS === '1' || process.env.HEADLESS === 'true') || false;

// Estas constantes se mantienen por compatibilidad de firma, aunque el delay ya no se usa en la escritura.
const HUMAN_KEY_DELAY_MIN = parseInt(process.env.HUMAN_KEY_DELAY_MIN || '80', 10);
const HUMAN_KEY_DELAY_MAX = parseInt(process.env.HUMAN_KEY_DELAY_MAX || '200', 10);
const HUMAN_PRE_DELAY_MIN = parseInt(process.env.HUMAN_PRE_DELAY_MIN || '300', 10);
const HUMAN_PRE_DELAY_MAX = parseInt(process.env.HUMAN_PRE_DELAY_MAX || '1200', 10);
const HUMAN_POST_DELAY_MIN = parseInt(process.env.HUMAN_POST_DELAY_MIN || '200', 10);
const HUMAN_POST_DELAY_MAX = parseInt(process.env.HUMAN_POST_DELAY_MAX || '800', 10);
const HUMAN_LOGIN_TIME_MS = process.env.HUMAN_LOGIN_TIME_MS ? parseInt(process.env.HUMAN_LOGIN_TIME_MS, 10) : null;

// --- RL Interface (se define globalmente) ---
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomBetween(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function nowMs() { return Date.now(); }

/**
 * MODIFICADO PARA ESCRITURA RÁPIDA
 * En lugar de tipear carácter por carácter, usa locator.fill() para velocidad instantánea.
 */
async function humanTypeOnLocator(page, locator, text, keyMin = HUMAN_KEY_DELAY_MIN, keyMax = HUMAN_KEY_DELAY_MAX) {
  try {
    await locator.scrollIntoViewIfNeeded();
    await locator.focus();
  } catch (e) {
    try { await locator.click({ timeout: 2000 }); } catch (e) { }
  }

  // Lógica de borrado (Ctrl+A, Backspace)
  try {
    await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.press('a');
    await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.press('Backspace');
  } catch (e) {
    try { await locator.fill(''); } catch (e) { }
  }

  // --- MODIFICACIÓN POR VELOCIDAD ---
  // Reemplazamos el bucle lento de tipeo por un `fill` instantáneo.
  try {
    await locator.fill(text);
    // Disparamos eventos manualmente por si `fill` no lo hace (común en React/Vue)
    await locator.evaluate(el => {
      if (!el) return;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }).catch(() => { });
  } catch (e) {
    // Fallback: usar page.keyboard.type pero sin delay
    try {
      await page.keyboard.type(text, { delay: 0 });
    } catch (ee) {
      // Fallback final: setear el valor directamente
      try { await locator.evaluate((el, txt) => { if (el) el.value = txt; }, text); } catch (eee) { }
    }
  }
  // --- FIN DE LA MODIFICACIÓN ---
}

async function humanType(page, selectorOrLocator, text, keyMin = HUMAN_KEY_DELAY_MIN, keyMax = HUMAN_KEY_DELAY_MAX) {
  let locator;
  if (typeof selectorOrLocator === 'string') locator = page.locator(selectorOrLocator).first();
  else locator = selectorOrLocator;
  if (!locator) throw new Error('Locator inválido en humanType');
  await humanTypeOnLocator(page, locator, text, keyMin, keyMax);
}

/* ------------------- CLICK LOGIN: estrategia robusta ------------------- */
async function clickLoginButtonRobust(page, scope = null) {
  const root = scope || page;
  try {
    const btnRole = root.getByRole('button', { name: /^Iniciar sesión$/i }).first();
    if (await btnRole.count()) { await btnRole.click({ timeout: 5000 }); return true; }
  } catch (e) { }

  try {
    const btnHasText = root.locator('button:has-text("Iniciar sesión"), [role="button"]:has-text("Iniciar sesión")').first();
    if (await btnHasText.count()) { await btnHasText.scrollIntoViewIfNeeded().catch(() => { }); await wait(randomBetween(80, 250)); await btnHasText.click({ timeout: 5000 }); return true; }
  } catch (e) { }

  try {
    const txtLoc = root.locator('text="Iniciar sesión"').first();
    if (await txtLoc.count()) {
      await txtLoc.scrollIntoViewIfNeeded().catch(() => { });
      await wait(randomBetween(60, 180));
      try { await txtLoc.click({ timeout: 3000 }); return true; } catch (e) {
        const handle = await txtLoc.elementHandle();
        if (handle) {
          const ancestor = await page.evaluateHandle(el => {
            let e = el;
            while (e && e.nodeType === 1) {
              const tag = e.tagName ? e.tagName.toLowerCase() : '';
              const role = e.getAttribute ? e.getAttribute('role') : null;
              if (tag === 'button' || tag === 'a' || role === 'button') return e;
              e = e.parentElement;
            }
            return null;
          }, handle);
          if (ancestor) {
            try { await ancestor.asElement().click({ timeout: 5000 }); return true; } catch (ee) { await page.evaluate(el => el.click(), ancestor).catch(() => { }); return true; }
          }
        }
      }
    }
  } catch (e) { }

  try {
    const looseBtn = root.locator('button, input[type=submit], [role="button"]').filter({ hasText: /iniciar|ingresar|acceder|entrar/i }).first();
    if (await looseBtn.count()) { await looseBtn.scrollIntoViewIfNeeded().catch(() => { }); await wait(randomBetween(80, 200)); await looseBtn.click({ timeout: 5000 }); return true; }
  } catch (e) { }

  if (!scope) {
    try { await page.evaluate(() => { const f = document.querySelector('form'); if (f) f.submit(); }); return true; } catch (e) { }
  }

  return false;
}

/* --------------------- Helpers --------------------- */
function normalizeTitle(t) {
  if (!t) return null;
  return t.replace(/\s+/g, ' ').replace(/[^\w\dáéíóúÁÉÍÓÚüÜ\-\s]/g, '').trim().toLowerCase();
}

function parsePriceToFloat(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.replace(/[^\d.,-]/g, '').trim();
  if (!s) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  if (lastDot !== -1 && lastComma !== -1) {
    if (lastDot > lastComma) {
      s = s.replace(/,/g, '');
      const n = Number(s);
      return isNaN(n) ? null : n;
    } else {
      s = s.replace(/\./g, '').replace(',', '.');
      const n = Number(s);
      return isNaN(n) ? null : n;
    }
  }

  if (lastComma !== -1 && lastDot === -1) {
    if ((s.match(/,/g) || []).length > 1) {
      s = s.replace(/,/g, '');
      const n = Number(s); return isNaN(n) ? null : n;
    }
    const afterComma = s.split(',')[1] || '';
    if (afterComma.length === 3) {
      s = s.replace(/,/g, '');
      const n = Number(s); return isNaN(n) ? null : n;
    } else {
      s = s.replace(',', '.');
      const n = Number(s); return isNaN(n) ? null : n;
    }
  }

  if (lastDot !== -1 && lastComma === -1) {
    if ((s.match(/\./g) || []).length > 1) {
      s = s.replace(/\./g, '');
      const n = Number(s); return isNaN(n) ? null : n;
    }
    const n = Number(s);
    return isNaN(n) ? null : n;
  }

  const n = Number(s);
  return isNaN(n) ? null : n;
}

/* --------------------- Helpers para search focus --------------------- */
const SEARCH_SELECTORS = [
  'input[type=search]', 'input[placeholder*="Buscar"]', 'input[placeholder*="buscar"]',
  'input[name*=search]', 'input[name*=q]', 'input[id*=search]', 'input[id*=buscar]', 'input[class*="search"]',
  'input[type=text][name*=buscar]', 'input[type=text][placeholder*="Buscar"]', 'input[aria-label*="Buscar"]', 'input[aria-label*="buscar"]'
];
const SEARCH_TOGGLE_SELECTORS = [
  'button[aria-label*="Buscar"]', 'button[aria-label*="buscar"]',
  '.search-toggle', '.search-open', '.open-search', 'button:has(.icon-search)',
  'button:has-text("Buscar")', 'button:has-text("buscar")', '.icon-search', '.search-button'
];

async function focusSearchInput(page) {
  try {
    for (const sel of SEARCH_SELECTORS) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count() > 0) {
          await loc.scrollIntoViewIfNeeded().catch(() => { });
          await loc.focus().catch(() => { });
          try { await loc.click({ timeout: 300 }); } catch (_) { }
          return true;
        }
      } catch (e) { }
    }
    for (const t of SEARCH_TOGGLE_SELECTORS) {
      try {
        const toggle = page.locator(t).first();
        if (await toggle.count() > 0) {
          await toggle.scrollIntoViewIfNeeded().catch(() => { });
          try { await toggle.click({ timeout: 500 }); } catch (_) { }
          await wait(300);
          for (const sel of SEARCH_SELECTORS) {
            try {
              const loc2 = page.locator(sel).first();
              if (await loc2.count() > 0) {
                await loc2.scrollIntoViewIfNeeded().catch(() => { });
                await loc2.focus().catch(() => { });
                try { await loc2.click({ timeout: 300 }); } catch (_) { }
                return true;
              }
            } catch (e) { }
          }
        }
      } catch (e) { }
    }
    const first = page.locator('input:visible').first();
    if (await first.count() > 0) {
      await first.scrollIntoViewIfNeeded().catch(() => { });
      await first.focus().catch(() => { });
      try { await first.click({ timeout: 300 }); } catch (_) { }
      return true;
    }
  } catch (e) { }
  return false;
}

/* --------------------- Perform search + scrape --------------------- */
async function performSearchAndScrape(page, term) {
  console.log(`\n>>> Buscando: "${term}" (usando la barra de búsqueda de la página)\n`);

  // localizar input
  let searchInput = null;
  for (const s of SEARCH_SELECTORS) {
    try {
      const loc = page.locator(s).first();
      if (await loc.count()) { searchInput = loc; break; }
    } catch (e) { }
  }
  if (!searchInput) {
    for (const t of SEARCH_TOGGLE_SELECTORS) {
      try {
        const toggle = page.locator(t).first();
        if (await toggle.count()) {
          await toggle.scrollIntoViewIfNeeded().catch(() => { });
          await wait(randomBetween(80, 200));
          try { await toggle.click({ timeout: 4000 }); } catch (e) { }
          await wait(300);
          for (const s of SEARCH_SELECTORS) {
            try {
              const loc2 = page.locator(s).first();
              if (await loc2.count()) { searchInput = loc2; break; }
            } catch (e) { }
          }
          if (searchInput) break;
        }
      } catch (e) { }
    }
  }
  if (!searchInput) {
    console.warn('No se encontró la barra de búsqueda. Abortando búsqueda.');
    return;
  }

  // escribir y presionar Enter
  try {
    await humanTypeOnLocator(page, searchInput, term); // Esto ahora es rápido
    await wait(randomBetween(120, 320));

    // Refuerzo de valor en input
    try {
      const selectorHint = await (async () => {
        try {
          return await searchInput.evaluate(n => {
            if (n.id) return `#${n.id}`;
            if (n.name) return `input[name="${n.name}"]`;
            if (n.getAttribute && n.getAttribute('data-testid')) return `[data-testid="${n.getAttribute('data-testid')}"]`;
            const cls = (n.className && typeof n.className === 'string') ? n.className.split(' ').slice(0, 2).join('.') : '';
            if (cls) return `.${cls}`;
            return null;
          });
        } catch (e) { return null; }
      })();
      if (selectorHint) {
        await page.evaluate((sel, val) => {
          const el = document.querySelector(sel);
          if (!el) return;
          el.focus();
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, selectorHint, term).catch(() => { });
      } else {
        await page.evaluate((val) => {
          const el = document.activeElement;
          if (!el) return;
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, term).catch(() => { });
      }
    } catch (e) { }

    await page.keyboard.press('Enter').catch(() => { });
  } catch (e) {
    console.warn('Error tipeando en la barra de búsqueda:', e.message);
    return;
  }

  // espera corta para resultados
  // await wait(2000); // Reemplazado por un waiter más eficiente

  // --- MODIFICACIÓN: Polling reemplazado por waiter ---
  // Reemplazamos el loop de polling manual (con 'while' y 'wait')
  // por un waiter nativo de Playwright, que es mucho más rápido y eficiente.
  const possibleRowSelectors = ['[role="listitem"]', 'li.row.rowItem', 'li.rowItem', '.row.rowItem', '.dmaltem', '.dmaBS-listItem', 'tr', '.product-item', '.product-card', 'li.product', '.item.product'];
  const maxWaitMs = 12000;
  const anyRowSelector = possibleRowSelectors.join(',');

  try {
    // Esperar a que el *primer* elemento de la lista sea visible.
    // Esto resuelve inmediatamente en lugar de esperar 12 segundos.
    await page.locator(anyRowSelector).first().waitFor({ state: 'visible', timeout: maxWaitMs });
    // Damos un respiro corto para que carguen más elementos si es necesario
    await wait(1500);
  } catch (e) {
    // El waiter falló (timeout), no se encontraron productos.
    await focusSearchInput(page).catch(() => { });
    console.log('No se detectaron elementos tipo listitem/producto tras esperar.');
    return;
  }
  // --- FIN MODIFICACIÓN ---

  // (Se eliminan las variables 'start', 'found', 'pollInterval' y la función 'countProducts'
  // que ya no son necesarias gracias al waiter)

  // === Extracción ===
  const extracted = await page.evaluate(() => {
    const decimalRegex = /[\d]{1,3}(?:[.,][\d]{3})*[.,][\d]{2}/g;
    const normalize = s => s ? s.replace(/\s+/g, ' ').trim() : '';

    function isVisible(el) {
      try {
        if (!el || !(el instanceof Element)) return false;
        const cs = window.getComputedStyle(el);
        if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        if (!rect) return false;
        if ((rect.width === 0 && rect.height === 0) || rect.bottom < 0) return false;
        return true;
      } catch (e) { return false; }
    }
    function isStruck(el) {
      if (!el) return false;
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 's' || tag === 'del' || tag === 'strike') return true;
      let current = el, depth = 0;
      while (current && depth < 6) {
        try {
          const t = (current.tagName || '').toLowerCase();
          if (t === 's' || t === 'del' || t === 'strike') return true;
          const className = (current.className || '').toString().toLowerCase();
          if (/\bstruck|deleted|old-price|line-through|price--old|precio-antiguo\b/i.test(className)) return true;
          const cs = window.getComputedStyle(current);
          if (cs) {
            const decLine = (cs.textDecorationLine || cs.textDecoration || '').toString().toLowerCase();
            if (decLine.indexOf('line-through') !== -1) return true;
          }
        } catch (e) { }
        current = current.parentElement;
        depth++;
      }
      return false;
    }

    // --- MODIFICACIÓN: Pre-cálculo para optimizar velocidad ---
    // En lugar de iterar todos los nodos (N) por cada item (M) (lento: O(N*M)),
    // iteramos todos los nodos UNA VEZ (rápido: O(N)) y luego filtramos para cada item (O(M)).

    const allPotentialNodes = Array.from(document.querySelectorAll('span, div, p, strong, td, small, a, b, i'));
    const allPriceElements = [];
    const allTextElements = [];

    for (let i = 0; i < allPotentialNodes.length; i++) {
      const el = allPotentialNodes[i];
      try {
        if (!isVisible(el)) continue;

        const txt = (el.innerText || '').trim();
        if (txt) {
          // Para Títulos
          if (txt.length > 3) {
            allTextElements.push({ el, idx: i, txt });
          }

          // Para Precios
          const m = txt.match(decimalRegex);
          if (m && m.length) {
            if (txt.indexOf('%') === -1 && !/\b(mult|múlt)\b/i.test(txt)) {
              allPriceElements.push({
                el,
                priceText: m[0],
                elementText: txt,
                domIndex: i, // domIndex ahora es el índice en allPotentialNodes
                struck: isStruck(el)
              });
            }
          }
        }
      } catch (e) { }
    }
    // --- FIN MODIFICACIÓN ---

    // (La función 'collectPriceElementsOrderedFromNodes' y la variable 'nodesAll'
    // se eliminan porque su lógica ahora está pre-calculada arriba)

    function isGoodTitleText(txt) {
      if (!txt) return false;
      const s = txt.trim();
      if (s.length < 4) return false;
      if (/\b(unidades|ud|uds|stock|en stock|múlt|mult|%|entrega)\b/i.test(s)) return false;
      const words = s.split(/\s+/);
      if (words.length < 2) return false;
      const digits = (s.match(/\d/g) || []).length;
      if (digits / Math.max(1, s.length) > 0.4) return false;
      return true;
    }

    const candidates = Array.from(document.querySelectorAll('[role="listitem"], li'));
    const results = [];
    const seen = new Set();

    for (const node of candidates) {
      try {
        const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
        if (rect && (rect.width < 20 || rect.height < 12)) continue;

        const nodeText = normalize(node.innerText || '');
        if (!nodeText) continue;

        const hasSpin = node.querySelector('[role="spinbutton"], [aria-label*="Unidades"], [aria-label*="unidades"], input[type="number"], .spinbutton') !== null;
        const mentionsUnidades = /unidades/i.test(nodeText);
        if (!hasSpin && !mentionsUnidades) continue;

        // Título (MODIFICADO: usa allTextElements pre-calculados)
        const localWithIndex = allTextElements.filter(n => node.contains(n.el));
        localWithIndex.sort((a, b) => (b.txt.length - a.txt.length));
        let title = '';
        let titleDomIndex = -1;
        for (const item of localWithIndex) {
          const t = item.txt;
          if (isGoodTitleText(t)) { title = t; titleDomIndex = item.idx; break; }
        }
        const lines = nodeText.split('\n').map(l => l.trim()).filter(Boolean);
        if (!title) {
          for (const l of lines) {
            if (isGoodTitleText(l)) {
              title = l;
              const found = localWithIndex.find(x => x.txt.indexOf(l) !== -1);
              titleDomIndex = found ? found.idx : -1;
              break;
            }
          }
        }
        if (!title) {
          for (const l of lines) {
            if (!/\d{2,}/.test(l) && !/unidades/i.test(l) && !/\%/.test(l) && l.length > 3) {
              title = l;
              const found = localWithIndex.find(x => x.txt.indexOf(l) !== -1);
              titleDomIndex = found ? found.idx : -1;
              break;
            }
          }
        }
        if (!title) {
          title = lines && lines[0] ? lines[0] : nodeText.slice(0, 80);
          const found = localWithIndex.find(x => x.txt && title.indexOf(x.txt) !== -1);
          titleDomIndex = found ? found.idx : (localWithIndex[0] ? localWithIndex[0].idx : -1);
        }

        // Precios (MODIFICADO: usa allPriceElements pre-calculados)
        const priceEls = allPriceElements.filter(p => node.contains(p.el));
        const seenTexts = new Set();
        const dedup = [];
        for (const p of priceEls) {
          if (!seenTexts.has(p.priceText)) { dedup.push(p); seenTexts.add(p.priceText); }
        }
        const priceInfos = dedup.map(p => {
          let num = null;
          try {
            const normalized = p.priceText.replace(/\./g, '').replace(',', '.');
            num = Number(normalized);
            if (isNaN(num)) num = null;
          } catch (e) { num = null; }
          return {
            priceText: p.priceText,
            elementText: p.elementText,
            struck: !!p.struck,
            domIndex: p.domIndex,
            num
          };
        }).filter(pi => pi.num !== null);

        if (!priceInfos.length) continue;

        // === Decisión por estructura tipo grilla ===
        const publicObj = priceInfos.slice().sort((a, b) => b.num - a.num)[0]; // Público: el máximo

        const nonPublic = priceInfos.filter(pi => pi !== publicObj);

        // Unitario: el menor no-público, priorizando NO tachado
        let unitObj = null;
        const nonStruck = nonPublic.filter(pi => !pi.struck);
        const poolUnit = nonStruck.length ? nonStruck : nonPublic;
        if (poolUnit.length) unitObj = poolUnit.slice().sort((a, b) => a.num - b.num)[0];

        // Antiguo: el NO público > unitario más cercano en DOM al unitario
        let oldObj = null;
        if (unitObj) {
          const higher = nonPublic.filter(pi => pi.num > unitObj.num);
          if (higher.length) {
            oldObj = higher
              .map(pi => ({ pi, d: Math.abs(pi.domIndex - unitObj.domIndex) }))
              .sort((a, b) => a.d - b.d || a.pi.num - b.pi.num)[0].pi;
          }
        }

        // --- STOCK reforzado ---
        let stock = '';
        let debug_color = { found: false, reason: 'none' };

        try {
          const dotCandidates = [];
          const elems = Array.from(node.querySelectorAll('svg, span, i, div, b, em, small'));
          for (const e of elems) {
            try {
              if (!isVisible(e)) continue;
              const r = e.getBoundingClientRect ? e.getBoundingClientRect() : null;
              if (!r) continue;
              if (r.width <= 26 && r.height <= 26 && r.width > 2 && r.height > 2) {
                dotCandidates.push(e);
              }
            } catch (e) { }
          }

          let foundRed = false, foundGreen = false;
          for (const d of dotCandidates) {
            try {
              const cs = getComputedStyle(d);
              const colors = [cs.backgroundColor, cs.color, cs.borderColor].filter(Boolean);
              for (const c of colors) {
                const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
                if (!m) continue;
                const r = +m[1], g = +m[2], b = +m[3];
                const toHsl = (r, g, b) => { r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0, s = 0, l = (max + min) / 2; if (max !== min) { const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min); switch (max) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; default: h = (r - g) / d + 4; }h = Math.round(h * 60); } return [h, Math.round(s * 100), Math.round(l * 100)]; };
                const [h, s] = toHsl(r, g, b);
                if ((((h >= 340 && h <= 360) || (h >= 0 && h <= 20)) && s >= 18)) foundRed = true;
                if (((h >= 80 && h <= 160) && s >= 18)) foundGreen = true;
              }
              if (foundRed || foundGreen) break;
            } catch (e) { }
          }

          if (foundRed) { stock = 'no'; debug_color.found = true; debug_color.reason = 'found_red'; }
          else if (foundGreen) { stock = 'si'; debug_color.found = true; debug_color.reason = 'found_green'; }
        } catch (e) { }

        if (!stock) {
          try {
            const spin = node.querySelector('[role="spinbutton"], input[type="number"], .spinbutton');
            if (spin) {
              const disabled = spin.hasAttribute('disabled') || spin.getAttribute('aria-disabled') === 'true';
              const plusBtn = Array.from(node.querySelectorAll('button,[role="button"]')).find(b => {
                const t = (b.innerText || '').trim();
                const dis = b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true';
                return !dis && (/^\+$/.test(t) || /agregar|sumar|más|\bmas\b/i.test(t));
              });
              if (plusBtn || !disabled) { stock = 'si'; debug_color.found = true; debug_color.reason = 'spin_or_plus_enabled'; }
            }
          } catch (e) { }
        }

        if (!stock) {
          const neg = /\b(sin stock|sin existencia|agotad|no disponible|no hay stock|agotado|agotados|0 unidades|0 uds)\b/i;
          const pos = /\b(disponible|en stock|stock\b|hay stock|sí|si)\b/i;
          if (neg.test(nodeText)) stock = 'no';
          else if (pos.test(nodeText)) stock = 'si';
        }
        if (!stock) stock = 'si';

        const section_texts = Array.from(node.querySelectorAll('*'))
          .filter(isVisible)
          .map(el => (el.innerText || '').trim())
          .filter(t => t)
          .slice(0, 200);

        const all_prices_raw = priceInfos.map(pi => ({
          text: pi.priceText,
          num: pi.num,
          struck: pi.struck,
          domIndex: pi.domIndex
        }));

        const key = (title + '|' + (unitObj ? unitObj.priceText : '') + '|' + (publicObj ? publicObj.priceText : '')).slice(0, 300);
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          title: normalize(title),
          price_unit_raw: unitObj ? unitObj.priceText : null,
          price_old_raw: oldObj ? oldObj.priceText : null,
          price_public_raw: publicObj ? publicObj.priceText : null,
          mult_raw: (nodeText.match(/\b(?:mult|múlt|min|mín)\b\s*(?:[:\-]?\s*)?(?:x|X)?\s*([0-9]{1,3})?/i) || [null])[0] || null,
          stock,
          has_discount: !!oldObj,
          all_prices_raw,
          section_texts,
          debug_color
        });
      } catch (e) { }
      if (results.length >= 500) break;
    }

    return results;
  });

  // Normalizar, parsear y salida
  const rows = [];
  const seenNorm = new Set();
  for (const it of extracted) {
    const rawTitle = it.title || '';
    const tnorm = normalizeTitle(rawTitle);
    if (!tnorm || seenNorm.has(tnorm)) continue;
    seenNorm.add(tnorm);

    const pUnitRaw = it.price_unit_raw || null;
    const pOldRaw = it.price_old_raw || null;
    const pPublRaw = it.price_public_raw || null;

    let multRaw = it.mult_raw || '';
    const stockVal = it.stock || '';
    const hasDiscount = !!it.has_discount;

    if (multRaw) {
      multRaw = String(multRaw).replace(/\s{2,}/g, ' ').trim();
      multRaw = multRaw.replace(/\.$/, '');
    }

    const unitParsed = pUnitRaw ? parsePriceToFloat(String(pUnitRaw)) : null;
    const oldParsed = pOldRaw ? parsePriceToFloat(String(pOldRaw)) : null;
    const publParsed = pPublRaw ? parsePriceToFloat(String(pPublRaw)) : null;

    rows.push({
      product: rawTitle,
      precio_unitario: (unitParsed !== null && !isNaN(unitParsed)) ? unitParsed.toFixed(2) : (pUnitRaw || ''),
      precio_sin_descuento: (oldParsed !== null && !isNaN(oldParsed)) ? oldParsed.toFixed(2) : (pOldRaw || ''),
      precio_publico: (publParsed !== null && !isNaN(publParsed)) ? publParsed.toFixed(2) : (pPublRaw || ''),
      stock: (stockVal || 'no'),
      mult_min: multRaw || '',
      tiene_descuento: hasDiscount ? 'si' : 'no',
      all_prices_raw: it.all_prices_raw || [],
      section_texts: it.section_texts || [],
      debug_color: it.debug_color || null
    });
  }

  if (rows.length) {
    console.log(`Resultados encontrados: ${rows.length}\n`);
    console.table(rows.map(r => ({
      product: r.product,
      precio_unitario: r.precio_unitario,
      precio_sin_descuento: r.precio_sin_descuento,
      precio_publico: r.precio_publico,
      stock: r.stock,
      mult_min: r.mult_min,
      tiene_descuento: r.tiene_descuento
    })));

    console.log('CSV output (product,precio_unitario,precio_sin_descuento,precio_publico,stock,mult_min,tiene_descuento):');
    rows.forEach(r => {
      const esc = v => (v === null || v === undefined) ? '' : String(v).replace(/"/g, '""');
      console.log(`"${esc(r.product)}",${esc(r.precio_unitario)},${esc(r.precio_sin_descuento)},${esc(r.precio_publico)},${esc(r.stock)},"${esc(r.mult_min)}",${esc(r.tiene_descuento)}`);
    });

    console.log('\n--- all_prices_raw (primeros 3 items) ---');
    rows.slice(0, 3).forEach((r, i) => {
      console.log(`#${i + 1} ${r.product}`);
      console.log(r.all_prices_raw);
    });

    console.log('\n--- section_texts (primeros 1-2 items, recortado) ---');
    rows.slice(0, 2).forEach((r, i) => {
      console.log(`#${i + 1}`, r.section_texts.slice(0, 20));
    });

    console.log('\n--- Debug stock (primeros items) ---');
    rows.slice(0, 6).forEach((r, idx) => {
      const dbg = r.debug_color || {};
      console.log(`#${idx + 1} ${r.product} -> stock=${r.stock}  reason=${dbg.reason || 'none'}`);
    });
  } else {
    console.log('Se detectó presencia de resultados pero no se pudieron parsear items con las heurísticas aplicadas.');
  }

  try { await focusSearchInput(page); } catch (e) { }
  await wait(2000);
}

/* --------------------- Cerrar cartel de horario --------------------- */
async function dismissHorarioModal(page) {
  try {
    const textCandidates = [
      'Finaliza el horario de Ingreso de Pedidos',
      'Finaliza el horario de Ingreso',
      'Último horario de ingreso',
      'Ultimo horario de ingreso'
    ];
    await page.waitForTimeout(500);

    for (const t of textCandidates) {
      try {
        const loc = page.locator(`text=${t}`).first();
        if (await loc.count() > 0) {
          const handle = await loc.elementHandle();
          if (handle) {
            const dialogHandle = await page.evaluateHandle((el) => {
              let e = el;
              while (e && e.nodeType === 1) {
                const role = e.getAttribute && e.getAttribute('role');
                const cls = (e.className || '');
                if ((role && /dialog|alert/i.test(role)) || /modal|popup|overlay|dialog|notice|box|panel/i.test(cls)) return e;
                e = e.parentElement;
              }
              return null;
            }, handle);

            if (dialogHandle) {
              try {
                const btn = await dialogHandle.asElement().$('button:has-text("OK"), button:has-text("Ok"), button:has-text("Aceptar"), button:has-text("ACEPTAR")');
                if (btn) {
                  try {
                    await btn.click({ timeout: 3000 });
                    await wait(400);
                    await focusSearchInput(page);
                    return true;
                  } catch (e) { }
                }
              } catch (e) { }
            }
          }

          try {
            const btnFollowing = page.locator(`xpath=//*[contains(normalize-space(.), "${t}")]/following::button[1]`);
            if (await btnFollowing.count() > 0) {
              try {
                await btnFollowing.first().click({ timeout: 3000 });
                await wait(400);
                await focusSearchInput(page);
                return true;
              } catch (e) { }
            }
          } catch (e) { }

          const genericBtn = page.locator('button:has-text("OK"), button:has-text("Ok"), button:has-text("Aceptar"), button:has-text("ACEPTAR")').first();
          if (await genericBtn.count() > 0) {
            try {
              await genericBtn.click({ timeout: 3000 });
              await wait(400);
              await focusSearchInput(page);
              return true;
            } catch (e) { }
          }

          const allButtons = await page.$$('button');
          for (const b of allButtons) {
            try {
              const txt = (await b.innerText()).trim().toLowerCase();
              if (/^(ok|aceptar|cerrar|entendido)$/i.test(txt) || /\bok\b/i.test(txt)) {
                try {
                  await b.click({ timeout: 2000 });
                  await wait(400);
                  await focusSearchInput(page);
                  return true;
                } catch (e) { }
              }
            } catch (e) { }
          }

          return false;
        }
      } catch (e) { }
    }

    try {
      const html = await page.content();
      if (/Finaliza el horario de Ingreso de Pedidos|Último horario de ingreso/i.test(html)) {
        const genericBtn2 = page.locator('button:has-text("OK"), button:has-text("Aceptar")').first();
        if (await genericBtn2.count() > 0) {
          try { await genericBtn2.click({ timeout: 3000 }); await wait(400); await focusSearchInput(page); return true; } catch (e) { }
        }
      }
    } catch (e) { }
  } catch (err) {
    console.warn('[HORARIO] Error en dismissHorarioModal:', err && (err.message || err));
  }
  return false;
}

/* --------------------- (NUEVO) Loop de búsqueda interactiva --------------------- */
function startInteractiveSearchLoop(page) {
  console.log('\n--- MODO BÚSQUEDA INTERACTIVA ---');
  console.log('@@@READY@@@');
  console.log('Escribí lo que querés buscar y apretá Enter. Escribí "exit" para salir.\n');

  rl.on('line', async (raw) => {
    const term = (raw || '').trim();
    if (!term) {
      console.log('Entrada vacía detectada. Para salir escribí "exit".');
      return;
    }
    if (term.toLowerCase() === 'exit') {
      console.log('Exit detectado. Cerrando...');
      try { await page.context().close(); } catch (e) { }
      process.exit(0); // <--- MODIFICACIÓN: Salir del proceso inmediatamente
    }
    try {
      await performSearchAndScrape(page, term);
    } catch (e) {
      console.error('Error durante la búsqueda/scrape:', e && e.message);
    } finally {
      await wait(300);
      console.log(`Finalizado para "${term}"`);
      try { console.log('@@@SKU_DONE@@@ ' + JSON.stringify({ term })); } catch (_) { }
    }
  });

  rl.on('close', () => {
    console.log('Cerrando proceso por fin de input stream.');
    process.exit(0); // <--- MODIFICACIÓN: Asegurar salida
  });
}


/* --------------------- FLOW principal --------------------- */
(async () => {
  console.log('Iniciando login Monroe (Chromium/Chrome) — tipeo instantáneo.'); // Mensaje actualizado

  const userDataDir = path.resolve('./monroe_user_data');
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  // Preferimos Chromium por defecto (sin channel forzado). Si CHROME_PATH está seteado, lo usamos.
  const launchOpts = {
    headless: HEADLESS,
    viewport: { width: 1366, height: 900 },
    args: ['--start-maximized']
  };
  if (CHROME_PATH) launchOpts.executablePath = CHROME_PATH;

  let context = null;
  let browserFallback = null;

  const tryLaunchPersistent = async (dir) => {
    return chromium.launchPersistentContext(dir, launchOpts);
  };

  try {
    context = await tryLaunchPersistent(userDataDir);
  } catch (e1) {
    try {
      const altDir = path.resolve(`${userDataDir}_tmp_${Date.now()}`);
      fs.mkdirSync(altDir, { recursive: true });
      context = await tryLaunchPersistent(altDir);
    } catch (e2) {
      try {
        // Fallback: navegador no persistente
        const args = (launchOpts.args || []);
        const opts = { headless: launchOpts.headless, args };
        if (launchOpts.executablePath) opts.executablePath = launchOpts.executablePath;
        browserFallback = await chromium.launch(opts);
        context = await browserFallback.newContext({ viewport: launchOpts.viewport });
      } catch (e3) {
        console.error('Fallo absoluto al iniciar el navegador:', e3.message || e3);
        process.exit(2);
      }
    }
  }

  const page = await context.newPage();

  try { await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) { console.warn('Error en goto:', e.message); }

  // login heuristics
  const emailSelectors = ['input[type=email]', 'input[type=text][name*=user]', 'input[name*=email]', 'input[id*=user]', 'input[id*=email]', 'input[name=username]', 'input[name=usuario]'];
  const passSelectors = ['input[type=password]', 'input[name*=pass]', 'input[id*=pass]'];

  const preThink = randomBetween(HUMAN_PRE_DELAY_MIN, HUMAN_PRE_DELAY_MAX);
  await wait(preThink);

  const loginTypingStart = nowMs();

  let typedUser = false;
  for (const s of emailSelectors) {
    const loc = page.locator(s).first();
    if (await loc.count() > 0) {
      await humanTypeOnLocator(page, loc, USERNAME, HUMAN_KEY_DELAY_MIN, HUMAN_KEY_DELAY_MAX); // Rápido
      typedUser = true;
      break;
    }
  }
  if (!typedUser) {
    const first = page.locator('input:visible').first();
    if (await first.count()) {
      await humanTypeOnLocator(page, first, USERNAME, HUMAN_KEY_DELAY_MIN, HUMAN_KEY_DELAY_MAX); // Rápido
    } else {
      await page.evaluate((u) => { const i = document.querySelector('input'); if (i) i.value = u; }, USERNAME).catch(() => { });
    }
  }

  await wait(randomBetween(120, 500));

  let typedPass = false;
  for (const s of passSelectors) {
    const loc = page.locator(s).first();
    if (await loc.count() > 0) {
      await humanTypeOnLocator(page, loc, PASSWORD, HUMAN_KEY_DELAY_MIN, HUMAN_KEY_DELAY_MAX); // Rápido
      typedPass = true;
      break;
    }
  }
  if (!typedPass) {
    const inputs = page.locator('input:visible');
    if (await inputs.count() >= 2) {
      await humanTypeOnLocator(page, inputs.nth(1), PASSWORD, HUMAN_KEY_DELAY_MIN, HUMAN_KEY_DELAY_MAX); // Rápido
    } else {
      await page.evaluate((p) => {
        const ps = Array.from(document.querySelectorAll('input[type=password]'));
        if (ps.length) ps[0].value = p;
      }, PASSWORD).catch(() => { });
    }
  }

  const postThink = randomBetween(HUMAN_POST_DELAY_MIN, HUMAN_POST_DELAY_MAX);
  await wait(postThink);

  const loginTypingEnd = nowMs();
  const elapsedTyping = loginTypingEnd - loginTypingStart;
  if (HUMAN_LOGIN_TIME_MS && HUMAN_LOGIN_TIME_MS > elapsedTyping) {
    const remaining = HUMAN_LOGIN_TIME_MS - elapsedTyping;
    const jitter = randomBetween(Math.max(0, Math.floor(remaining * 0.1)), Math.max(1, Math.floor(remaining * 0.3)));
    const wait1 = Math.max(0, Math.floor(remaining - jitter));
    const wait2 = jitter;
    await wait(wait1);
    try { await page.mouse.move(randomBetween(100, 600), randomBetween(50, 400), { steps: 5 }); } catch (e) { }
    await wait(wait2);
  }

  const clicked = await clickLoginButtonRobust(page);
  if (clicked) {
    try { await Promise.race([page.waitForNavigation({ timeout: 7000 }).catch(() => { }), wait(1800)]); } catch (e) { }
  }

  await wait(2000); // Espera para que aparezca el modal de captcha

  // --- (NUEVO) Detección de CAPTCHA ---
  let captchaModal = null;
  try {
    captchaModal = page.locator('*:has-text("Para una mayor seguridad...")').filter({
      has: page.locator('text="Por favor ingrese el código que muestra más abajo"')
    }).last();
  } catch (e) { }

  if (captchaModal && (await captchaModal.count() > 0)) {
    console.log('[CAPTCHA] Modal de CAPTCHA detectado.');

    let imageBase64 = '';
    try {
      const imgLocator = captchaModal.locator('img');
      const imgCount = await imgLocator.count();
      if (imgCount > 0) {
        // Tomar screenshot del elemento imagen
        const buffer = await imgLocator.first().screenshot();
        imageBase64 = `data:image/png;base64,${buffer.toString('base64')}`;
      }
    } catch (e) {
      console.warn('[CAPTCHA] Error al extraer imagen:', e.message);
    }

    if (imageBase64) {
      // Enviar señal a main.js con la imagen
      console.log(`@@@CAPTCHA_REQUIRED@@@${JSON.stringify({ imageBase64 })}`);

      // Esperar una sola línea de stdin (el código del captcha)
      rl.once('line', async (captchaCode) => {
        console.log(`[CAPTCHA] Código recibido: "${captchaCode}"`);
        if (!captchaCode) {
          console.error('[CAPTCHA] Se recibió un código vacío. Abortando.');
          rl.close();
          return;
        }

        try {
          // Encontrar el input dentro del modal
          const inputLocator = captchaModal.locator('input[type="text"], input:not([type])').first();
          if (await inputLocator.count() > 0) {
            await humanTypeOnLocator(page, inputLocator, captchaCode); // Rápido
            await wait(randomBetween(200, 500));

            // Clic en "Iniciar sesión" DENTRO del modal
            const clickedModal = await clickLoginButtonRobust(page, captchaModal);
            if (clickedModal) {
              await Promise.race([page.waitForNavigation({ timeout: 7000 }).catch(() => { }), wait(1800)]);
            }
            await wait(3000); // Espera post-captcha
          } else {
            console.error('[CAPTCHA] No se encontró el input para el código.');
          }
        } catch (e) {
          console.error('[CAPTCHA] Error al ingresar código:', e.message);
        }

        // Continuar con el flujo normal
        try {
          const dismissed = await dismissHorarioModal(page);
          if (!dismissed) await focusSearchInput(page);
        } catch (e) {
          await focusSearchInput(page);
        }

        startInteractiveSearchLoop(page);
      });

    } else {
      console.error('[CAPTCHA] Modal detectado, pero no se pudo extraer la imagen. Abortando.');
      rl.close();
    }

  } else {
    // --- Flujo SIN CAPTCHA ---
    console.log('No se detectó modal de CAPTCHA, continuando...');
    try {
      const dismissed = await dismissHorarioModal(page);
      if (!dismissed) await focusSearchInput(page);
    } catch (e) {
      await focusSearchInput(page);
    }

    startInteractiveSearchLoop(page);
  }

})();