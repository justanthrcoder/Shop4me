// renderer.js — Shop4me (Ascend)
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------- Constantes de paginación ---------- */
const INITIAL_DISPLAY_LIMIT = 50;
const LOAD_MORE_INCREMENT = 100;

/* ---------- Element References ---------- */
// General UI
const appRoot = $('#appRoot');
const sidebar = $('#sidebar');
const drawerBackdrop = $('#drawerBackdrop');
const statusEl = $('#status');

// Tabs & Panes
const tabBtns = {
  search: $('#tabSearchBtn'),
  compare: $('#tabCompareBtn'),
  scraper: $('#tabScraperBtn'),
  settings: $('#tabSettingsBtn'),
};
const panes = {
  search: $('#tab-search'),
  compare: $('#tab-compare'),
  scraper: $('#tab-scraper'),
  settings: $('#tab-settings'),
};

// Search Bar Elements
const searchBar = $('#searchBar');
const qInput = $('#q');
const predictiveResultsEl = $('#predictiveResults');
const runBtn = $('#runBtn');
const addToCompareBtn = $('#addToCompareBtn');
const fileBtn = $('#fileTrigger');
const fileInput = $('#fileInput');
const clearFileBtn = $('#clearFileBtn');
const fileItemListEl = $('#fileItemList');
const itemsLoadedCard = $('#itemsLoadedCard');
const itemsCountEl = $('#itemsCount');
const filterFileItemsInput = $('#filterFileItems');

// Compare Tab Elements
const compareWrap = $('#compareWrap');
const totalsAmt = $('#totalsAmt');
const avgSaveEl = $('#avgSave');
const totalsBar = $('#totalsBar');
const compareLoading = $('#compareLoading');
const progressBar = $('#progressBar');
const progressHint = $('#progressHint');
const progressText = $('#progressText');
const progressEta = $('#progressEta');
const compareActions = $('#compareActions');

// CAPTCHA Elements
const captchaModal = $('#captchaModal');
const captchaImage = $('#captchaImage');
const captchaInput = $('#captchaInput');
const captchaSubmitBtn = $('#captchaSubmitBtn');

// Log Elements
const logs = {
  monroe: $('#log-monroe'),
  delsud: $('#log-delsud'),
  suizo: $('#log-suizo'),
};

// --- NUEVO: Botones de Stop para Scrapers ---
const stopBtns = {
  monroe: $('#btn-stop-monroe'),
  delsud: $('#btn-stop-delsud'),
  suizo: $('#btn-stop-suizo'),
};

// Priority Modal Elements
const priorityBtn = $('#tab-compare #priorityBtn');
const priorityModal = $('#priorityModal');
const priorityBackdrop = $('#priorityBackdrop');
const priorityCloseBtn = $('#priorityCloseBtn');
const priorityList = $('#priorityList');
const priorityToleranceInput = $('#priorityTolerance');

// Settings Elements
const settingsForm = $('#settingsForm');
const saveSettingsBtn = $('#saveSettingsBtn');
const settingsStatusEl = $('#settingsStatus');

// Switches
const intensiveModeSwitch = $('#intensiveModeSwitch');
const monroeFileAlgorithmSwitch = $('#monroeFileAlgorithmSwitch');
const delsudFileAlgorithmSwitch = $('#delsudFileAlgorithmSwitch');
const suizoFileAlgorithmSwitch = $('#suizoFileAlgorithmSwitch');

const credInputs = {
  delsud_user: $('#delsud_user'),
  delsud_pass: $('#delsud_pass'),
  suizo_user: $('#suizo_user'),
  suizo_pass: $('#suizo_pass'),
  monroe_user: $('#monroe_user'),
  monroe_pass: $('#monroe_pass'),
};

const generalInputs = {
  chrome_path: $('#chrome_path')
};

const selectChromeBtn = $('#selectChromeBtn');

const settingsNavBtns = $$('.settings-nav-btn');
const settingsPanes = $$('.settings-pane');

/* ---------- Drawer lateral (Eliminado, limpiando referencias) ---------- */
drawerBackdrop?.addEventListener('click', () => appRoot?.classList.remove('menu-open'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    appRoot?.classList.remove('menu-open');
    showPriorityModal(false);
    predictiveResultsEl?.classList.add('hidden');
  }
});

/* ---------- Tabs (sidebar) ---------- */
function setSearchBarVisibility(tabName) {
  if (!searchBar) return;
  if (tabName !== 'search') {
    searchBar.classList.add('hidden');
  } else {
    searchBar.classList.remove('hidden');
  }
}

function activate(tabName) {
  if (
    tabName === 'compare' &&
    tabBtns.compare?.style.display === 'none' &&
    !tabBtns.compare?.classList.contains('active')
  ) {
    return;
  }
  Object.values(tabBtns).forEach((b) => b?.classList.remove('active'));
  Object.values(panes).forEach((p) => p?.classList.add('hidden'));
  tabBtns[tabName]?.classList.add('active');
  panes[tabName]?.classList.remove('hidden');
  setSearchBarVisibility(tabName);
  appRoot?.classList.remove('menu-open');
}

tabBtns.search?.addEventListener('click', () => activate('search'));
tabBtns.compare?.addEventListener('click', () => activate('compare'));
tabBtns.scraper?.addEventListener('click', () => activate('scraper'));
tabBtns.settings?.addEventListener('click', () => activate('settings'));

if (window.api?.onScraperVisible) {
  window.api.onScraperVisible((visible) => {
    if (!tabBtns.scraper) return;
    tabBtns.scraper.style.display = visible ? 'flex' : 'none';
    if (!visible && panes.scraper && !panes.scraper.classList.contains('hidden')) {
      activate('search');
    }
  });
}

/* ---------- Estado ---------- */
let fileItems = [];
let displayedFileItemsCount = INITIAL_DISPLAY_LIMIT;
let fileFilterTerm = '';
let compareItems = [];
let nextId = 1;
let isBatchRunning = false;
let batchStartTime = 0;
let progressState = { completedUnits: 0, totalUnits: 0 };

const PROVIDER_LABEL = {
  delsud: 'Del Sud',
  suizo: 'Suizo Argentina',
  monroe: 'Monroe Americana',
};

let priorityOrder = ['delsud', 'suizo', 'monroe'];
let priorityTolerance = 0;
let productDB = new Map();

/* ---------- Logs ---------- */
function appendLog(name, line) {
  const el = logs[name];
  if (!el) return;
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}
function clearLogs() {
  Object.values(logs).forEach((el) => {
    if (el) el.textContent = '';
  });
}

/* ---------- Utils ---------- */
function parseCurrencyToNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/[^\d.,-]/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    if (lastDot > lastComma) {
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(/\./g, '').replace(',', '.');
    }
  } else if (lastComma !== -1) {
    const parts = s.split(',');
    if (parts.length > 2 || (parts[1] && parts[1].length === 3 && parts[0].length > 0)) {
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(',', '.');
    }
  }
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

function fmtARS(n) {
  return n == null || Number.isNaN(n)
    ? '—'
    : n.toLocaleString('es-AR', {
      style: 'currency',
      currency: 'ARS',
      maximumFractionDigits: 2,
    });
}

function fmtPct(frac) {
  if (frac == null || !isFinite(frac)) return '—';
  return frac.toLocaleString('es-AR', {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function stockToBool(v) {
  const s = (v || '').toString().trim().toLowerCase();
  if (!s) return true;
  if (/^si|sí|ok|hay|1|true|disponible$/i.test(s)) return true;
  if (/^\d+$/.test(s)) return Number(s) > 0;
  return !/no|sin|agotad|0|no disponible/i.test(s);
}

function parseMin(text) {
  const s = text ? String(text) : '';
  if (!s) return null;
  let m = s.match(/\b(min|mín|mult|múlt)\b\W*(\d{1,4})\b/i);
  if (m && m[2]) return parseInt(m[2], 10);
  m = s.match(/^\s*(\d{1,4})\s*$/);
  if (m && m[1]) return parseInt(m[1], 10);
  return null;
}

function escapeHtml(s) {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const canon = (s) => (s || '').toString().trim().replace(/\s+/g, ' ').toLowerCase();
const plural = (n, one, many) => (n === 1 ? one : many);

/* ---------- Identidad de producto (EAN + nombre) ---------- */
const stripBom = (s) => String(s || '').replace(/^\uFEFF/, '');

function normalizeEAN(raw) {
  if (raw == null) return '';
  const s = stripBom(String(raw)).trim();
  const m = s.match(/\b(\d{8,14})\b/);
  if (m) return m[1];
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 8 && digits.length <= 14) return digits;
  return '';
}

function isEANLike(s) {
  return /^\d{8,14}$/.test(String(s || '').trim());
}

function cleanName(raw) {
  return stripBom(String(raw || ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function nameScore(name) {
  const n = cleanName(name);
  if (!n || n === '—') return 0;
  if (isEANLike(n)) return 1;
  return Math.min(10, 2 + n.length / 8);
}

function dbNameFor(term, sku) {
  const eSku = normalizeEAN(sku);
  if (eSku && productDB?.size) {
    const n = productDB.get(eSku);
    if (n) return n;
  }
  const eTerm = normalizeEAN(term);
  if (eTerm && productDB?.size) {
    const n = productDB.get(eTerm);
    if (n) return n;
  }
  return '';
}

function resolveBestName({ term, sku, providers, currentName }) {
  const t = cleanName(term);
  const e = normalizeEAN(sku) || normalizeEAN(term);

  const provCandidates = [
    providers?.delsud?.name,
    providers?.suizo?.name,
    providers?.monroe?.name,
    providers?.delsud?.raw?.producto,
    providers?.suizo?.raw?.nombreProducto,
    providers?.suizo?.raw?.descripcion,
    providers?.monroe?.raw?.product,
  ]
    .map(cleanName)
    .filter(Boolean)
    .filter((x) => x !== '—')
    .filter((x) => !isEANLike(x));

  const providerName = provCandidates[0] || '';
  const dbName = dbNameFor(t, e);
  const cur = cleanName(currentName);

  if (dbName) {
    const curIsWeak = nameScore(cur) <= 2;
    const provIsWeak = nameScore(providerName) <= 2;
    const looksTruncated = providerName && dbName && providerName.length < dbName.length * 0.6;

    if (curIsWeak || provIsWeak || looksTruncated || cur === t) {
      return dbName;
    }
  }

  if (providerName) return providerName;
  if (t && !isEANLike(t)) return t;
  return '(sin descripción)';
}

function syncItemIdentity(item) {
  if (!item) return;

  const fromProviders =
    normalizeEAN(item.providers?.delsud?.ean) ||
    normalizeEAN(item.providers?.suizo?.ean) ||
    normalizeEAN(item.providers?.monroe?.ean) ||
    normalizeEAN(item.providers?.delsud?.raw?.ean) ||
    normalizeEAN(item.providers?.suizo?.raw?.ean) ||
    normalizeEAN(item.providers?.monroe?.raw?.ean);

  const normalizedSku = normalizeEAN(item.sku) || fromProviders || normalizeEAN(item.term);
  if (normalizedSku) item.sku = normalizedSku;

  const best = resolveBestName({
    term: item.term,
    sku: item.sku,
    providers: item.providers,
    currentName: item.name,
  });

  if (nameScore(best) > nameScore(item.name) || isEANLike(item.name)) {
    item.name = best;
  }
}

function displayTitleForItem(item) {
  const n = cleanName(item?.name);
  if (!n || n === '—' || isEANLike(n)) return '(sin descripción)';
  return n;
}

/* ---------- Búsqueda predictiva MEJORADA (Weighted Scoring) ---------- */
function searchProductDB(query) {
  const cleanQuery = canon(query);
  if (!cleanQuery || cleanQuery.length < 2) return [];

  const candidates = [];
  const queryTokens = cleanQuery.split(' ').filter(t => t.length > 0);
  const isQueryEanLike = isEANLike(cleanQuery);

  for (const [ean, rawName] of productDB.entries()) {
    const name = String(rawName);
    const normName = canon(name);
    const normEan = String(ean);

    let score = 0;

    if (isQueryEanLike) {
      if (normEan === cleanQuery) {
        score += 10000;
      } else if (normEan.startsWith(cleanQuery)) {
        score += 5000;
      } else if (normEan.includes(cleanQuery)) {
        score += 1000;
      }
    } else {
      if (normEan.includes(cleanQuery)) {
        score += 500;
      }
    }

    if (normName === cleanQuery) {
      score += 2000;
    }
    else if (normName.startsWith(cleanQuery)) {
      score += 500;
    }

    let tokensFoundCount = 0;
    let tokensStartingCount = 0;

    for (const token of queryTokens) {
      const idx = normName.indexOf(token);
      if (idx !== -1) {
        tokensFoundCount++;
        if (idx === 0 || normName[idx - 1] === ' ') {
          tokensStartingCount++;
          score += 50;
        } else {
          score += 10;
        }
      }
    }

    if (tokensFoundCount === queryTokens.length) {
      score += 300;
    }

    if (tokensStartingCount === queryTokens.length) {
      score += 100;
    }

    score -= (normName.length * 0.1);

    if (score > 20) {
      candidates.push({ ean, name, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 20);
}

function renderPredictiveResults(results) {
  if (!predictiveResultsEl || !qInput) return;

  predictiveResultsEl.style.width = `${qInput.offsetWidth}px`;

  if (!results || results.length === 0) {
    if (qInput.value.length >= 2) {
      predictiveResultsEl.innerHTML =
        '<div class="predictive-empty">No se encontraron productos coincidentes.</div>';
      predictiveResultsEl.classList.remove('hidden');
    } else {
      predictiveResultsEl.classList.add('hidden');
    }
    return;
  }

  predictiveResultsEl.innerHTML = '';
  results.forEach((item) => {
    const itemEl = document.createElement('div');
    itemEl.className = 'predictive-item';

    itemEl.innerHTML = `
      <div class="predictive-item-name">${escapeHtml(item.name)}</div>
      <div class="predictive-item-ean">${escapeHtml(item.ean)}</div>
    `;

    itemEl.addEventListener('click', (e) => {
      qInput.value = item.ean;
      predictiveResultsEl.classList.add('hidden');
      if (addToCompareBtn) addToCompareBtn.click();
    });
    predictiveResultsEl.appendChild(itemEl);
  });

  predictiveResultsEl.classList.remove('hidden');
}

/* ---------- Map rows ---------- */
function mapProvider(provider, row) {
  if (!row) return null;

  if (provider === 'delsud') {
    const pvpVal = parseCurrencyToNumber(row.pvp);
    const discVal = parseCurrencyToNumber(row.con_desc || row.precio_c_desc);

    let discount_pct = null;
    if (row.oferta && typeof row.oferta === 'string' && row.oferta.includes('%')) {
      const rawPct = parseCurrencyToNumber(row.oferta.replace('%', ''));
      if (rawPct != null) discount_pct = rawPct / 100.0;
    }
    if (discount_pct == null && pvpVal != null && discVal != null && pvpVal > discVal) {
      discount_pct = (pvpVal - discVal) / pvpVal;
    }

    return {
      name: row.producto || '',
      pvp: pvpVal,
      disc: discVal,
      min: parseMin(row.min),
      inStock: stockToBool(row.stock),
      provider: PROVIDER_LABEL.delsud,
      key: 'delsud',
      raw: row,
      discount_pct,
      ean: normalizeEAN(row.ean || row.sku || null) || null
    };
  }

  if (provider === 'suizo') {
    const pvpVal = parseCurrencyToNumber(row.precio || row.suPrecio);
    const discVal = parseCurrencyToNumber(row.con_desc || row.precioConDescuento);

    const effectivePvp = pvpVal;
    const effectiveDisc = discVal;

    let discount_pct = null;
    if (row.oferta) {
      const rawPct = parseCurrencyToNumber(row.oferta);
      if (rawPct != null && rawPct > 0 && rawPct < 100) {
        discount_pct = rawPct / 100.0;
      }
    }
    if (discount_pct == null && effectivePvp != null && effectiveDisc != null && effectivePvp > effectiveDisc) {
      discount_pct = (effectivePvp - effectiveDisc) / effectivePvp;
    }

    return {
      name: row.producto || '',
      pvp: effectivePvp,
      disc: effectiveDisc,
      min: parseMin(row.min),
      inStock: stockToBool(row.stock),
      provider: PROVIDER_LABEL.suizo,
      key: 'suizo',
      raw: row,
      discount_pct,
      ean: normalizeEAN(row.ean || null) || null
    };
  }

  if (provider === 'monroe') {
    const pvpVal = parseCurrencyToNumber(row.precio);
    const discVal = parseCurrencyToNumber(row.con_desc);

    let discount_pct = null;
    if (pvpVal != null && discVal != null && pvpVal > discVal) {
      discount_pct = (pvpVal - discVal) / pvpVal;
    }

    return {
      name: row.producto || '',
      pvp: pvpVal,
      disc: discVal,
      min: parseMin(row.min),
      inStock: stockToBool(row.stock),
      provider: PROVIDER_LABEL.monroe,
      key: 'monroe',
      raw: row,
      discount_pct,
      ean: normalizeEAN(row.ean || null) || null
    };
  }

  return null;
}

function decidePrice(entry, q) {
  if (!entry || !entry.inStock)
    return { mode: 'nostock', price: null, originalPrice: null, discount_pct: null };

  const qty = q || 0;
  const minQty = entry.min || null;
  const meetsMinRequirement = minQty ? qty >= minQty : true;

  let finalPrice = null;
  let originalPrice = null;
  let mode = 'publico';
  let discount_pct = entry.discount_pct || null;

  const pvpVal = entry.pvp;
  const discVal = entry.disc;

  if (meetsMinRequirement && discVal != null) {
    finalPrice = discVal;
    mode = 'disc';
    if (pvpVal != null && pvpVal !== discVal) originalPrice = pvpVal;
  } else if (pvpVal != null) {
    finalPrice = pvpVal;
    mode = 'pvp';
    if (!meetsMinRequirement && discVal != null && discVal !== pvpVal) {
      originalPrice = discVal;
    }
  } else if (discVal != null) {
    finalPrice = discVal;
    mode = 'disc_only';
  }

  if (
    discount_pct == null &&
    finalPrice != null &&
    originalPrice != null &&
    originalPrice > finalPrice &&
    (mode === 'disc')
  ) {
    discount_pct = (originalPrice - finalPrice) / originalPrice;
  }

  if (meetsMinRequirement && discount_pct != null && (mode === 'disc')) {
    return { mode, price: finalPrice, originalPrice, discount_pct };
  }

  return { mode, price: finalPrice, originalPrice, discount_pct: null };
}

function pickRow(arr) {
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}

/* ---------- Comparador UI ---------- */
function showLoading(on) {
  if (!compareLoading) return;

  if (on) {
    compareLoading.classList.remove('hidden');
    compareLoading.classList.add('show');
    if (compareWrap) {
      compareWrap.style.opacity = '0';
      compareWrap.style.pointerEvents = 'none';
    }
    totalsBar?.classList.add('hidden');
    compareActions?.classList.add('hidden');
  } else {
    compareLoading.classList.remove('show');

    if (panes.compare && panes.compare.classList.contains('hidden')) {
      compareLoading.classList.add('hidden');
    }
    if (compareWrap) {
      compareWrap.style.opacity = '1';
      compareWrap.style.pointerEvents = 'auto';
    }
    totalsBar?.classList.remove('hidden');
    compareActions?.classList.remove('hidden');
  }
}

function setProgress(completed, total) {
  progressState = { completedUnits: completed, totalUnits: total };
  const pct = total ? Math.round((completed / total) * 100) : 0;
  if (progressBar) progressBar.style.width = `${pct}%`;
  if (progressHint) progressHint.textContent = `${pct}%`;
  if (progressText)
    progressText.textContent = `Preparando comparativa… (${completed}/${total})`;

  // Calcular ETA
  if (progressEta && isBatchRunning && completed > 0 && batchStartTime > 0 && total > completed) {
    const elapsed = Date.now() - batchStartTime;
    const avgTimePerUnit = elapsed / completed;
    const remainingUnits = total - completed;
    const etaMs = avgTimePerUnit * remainingUnits;
    const minutes = Math.ceil(etaMs / 60000);

    progressEta.textContent = `Quedan aproximadamente ${minutes} minuto(s)`;
  } else if (progressEta) {
    if (completed === 0 && isBatchRunning) {
      progressEta.textContent = 'Calculando tiempo restante...';
    } else if (total > 0 && completed >= total) {
      progressEta.textContent = 'Finalizando...';
    } else {
      progressEta.textContent = '';
    }
  }
}

function findExistingItem({ name, sku, term }) {
  const cn = canon(name || '');
  const ct = canon(term || '');
  const skuN = normalizeEAN(sku);
  const termN = normalizeEAN(term);

  return (
    compareItems.find((it) => {
      const itSkuN = normalizeEAN(it.sku);
      const itTermN = normalizeEAN(it.term);

      if (skuN && itSkuN && itSkuN === skuN) return true;
      if (termN && itTermN && itTermN === termN) return true;

      if (ct && canon(it.term) === ct) return true;
      if (cn && canon(it.name) === cn) return true;

      const rawNames = Object.values(it.providers)
        .map((p) => p?.raw?.producto || p?.raw?.nombreProducto || p?.raw?.descripcion)
        .filter(Boolean)
        .map(canon);

      if (cn && rawNames.some((rn) => rn === cn)) return true;
      return false;
    }) || null
  );
}

function computeBestKey(item) {
  const opts = Object.entries(item.providers)
    .map(([key, entry]) => {
      if (!entry || !entry.inStock) return null;
      const d = decidePrice(entry, item.qty);
      return d.price != null ? { key, price: d.price } : null;
    })
    .filter(Boolean);

  if (!opts.length) return null;

  opts.sort((a, b) => a.price - b.price);
  const cheapestOpt = opts[0];
  if (!cheapestOpt) return null;

  let priorityAvailableKey = null;
  for (const key of priorityOrder) {
    if (opts.some((o) => o.key === key)) {
      priorityAvailableKey = key;
      break;
    }
  }

  if (!priorityAvailableKey || priorityAvailableKey === cheapestOpt.key) {
    return cheapestOpt.key;
  }

  const priorityPrice = opts.find((o) => o.key === priorityAvailableKey).price;
  const cheapestPrice = cheapestOpt.price;

  if (priorityTolerance > 0 && priorityPrice - cheapestPrice <= priorityTolerance) {
    return priorityAvailableKey;
  } else {
    return cheapestOpt.key;
  }
}

function addOrMergeItem(payload) {
  const m = payload.monroe ? mapProvider('monroe', pickRow(payload.monroe)) : null;
  const d = payload.delsud ? mapProvider('delsud', pickRow(payload.delsud)) : null;
  const s = payload.suizo ? mapProvider('suizo', pickRow(payload.suizo)) : null;

  const eanCandidate =
    normalizeEAN(m?.ean) ||
    normalizeEAN(d?.ean) ||
    normalizeEAN(s?.ean) ||
    normalizeEAN(m?.raw?.ean) ||
    normalizeEAN(d?.raw?.ean) ||
    normalizeEAN(s?.raw?.ean) ||
    normalizeEAN(payload.term);

  const sku = eanCandidate || '';

  let item = null;
  if (payload.term) item = findExistingItem({ term: payload.term });
  if (!item && sku) item = findExistingItem({ sku });
  if (!item) {
    const possibleName = d?.name || s?.name || m?.name || payload.term || '';
    if (possibleName && !isEANLike(possibleName)) item = findExistingItem({ name: possibleName });
  }

  if (item) {
    if (d) item.providers.delsud = d;
    if (s) item.providers.suizo = s;
    if (m) item.providers.monroe = m;

    if (sku) item.sku = sku;

    syncItemIdentity(item);

    item.bestKey = computeBestKey(item);
    if (!item.userSelected) item.selected = item.bestKey;
    return;
  }

  const newItem = {
    id: nextId++,
    term: payload.term || '',
    sku: sku || (isEANLike(payload.term) ? normalizeEAN(payload.term) : ''),
    name: '(sin descripción)',
    qty: 1,
    providers: {
      delsud: d || null,
      suizo: s || null,
      monroe: m || null,
    },
    selected: null,
    bestKey: null,
    userSelected: false,
  };

  syncItemIdentity(newItem);

  newItem.bestKey = computeBestKey(newItem);
  newItem.selected = newItem.bestKey;
  compareItems.push(newItem);
}

function providerHasSelection(key) {
  return compareItems.some(
    (it) =>
      it.selected === key &&
      (it.qty || 0) > 0 &&
      it.providers[key] &&
      it.providers[key].inStock,
  );
}

function generateProviderFile(key) {
  if (!providerHasSelection(key)) return null;

  const lines = [];

  const formatFixedPed = (ean, name, qty) => {
    const e = (ean || '').padEnd(13, ' ').substring(0, 13);
    const n = (name || '').toUpperCase().replace(/[^A-Z0-9\s]/g, '').padEnd(30, ' ').substring(0, 30);
    const q = String(qty).padStart(3, '0').substring(0, 3);
    return `${e}${n}${q}`;
  };

  const formatMonroeCsv = (ean, name, qty) => {
    return `${ean};${qty};${name}`;
  };

  for (const it of compareItems) {
    if (it.selected !== key) continue;

    const qty = Math.max(0, it.qty || 0);
    if (!qty) continue;

    const entry = it.providers[key];
    if (!entry || !entry.inStock) continue;

    const identifier = normalizeEAN(it.sku) || normalizeEAN(entry.ean) || normalizeEAN(it.term) || '';
    if (!identifier) continue;

    const name = displayTitleForItem(it);

    if (key === 'delsud' || key === 'suizo') {
      lines.push(formatFixedPed(identifier, name, qty));
    } else if (key === 'monroe') {
      lines.push(formatMonroeCsv(identifier, name, qty));
    }
  }

  if (lines.length === 0) return null;

  if (key === 'monroe') {
    return 'EAN;CANTIDAD;DESCRIPCION\n' + lines.join('\n');
  }

  return lines.join('\r\n');
}

async function saveTxtDialog(defaultName, content) {
  if (!content) return;
  if (window.api?.saveTxt) {
    try {
      await window.api.saveTxt({ defaultPath: defaultName, content });
    } catch {
      // ignore
    }
  } else {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  }
}

function rerenderComparator() {
  renderComparator();
  updateTotals();
}

/* ---------- Generación de HTML para una fila (para Diffing) ---------- */
function buildRowHTML(item) {
  syncItemIdentity(item);
  item.bestKey = computeBestKey(item);
  if (!item.userSelected && item.selected !== item.bestKey) item.selected = item.bestKey;

  const eanDisplay = item.sku
    ? `EAN: ${escapeHtml(item.sku)}`
    : item.term
      ? `Término: ${escapeHtml(item.term)}`
      : '';
  const eanValue = item.sku || item.term || '';
  const eanHtml = eanValue
    ? `<span class="copyable-ean" title="Copiar EAN">${eanDisplay}</span>`
    : eanDisplay;

  let leftCell = `
      <div class="prod-stack">
        <div class="prod-title">
          ${escapeHtml(displayTitleForItem(item))}
          <span class="row-x" title="Eliminar">✕</span>
        </div>
        <div class="prod-sku">${eanHtml}</div>
        <div class="qty-box">
          <button type="button" class="qtyMinus">−</button>
          <input class="qtyInput" type="number" min="0" value="${item.qty}" />
          <button type="button" class="qtyPlus">+</button>
          <span class="pill">Cantidad</span>
        </div>
      </div>
  `;

  let providersCells = '';
  ['delsud', 'suizo', 'monroe'].forEach((key) => {
    const entry = item.providers[key];
    let cellContent = '';
    let cellClasses = 'comp-cell comp-supplier';
    let isWinner = (item.bestKey === key);

    if (!entry || !entry.inStock) {
      cellClasses += ' disabled';
      cellContent = `
        <input class="radio" type="radio" name="win-${item.id}" disabled />
        <span class="no-stock">${entry ? 'Sin stock' : 'No disponible'}</span>
        ${entry?.min ? `<span class="minpill">Min: ${entry.min}</span>` : '<span class="minpill">Sin Min</span>'}
      `;
    } else {
      const d = decidePrice(entry, item.qty);
      const checked = item.selected === key ? 'checked' : '';
      if (isWinner) cellClasses += ' is-winner';

      const mutedPriceHtml =
        d.originalPrice != null && d.originalPrice !== d.price
          ? `<div class="price-muted">${fmtARS(d.originalPrice)}</div>`
          : '';

      let discountHtml = '';
      if (entry.min && d.discount_pct != null && d.discount_pct > 0) {
        discountHtml = `
          <div class="pill" style="color:var(--ok); border-color:var(--ok); margin-top:4px;">
            ${fmtPct(d.discount_pct)} OFF (a partir de ${entry.min} u.)
          </div>
        `;
      }

      cellContent = `
        <input class="radio" type="radio" name="win-${item.id}" value="${key}" ${checked} />
        <div class="price-col">
          <div class="price">${fmtARS(d.price)}</div>
          ${mutedPriceHtml}
          ${discountHtml}
        </div>
        ${entry.min ? `<span class="minpill">Min: ${entry.min}</span>` : '<span class="minpill">Sin Min</span>'}
      `;
    }

    providersCells += `<div class="${cellClasses}" data-provider="${key}">${cellContent}</div>`;
  });

  return `<div class="comp-cell">${leftCell}</div>${providersCells}`;
}

function bindRowListeners(row, item) {
  const copyEanElement = $('.copyable-ean', row);
  if (copyEanElement) {
    const eanValue = item.sku || item.term || '';
    if (eanValue) {
      copyEanElement.addEventListener('click', (ev) => {
        ev.stopPropagation();
        navigator.clipboard.writeText(eanValue).then(() => {
          setStatus(`EAN ${eanValue} copiado!`);
          copyEanElement.textContent = '¡Copiado!';
          setTimeout(() => {
            copyEanElement.textContent = item.sku ? `EAN: ${item.sku}` : `Término: ${item.term}`;
          }, 1500);
        }).catch(err => setStatus(`Error al copiar: ${err.message}`));
      });
    }
  }

  $('.row-x', row)?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    compareItems = compareItems.filter((it) => it.id !== item.id);
    rerenderComparator();
  });

  const minus = $('.qtyMinus', row);
  const plus = $('.qtyPlus', row);
  const input = $('.qtyInput', row);

  const updateQuantityAndRerender = (newQty) => {
    const v = Math.max(0, newQty);
    item.qty = v;
    item.bestKey = computeBestKey(item);
    if (!item.userSelected) item.selected = item.bestKey;
    rerenderComparator();
  };

  minus?.addEventListener('click', () => updateQuantityAndRerender((parseInt(input?.value, 10) || 0) - 1));
  plus?.addEventListener('click', () => updateQuantityAndRerender((parseInt(input?.value, 10) || 0) + 1));
  input?.addEventListener('change', () => updateQuantityAndRerender(parseInt(input.value, 10) || 0));

  $$('.comp-supplier', row).forEach((cell) => {
    if (!cell.classList.contains('disabled')) {
      cell.addEventListener('click', () => {
        const key = cell.dataset.provider;
        item.selected = key;
        item.userSelected = true;
        rerenderComparator();
      });
    }
  });
}

/* ---------- Render con DOM DIFFING (Sin parpadeo) ---------- */
function renderComparator() {
  if (!compareWrap) return;

  if (!compareWrap.querySelector('.comp-header')) {
    compareWrap.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'comp-header';
    header.innerHTML = `
      <div>Producto</div>
      <div>
        <span>Del Sud</span>
        <button class="btn btn-ghost" style="padding:6px 10px;font-size:12px;" data-key="delsud">☁️ Descargar PED</button>
      </div>
      <div>
        <span>Suizo Argentina</span>
        <button class="btn btn-ghost" style="padding:6px 10px;font-size:12px;" data-key="suizo">☁️ Descargar PED</button>
      </div>
      <div>
        <span>Monroe Americana</span>
        <button class="btn btn-ghost" style="padding:6px 10px;font-size:12px;" data-key="monroe">☁️ Descargar CSV</button>
      </div>
    `;
    compareWrap.appendChild(header);

    $$('button[data-key]', header).forEach((btn) => {
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        const key = btn.getAttribute('data-key');
        if (!key || !providerHasSelection(key)) return;

        const txt = generateProviderFile(key);
        let filename = '';
        if (key === 'delsud') filename = 'pedido_delsud.txt';
        else if (key === 'suizo') filename = 'pedido_suizo.pedsec';
        else if (key === 'monroe') filename = 'pedido_monroe.csv';

        if (txt) await saveTxtDialog(filename, txt);
      };
    });
  }

  $$('.comp-header button[data-key]').forEach((btn) => {
    btn.disabled = !providerHasSelection(btn.getAttribute('data-key'));
  });

  const existingRows = Array.from(compareWrap.querySelectorAll('.comp-row:not(.comp-summary)'));
  const currentItemIds = new Set(compareItems.map(i => i.id));

  existingRows.forEach(row => {
    const id = parseInt(row.dataset.id);
    if (!currentItemIds.has(id)) {
      row.remove();
    }
  });

  let lastRow = compareWrap.querySelector('.comp-header');

  compareItems.forEach(item => {
    let row = compareWrap.querySelector(`.comp-row[data-id="${item.id}"]`);
    const newHtmlContent = buildRowHTML(item);

    if (row) {
      if (row.innerHTML !== newHtmlContent) {
        row.innerHTML = newHtmlContent;
        bindRowListeners(row, item);
      } else {
        const qtyInput = row.querySelector('.qtyInput');
        if (qtyInput && parseInt(qtyInput.value) !== item.qty) {
          qtyInput.value = item.qty;
        }
      }
    } else {
      row = document.createElement('div');
      row.className = 'comp-row new-row';
      row.dataset.id = item.id;
      row.innerHTML = newHtmlContent;

      if (lastRow && lastRow.nextSibling) {
        compareWrap.insertBefore(row, lastRow.nextSibling);
      } else {
        compareWrap.appendChild(row);
      }

      bindRowListeners(row, item);
    }
    lastRow = row;
  });

  let sumRow = compareWrap.querySelector('.comp-summary');
  if (!sumRow) {
    sumRow = document.createElement('div');
    sumRow.className = 'comp-row comp-summary';
    compareWrap.appendChild(sumRow);
  } else {
    compareWrap.appendChild(sumRow);
  }

  const { shares } = computeProviderShares();

  let sumHtml = `<div class="comp-cell"><div class="summary-meta">Distribución de la compra</div></div>`;
  ['delsud', 'suizo', 'monroe'].forEach((key) => {
    const sh = shares[key];
    const pctText = fmtPct(sh.fraction ?? 0);
    const prods = sh.products || 0;
    const units = sh.units || 0;
    const prodLbl = plural(prods, 'producto', 'productos');
    const unitLbl = plural(units, 'unidad', 'unidades');
    sumHtml += `
      <div class="comp-cell">
        <div>
          <div class="totals-amt">${pctText}</div>
          <div class="summary-meta">${prods} ${prodLbl} • ${units} ${unitLbl}</div>
        </div>
      </div>
    `;
  });

  if (sumRow.innerHTML !== sumHtml) {
    sumRow.innerHTML = sumHtml;
  }
}

/* ---------- Totales y ahorro ponderado ---------- */
function computeItemPrice(item) {
  if (!item.selected) return 0;
  const entry = item.providers[item.selected];
  if (!entry || !entry.inStock) return 0;
  const d = decidePrice(entry, item.qty);
  return d.price != null ? d.price : 0;
}

function getAllAvailablePricesForItem(item) {
  const prices = [];
  for (const entry of Object.values(item.providers)) {
    if (!entry || !entry.inStock) continue;
    const d = decidePrice(entry, item.qty);
    if (d.price != null) prices.push(d.price);
  }
  return prices;
}

function computeAhorroPonderado() {
  let mostExpensiveTotal = 0;
  let selectedTotal = 0;

  for (const it of compareItems) {
    const qty = it.qty || 0;
    if (!it.selected || qty <= 0) continue;

    const selPrice = computeItemPrice(it);
    if (selPrice == null || selPrice <= 0) continue;

    const allPrices = getAllAvailablePricesForItem(it);
    if (!allPrices.length) continue;

    const maxPrice = Math.max(...allPrices);
    if (maxPrice == null || !isFinite(maxPrice) || maxPrice <= 0) continue;

    mostExpensiveTotal += maxPrice * qty;
    selectedTotal += selPrice * qty;
  }

  if (mostExpensiveTotal <= 0 || selectedTotal >= mostExpensiveTotal) {
    return { fraction: 0, amount: 0 };
  }

  const amount = mostExpensiveTotal - selectedTotal;
  const fraction = amount / mostExpensiveTotal;
  return { fraction, amount };
}

function computeProviderShares() {
  const keys = ['delsud', 'suizo', 'monroe'];
  const state = {
    totals: { delsud: 0, suizo: 0, monroe: 0 },
    products: { delsud: 0, suizo: 0, monroe: 0 },
    units: { delsud: 0, suizo: 0, monroe: 0 },
  };

  for (const it of compareItems) {
    const qty = it.qty || 0;
    const key = it.selected;
    if (!key || qty <= 0) continue;

    const price = computeItemPrice(it);
    if (price == null || price <= 0) continue;

    state.totals[key] += price * qty;
    state.products[key] += 1;
    state.units[key] += qty;
  }

  const grand = keys.reduce((a, k) => a + state.totals[k], 0);
  const shares = {};
  keys.forEach((k) => {
    shares[k] = {
      fraction: grand > 0 ? state.totals[k] / grand : 0,
      products: state.products[k],
      units: state.units[k],
      amount: state.totals[k],
    };
  });
  return { shares, grand };
}

function updateTotals() {
  const { grand } = computeProviderShares();
  if (totalsAmt) totalsAmt.textContent = `${fmtARS(grand)} + IVA`;

  const { fraction, amount } = computeAhorroPonderado();
  if (avgSaveEl) {
    if (fraction == null || fraction <= 0) {
      avgSaveEl.textContent = '—';
    } else {
      avgSaveEl.innerHTML = `${fmtPct(fraction)} <span class="subtle">(${fmtARS(
        Math.abs(amount),
      )})</span>`;
    }
  }
}

function setStatus(t) {
  if (statusEl) statusEl.textContent = t || '';
}

function renderFileItemsList() {
  if (!fileItemListEl || !itemsLoadedCard) return;
  fileItemListEl.innerHTML = '';

  if (!fileItems.length) {
    itemsLoadedCard.classList.add('hidden');
    clearFileBtn?.classList.add('hidden');
    if (itemsCountEl) itemsCountEl.textContent = '(0)';
    return;
  }

  itemsLoadedCard.classList.remove('hidden');
  clearFileBtn?.classList.remove('hidden');
  if (itemsCountEl) itemsCountEl.textContent = `(${fileItems.length})`;

  // Filtrado
  const term = fileFilterTerm.trim().toLowerCase();
  const filteredItems = fileItems.filter(item => {
    if (!term) return true;
    const n = (item.name || '').toLowerCase();
    const e = (item.ean || '').toLowerCase();
    return n.includes(term) || e.includes(term);
  });

  const itemsToDisplay = filteredItems.slice(0, displayedFileItemsCount);

  itemsToDisplay.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'file-list-row';

    const cellName = document.createElement('div');
    cellName.className = 'file-cell';
    cellName.textContent = item.name;
    cellName.title = item.name;
    row.appendChild(cellName);

    const cellEan = document.createElement('div');
    cellEan.className = 'file-cell file-cell-ean';
    cellEan.textContent = item.ean;
    cellEan.title = 'Click para copiar';
    cellEan.style.cursor = 'pointer';
    cellEan.addEventListener('click', (ev) => {
      ev.stopPropagation();
      navigator.clipboard.writeText(item.ean).then(() => {
        setStatus(`EAN copiado: ${item.ean}`);
      });
    });
    row.appendChild(cellEan);

    const cellQty = document.createElement('div');
    cellQty.className = 'file-cell';
    cellQty.style.display = 'flex';
    cellQty.style.justifyContent = 'center';

    const qtyInput = document.createElement('input');
    qtyInput.type = 'number';
    qtyInput.min = '1';
    qtyInput.className = 'file-qty-input';
    qtyInput.value = item.qty;

    qtyInput.addEventListener('change', (ev) => {
      let newQ = parseInt(ev.target.value, 10);
      if (isNaN(newQ) || newQ < 1) newQ = 1;
      item.qty = newQ;
      ev.target.value = newQ;
    });
    qtyInput.addEventListener('click', (ev) => ev.stopPropagation());

    cellQty.appendChild(qtyInput);
    row.appendChild(cellQty);

    const cellAction = document.createElement('div');
    cellAction.className = 'file-cell';
    cellAction.style.textAlign = 'center';

    const xBtn = document.createElement('span');
    xBtn.className = 'sku-x';
    xBtn.textContent = '✕';
    xBtn.title = 'Quitar';
    xBtn.addEventListener('click', () => {
      fileItems = fileItems.filter(it => it !== item);
      renderFileItemsList();
      setStatus(`${fileItems.length} ítems restantes.`);
    });

    cellAction.appendChild(xBtn);
    row.appendChild(cellAction);

    fileItemListEl.appendChild(row);
  });

  const remainingItems = filteredItems.length - displayedFileItemsCount;
  if (remainingItems > 0) {
    const loadMoreBtn = document.createElement('div');
    loadMoreBtn.className = 'load-more-btn btn-ghost';
    loadMoreBtn.textContent = `Mostrar ${remainingItems} más...`;
    loadMoreBtn.style.cursor = 'pointer';
    loadMoreBtn.addEventListener('click', () => {
      displayedFileItemsCount = Math.min(
        filteredItems.length,
        displayedFileItemsCount + LOAD_MORE_INCREMENT,
      );
      renderFileItemsList();
    });
    fileItemListEl.appendChild(loadMoreBtn);
  }
}

const monroeReadyPattern = /\[APP\] monroe está LISTO/i;

window.api.onLine(({ scraper, line }) => {
  appendLog(scraper, line);
  if (scraper === 'monroe' && monroeReadyPattern.test(line)) {
    // Logic for Monroe Ready if needed
  }
});

window.api.onTable(({ scraper, rows }) => {
  if (!rows || rows.length === 0) return;
  let updated = false;

  for (const rowData of rows) {
    const mappedData = mapProvider(scraper, rowData);
    if (!mappedData) continue;

    if (!mappedData.name && mappedData.raw) {
      mappedData.name =
        mappedData.raw.producto ||
        mappedData.raw.nombreProducto ||
        mappedData.raw.descripcion ||
        '';
    }

    let item = null;

    const potentialEAN = normalizeEAN(
      mappedData.ean ||
      mappedData.raw?.ean ||
      mappedData.raw?.sku ||
      mappedData.raw?.matchedEan ||
      mappedData.raw?.query ||
      (mappedData.name && isEANLike(mappedData.name) ? mappedData.name : null)
    );

    if (potentialEAN) {
      item =
        findExistingItem({ sku: potentialEAN }) ||
        findExistingItem({ term: potentialEAN }) ||
        null;
    }

    if (!item && mappedData.name) {
      item = findExistingItem({ name: mappedData.name });
    }

    if (item) {
      item.providers[scraper] = mappedData;
      updated = true;

      if (potentialEAN && (!item.sku || normalizeEAN(item.sku) !== potentialEAN)) {
        item.sku = potentialEAN;
      }

      syncItemIdentity(item);

      item.bestKey = computeBestKey(item);
      if (!item.userSelected) item.selected = item.bestKey;
    }
  }

  if (updated && !isBatchRunning) {
    rerenderComparator();
  }
});

window.api.onCompareUpdate((payload) => {
  addOrMergeItem(payload);
  if (!isBatchRunning) {
    rerenderComparator();
    setStatus(`Datos actualizados para "${payload.term || 'item'}".`);
  }
});

window.api.onScraperResult((payload) => {
  if (!isBatchRunning) return;

  const termN = normalizeEAN(payload.term) || payload.term;
  const item =
    findExistingItem({ term: payload.term }) ||
    (termN && findExistingItem({ sku: termN })) ||
    null;

  if (!item) {
    console.warn(`onScraperResult: No item found for term ${payload.term}`);
    return;
  }

  const mappedData = mapProvider(payload.scraper, pickRow(payload.data));
  if (mappedData) {
    item.providers[payload.scraper] = mappedData;
    const eanFromRow = normalizeEAN(mappedData.ean || mappedData.raw?.ean);
    if (eanFromRow) item.sku = eanFromRow;

    syncItemIdentity(item);

    item.bestKey = computeBestKey(item);
    if (!item.userSelected) item.selected = item.bestKey;
  }
});

window.api.onStatus((st) => {
  if (st.phase === 'start') {
    isBatchRunning = true;
    batchStartTime = Date.now();
    setProgress(0, st.totalUnits ?? 0);
    activate('compare');
    showLoading(true);
  } else if (st.phase === 'progress') {
    setProgress(st.completedUnits || 0, st.totalUnits || 0);
  } else if (st.phase === 'running') {
    setStatus(`Buscando ${st.index}/${st.total}: "${st.term}"…`);
  } else if (st.phase === 'done') {
    isBatchRunning = false;
    rerenderComparator();
    showLoading(false);
    setStatus('Búsqueda completada.');
  }
});

// --- NUEVO: Listener para el estado de los scrapers (Idle/Running) ---
if (window.api?.onScraperStatus) {
  window.api.onScraperStatus(({ name, status }) => {
    const btn = stopBtns[name];
    if (!btn) return;

    if (status === 'running') {
      btn.classList.remove('status-idle');
      btn.classList.add('status-running');
      btn.innerHTML = `
        <span style="font-size:16px;">🛑</span> Detener ${PROVIDER_LABEL[name] || name}
      `;
    } else {
      btn.classList.remove('status-running');
      btn.classList.add('status-idle');
      btn.innerHTML = `
        <span style="font-size:16px;">⚡</span> ${PROVIDER_LABEL[name] || name} Inactivo
      `;
    }
  });
}

// --- NUEVO: Handlers para los botones de Stop ---
Object.keys(stopBtns).forEach(key => {
  const btn = stopBtns[key];
  if (btn) {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      // Opcional: Feedback visual inmediato, aunque onScraperStatus lo confirmará
      btn.disabled = true;
      btn.textContent = 'Deteniendo...';
      try {
        await window.api.stopScraper(key);
      } catch (err) {
        console.error('Error stopping scraper:', err);
      } finally {
        btn.disabled = false;
      }
    });
  }
});


if (window.api?.onProgress) {
  window.api.onProgress(({ completedUnits, totalUnits }) =>
    setProgress(completedUnits, totalUnits),
  );
}

// LÓGICA DE ENVÍO DE CAPTCHA
async function handleCaptchaSubmit() {
  const code = captchaInput?.value.trim();
  if (!code || !captchaSubmitBtn || captchaSubmitBtn.disabled) return;

  captchaSubmitBtn.disabled = true;
  if (captchaInput) captchaInput.disabled = true;
  setStatus('Enviando código CAPTCHA...');

  let success = false;
  try {
    const result = await window.api.submitCaptcha(code);
    success = result?.ok;
    if (!success) {
      setStatus(
        `Error al enviar CAPTCHA: ${result?.error || 'Error desconocido'}. Intente de nuevo.`,
      );
    }
  } catch (err) {
    setStatus(`Error al invocar API submitCaptcha: ${err.message}. Intente de nuevo.`);
  } finally {
    captchaSubmitBtn.disabled = false;
    if (captchaInput) captchaInput.disabled = false;

    if (success) {
      captchaModal?.classList.add('hidden');
      if (captchaInput) captchaInput.value = '';
      setStatus('Código CAPTCHA enviado. Esperando continuación del scraper...');
    } else if (captchaInput) {
      captchaInput.value = '';
      captchaInput.focus();
    }
  }
}

// LÓGICA DE RECEPCIÓN DE CAPTCHA
window.api.onCaptchaRequired((payload) => {
  if (payload?.imageBase64 && captchaModal && captchaImage && captchaInput) {
    captchaImage.src = payload.imageBase64;
    captchaInput.value = '';
    captchaInput.disabled = false;
    captchaSubmitBtn.disabled = false;
    captchaModal.classList.remove('hidden');
    captchaInput.focus();
    setStatus('Acción requerida: Ingrese el código CAPTCHA de Monroe.');
  } else {
    setStatus('Error: Se requirió CAPTCHA pero no se pudo mostrar el modal.');
  }
});

captchaSubmitBtn?.addEventListener('click', handleCaptchaSubmit);
captchaInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleCaptchaSubmit();
  }
});

function showPriorityModal(show) {
  if (priorityModal) {
    if (show) priorityModal.classList.remove('hidden');
    else priorityModal.classList.add('hidden');
  }
  if (priorityBackdrop) {
    if (show) priorityBackdrop.classList.remove('hidden');
    else priorityBackdrop.classList.add('hidden');
  }
}

function renderPriorityList() {
  if (!priorityList) return;
  priorityList.innerHTML = '';

  priorityOrder.forEach((key) => {
    const li = document.createElement('li');
    li.dataset.key = key;
    li.draggable = true;
    li.textContent = PROVIDER_LABEL[key] || key;

    li.addEventListener('dragstart', () => {
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      priorityOrder = $$('#priorityList li').map((listItem) => listItem.dataset.key);
      rerenderComparator();
    });

    priorityList.appendChild(li);
  });
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('li:not(.dragging)')];

  return draggableElements.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      } else {
        return closest;
      }
    },
    { offset: Number.NEGATIVE_INFINITY },
  ).element;
}

priorityList?.addEventListener('dragover', (e) => {
  e.preventDefault();
  const afterElement = getDragAfterElement(priorityList, e.clientY);
  const dragging = $('.dragging', priorityList);
  if (dragging) {
    if (!afterElement) {
      priorityList.appendChild(dragging);
    } else {
      priorityList.insertBefore(dragging, afterElement);
    }
  }
});

priorityList?.addEventListener('drop', (e) => {
  e.preventDefault();
});

let settingsStatusTimer;

function showSettingsStatus(message, isError = false) {
  if (!settingsStatusEl) return;
  clearTimeout(settingsStatusTimer);
  settingsStatusEl.textContent = message;
  settingsStatusEl.style.color = isError ? 'var(--bad)' : 'var(--ok)';
  settingsStatusTimer = setTimeout(() => {
    settingsStatusEl.textContent = '';
  }, 3000);
}

async function handleSaveSettings(e) {
  e.preventDefault();
  if (!saveSettingsBtn) return;

  saveSettingsBtn.disabled = true;
  saveSettingsBtn.textContent = 'Guardando...';

  try {
    const settings = {
      credentials: {
        delsud_user: credInputs.delsud_user?.value || '',
        delsud_pass: credInputs.delsud_pass?.value || '',
        suizo_user: credInputs.suizo_user?.value || '',
        suizo_pass: credInputs.suizo_pass?.value || '',
        monroe_user: credInputs.monroe_user?.value || '',
        monroe_pass: credInputs.monroe_pass?.value || '',
      },
      experimental: {
        intensiveMode: intensiveModeSwitch?.checked || false,
        monroeFileAlgorithm: monroeFileAlgorithmSwitch?.checked || false,
        delsudFileAlgorithm: delsudFileAlgorithmSwitch?.checked || false,
        suizoFileAlgorithm: suizoFileAlgorithmSwitch?.checked || false,
      },
      general: {
        chromePath: generalInputs.chrome_path?.value || '',
      }
    };

    await window.api.saveSettings(settings);
    showSettingsStatus('Configuración guardada.', false);
  } catch (err) {
    console.error('Error al guardar configuración:', err);
    showSettingsStatus(`Error: ${err.message}`, true);
  } finally {
    saveSettingsBtn.disabled = false;
    saveSettingsBtn.textContent = 'Guardar Cambios';
  }
}

if (selectChromeBtn) {
  selectChromeBtn.addEventListener('click', async () => {
    try {
      const result = await window.api.selectChromePath();
      if (result && result.path) {
        if (generalInputs.chrome_path) {
          generalInputs.chrome_path.value = result.path;
        }
      }
    } catch (err) {
      console.error('Error selecting chrome path:', err);
      showSettingsStatus('Error al abrir selector de archivo.', true);
    }
  });
}

async function loadSettings() {
  try {
    const settings = await window.api.loadSettings();
    if (settings) {
      if (settings.credentials) {
        if (credInputs.delsud_user) credInputs.delsud_user.value = settings.credentials.delsud_user || '';
        if (credInputs.delsud_pass) credInputs.delsud_pass.value = settings.credentials.delsud_pass || '';
        if (credInputs.suizo_user) credInputs.suizo_user.value = settings.credentials.suizo_user || '';
        if (credInputs.suizo_pass) credInputs.suizo_pass.value = settings.credentials.suizo_pass || '';
        if (credInputs.monroe_user) credInputs.monroe_user.value = settings.credentials.monroe_user || '';
        if (credInputs.monroe_pass) credInputs.monroe_pass.value = settings.credentials.monroe_pass || '';
      }
      if (settings.experimental) {
        if (intensiveModeSwitch)
          intensiveModeSwitch.checked = !!settings.experimental.intensiveMode;
        if (monroeFileAlgorithmSwitch)
          monroeFileAlgorithmSwitch.checked = !!settings.experimental.monroeFileAlgorithm;
        if (delsudFileAlgorithmSwitch)
          delsudFileAlgorithmSwitch.checked = !!settings.experimental.delsudFileAlgorithm;
        if (suizoFileAlgorithmSwitch)
          suizoFileAlgorithmSwitch.checked = !!settings.experimental.suizoFileAlgorithm;
      }
      if (settings.general) {
        if (generalInputs.chrome_path)
          generalInputs.chrome_path.value = settings.general.chromePath || '';
      }
    }
  } catch (err) {
    console.error('Error al cargar la configuración:', err);
    showSettingsStatus(`Error al cargar config: ${err.message}`, true);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();

  try {
    setStatus('Cargando base de datos de productos...');
    const dbData = await window.api.loadDB();
    productDB = new Map(
      Object.entries(dbData).map(([k, v]) => [normalizeEAN(k) || String(k), String(v)])
    );
    setStatus('Base de datos lista.');
  } catch (err) {
    console.error(err);
    setStatus('Error al cargar base de datos. Funcionalidad limitada.');
  }

  setSearchBarVisibility('search');
  captchaModal?.classList.add('hidden');
  clearFileBtn?.classList.add('hidden');
  itemsLoadedCard?.classList.add('hidden');

  showPriorityModal(false);
  showLoading(false);

  renderPriorityList();
  renderComparator();
  setStatus('Listo.');

  if (runBtn) {
    runBtn.addEventListener('click', async () => {
      if (tabBtns.compare) {
        tabBtns.compare.style.display = 'flex';
      }

      clearLogs();
      setStatus('Buscando…');
      predictiveResultsEl?.classList.add('hidden');

      const termFromInput = (qInput?.value || '').trim();
      const hasFileInput = fileItems.length > 0;

      let queue = [];
      let isSearchFromFile = false;

      if (hasFileInput) {
        queue = fileItems.map((item) => ({ ean: normalizeEAN(item.ean) || item.ean, name: item.name }));
        isSearchFromFile = true;
        if (qInput) qInput.value = '';
      } else if (termFromInput) {
        queue = [termFromInput];
      }

      if (!queue.length) {
        setStatus('Nada para buscar (ingrese un término o cargue un archivo).');
        return;
      }

      compareItems = [];
      nextId = 1;

      if (isSearchFromFile) {
        fileItems.forEach((fileItem) => {
          const term = normalizeEAN(fileItem.ean) || fileItem.ean;
          const qty = fileItem.qty;
          const sku = normalizeEAN(term);
          const name = fileItem.name || productDB.get(sku) || (isEANLike(term) ? '(sin descripción)' : term);

          if (!findExistingItem({ term, sku })) {
            const it = {
              id: nextId++,
              term,
              sku,
              name,
              qty,
              providers: { delsud: null, suizo: null, monroe: null },
              selected: null,
              bestKey: null,
              userSelected: false,
            };
            syncItemIdentity(it);
            compareItems.push(it);
          }
        });
      }

      captchaModal?.classList.add('hidden');

      try {
        if (queue.length === 1 && !isSearchFromFile) {
          await window.api.runQuery(queue[0]);
        } else {
          await window.api.runBatch(queue);
        }
      } catch (error) {
        console.error('Error running query/batch:', error);
        setStatus(`Error al iniciar la búsqueda: ${error.message}`);
        showLoading(false);
      }
    });
  }

  if (addToCompareBtn) {
    addToCompareBtn.addEventListener('click', () => {
      const termRaw = (qInput?.value || '').trim();
      if (!termRaw) {
        setStatus('Por favor, ingrese un EAN o término para agregar.');
        return;
      }

      predictiveResultsEl?.classList.add('hidden');

      const term = normalizeEAN(termRaw) || termRaw;

      const alreadyExists = fileItems.some((item) => normalizeEAN(item.ean) === normalizeEAN(term));
      if (alreadyExists) {
        setStatus(`"${term}" ya está en la lista.`);
        if (qInput) qInput.value = '';
        return;
      }

      const dbName = productDB.get(normalizeEAN(term)) || '';
      const name = dbName || (isEANLike(term) ? '(sin descripción)' : term);

      fileItems.push({ ean: term, qty: 1, name });

      displayedFileItemsCount = Math.max(INITIAL_DISPLAY_LIMIT, displayedFileItemsCount);
      renderFileItemsList();

      setStatus(
        `"${name}" agregado a la lista. ${fileItems.length} ${plural(
          fileItems.length,
          'item',
          'items',
          'items',
        )} para buscar.`,
      );
      if (qInput) {
        qInput.value = '';
        qInput.focus();
      }
    });
  }

  if (fileBtn) {
    fileBtn.addEventListener('click', () => fileInput?.click());
  }

  if (fileInput) {
    fileInput.addEventListener('change', async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const lines = text.split(/[\r\n]+/);
        const items = [];
        const seenEANs = new Set();

        lines.forEach((line) => {
          const trimmedLine = line.trim();
          if (!trimmedLine) return;
          const parts = trimmedLine.split(',');
          if (parts.length < 3) return;

          const eanRaw = (parts[0] || '').trim();
          const ean = normalizeEAN(eanRaw);
          if (!ean || !/^\d{8,14}$/.test(ean)) return;

          const qtyStr = (parts[parts.length - 2] || '').trim();
          let qty = parseInt(qtyStr, 10);
          if (Number.isNaN(qty) || qty < 1) qty = 1;

          const name = productDB.get(ean) || '(sin descripción)';

          if (!seenEANs.has(ean)) {
            items.push({ ean, qty, name });
            seenEANs.add(ean);
          }
        });

        fileItems = items;
        displayedFileItemsCount = INITIAL_DISPLAY_LIMIT;
        renderFileItemsList();
        setStatus(
          `${fileItems.length} ${plural(
            fileItems.length,
            'item',
            'items',
            'items',
          )} cargados desde ${file.name}. Presiona "Buscar".`,
        );
      } catch (err) {
        console.error('Error reading file:', err);
        setStatus(`Error al leer el archivo: ${err.message}`);
        fileItems = [];
        displayedFileItemsCount = INITIAL_DISPLAY_LIMIT;
        renderFileItemsList();
      } finally {
        fileInput.value = '';
      }
    });
  }

  if (clearFileBtn) {
    clearFileBtn.addEventListener('click', () => {
      fileItems = [];
      displayedFileItemsCount = INITIAL_DISPLAY_LIMIT;
      renderFileItemsList();
      setStatus('Lista de archivo reiniciada.');
    });
  }

  if (filterFileItemsInput) {
    filterFileItemsInput.addEventListener('input', (e) => {
      fileFilterTerm = e.target.value;
      displayedFileItemsCount = INITIAL_DISPLAY_LIMIT;
      renderFileItemsList();
    });
  }

  if (priorityBtn) {
    priorityBtn.addEventListener('click', () => {
      showPriorityModal(true);
    });
  }

  if (priorityBackdrop) {
    priorityBackdrop.addEventListener('click', () => {
      showPriorityModal(false);
    });
  }

  if (priorityCloseBtn) {
    priorityCloseBtn.addEventListener('click', () => {
      showPriorityModal(false);
    });
  }

  if (priorityToleranceInput) {
    priorityToleranceInput.addEventListener('change', (e) => {
      priorityTolerance = parseCurrencyToNumber(e.target.value) || 0;
      rerenderComparator();
    });
  }

  settingsNavBtns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const paneName = btn.dataset.pane;

      settingsNavBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      settingsPanes.forEach((p) => p.classList.add('hidden'));
      const activePane = $(`#settings-pane-${paneName}`);
      if (activePane) activePane.classList.remove('hidden');
    });
  });

  settingsForm?.addEventListener('submit', handleSaveSettings);

  let predictiveDebounceTimer;
  qInput?.addEventListener('input', () => {
    clearTimeout(predictiveDebounceTimer);
    const query = qInput.value.trim();

    if (query.length < 2) {
      predictiveResultsEl?.classList.add('hidden');
      return;
    }

    predictiveDebounceTimer = setTimeout(() => {
      const results = searchProductDB(query);
      renderPredictiveResults(results);
    }, 250);
  });

  document.addEventListener('click', (e) => {
    if (!searchBar?.contains(e.target)) {
      predictiveResultsEl?.classList.add('hidden');
    }
  });

  window.addEventListener('resize', () => {
    predictiveResultsEl?.classList.add('hidden');
  });
});