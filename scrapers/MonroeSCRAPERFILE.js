#!/usr/bin/env node
// MonroeSCRAPERFILE.js
// Versión FINAL FIXED MATCHING + EAN LINKED PRIORITY
// Requiere: playwright (npm i playwright) y xlsx (npm i xlsx)

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// DETECCIÓN DE ENTORNO Y CONFIGURACIÓN
// ---------------------------------------------------------------------------
const IS_SHOP4ME_CONTEXT = process.env.SHOP4ME_CHILD_PROCESS === 'true';

// Variable global para controlar el proceso de Chrome
let globalChromeProcess = null;

let XLSX;
try {
  XLSX = require('xlsx');
} catch (e) {
  console.error('Falta la dependencia "xlsx". Instálala con: npm i xlsx');
  process.exit(1);
}

const URL = 'https://www.monroeamericana.com.ar/apps/login/ext/index.html';
const USERNAME = process.env.MONROE_USER;
const PASSWORD = process.env.MONROE_PASS;

// --- CONFIGURACIÓN DE CHROME CON PUERTO FIJO ---
// Se ha eliminado la aleatoriedad para usar siempre el mismo puerto y perfil
const CHROME_DEBUG_PORT = 9222;

// Usamos una carpeta de perfil vinculada al puerto fijo
const CHROME_USER_DATA_DIR = `C:\\chrome_debug_profile_${CHROME_DEBUG_PORT}`;

console.log(`[INIT] Configuración de Stealth (Chrome): Usando Puerto FIJO ${CHROME_DEBUG_PORT}`);
console.log(`[INIT] Perfil de usuario temporal: ${CHROME_USER_DATA_DIR}`);

// Configuración de tiempos humanos
const HUMAN_KEY_DELAY_MIN = parseInt(process.env.HUMAN_KEY_DELAY_MIN || '80', 10);
const HUMAN_KEY_DELAY_MAX = parseInt(process.env.HUMAN_KEY_DELAY_MAX || '200', 10);

// Configuración de Matching (Bajamos la vara para Monroe que tiene textos sucios, pero compensamos con Brand Bonus)
const NAME_STRICT_THRESHOLD = 0.45; // Bajado de 0.55 para permitir matches difusos si la marca coincide
const LINK_DEBUG = true; // Activamos debug para ver en consola por qué matchea o no

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

// ---------------------------------------------------------------------------
// UTILIDADES DE MATCHING (Lógica avanzada portada y AJUSTADA)
// ---------------------------------------------------------------------------

function safeTrim(s) { return (s === null || s === undefined) ? '' : String(s).replace(/\s+/g, ' ').trim(); }

function normalizeForMatch(s) {
  const txt = safeTrim(s).toUpperCase();
  let out = txt;
  try { out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch { }

  // Limpieza específica para Monroe vs Input
  out = out.replace(/\./g, ' '); // Puntos a espacios (Grage. -> Grage)
  out = out.replace(/[^A-Z0-9\s%]/g, ' '); // Mantener % por las dudas
  out = out.replace(/\s+/g, ' ').trim();

  // Normalizar unidades comunes y abreviaturas de Monroe
  out = out
    .replace(/\bMGS?\b/g, 'MG')
    .replace(/\bMILILITROS?\b/g, 'ML')
    .replace(/\bGRAMOS?\b/g, 'GR')
    .replace(/\bLITROS?\b/g, 'L')
    .replace(/\bCOMPR?(\s|$)/g, 'COMP ') // Compr -> COMP
    .replace(/\bCOMPRIMIDOS?\b/g, 'COMP')
    .replace(/\bGRAGEAS?\b/g, 'GRAGEAS')
    .replace(/\bGRAGE\.?\b/g, 'GRAGEAS') // Grage. -> GRAGEAS
    .replace(/\bCAPSULAS?\b/g, 'CAP')
    .replace(/\bTABLETAS?\b/g, 'TAB')
    .replace(/X(\d+)/g, ' $1 ') // Separar X30 -> 30
    .replace(/X\s+(\d+)/g, ' $1 '); // Asegurar espacios

  return out.trim();
}

function extractHardTokens(norm) {
  const hard = [];

  // 1. Separar números pegados a letras (ej: 50MG -> 50 MG) para análisis
  const spaced = norm.replace(/(\d+)([A-Z]+)/g, '$1 $2').replace(/([A-Z]+)(\d+)/g, '$1 $2');

  // Números solos (cantidades, dosis)
  const nums = spaced.match(/\b\d+(?:[.,]\d+)?\b/g) || [];

  // Números con unidades específicas
  const numUnits = norm.match(/\b(\d+(?:[.,]\d+)?)\s*(MG|ML|GR|KG|L|CC|MM|CM|MCI|UI|%|KMCG|MCG)\b/g) || [];

  // Agregar números puros
  for (const n of nums) hard.push(n.replace(',', '.'));

  // Agregar combinaciones Dosis (normalizadas)
  for (const x of numUnits) {
    // Normalizar casos raros como 5kmcg -> 5000mcg (logica simple de reemplazo caracteres raros)
    let clean = x.replace(/\s+/g, '');
    hard.push(clean);
  }

  return Array.from(new Set(hard));
}

function tokenizeWords(norm) {
  if (!norm) return [];

  // Mapa de sinónimos para aumentar coincidencias (FIX PRINCIPAL PARA OZEMPIC/LAPICERAS)
  const SYNONYMS = {
    'LAP': 'LAPICERA', 'LAPIC': 'LAPICERA', 'LAPI': 'LAPICERA',
    'AGU': 'AGUJA', 'AGUJAS': 'AGUJA',
    'PRE': 'PRELLENADA', 'PRELL': 'PRELLENADA',
    'AMP': 'AMPOLLA', 'AMPOLLAS': 'AMPOLLA',
    'JBE': 'JARABE', 'SUSP': 'SUSPENSION',
    'GTS': 'GOTAS',
    'DUAL': 'DUAL', // Mantener
    'DOSE': 'DOSIS'
  };

  // Separamos numeros de letras para tokenizar mejor
  const spaced = norm.replace(/(\d+)/g, ' $1 ');
  const toks = spaced.split(/\s+/).filter(t => t.length >= 2);

  const stop = new Set([
    'PARA', 'CON', 'SIN', 'POR', 'DEL', 'DE', 'LA', 'LAS', 'LOS', 'UNA', 'UN', 'EL',
    'THE', 'AND', 'X', 'DE', 'EN', 'COM', 'ENV', 'FRASCO'
  ]);

  return toks
    .filter(t => !stop.has(t))
    .map(t => SYNONYMS[t] || t); // Aplicar sinónimos
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

function jaroWinkler(s1, s2) {
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;

  const a = s1, b = s2;
  const len1 = a.length, len2 = b.length;
  const matchDist = Math.floor(Math.max(len1, len2) / 2) - 1;

  const aMatch = new Array(len1).fill(false);
  const bMatch = new Array(len2).fill(false);

  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, len2);
    for (let j = start; j < end; j++) {
      if (bMatch[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatch[i] = true;
      bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let t = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / len1 + matches / len2 + (matches - t / 2) / matches) / 3;

  let prefix = 0;
  for (let i = 0; i < Math.min(4, len1, len2); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function buildInputIndex(inputItems) {
  const items = (inputItems || []).map((it, idx) => {
    // FIX: Usamos ean_linked como prioridad si viene de Del Sud
    const ean = safeTrim(it.ean_linked || it.ean);
    // Soporte robusto para distintos formatos de entrada (JSON del batch)
    const desc = safeTrim(it.name || it.description || it.desc || it.producto || '');
    const norm = normalizeForMatch(desc);
    return {
      idx,
      ean, // Este ean ahora tiene alta chance de ser el "bueno"
      desc,
      norm,
      hard: extractHardTokens(norm),
      words: tokenizeWords(norm)
    };
  });

  const byEan = new Map();
  for (const it of items) {
    if (it.ean && /^\d{8,14}$/.test(it.ean)) byEan.set(it.ean, it);
  }

  return { items, byEan };
}

function scoreNameMatch(productName, inputItem) {
  const pn = normalizeForMatch(productName);
  if (!pn || !inputItem?.norm) return { score: 0 };

  const pHard = extractHardTokens(pn);
  const iHard = inputItem.hard || [];
  const hardScore = jaccard(pHard, iHard);

  const pWords = tokenizeWords(pn);
  const iWords = inputItem.words || [];
  const wordScore = jaccard(pWords, iWords);
  const jw = jaroWinkler(pn, inputItem.norm);

  // --- BRAND BONUS (FIX CRÍTICO) ---
  // Si la primera palabra (Marca usualmente) coincide, damos un bono masivo
  let brandBonus = 0;
  if (pWords.length > 0 && iWords.length > 0 && pWords[0] === iWords[0]) {
    brandBonus = 0.35; // +35% de coincidencia si la marca es exacta
  }

  // Peso: Palabras (40%) + Jaro (30%) + Numeros (20%) + Brand (Bonus)
  // Ajusté Jaro a 30% y añadí el bonus directo
  let score = (wordScore * 0.40) + (jw * 0.30) + (hardScore * 0.20) + brandBonus;

  if (score > 1) score = 1; // Cap en 1

  return { score, debug: { pn, iNorm: inputItem.norm, ws: wordScore, jw, hs: hardScore, bonus: brandBonus } };
}

/**
 * Vincula los productos scrapeados con los items de entrada.
 * Prioridad: 1. EAN Exacto, 2. Nombre similar (Fuzzy).
 */
function linkEansToProducts(products, inputItems) {
  const out = (products || []).map(p => ({ ...p }));
  const { items, byEan } = buildInputIndex(inputItems || []);

  const usedInput = new Set();
  const assigned = new Array(out.length).fill(null);

  // 1) Match exacto por EAN (si la web lo devolvió y coincide)
  for (let pi = 0; pi < out.length; pi++) {
    const p = out[pi];
    const webEan = safeTrim(p.extractedEAN || p.ean);

    if (webEan && /^\d{8,14}$/.test(webEan) && byEan.has(webEan)) {
      const it = byEan.get(webEan);
      if (!usedInput.has(it.idx)) {
        usedInput.add(it.idx);
        assigned[pi] = { idx: it.idx, ean: it.ean, method: 'ean_exact', score: 1.0 };
      }
    }
  }

  // 2) Match por nombre (Fuzzy) para los que faltan
  const bestPerProduct = out.map((p, pi) => {
    if (assigned[pi]) return null; // Ya asignado por EAN

    let best = null;
    for (const it of items) {
      // Permitimos reutilizar input si es necesario (comentado if usado)
      // if (usedInput.has(it.idx)) continue; 

      const s = scoreNameMatch(p.productName || '', it);
      if (s.score <= 0) continue;

      if (!best || s.score > best.score) {
        best = { it, score: s.score, debug: s.debug };
      }
    }
    return best;
  });

  // Asignación voraz (Greedy) basada en el mejor puntaje global
  const pairs = [];
  for (let pi = 0; pi < bestPerProduct.length; pi++) {
    const best = bestPerProduct[pi];
    // Usamos el umbral ajustado
    if (best && best.score >= NAME_STRICT_THRESHOLD) {
      pairs.push({
        pi,
        ii: best.it.idx,
        ean: best.it.ean,
        score: best.score,
        debug: best.debug
      });
    }
  }

  // Ordenar por score descendente
  pairs.sort((a, b) => b.score - a.score);

  for (const pr of pairs) {
    if (assigned[pr.pi]) continue;
    // if (usedInput.has(pr.ii)) continue; // Permitimos 1-a-muchos match si es muy bueno

    usedInput.add(pr.ii);
    assigned[pr.pi] = {
      idx: pr.ii,
      ean: pr.ean,
      method: 'name_fuzzy',
      score: Number(pr.score.toFixed(4)),
      debug: pr.debug
    };
  }

  // 3) Aplicar asignaciones al array de salida
  for (let pi = 0; pi < out.length; pi++) {
    const a = assigned[pi];
    if (a) {
      out[pi].ean_linked = a.ean;
      out[pi].link_method = a.method;
      out[pi].link_score = a.score;
      if (LINK_DEBUG) out[pi].link_debug = a.debug;
    } else {
      out[pi].ean_linked = '';
      out[pi].link_method = 'none';
      out[pi].link_score = 0;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// MANEJO DE CTRL + C (SIGINT)
// ---------------------------------------------------------------------------
process.on('SIGINT', () => {
  console.log('\n[SIGINT] Detectado Ctrl+C. Cerrando Chrome forzosamente y saliendo...');

  if (globalChromeProcess) {
    try {
      // Matamos el proceso de Chrome spawneado
      globalChromeProcess.kill();
      console.log('[SIGINT] Proceso de Chrome terminado.');
    } catch (e) {
      console.error('[SIGINT] Error al intentar matar Chrome:', e.message);
    }
  }

  setTimeout(() => {
    process.exit(0);
  }, 500);
});

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/* -------------------- Selector de archivo nativo (cross-platform) -------------------- */
function pickFileNative(opts = { filter: ['*.txt'] }) {
  const platform = process.platform;
  if (platform === 'win32') {
    try {
      const ps = `
Add-Type -AssemblyName System.Windows.Forms;
$ofd = New-Object System.Windows.Forms.OpenFileDialog;
$ofd.Filter = "Text files (*.txt)|*.txt|All files (*.*)|*.*";
$ofd.Multiselect = $false;
if ($ofd.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $ofd.FileName
}
`;
      const res = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-STA', '-Command', ps],
        { encoding: 'utf8', windowsHide: true, timeout: 120000 }
      );
      if (res.status === 0) {
        const out = (res.stdout || '').trim().split(/\r?\n/).pop() || '';
        if (out) return out;
      }
    } catch (e) { /* fallback */ }
  }

  if (platform === 'darwin') {
    try {
      const osa = `set f to POSIX path of (choose file with prompt "Seleccioná el archivo .txt" of type {"txt","text"})
if f is not missing value then
  do shell script "printf " & quoted form of f
end if`;
      const res = spawnSync('osascript', ['-e', osa], { encoding: 'utf8', timeout: 120000 });
      if (res.status === 0) {
        const out = (res.stdout || '').trim();
        if (out) return out;
      }
    } catch (e) { }
  }

  if (platform === 'linux') {
    try {
      const res = spawnSync('zenity', ['--file-selection', '--title=Seleccioná el archivo .txt', '--file-filter=*.txt'], { encoding: 'utf8', timeout: 120000 });
      if (res.status === 0) {
        const out = (res.stdout || '').trim();
        if (out) return out;
      }
    } catch (e) { }
  }

  return null;
}

/* -------------------- Parseo del .txt y conversión a Excel -------------------- */

// --- MODIFICADO: Generación de Excel desde lista de OBJETOS (para Batch) ---
function generateTempExcelFromList(items) {
  const rows = [];

  // Detectar si items es array de strings o de objetos JSON
  if (items.length > 0 && typeof items[0] === 'string') {
    // Legacy: Array de EANs strings
    items.forEach(ean => rows.push([ean, "1", ean]));
  } else {
    // Nuevo: Array de objetos {ean, name, qty...}
    items.forEach(item => {
      // FIX CRITICO: Usar ean_linked para el Excel si está disponible. 
      // Esto hace que Monroe busque el EAN correcto (el de Del Sud)
      const ean = item.ean_linked || item.ean || '';
      const qty = item.qty || "1";
      // Usamos el nombre para la descripción en el Excel, ayuda al buscador interno de Monroe
      const desc = item.name || item.desc || item.description || item.producto || '';
      rows.push([ean, String(qty), desc]);
    });
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

  const tempDir = os.tmpdir();
  const tempFileName = `monroe_batch_${Date.now()}_${Math.floor(Math.random() * 1000)}.xlsx`;
  const outPath = path.join(tempDir, tempFileName);
  XLSX.writeFile(wb, outPath);
  return outPath;
}

function convertTxtToExcelSync(inputPath) {
  if (!fs.existsSync(inputPath)) throw new Error('Archivo no existe: ' + inputPath);

  const content = fs.readFileSync(inputPath, 'utf8');
  const lines = content.split(/\r?\n/).filter(l => l && l.trim().length > 0);

  const excelRows = [];
  const fullInputData = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(',');

    if (parts.length >= 7) {
      const ean = parts[0].trim().replace(/"/g, '');
      const quantity = parts[5].trim().replace(/"/g, '');
      const description = parts.slice(6).join(',').trim().replace(/"/g, '');

      if (ean && quantity) {
        excelRows.push([ean, quantity, description || '']);
        fullInputData.push({ ean: ean, description: description || '' });
      }
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(excelRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

  const tempDir = os.tmpdir();
  const tempFileName = `monroe_upload_${Date.now()}_${Math.floor(Math.random() * 1000)}.xlsx`;
  const outPath = path.join(tempDir, tempFileName);

  XLSX.writeFile(wb, outPath);

  return { outPath, rows: excelRows, fullInputData: fullInputData };
}

/* -------------------- Ejecutar PICKER y conversión -------------------- */
async function preflightFileConvert() {
  try {
    let selected = pickFileNative();
    if (!selected) {
      console.log('No se pudo abrir diálogo nativo (o usuario canceló).');
      selected = await new Promise(resolve => resolve(null));
    }

    if (!selected) {
      console.log("Operación de selección de archivo cancelada.");
      return null;
    }

    console.log('Convirtiendo archivo:', selected);
    const { outPath, rows, fullInputData } = convertTxtToExcelSync(selected);

    console.log('Archivo Excel temporal creado en:', outPath);
    return { outPath, rows, fullInputData };
  } catch (err) {
    console.error('Error durante la conversión de archivo:', err && (err.message || err));
    return null;
  }
}

/* ---------------- NEW: subir archivo convertido y click "Ingresar Productos" ---------------- */
async function uploadConvertedExcel(page, excelPath) {
  if (!excelPath || !fs.existsSync(excelPath)) {
    console.warn('[UPLOAD] Ruta inválida o archivo no existe:', excelPath);
    return false;
  }

  const fileSelectors = [
    'input#import-file-excel',
    'input[type="file"][id*="import"]',
    'input[type="file"][name*="import"]',
    'input[type="file"].form-control-file',
    'input[type="file"]'
  ];

  let fileSet = false;
  for (const sel of fileSelectors) {
    try {
      const locator = page.locator(sel).first();
      if ((await locator.count()) > 0) {
        await locator.scrollIntoViewIfNeeded().catch(() => { });
        await locator.setInputFiles(excelPath);
        fileSet = true;
        await wait(400);
        break;
      }
    } catch (e) { }
  }

  if (!fileSet) {
    // Fallback: buscar dentro de modal
    try {
      const modal = page.locator('div[role="dialog"], .modal, dialog').filter({ hasText: /Importación|Seleccionación/i }).first();
      if ((await modal.count()) > 0) {
        const insideInput = modal.locator('input[type="file"]').first();
        if ((await insideInput.count()) > 0) {
          await insideInput.setInputFiles(excelPath);
          fileSet = true;
          await wait(400);
        }
      }
    } catch (e) { }
  }

  if (!fileSet) {
    console.warn('[UPLOAD] No se encontró el input de tipo file para subir el Excel.');
    return false;
  }

  const ingresarSelectors = [
    'button:has-text("Ingresar Productos")',
    'button:has-text("Ingresar producto")',
    'button:has-text("Ingresar")',
    '.modal button:has-text("Ingresar Productos")',
    'button.btn-primary:has-text("Ingresar Productos")'
  ];

  let clickedIngresar = false;
  for (const sel of ingresarSelectors) {
    try {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0) {
        await btn.scrollIntoViewIfNeeded().catch(() => { });
        await wait(randomBetween(80, 200));
        await btn.click({ timeout: 5000 }).catch(() => { });
        clickedIngresar = true;
        break;
      }
    } catch (e) { }
  }

  if (!clickedIngresar) {
    try {
      const modal = page.locator('div[role="dialog"], .modal, dialog').first();
      if ((await modal.count()) > 0) {
        const btn = modal.locator('button').filter({ hasText: /Ingresar Productos|Ingresar/i }).first();
        if ((await btn.count()) > 0) {
          await btn.click().catch(() => { });
          clickedIngresar = true;
        }
      }
    } catch (e) { }
  }

  return clickedIngresar;
}

/* -------------------- Util: escape CSV y helpers de parseo -------------------- */
function escapeCsvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  const escaped = s.replace(/"/g, '""');
  if (/[,"\r\n]/.test(escaped)) return `"${escaped}"`;
  return escaped;
}

/* -------------------- Guardar CSV con headers solicitados -------------------- */
function saveResultsToCSV_tableOnly(results) {
  const headers = ['Producto', '$ unitario', '$ publico', '% de descuento', 'unidades min', 'nivel de stock'];
  const lines = [headers.join(',')];

  for (const r of results) {
    const producto = r.productName || '';
    let unitario = '';
    if (r.unitPrice != null) unitario = r.unitPrice.toFixed(2);
    else if (r.originalPrice != null) unitario = r.originalPrice.toFixed(2);
    else if (r.publicPrice != null) unitario = r.publicPrice.toFixed(2);

    const publico = r.publicPrice != null ? r.publicPrice.toFixed(2) : '';
    let descuento = '';
    if (r.discountPercent != null) descuento = r.discountPercent.toFixed(2);

    const unidadesMin = r.discountMin != null ? String(r.discountMin) : '';
    const nivelStock = r.levelStock != null ? String(r.levelStock) : '';

    const row = [
      escapeCsvField(producto),
      escapeCsvField(unitario),
      escapeCsvField(publico),
      escapeCsvField(descuento),
      escapeCsvField(unidadesMin),
      escapeCsvField(nivelStock)
    ];
    lines.push(row.join(','));
  }

  const outCsv = path.join(__dirname, 'cart_scrape.csv');
  fs.writeFileSync(outCsv, lines.join('\n'), 'utf8');
  return outCsv;
}

/* -------------------- LÓGICA DE EXTRACCIÓN (POR PÁGINA) -------------------- */
async function extractDataFromCurrentPage(page) {
  const extracted = await page.evaluate(() => {
    const priceRegex = /[\d]{1,3}(?:[.,][\d]{3})*[.,][\d]{2}/g;

    function normalizeSpaces(s) { return s ? s.replace(/\s+/g, ' ').trim() : ''; }

    function isVisible(el) {
      try {
        if (!el || !(el instanceof Element)) return false;
        const cs = window.getComputedStyle(el);
        if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity || 1) === 0) return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width === 0 || r.height === 0 || r.bottom < 0) return false;
        return true;
      } catch (e) { return false; }
    }

    function isStruck(el) {
      if (!el) return false;
      let current = el;
      let depth = 0;
      while (current && depth < 4) {
        const tag = (current.tagName || '').toLowerCase();
        if (tag === 's' || tag === 'del' || tag === 'strike') return true;
        try {
          const cs = window.getComputedStyle(current);
          const dec = (cs.textDecorationLine || cs.textDecoration || '').toLowerCase();
          if (dec.includes('line-through')) return true;
        } catch (e) { }
        current = current.parentElement;
        depth++;
      }
      return false;
    }

    function parsePrice(raw) {
      if (!raw) return null;
      let s = String(raw).replace(/[^\d.,-]/g, '').trim();
      if (!s) return null;
      const lastComma = s.lastIndexOf(',');
      const lastDot = s.lastIndexOf('.');
      if (lastComma !== -1 && lastDot !== -1) {
        if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
        else s = s.replace(/,/g, '');
      } else if (lastComma !== -1 && lastDot === -1) {
        const after = (s.split(',')[1] || '');
        if (after.length !== 2) s = s.replace(/,/g, '');
        else s = s.replace(',', '.');
      } else if (lastDot !== -1 && lastComma === -1) {
        const parts = s.split('.');
        if (parts.length > 2) s = s.replace(/\./g, '');
      }
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }

    let rows = Array.from(document.querySelectorAll('ul#dmaBS-listItem li.row.rowItem.dmaItem, ul#dmaBS-listItem li.rowItem.dmaItem, ul#dmaBS-listItem li.row.rowItem, ul#dmaBS-listItem li.rowItem'));
    if (!rows.length) rows = Array.from(document.querySelectorAll('ul#dmaBS-listItem li, [role="listitem"]'));

    const results = [];

    for (const row of rows) {
      try {
        if (!isVisible(row)) continue;

        let title = '';
        const nameDiv = row.querySelector('.nbreItem') || row.querySelector('div[data-filter-tags]') || row.querySelector('[data-filter-tags]');
        if (nameDiv) title = normalizeSpaces(nameDiv.textContent || '');
        else {
          const lines = (row.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
          title = lines.find(l => /[a-záéíóúüñ]/i.test(l) && !/\b(Unidades?|IVA|M[ií]n|mín|stock|Total|Agregar|Seleccionados?)\b/i.test(l)) || lines[0] || ';';
          title = normalizeSpaces(title);
        }

        // --- IMPROVED EAN EXTRACTION ---
        let extractedEAN = '';
        if (!extractedEAN) extractedEAN = row.getAttribute('data-ean') || '';
        if (!extractedEAN) extractedEAN = row.getAttribute('data-codigo') || '';
        if (!extractedEAN) extractedEAN = row.getAttribute('data-sku') || '';
        if (!extractedEAN) extractedEAN = row.getAttribute('data-id') || '';

        if (!extractedEAN) {
          const hiddenInput = row.querySelector('input[name*="EAN"], input[name*="ean"], input[type="hidden"][value*="779"]');
          if (hiddenInput) extractedEAN = hiddenInput.value;
        }

        if (!extractedEAN) {
          const fullText = row.innerText || '';
          const eanMatch = fullText.match(/\b(779\d{10})\b/) || fullText.match(/\b(\d{13})\b/);
          if (eanMatch) extractedEAN = eanMatch[1];
          else {
            const codMatch = fullText.match(/Cod\.?[:\s]*(\d+)/i);
            if (codMatch) extractedEAN = codMatch[1];
          }
        }
        if (extractedEAN) extractedEAN = extractedEAN.trim();

        let levelStock = null;
        const stockIcon = row.querySelector('i.fa-circle') || row.querySelector('i.fas.fa-circle');
        if (stockIcon) {
          const cls = stockIcon.className || '';
          if (/\btxt-color-green\b/i.test(cls)) levelStock = 'stock';
          else if (/\btxt-color-red\b/i.test(cls)) levelStock = 'sin stock';
          else if (/\btxt-color-(yellow|warning|amber|orange)\b/i.test(cls)) levelStock = 'stock crítico';
        }

        const priceSpans = Array.from(row.querySelectorAll('span, div, s, del, strong, b, p, small'));
        const prices = [];
        let discountPercent = null;
        let discountMin = null;

        // Detectar inputs de cantidad para no leerlos como precio
        const qtyInputs = Array.from(row.querySelectorAll('input'));

        for (const el of priceSpans) {
          // --- FIX CRITICO: IGNORAR CONTENIDO DEL TITULO O INPUTS ---
          if (nameDiv && (el === nameDiv || nameDiv.contains(el))) continue;
          const isInputPart = qtyInputs.some(inp => inp.contains(el) || el.contains(inp));
          if (isInputPart) continue;

          const text = normalizeSpaces(el.textContent || '');
          if (!text) continue;

          if (text.includes('%')) {
            const pm = text.match(/(\d{1,3}(?:[.,]\d+)?)/);
            if (pm) {
              const val = parsePrice(pm[1]);
              if (val !== null && val > 0 && val <= 100) discountPercent = val;
            }
            const mm = text.match(/M[ií]n\.?\s*(\d+)/i);
            if (mm) {
              const n = parseInt(mm[1], 10);
              if (!isNaN(n)) discountMin = n;
            }
            continue;
          }

          if (/M[ií]n/.test(text)) {
            const mm = text.match(/M[ií]n\.?\s*(\d+)/i);
            if (mm) {
              const n = parseInt(mm[1], 10);
              if (!isNaN(n)) discountMin = n;
              if (!/[\d]/.test(text.replace(/M[ií]n|min/ig, ''))) continue;
            }
          }

          const matches = text.match(priceRegex);
          if (!matches) continue;
          const struck = isStruck(el);
          for (const m of matches) {
            const value = parsePrice(m);
            if (value === null) continue;
            prices.push({ text: m, value, struck });
          }
        }

        if (!title && !prices.length) continue;

        let publicPrice = null;
        let unitPrice = null;
        let originalPrice = null;

        if (prices.length) {
          const sortedByValue = prices.slice().sort((a, b) => a.value - b.value);
          const publicEntry = sortedByValue[sortedByValue.length - 1];
          publicPrice = publicEntry.value;

          const oldEntry = prices.find(p => p.struck && Math.abs(p.value - publicPrice) > 0.01);
          if (oldEntry) originalPrice = oldEntry.value;

          const nonPublic = prices.filter(p => p !== publicEntry);
          if (nonPublic.length) {
            const nonStruck = nonPublic.filter(p => !p.struck);
            const candidates = nonStruck.length ? nonStruck : nonPublic;
            const unitEntry = candidates.slice().sort((a, b) => a.value - b.value)[0];
            unitPrice = unitEntry.value;

            if (!originalPrice && candidates.length > 1) {
              const others = candidates.slice().sort((a, b) => b.value - a.value).filter(p => Math.abs(p.value - unitEntry.value) > 0.01);
              if (others.length) originalPrice = others[0].value;
            }
          } else {
            unitPrice = publicEntry.value;
          }
        }

        results.push({
          productName: title || null,
          unitPrice: unitPrice !== null ? unitPrice : null,
          publicPrice: publicPrice !== null ? publicPrice : null,
          originalPrice: originalPrice !== null ? originalPrice : null,
          discountPercent: discountPercent !== null ? discountPercent : null,
          discountMin: discountMin !== null ? discountMin : null,
          levelStock: levelStock,
          extractedEAN: extractedEAN
        });
      } catch (e) { continue; }
    }
    return results;
  });

  return extracted;
}

/* -------------------- Scrape tabla carrito CON PAGINACIÓN Y FALLBACK EAN -------------------- */
async function scrapeCartTable(page, convertedExcelPath, inputFullData = []) {
  try {
    await page.waitForFunction(() => {
      const list = document.querySelector('ul#dmaBS-listItem');
      if (!list) return false;
      const rows = list.querySelectorAll('li.row.rowItem.dmaItem, li.rowItem.dmaItem, li.row.rowItem, li.rowItem');
      return rows.length > 0;
    }, { timeout: 15000 });
  } catch (e) {
    console.log('No se detectaron productos en la tabla/lista de la página.');
    return [];
  }

  let allResults = [];
  let hasMorePages = true;
  let pageIndex = 1;

  while (hasMorePages) {
    console.log(`[SCRAPER] Procesando página ${pageIndex}...`);
    const pageData = await extractDataFromCurrentPage(page);
    if (pageData && pageData.length > 0) {
      allResults.push(...pageData);
      console.log(`   -> Extraídos ${pageData.length} productos.`);
    }

    const nextPageAvailable = await page.evaluate(async () => {
      const ul = document.querySelector('#ind-paginas');
      if (!ul) return false;
      const currentLi = ul.querySelector('.actual-page');
      if (!currentLi) return false;
      const nextLi = currentLi.nextElementSibling;
      if (nextLi && nextLi.innerText.trim() !== '') return true;
      return false;
    });

    if (nextPageAvailable) {
      const nextPageNum = pageIndex + 1;
      const nextBtnLocator = page.locator(`#ind-paginas li`).filter({ hasText: String(nextPageNum) }).first();
      if (await nextBtnLocator.count() > 0) {
        try {
          await nextBtnLocator.click();
          await page.waitForFunction((n) => {
            const active = document.querySelector('#ind-paginas .actual-page');
            return active && active.innerText.trim() == String(n);
          }, nextPageNum, { timeout: 15000 });
          await wait(1500);
          pageIndex++;
        } catch (e) {
          console.warn(`[PAGINACIÓN] Error al cambiar a pág ${nextPageNum}: ${e.message}`);
          hasMorePages = false;
        }
      } else { hasMorePages = false; }
    } else { hasMorePages = false; }
  }

  console.log(`[SCRAPER] Finalizado. Total productos extraídos: ${allResults.length}`);

  if (!allResults || !allResults.length) {
    console.log('No se encontraron productos en ninguna página.');
    return [];
  }

  // Preparar datos para matching
  const results = allResults.map(it => {
    return {
      productName: it.productName || null,
      unitPrice: typeof it.unitPrice === 'number' ? Number(it.unitPrice.toFixed(2)) : null,
      publicPrice: typeof it.publicPrice === 'number' ? Number(it.publicPrice.toFixed(2)) : null,
      originalPrice: typeof it.originalPrice === 'number' ? Number(it.originalPrice.toFixed(2)) : null,
      discountPercent: typeof it.discountPercent === 'number' ? Number(it.discountPercent) : null,
      discountMin: typeof it.discountMin === 'number' && !isNaN(it.discountMin) ? it.discountMin : null,
      levelStock: (typeof it.levelStock === 'string') ? it.levelStock : null,
      extractedEAN: it.extractedEAN || ''
    };
  });

  saveResultsToCSV_tableOnly(results);

  if (results.length > 0) {
    // --- MATCHING INTELIGENTE ---
    // Usamos inputFullData (que viene del JSON) para linkear EANs faltantes
    const linkedResults = linkEansToProducts(results, inputFullData);

    const outputData = linkedResults.map((r, index) => {
      let unitarioStr = (r.unitPrice != null) ? r.unitPrice : '';
      let publicoStr = (r.publicPrice != null) ? r.publicPrice : '';
      let sinDescStr = (r.originalPrice != null) ? r.originalPrice : '';
      if (!sinDescStr && r.publicPrice) sinDescStr = publicoStr;

      let stockStr = (r.levelStock === 'stock' || r.levelStock === 'stock crítico') ? 'si' : 'no';
      let multMinStr = (r.discountMin != null) ? String(r.discountMin) : '1';

      return {
        producto: r.productName || '',
        precio_unitario: unitarioStr,
        precio_sin_descuento: sinDescStr,
        precio_publico: publicoStr,
        stock: stockStr,
        mult_min: multMinStr,
        // CLAVE: Usamos el EAN linkeado si existe, sino el extraído, sino vacío.
        ean: r.ean_linked || r.extractedEAN || '',
        ean_linked: r.ean_linked || '',
        link_score: r.link_score || 0
      };
    });

    if (!IS_SHOP4ME_CONTEXT) {
      console.log('\n================ RESULTADOS OBTENIDOS ================');
      outputData.forEach((item, index) => {
        console.log(`\n--- [ Producto #${index + 1} ] ---`);
        console.log(`Nombre       : ${item.producto}`);
        console.log(`$ Unitario   : $${item.precio_unitario}`);
        console.log(`$ Público    : $${item.precio_publico}`);
        console.log(`Stock        : ${item.stock.toUpperCase()}`);
        console.log(`EAN (Linked): ${item.ean} ${item.link_score > 0 ? '(Match: ' + item.link_score + ')' : ''}`);
        if (LINK_DEBUG && item.link_score === 0) {
          console.log(`   (DEBUG) Falló match para: "${item.producto}"`);
        }
      });
      console.log('\n======================================================\n');
    }

    console.log('@@@PILLIGENCE_TABLE@@@' + JSON.stringify({ data: outputData }));
    console.log(`[APP] Datos CSV parseados y emitidos (via JSON seguro).`);

  } else {
    console.log('No se encontraron productos en la tabla/lista de la página.');
  }

  return results;
}

/* -------------------- Helpers UI / login / import -------------------- */

async function humanTypeOnLocator(page, locator, text) {
  try {
    await locator.scrollIntoViewIfNeeded().catch(() => { });
    await locator.focus().catch(() => { });
    await locator.fill(text);
  } catch (e) {
    try {
      await page.evaluate((el, val) => { if (el) el.value = val; }, await locator.elementHandle(), text);
    } catch (e2) { }
  }
}

async function clickLoginButtonRobust(page, scope = null) {
  const root = scope || page;
  try {
    const btnRole = root.getByRole('button', { name: /^Iniciar sesión$/i }).first();
    if (await btnRole.count()) { await btnRole.click({ timeout: 5000 }); return true; }
  } catch (e) { }
  try {
    const btnHasText = root.locator('button:has-text("Iniciar sesión"), [role="button"]:has-text("Iniciar sesión")').first();
    if (await btnHasText.count()) { await btnHasText.click({ timeout: 5000 }); return true; }
  } catch (e) { }
  try {
    const looseBtn = root.locator('button, input[type=submit], [role="button"]').filter({ hasText: /iniciar|ingresar|acceder|entrar/i }).first();
    if (await looseBtn.count()) { await looseBtn.click({ timeout: 5000 }); return true; }
  } catch (e) { }
  if (!scope) {
    try {
      await page.evaluate(() => { const f = document.querySelector('form'); if (f) f.submit(); });
      return true;
    } catch (e) { }
  }
  return false;
}

const SEARCH_SELECTORS = ['input[type=search]', 'input[placeholder*="Buscar"]', 'input[name*=search]', 'input[id*=search]', 'input[class*="search"]'];
const SEARCH_TOGGLE_SELECTORS = ['button[aria-label*="Buscar"]', '.search-toggle', 'button:has(.icon-search)'];

async function focusSearchInput(page) {
  try {
    for (const sel of SEARCH_SELECTORS) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) {
        await loc.scrollIntoViewIfNeeded().catch(() => { });
        await loc.click({ timeout: 300 }).catch(() => { });
        return true;
      }
    }
    for (const t of SEARCH_TOGGLE_SELECTORS) {
      const toggle = page.locator(t).first();
      if ((await toggle.count()) > 0) {
        await toggle.click({ timeout: 500 }).catch(() => { });
        await wait(300);
        for (const sel of SEARCH_SELECTORS) {
          const loc2 = page.locator(sel).first();
          if ((await loc2.count()) > 0) {
            await loc2.click({ timeout: 300 }).catch(() => { });
            return true;
          }
        }
      }
    }
  } catch (e) { }
  return false;
}

async function dismissHorarioModal(page) {
  try {
    const textCandidates = ['Finaliza el horario de Ingreso de Pedidos', 'Finaliza el horario de Ingreso'];
    await wait(500);
    for (const t of textCandidates) {
      const loc = page.locator(`text=${t}`).first();
      if ((await loc.count()) > 0) {
        const genericBtn = page.locator('button:has-text("OK"), button:has-text("Ok"), button:has-text("Aceptar")').first();
        if ((await genericBtn.count()) > 0) {
          await genericBtn.click({ timeout: 3000 }).catch(() => { });
          await wait(400);
          await focusSearchInput(page);
          return true;
        }
      }
    }
  } catch (err) { }
  return false;
}

async function clickImportAndSelectExcel(page) {
  try {
    const importSelectors = ['button:has-text("Importar")', 'button.btn-primary:has-text("Importar")', 'button[class*="importar"]'];
    let clickedImport = false;
    for (const sel of importSelectors) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0) {
        await btn.scrollIntoViewIfNeeded().catch(() => { });
        await btn.click({ timeout: 4000 }).catch(() => { });
        clickedImport = true;
        break;
      }
    }
    await wait(500);
    if (!clickedImport) {
      const candidate = page.locator('button').filter({ hasText: /importar|import/i }).first();
      if ((await candidate.count()) > 0) { await candidate.click().catch(() => { }); clickedImport = true; }
    }
    await wait(300);
    const tab = page.locator('text="Excel y más"').first();
    if ((await tab.count()) > 0) await tab.click().catch(() => { });
    return clickedImport;
  } catch (err) { return false; }
}

// **** BUCLE PRINCIPAL INTERACTIVO ****
async function startInteractiveSearchLoop(page) {
  console.log('\n--- MODO BÚSQUEDA INTERACTIVA (REMOTE CHROME) ---');
  console.log(`[INFO] Conectado a sesión existente. Usa "BATCH:..." o "CMD_PICK_FILE".`);
  console.log('@@@READY@@@');

  rl.on('line', async raw => {
    const term = (raw || '').trim();
    if (!term) return;

    if (term.toLowerCase() === 'exit') {
      console.log('[SHUTDOWN] Cerrando conexión y ventana de Chrome...');
      try { if (page && page.context().browser()) await page.context().browser().close(); } catch (e) { }
      if (globalChromeProcess) try { globalChromeProcess.kill(); } catch (e) { }
      process.exit(0);
    }

    if (term === 'CMD_PICK_FILE') {
      console.log('[FILE-ALGO] Iniciando selector de archivo nativo...');
      const conversionResult = await preflightFileConvert();
      if (conversionResult && conversionResult.outPath) {
        try {
          await clickImportAndSelectExcel(page);
          const uploaded = await uploadConvertedExcel(page, conversionResult.outPath);
          if (uploaded) {
            console.log(`[FILE-ALGO] Archivo subido. Esperando procesamiento...`);
            await wait(8000);
            await scrapeCartTable(page, conversionResult.outPath, conversionResult.fullInputData);
          } else console.log('[ERROR] No se pudo subir el archivo Excel a la web.');
        } catch (e) { console.error(`[ERROR] Fallo en el flujo de archivo manual: ${e.message}`); }
        finally {
          if (fs.existsSync(conversionResult.outPath)) try { fs.unlinkSync(conversionResult.outPath); } catch (e) { }
          console.log(`Finalizado para CMD_PICK_FILE`);
        }
      }
      return;
    }

    // --- MANEJO DE BATCH JSON ---
    let inputItems = [];

    if (term.startsWith("BATCH_JSON:")) {
      const jsonStr = term.replace("BATCH_JSON:", "").trim();
      try {
        inputItems = JSON.parse(jsonStr); // Expecting [{ean, name, qty?}, ...]
        console.log(`[FILE-ALGO] Procesando BATCH_JSON de ${inputItems.length} items...`);
      } catch (e) {
        console.error('[ERROR] Fallo al parsear JSON:', e);
        return;
      }
    } else if (term.startsWith("BATCH:")) {
      const eanListStr = term.replace("BATCH:", "");
      const eans = eanListStr.split(',').filter(Boolean);
      inputItems = eans.map(e => ({ ean: e, name: e })); // Dummy name
      console.log(`[FILE-ALGO] Procesando BATCH string de ${inputItems.length} términos...`);
    } else {
      inputItems = [{ ean: term, name: term }];
      console.log(`[FILE-ALGO] Procesando término único: "${term}"`);
    }

    // Generar excel temporal usando los nombres del JSON para que la web encuentre algo
    let excelPath;
    try {
      excelPath = generateTempExcelFromList(inputItems);
    } catch (e) {
      console.error(`[ERROR] Fallo al generar Excel: ${e.message}`);
      return;
    }

    try {
      await clickImportAndSelectExcel(page);
      const uploaded = await uploadConvertedExcel(page, excelPath);

      if (uploaded) {
        const waitTime = 5000;
        console.log(`Esperando ${waitTime / 1000}s para procesamiento...`);
        await wait(waitTime);
        // Pasamos inputItems completos para el matching inteligente
        await scrapeCartTable(page, excelPath, inputItems);
      } else {
        console.log('[ERROR] No se pudo subir el archivo Excel.');
      }

    } catch (e) {
      console.error(`[ERROR] Fallo en el flujo de archivo: ${e.message}`);
    } finally {
      if (excelPath && fs.existsSync(excelPath)) {
        try { fs.unlinkSync(excelPath); } catch (e) { }
      }
      console.log(`Finalizado para "${term.startsWith('BATCH_JSON') ? 'BATCH_JSON' : term}"`);
    }
  });
}

// ---------------------------------------------------------------------------
// NUEVO: LANZADOR AUTOMÁTICO DE CHROME
// ---------------------------------------------------------------------------
function candidateChromePaths() {
  const envPath = process.env.CHROME_PATH || process.env.CHROME_EXE;
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

async function launchChromeManually() {
  console.log('[BOOT] Buscando ejecutable de Chrome...');

  const paths = candidateChromePaths();
  const chosenPath = paths.find(p => fs.existsSync(p));

  if (!chosenPath) {
    console.error(`ERROR: No se encontró Chrome en ninguna ruta estándar ni en env vars.`);
    console.error(`Rutas probadas: ${paths.join(', ')}`);
    process.exit(1);
  }

  console.log(`[BOOT] Usando ejecutable: ${chosenPath}`);

  if (!fs.existsSync(CHROME_USER_DATA_DIR)) {
    try { fs.mkdirSync(CHROME_USER_DATA_DIR, { recursive: true }); } catch (e) { }
  }

  console.log(`[BOOT] Lanzando proceso Google Chrome en puerto ${CHROME_DEBUG_PORT}...`);
  globalChromeProcess = spawn(chosenPath, [
    `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
    `--user-data-dir=${CHROME_USER_DATA_DIR}`,
    '--window-position=-2400,-2400', // <--- CAMBIO CLAVE: Mueve la ventana fuera del monitor
    '--window-size=1920,1080',       // <--- CAMBIO CLAVE: Fuerza tamaño de monitor Full HD
    '--start-maximized',
    '--no-first-run',
    '--no-default-browser-check',
    URL
  ], { detached: true, stdio: 'ignore' });
  globalChromeProcess.unref();
  console.log('[BOOT] Esperando 4 segundos a que Chrome inicie...');
  await wait(4000);
}

/* --------------------- FLOW principal --------------------- */
(async () => {
  await launchChromeManually();
  console.log(`[INIT] Conectando a Chrome en puerto ${CHROME_DEBUG_PORT}...`);
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${CHROME_DEBUG_PORT}`);
    console.log('[INIT] ¡Conexión exitosa a la instancia de Chrome!');
  } catch (e) {
    console.error('ERROR CRÍTICO: Playwright no pudo conectarse al navegador.', e.message);
    process.exit(1);
  }

  const contexts = browser.contexts();
  const context = contexts[0];
  console.log('[INIT] Abriendo nueva pestaña forzada...');
  const page = await context.newPage();
  await page.goto(URL);
  await page.bringToFront();

  const isLoginPage = await page.evaluate(() => !!document.querySelector('form') && !!document.querySelector('input[type="password"]'));

  if (isLoginPage) {
    console.log('[LOGIN] Detectada página de login. Procediendo a autocompletar...');
    const emailSelectors = ['input[type=email]', 'input[type=text][name*=user]', 'input[name*=email]', 'input[id*=user]'];
    let typedUser = false;
    for (const s of emailSelectors) {
      const loc = page.locator(s).first();
      if (await loc.count()) { await humanTypeOnLocator(page, loc, USERNAME); typedUser = true; break; }
    }
    if (!typedUser) { const first = page.locator('input:visible').first(); if (await first.count()) await humanTypeOnLocator(page, first, USERNAME); }

    const passSelectors = ['input[type=password]', 'input[name*=pass]', 'input[id*=pass]'];
    for (const s of passSelectors) {
      const loc = page.locator(s).first();
      if (await loc.count()) { await humanTypeOnLocator(page, loc, PASSWORD); break; }
    }

    // ---------------------------------------------------------------------------
    // NUEVO: CLICK EN CHECKBOX "RECORDAR SESIÓN" (Detectado por ID pExt)
    // ---------------------------------------------------------------------------
    try {
      const checkboxSelector = 'input#pExt'; // Selector específico del ID visto en la imagen
      const checkbox = page.locator(checkboxSelector).first();

      if (await checkbox.count() > 0) {
        const isChecked = await checkbox.isChecked();
        if (!isChecked) {
          console.log('[LOGIN] Checkbox "Recordar sesión" detectado y desmarcado. Click en él...');
          await checkbox.click();
          await wait(randomBetween(200, 500));
        } else {
          console.log('[LOGIN] Checkbox "Recordar sesión" ya estaba marcado.');
        }
      } else {
        // Fallback genérico por si cambian el ID
        const fallbackCheckbox = page.locator('input[type="checkbox"]').filter({ hasText: /Recordar/i }).first();
        if (await fallbackCheckbox.count() > 0 && !(await fallbackCheckbox.isChecked())) {
          console.log('[LOGIN] Checkbox (fallback) detectado. Click en él...');
          await fallbackCheckbox.click();
          await wait(randomBetween(200, 500));
        }
      }
    } catch (errCheckbox) {
      console.warn('[LOGIN] Advertencia no crítica al intentar clickear checkbox:', errCheckbox.message);
    }

    const clicked = await clickLoginButtonRobust(page);
    if (clicked) {
      console.log('[LOGIN] Botón presionado. Esperando detección de Captcha o Dashboard...');
      // AUMENTADO: Esperar 5s porque Monroe tarda en mostrar el modal
      await wait(5000);
    }

    // LOGICA DE CAPTCHA MEJORADA (Selectors muy específicos para evitar falsos positivos)
    let captchaModal = null;
    let captchaDetected = false;

    try {
      // SOLO detectamos si contiene el texto exacto que usa Monroe para pedir el código
      const captchaSelectors = [
        'div:has-text("Para una mayor seguridad")',
        'div:has-text("Por favor ingrese el código")',
        'div:has-text("Ingrese los caracteres")'
      ].join(',');

      const potential = page.locator(captchaSelectors).first();

      // Verificamos que sea visible y tenga tamaño (no un pixel oculto)
      if (await potential.count() > 0 && await potential.isVisible()) {
        const box = await potential.boundingBox();
        if (box && box.width > 5 && box.height > 5) {
          captchaModal = page.locator('div[role="dialog"], div.modal').filter({ has: potential }).first();
          if (await captchaModal.count() === 0) captchaModal = potential;
          captchaDetected = true;
        }
      }
    } catch (e) { }

    if (captchaDetected) {
      console.log('[CAPTCHA] ¡Atención! Apareció Captcha.');
      let imageBase64 = '';
      try {
        const imgLocator = captchaModal.locator('img');
        if ((await imgLocator.count()) > 0) {
          const buffer = await imgLocator.first().screenshot();
          imageBase64 = `data:image/png;base64,${buffer.toString('base64')}`;
          console.log(`@@@CAPTCHA_REQUIRED@@@${JSON.stringify({ imageBase64 })}`);
        }
      } catch (e) { }

      rl.once('line', async (captchaCode) => {
        try {
          if (captchaCode && captchaCode.trim() !== '') {
            const inputLocator = captchaModal.locator('input[type="text"], input:not([type])').first();
            if (await inputLocator.count() > 0) {
              await humanTypeOnLocator(page, inputLocator, captchaCode);
              await wait(500);
              const confirmBtn = captchaModal.locator('button, input[type="submit"]').last();
              if (await confirmBtn.count() > 0) await confirmBtn.click();
              else await clickLoginButtonRobust(page, captchaModal);

              await wait(4000);
            }
          }
        } catch (err) {
          console.error('[CAPTCHA FLOW ERROR]', err.message);
        } finally {
          startInteractiveSearchLoop(page);
        }
      });
      return;
    }
  } else {
    console.log('[LOGIN] Parece que ya estás logueado. Omitiendo login.');
  }

  // Verificación final antes de arrancar
  try { await dismissHorarioModal(page); await focusSearchInput(page); } catch (e) { }

  const isLoggedIn = await page.locator(SEARCH_SELECTORS.join(',')).first().count() > 0;
  if (!isLoggedIn) {
    console.warn('[WARNING] No se detectó la barra de búsqueda. Es posible que el login haya fallado o siga en Captcha no detectado.');
  }

  startInteractiveSearchLoop(page);
})();