#!/usr/bin/env node
/**
 * DelSudSCRAPERFILE.js
 * FIXES:
 * - No ElementHandle/Locator mismatch (uses Locator everywhere)
 * - Handles MUI virtualization by scrolling the results container and harvesting all unique rows
 * - Pagination waits for page change + stable content
 * - Adds EAN (Linked): links scraped rows back to EANs from the input file (manual) / JSON (batch)
 * - NAME-SURGICAL linking: avoids mismatches by strict name+hard-token matching
 * - HEADER FILTERING: Ignora filas que son encabezados de tabla (Descripcion, Precio, etc.)
 * - SLOW SCROLL: Scroll factor reducido para evitar saltar registros en tablas virtualizadas.
 * - ZERO PRICE FIX: Si detecta precio con descuento en 0 pero PVP válido, usa el PVP.
 * - WINDOW POSITION: Ventanas ocultas (fuera de pantalla) usando coordenadas negativas.
 * - WINDOW SIZE: Tamaño forzado a 1920x1080 para evitar layout móvil.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const { spawnSync } = require('child_process');

/// =========== Config / envs ===========
const EMAIL = process.env.DELSUD_USER;
const PASS = process.env.DELSUD_PASS;

const STATE_FILE = process.env.STATE_FILE || path.resolve(__dirname, 'state-delsud.json');

const CHROME_PATH = process.env.CHROME_PATH || process.env.CHROME_EXE || null;
const PLAYWRIGHT_HEADLESS =
    (process.env.PLAYWRIGHT_HEADLESS === '1' || process.env.PLAYWRIGHT_HEADLESS === 'true') ? true : false;
const KEEP_BROWSER_OPEN =
    (process.env.KEEP_BROWSER_OPEN === '0' || process.env.KEEP_BROWSER_OPEN === 'false') ? false : true;

const ENABLE_DIAG = (process.env.DIAG === '1');
const DIAG_DIR = path.resolve(__dirname, 'diagnostics');

const LOGIN_URL = 'https://pedidos.delsud.com.ar/login';
const RAW_CLIENT_CODE = process.env.DELSUD_CLIENT || '';

const PAGE_WAIT_TIMEOUT = parseInt(process.env.PAGE_WAIT_TIMEOUT || '6500', 10);
const CHAR_DELAY_MIN = parseInt(process.env.CHAR_DELAY_MIN || '0', 10);

const MAX_PAGES = parseInt(process.env.MAX_PAGES || '200', 10);
const EXTRA_WAIT_AFTER_TABLE_MS = parseInt(process.env.EXTRA_WAIT_AFTER_TABLE_MS || '6000', 10);

// Legacy (kept for compatibility/logging)
const LINK_SCORE_THRESHOLD = parseFloat(process.env.LINK_SCORE_THRESHOLD || '0.34');
const LINK_DEBUG = (process.env.LINK_DEBUG === '1');

/// =========== Estado simple para secuencia de pedidos ===========
function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return {};
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        if (!raw.trim()) return {};
        return JSON.parse(raw);
    } catch (e) {
        console.warn('[STATE] No se pudo leer STATE_FILE, se reinicia contador:', e.message);
        return {};
    }
}

function saveState(state) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
        console.warn('[STATE] No se pudo guardar STATE_FILE (secuencia no persistente):', e.message);
    }
}

function normalizeClientCode(raw) {
    const digits = String(raw || '').trim().replace(/\D/g, '');
    if (!digits) return '00000';
    return digits.padStart(5, '0').slice(-5);
}

function getNextPedidoNumber(clientCode) {
    const clientKey = normalizeClientCode(clientCode);
    const state = loadState();
    if (!state.pedidos) state.pedidos = {};

    const last = Number(state.pedidos[clientKey] || 0);
    let next = (last + 1) % 10000;
    if (next === 0) next = 1;

    state.pedidos[clientKey] = next;
    saveState(state);
    return next;
}

function buildPedFileName(clientCodeFromBatchOrEnv) {
    const normalizedClient = normalizeClientCode(clientCodeFromBatchOrEnv || RAW_CLIENT_CODE);
    const pedidoNum = getNextPedidoNumber(normalizedClient);
    const pedidoStr = String(pedidoNum).padStart(4, '0').slice(-4);

    const fileName = 'ped.txt';
    console.log(`[PED] Nombre de archivo forzado: ${fileName} (Secuencia interna: cliente=${normalizedClient}, pedido=${pedidoStr})`);

    return { fileName, normalizedClient, pedidoStr };
}

/// =========== Utilidades File Picker & Conversión (MODO MANUAL) ===========
function pickFileNative() {
    const platform = process.platform;
    console.log('[FILE] Intentando abrir ventana de selección de archivo TXT...');

    if (platform === 'win32') {
        try {
            const ps = `
        [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
        $ofd = New-Object System.Windows.Forms.OpenFileDialog
        $ofd.Filter = "Archivos de texto (*.txt)|*.txt|Todos los archivos (*.*)|*.*"
        $ofd.Title = "SELECCIONÁ EL ARCHIVO TXT ORIGINAL"

        $form = New-Object System.Windows.Forms.Form
        $form.TopMost = $true
        $form.StartPosition = 'Manual'
        $form.Location = New-Object System.Drawing.Point(-20000, -20000)
        $form.ShowInTaskbar = $false

        if ($ofd.ShowDialog($form) -eq 'OK') {
          Write-Host $ofd.FileName
        }
        $form.Dispose()
      `;
            const res = spawnSync(
                'powershell.exe',
                ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
                { encoding: 'utf8', windowsHide: true }
            );
            if (res.status === 0) {
                const out = (res.stdout || '').trim().split(/\r?\n/).pop() || '';
                if (out) return out.trim();
            }
        } catch (e) {
            console.error('[FILE] Error al invocar PowerShell:', e.message);
        }
    }

    if (platform === 'darwin') {
        try {
            const osa = `set f to POSIX path of (choose file with prompt "Seleccioná el archivo .txt" of type {"txt","text"})
if f is not missing value then
  do shell script "printf " & quoted form of f
end if`;
            const res = spawnSync('osascript', ['-e', osa], { encoding: 'utf8' });
            if (res.status === 0 && res.stdout.trim()) return res.stdout.trim();
        } catch (e) { }
    }

    if (platform === 'linux') {
        try {
            const res = spawnSync('zenity', ['--file-selection', '--title=Seleccioná el archivo .txt'], { encoding: 'utf8' });
            if (res.status === 0 && res.stdout.trim()) return res.stdout.trim();
        } catch (e) { }
    }

    return null;
}

/**
 * Convierte un archivo TXT maestro
 * Salida: Archivo ped.txt con formato EAN[13] + DESC[30] + QTY[3]
 */
function convertInputToPedsec(inputPath, clientCodeFromCaller) {
    if (!fs.existsSync(inputPath)) throw new Error('Archivo no existe: ' + inputPath);

    const content = fs.readFileSync(inputPath, 'utf8');
    const lines = content.split(/\r?\n/).filter(l => l && l.trim().length > 0);

    const pedsecLines = [];
    const itemsInMemory = [];

    console.log(`[CONVERT] Procesando ${lines.length} líneas del TXT input...`);

    for (const line of lines) {
        const cleanLine = line.replace(/\r/g, '').trim();
        if (!cleanLine) continue;

        let eanRaw = '';
        let qtyRaw = '1';
        let descRaw = '';

        const spaceMatch = cleanLine.match(/^(\d+)\s+(.+)$/);

        if (spaceMatch && !cleanLine.includes(',')) {
            eanRaw = spaceMatch[1].trim();
            descRaw = spaceMatch[2].trim();
            qtyRaw = '1';
        } else {
            const parts = cleanLine.split(',');
            if (parts.length >= 5) {
                eanRaw = (parts[0] || '').trim().replace(/"/g, '');
                qtyRaw = (parts[4] || '1').trim().replace(/"/g, '');
                descRaw = parts.slice(5).join(',').trim().replace(/"/g, '');
            } else {
                eanRaw = (parts[0] || cleanLine).trim().replace(/"/g, '');
                qtyRaw = '1';
                descRaw = 'IMPORTADO MANUAL';
            }
        }

        if (!eanRaw) continue;

        const ean = eanRaw.padEnd(13, ' ').substring(0, 13);
        let qtyNum = parseInt(qtyRaw, 10);
        if (isNaN(qtyNum) || qtyNum < 1) qtyNum = 1;
        const qtyPadded = qtyNum.toString().padStart(3, '0').substring(0, 3);
        let descClean = (descRaw || '').toUpperCase().replace(/\s+/g, ' ').trim();
        const descPadded = descClean.padEnd(30, ' ').substring(0, 30);

        const pedsecLine = `${ean}${descPadded}${qtyPadded}`;
        pedsecLines.push(pedsecLine);

        // Keep full descClean for linking later
        itemsInMemory.push({ ean: eanRaw, qty: qtyNum.toString(), desc: descClean });
    }

    if (pedsecLines.length === 0) {
        throw new Error('[CONVERT] No se generaron líneas PEDSEC válidas. Revisa el formato del archivo TXT.');
    }

    console.log('\n==========================================================');
    console.log('   PREVIEW DEL ARCHIVO GENERADO (Primeras 3 líneas)');
    console.log('==========================================================');
    for (let i = 0; i < Math.min(3, pedsecLines.length); i++) {
        console.log(`Línea ${i + 1}: "${pedsecLines[i]}"`);
    }
    console.log('==========================================================\n');

    const tempDir = os.tmpdir();
    const { fileName, normalizedClient, pedidoStr } = buildPedFileName(clientCodeFromCaller || RAW_CLIENT_CODE);
    const pedsecPath = path.join(tempDir, fileName);

    fs.writeFileSync(pedsecPath, pedsecLines.join('\r\n'), 'utf8');
    console.log(`[CONVERT] Archivo de salida (${fileName}) generado en: ${pedsecPath} (${pedsecLines.length} items)`);

    return {
        pedsecPath,
        items: itemsInMemory,
        count: pedsecLines.length,
        fileName,
        clientCode: normalizedClient,
        pedidoNumber: pedidoStr
    };
}

function generatePedsecFromJSON(items, clientCodeFromCaller) {
    const pedsecLines = [];
    const validItems = [];

    console.log(`[CONVERT] Procesando ${items.length} items JSON...`);

    for (const item of items) {
        const eanRaw = (item.ean || '').trim().replace(/"/g, '');
        if (!eanRaw) continue;

        let qtyNum = parseInt(item.qty, 10);
        if (isNaN(qtyNum) || qtyNum < 1) qtyNum = 1;

        const descRaw = (item.name || item.desc || '').trim().replace(/"/g, '');

        const ean = eanRaw.padEnd(13, ' ').substring(0, 13);
        let descClean = descRaw.toUpperCase().replace(/\s+/g, ' ').trim();
        const descPadded = descClean.padEnd(30, ' ').substring(0, 30);
        const qtyPadded = qtyNum.toString().padStart(3, '0').substring(0, 3);

        pedsecLines.push(`${ean}${descPadded}${qtyPadded}`);
        validItems.push({ ean: eanRaw, qty: qtyNum.toString(), desc: descClean });
    }

    if (pedsecLines.length === 0) throw new Error('[CONVERT] No se generaron líneas válidas desde JSON.');

    const batchClient =
        clientCodeFromCaller ||
        (Array.isArray(items) && items[0] && items[0].client) ||
        RAW_CLIENT_CODE;

    const tempDir = os.tmpdir();
    const { fileName, normalizedClient, pedidoStr } = buildPedFileName(batchClient);
    const pedsecPath = path.join(tempDir, fileName);

    fs.writeFileSync(pedsecPath, pedsecLines.join('\r\n'), 'utf8');
    console.log(`[CONVERT] Archivo de salida (BATCH, ${fileName}) generado en: ${pedsecPath} (${pedsecLines.length} items)`);

    return { pedsecPath, validItems, count: pedsecLines.length, fileName, clientCode: normalizedClient, pedidoNumber: pedidoStr };
}

async function prepareFiles() {
    console.log('--- Paso 1: Selección y Conversión de Archivo ---');
    let txtPath = pickFileNative();

    if (!txtPath) {
        console.log('\n!!! No se detectó selección. Pegá la ruta del archivo TXT maestro: !!!');
        txtPath = await new Promise(resolve => {
            const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
            rl2.question('Ruta TXT > ', ans => { rl2.close(); resolve(ans && ans.trim()); });
        });
    }

    if (!txtPath) throw new Error('No se seleccionó archivo.');
    txtPath = txtPath.replace(/^"|"$/g, '');
    console.log('Archivo TXT seleccionado:', txtPath);

    return convertInputToPedsec(txtPath, RAW_CLIENT_CODE);
}

/// =========== Utilidades generales ===========
function nowStamp() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
}
function safeTrim(s) { return (s === null || s === undefined) ? '' : String(s).replace(/\s+/g, ' ').trim(); }

function normalizeMoneyText(raw) {
    const s = safeTrim(raw);
    if (!s) return s;
    let out = s.replace(/,([\s\u00A0]+)(\d{1,2})/g, ',$2');
    out = out.replace(/(\d)\s*%/g, '$1%');
    return out;
}

async function saveDiagnostic(page, namePrefix) {
    if (!ENABLE_DIAG) return;
    try {
        if (!fs.existsSync(DIAG_DIR)) fs.mkdirSync(DIAG_DIR, { recursive: true });
        const stamp = nowStamp();
        const png = path.join(DIAG_DIR, `${namePrefix}_${stamp}.png`);
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
                try { await el.first().click({ force: true, timeout: 1500 }); }
                catch { try { await el.first().click({ force: true }); } catch { } }
                await page.waitForTimeout(80);
            }
        } catch { }
    }
}

async function ensureFocusAndType(page, selector, text) {
    try { await page.waitForSelector(selector, { timeout: Math.max(500, PAGE_WAIT_TIMEOUT) }); } catch { }
    try { await page.focus(selector); } catch {
        try { await page.evaluate(sel => { const el = document.querySelector(sel); if (el) el.focus(); }, selector); } catch { }
    }

    try { await page.fill(selector, String(text)); } catch { }

    const val = await page.inputValue(selector).catch(() => '');
    if (val !== String(text)) {
        console.log(`[LOGIN] Reintentando escritura en ${selector} (Valor actual: '${val}' vs Esperado: '${text}')...`);
        try {
            await page.fill(selector, '');
            for (const ch of String(text)) await page.keyboard.type(ch, { delay: Math.max(0, CHAR_DELAY_MIN) });
        } catch {
            return false;
        }
    }

    const finalVal = await page.inputValue(selector).catch(() => '');
    return finalVal === String(text);
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

/// =========== EAN LINKING (NAME-SURGICAL) ===========
// High-confidence controls (env-overridable)
const NAME_STRICT_THRESHOLD = parseFloat(process.env.NAME_STRICT_THRESHOLD || '0.92');
const NAME_AMBIGUITY_GAP = parseFloat(process.env.NAME_AMBIGUITY_GAP || '0.02');
const REQUIRE_NUMERIC_TOKENS = (process.env.REQUIRE_NUMERIC_TOKENS || '1') !== '0';
const ALLOW_SEQUENTIAL_FALLBACK = (process.env.ALLOW_SEQUENTIAL_FALLBACK || '0') === '1';

function normalizeForMatch(s) {
    const txt = safeTrim(s).toUpperCase();
    let out = txt;
    try { out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch { }
    out = out.replace(/[^A-Z0-9\s]/g, ' ');
    out = out.replace(/\s+/g, ' ').trim();

    // normalize common unit variants
    out = out
        .replace(/\bMGS?\b/g, 'MG')
        .replace(/\bMILILITROS?\b/g, 'ML')
        .replace(/\bGRAMOS?\b/g, 'GR')
        .replace(/\bLITROS?\b/g, 'L')
        .replace(/\bCOMPRIMIDOS?\b/g, 'COMP')
        .replace(/\bCAPSULAS?\b/g, 'CAP')
        .replace(/\bTABLETAS?\b/g, 'TAB');

    return out;
}

function extractHardTokens(norm) {
    const hard = [];

    const nums = norm.match(/\b\d+(?:[.,]\d+)?\b/g) || [];
    const numUnits = norm.match(/\b(\d+(?:[.,]\d+)?)\s*(MG|ML|GR|G|KG|L|CC|MM|CM|MCI|UI|%)\b/g) || [];
    const packs = norm.match(/\bX\s*\d+\b/g) || [];
    const forms = norm.match(/\b(\d+)\s*(COMP|CAP|TAB|AMP|SOB|UN)\b/g) || [];

    for (const x of numUnits) hard.push(x.replace(/\s+/g, ''));
    for (const x of packs) hard.push(x.replace(/\s+/g, ''));
    for (const x of forms) hard.push(x.replace(/\s+/g, ''));

    if (hard.length === 0) {
        for (const n of nums) hard.push(n.replace(',', '.'));
    }

    return Array.from(new Set(hard));
}

function tokenizeWords(norm) {
    if (!norm) return [];
    const toks = norm.split(' ').filter(t => t.length >= 3);
    const stop = new Set([
        'PARA', 'CON', 'SIN', 'POR', 'DEL', 'DE', 'LA', 'LAS', 'LOS', 'UNA', 'UN',
        'THE', 'AND',
        'TAB', 'CAP', 'COMP', 'AMP', 'SOB', 'UN',
        'X'
    ]);
    return toks.filter(t => !stop.has(t));
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
    const transpositions = t / 2;

    const jaro =
        (matches / len1 + matches / len2 + (matches - transpositions) / matches) / 3;

    let prefix = 0;
    const maxPrefix = 4;
    for (let i = 0; i < Math.min(maxPrefix, len1, len2); i++) {
        if (a[i] === b[i]) prefix++;
        else break;
    }
    const p = 0.1;
    return jaro + prefix * p * (1 - jaro);
}

function buildInputIndex(inputItems) {
    const items = (inputItems || []).map((it, idx) => {
        const ean = safeTrim(it.ean);
        const desc = safeTrim(it.desc || it.name || '');
        const norm = normalizeForMatch(desc);
        return {
            idx,
            ean,
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
    if (!pn || !inputItem?.norm) return { score: 0, hardScore: 0, wordScore: 0, jw: 0 };

    const pHard = extractHardTokens(pn);
    const iHard = inputItem.hard || [];
    const hardScore = jaccard(pHard, iHard);

    if (REQUIRE_NUMERIC_TOKENS) {
        const bothHaveHard = (pHard.length > 0 && iHard.length > 0);
        if (bothHaveHard && hardScore < 0.60) {
            return { score: 0, hardScore, wordScore: 0, jw: 0 };
        }
    }

    const pWords = tokenizeWords(pn);
    const wordScore = jaccard(pWords, inputItem.words || []);
    const jw = jaroWinkler(pn, inputItem.norm);

    const score = Math.max(0, Math.min(1, (jw * 0.78) + (wordScore * 0.16) + (hardScore * 0.06)));
    return { score, hardScore, wordScore, jw };
}

/**
 * Adds:
 * - ean_linked
 * - link_method: 'ean_exact' | 'name_strict' | 'sequential' | 'none'
 * - link_score
 * - optional link_detail (when LINK_DEBUG=1)
 */
function linkEansToProducts(products, inputItems) {
    const out = (products || []).map(p => ({ ...p }));
    const { items, byEan } = buildInputIndex(inputItems || []);

    const usedInput = new Set();
    const assigned = new Array(out.length).fill(null);

    // 1) exact EAN match (if the site returns the real EAN and it exists in input)
    for (let pi = 0; pi < out.length; pi++) {
        const p = out[pi];
        const sku = safeTrim(p.sku);
        if (sku && /^\d{13}$/.test(sku) && byEan.has(sku)) {
            const it = byEan.get(sku);
            if (!usedInput.has(it.idx)) {
                usedInput.add(it.idx);
                assigned[pi] = { idx: it.idx, ean: it.ean, method: 'ean_exact', score: 1.0 };
            }
        }
    }

    // 2) compute best/second-best per product among unused input items
    const bestPerProduct = out.map((p, pi) => {
        if (assigned[pi]) return null;

        let best = null;
        let second = null;

        for (const it of items) {
            if (usedInput.has(it.idx)) continue;
            if (!it.desc || it.desc.length < 3) continue;

            const s = scoreNameMatch(p.producto || '', it);
            if (s.score <= 0) continue;

            const cand = { it, ...s };
            if (!best || cand.score > best.score) {
                second = best;
                best = cand;
            } else if (!second || cand.score > second.score) {
                second = cand;
            }
        }

        return { best, second };
    });

    // 2b) keep only confident, non-ambiguous matches
    const pairs = [];
    for (let pi = 0; pi < bestPerProduct.length; pi++) {
        const entry = bestPerProduct[pi];
        if (!entry || !entry.best) continue;

        const best = entry.best;
        const second = entry.second;

        const ambiguous = second && (best.score - second.score) < NAME_AMBIGUITY_GAP;

        if (best.score >= NAME_STRICT_THRESHOLD && !ambiguous) {
            pairs.push({
                pi,
                ii: best.it.idx,
                ean: best.it.ean,
                score: best.score,
                detail: { jw: best.jw, hard: best.hardScore, words: best.wordScore }
            });
        } else {
            if (LINK_DEBUG) {
                out[pi]._link_debug = {
                    best: best ? { idx: best.it.idx, ean: best.it.ean, score: best.score, jw: best.jw, hard: best.hardScore, words: best.wordScore } : null,
                    second: second ? { idx: second.it.idx, ean: second.it.ean, score: second.score, jw: second.jw, hard: second.hardScore, words: second.wordScore } : null,
                    ambiguous
                };
            }
        }
    }

    // 2c) global greedy assignment by highest score
    pairs.sort((a, b) => b.score - a.score);

    for (const pr of pairs) {
        if (assigned[pr.pi]) continue;
        if (usedInput.has(pr.ii)) continue;

        usedInput.add(pr.ii);
        assigned[pr.pi] = {
            idx: pr.ii,
            ean: pr.ean,
            method: 'name_strict',
            score: Number(pr.score.toFixed(4)),
            detail: pr.detail
        };
    }

    // 3) emit fields
    for (let pi = 0; pi < out.length; pi++) {
        const a = assigned[pi];
        if (a) {
            out[pi].ean_linked = a.ean;
            out[pi].link_method = a.method;
            out[pi].link_score = a.score;
            if (LINK_DEBUG && a.detail) out[pi].link_detail = a.detail;
        } else {
            out[pi].ean_linked = '';
            out[pi].link_method = 'none';
            out[pi].link_score = 0;
        }
    }

    // Optional sequential fallback (OFF by default to avoid mismatches)
    if (ALLOW_SEQUENTIAL_FALLBACK) {
        for (let pi = 0; pi < out.length; pi++) {
            if (out[pi].ean_linked) continue;
            const next = items.find(it => !usedInput.has(it.idx));
            if (!next) break;
            usedInput.add(next.idx);
            out[pi].ean_linked = next.ean;
            out[pi].link_method = 'sequential';
            out[pi].link_score = 0;
        }
    }

    if (LINK_DEBUG) {
        const stats = { ean_exact: 0, name_strict: 0, sequential: 0, none: 0 };
        for (const p of out) stats[p.link_method || 'none'] = (stats[p.link_method || 'none'] || 0) + 1;
        console.log('[LINK] Stats:', stats);
        const sample = out.slice(0, 12).map(p => ({
            producto: (p.producto || '').slice(0, 60),
            ean_linked: p.ean_linked,
            method: p.link_method,
            score: p.link_score
        }));
        console.log('[LINK] Sample:', sample);
    }

    return out;
}

/// =========== Upload logic ===========
async function clickSubirArchivo(page) {
    const selectors = [
        'button:has-text("Subir archivo")',
        'button:has-text("Subir")',
        'text="Subir archivo"',
        'button[title*="Subir"]',
        'button[aria-label*="Subir"]',
        'button[class*="upload"]'
    ];

    console.log('[UPLOAD] Buscando botón para ABRIR modal de subida...');
    const deadline = Date.now() + 15000;

    while (Date.now() < deadline) {
        try {
            const roleBtn = page.getByRole?.('button', { name: /Subir archivo|Subir/i });
            if (roleBtn && await roleBtn.count() > 0 && await roleBtn.first().isVisible()) {
                await roleBtn.first().scrollIntoViewIfNeeded();
                await roleBtn.first().click({ force: true });
                await page.waitForTimeout(400);
                return true;
            }
        } catch { }

        for (const sel of selectors) {
            try {
                const locator = page.locator(sel);
                if (await locator.count() > 0 && await locator.first().isVisible()) {
                    await locator.first().scrollIntoViewIfNeeded();
                    await locator.first().click({ force: true });
                    await page.waitForTimeout(400);
                    return true;
                }
            } catch { }
        }

        await page.waitForTimeout(400);
    }
    return false;
}

async function uploadFileInDialog(page, filePath) {
    try {
        const fileInputs = page.locator('input[type="file"]');
        if (await fileInputs.count() > 0) {
            await fileInputs.first().setInputFiles(filePath);
            await page.waitForTimeout(400);
            return true;
        }
    } catch { }

    try {
        const lbl = page.locator('text=Seleccionar archivo, label:has-text("Seleccionar archivo")');
        if (await lbl.count() > 0) {
            const [fileChooser] = await Promise.all([
                page.waitForEvent('filechooser', { timeout: 5000 }),
                lbl.first().click({ force: true })
            ]);
            await fileChooser.setFiles(filePath);
            await page.waitForTimeout(400);
            return true;
        }
    } catch (e) {
        console.warn('[UPLOAD] Fallback filechooser falló:', e.message);
    }
    return false;
}

async function confirmUploadButton(page) {
    console.log('[UPLOAD] Buscando botón de CONFIRMACIÓN dentro del modal...');
    const deadline = Date.now() + 12000;

    const confirmSelectors = [
        'div[role="dialog"] button:has-text("Subir")',
        '.modal-upload button:has-text("Subir")',
        'div[class*="modal"] button:has-text("Subir")',
        'button:has-text("Subir")'
    ];

    while (Date.now() < deadline) {
        for (const sel of confirmSelectors) {
            try {
                const btns = page.locator(sel);
                const count = await btns.count();
                if (count > 0) {
                    for (let i = count - 1; i >= 0; i--) {
                        const btn = btns.nth(i);
                        if (await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false)) {
                            console.log(`[UPLOAD] Click en confirmar (selector: ${sel})`);
                            await btn.click({ force: true });
                            await page.waitForTimeout(500);
                            return true;
                        }
                    }
                }
            } catch { }
        }
        await page.waitForTimeout(350);
    }

    console.error('[UPLOAD] No se encontró botón de confirmación habilitado.');
    return false;
}

/// =========== Scraping core ===========
function extractCurrencyAll(text) {
    if (!text) return [];
    const re = /[\$\€]\s*[\d\.\,]+|(?:\d{1,3}(?:[\.\,]\d{3})+|\d+[\.\,]\d+)/g;
    const m = String(text).match(re);
    return m ? m.map(x => x.trim()) : [];
}

function parseCurrencyToNumber(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    const m = s.match(/[-\d\.\,]+/);
    if (!m) return null;

    let num = m[0].trim();
    if (num.includes('.') && num.includes(',')) num = num.replace(/\./g, '').replace(/,/g, '.');
    else if (num.includes(',') && !num.includes('.')) num = num.replace(/,/g, '.');
    num = num.replace(/[^\d\.\-]/g, '');

    const f = parseFloat(num);
    return Number.isNaN(f) ? null : f;
}

function postProcessPriceRecord(rec) {
    if (!rec) return rec;

    // Helper to get numeric value
    const val = (s) => parseCurrencyToNumber(s) || 0;

    const pvpNum = val(rec.pvp);
    const descNum = val(rec.con_desc || rec.precio_c_desc);

    // Case 1: PVP is good, Desc is 0 => Use PVP as Desc (This fixes the "0.00%" issue)
    if (pvpNum > 0 && descNum === 0) {
        rec.con_desc = rec.pvp;
        rec.precio_c_desc = rec.pvp;
    }

    // Case 2: Desc is good, PVP is 0 => Use Desc as PVP
    if (descNum > 0 && pvpNum === 0) {
        rec.pvp = rec.precio_c_desc || rec.con_desc;
    }

    // Existing formatting logic for Oferta...
    if (rec.oferta) {
        const o = rec.oferta.toString().trim();
        if (/^\d+([\,\.]\d+)?$/.test(o) && !/%/.test(o)) rec.oferta = o + '%';
        rec.oferta = rec.oferta.replace(/[¡!]/g, '').trim();
    }
    return rec;
}

async function findResultsScrollContainer(page) {
    const candidates = [
        '.MuiDataGrid-virtualScroller',
        '[class*="MuiDataGrid-virtualScroller"]',
        '[class*="virtualScroller"]',
        '.MuiTableContainer-root',
        '[class*="TableContainer"]',
        '[role="grid"]',
        'table'
    ];

    for (const sel of candidates) {
        const loc = page.locator(sel).first();
        if (await loc.count().catch(() => 0) > 0) {
            const box = await loc.boundingBox().catch(() => null);
            if (box) return loc;
        }
    }

    const anyScrollable = page.locator('div, section, main').filter({
        has: page.locator('[role="row"], table tr, .MuiTableRow-root')
    });

    const n = await anyScrollable.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 30); i++) {
        const el = anyScrollable.nth(i);
        const ok = await el.evaluate(node => {
            const st = window.getComputedStyle(node);
            const oy = st.overflowY;
            const isScroll = (oy === 'auto' || oy === 'scroll');
            if (!isScroll) return false;
            return (node.scrollHeight || 0) > (node.clientHeight || 0) + 50;
        }).catch(() => false);
        if (ok) return el;
    }

    return null;
}

async function waitForResultsStable(page, timeoutMs = 30000) {
    const start = Date.now();
    let lastSig = '';
    let stableHits = 0;

    while (Date.now() - start < timeoutMs) {
        const sig = await page.evaluate(() => {
            const row = document.querySelector('[role="row"][data-rowindex], [role="row"]:not([role="rowgroup"]), table tbody tr, tr');
            if (!row) return '';
            const t = (row.innerText || '').replace(/\s+/g, ' ').trim();
            return t.slice(0, 140);
        }).catch(() => '');

        const hasAnyRow = await page.locator('[role="row"], table tr, .MuiTableRow-root').count().catch(() => 0);

        if (hasAnyRow > 0 && sig) {
            if (sig === lastSig) stableHits++;
            else stableHits = 0;
            lastSig = sig;
            if (stableHits >= 3) return true;
        } else {
            stableHits = 0;
            lastSig = sig;
        }

        await page.waitForTimeout(250);
    }

    return false;
}

async function extractRowRecord(page, rowLocator, query) {
    const rec = await rowLocator.evaluate((row, queryStr) => {
        const safeTrim = (s) => (s == null) ? '' : String(s).replace(/\s+/g, ' ').trim();
        const normalizeMoneyText = (raw) => {
            const s = safeTrim(raw);
            if (!s) return s;
            let out = s.replace(/,([\s\u00A0]+)(\d{1,2})/g, ',$2');
            out = out.replace(/(\d)\s*%/g, '$1%');
            return out;
        };

        const text = safeTrim(row.innerText || '');
        const upper = text.toUpperCase();

        if (!text || text.length < 2) return null;
        if (upper.includes('MATERIAL NO ENCONTRADO') || upper.includes('BUSCAR MATERIAL')) return null;
        if (/MOSTRANDO|RESULTADOS|SIN RESULTADOS|NO HAY PRODUCTOS/i.test(text)) return null;

        const cells = Array.from(row.querySelectorAll('td,[role="cell"],th')).map(c => safeTrim(c.innerText || ''));

        let producto = '';
        const nameSel = [
            '.product-description .product-name',
            '.product-name',
            '[class*="product-name"]',
            '.product-title',
            '[data-field*="descripcion"]',
            '[data-field*="description"]',
            '[data-field*="producto"]'
        ];
        for (const s of nameSel) {
            const el = row.querySelector(s);
            const t = el ? safeTrim(el.innerText) : '';
            if (t && t.length > 3) { producto = t; break; }
        }
        if (!producto) {
            for (const t of cells) {
                if (!t) continue;
                const up = t.toUpperCase();
                if (up === 'D') continue;
                if (/^[\d\.\,]+$/.test(t)) continue;
                if (/[\$\€]/.test(t)) continue;
                if (t.length >= 4) { producto = t; break; }
            }
        }
        if (!producto) producto = safeTrim((text.split('\n')[0] || '').trim());
        if (!producto || producto.length < 3) return null;

        // --- FILTER HEADERS (NEW) ---
        if (/^(DESCRIPCI[OÓ]N|PRODUCTO|PRECIO|CANTIDAD|DETALLE)$/i.test(producto)) return null;

        let sku = safeTrim(row.getAttribute('data-sku') || '');
        if (!sku) {
            const skuEl = row.querySelector('.sku,.product-sku,[class*="sku"]');
            if (skuEl) sku = safeTrim(skuEl.innerText || '');
        }
        if (!sku) {
            const m13 = text.match(/\b\d{13}\b/);
            if (m13) sku = m13[0];
        }
        if (!sku) {
            const m = text.match(/\b\d{6,14}\b/);
            if (m) sku = m[0];
        }

        let pvp = '';
        let con_desc = '';
        let oferta = '';
        let min_ofer = '';

        const amountSpans = Array.from(row.querySelectorAll('span.cell-main-text.amounts, span[class*="amount"]'))
            .map(s => normalizeMoneyText(safeTrim(s.innerText || '')))
            .filter(Boolean);

        if (amountSpans.length >= 1) pvp = amountSpans[0];
        if (amountSpans.length >= 2) con_desc = amountSpans[1];
        if (amountSpans.length >= 3) oferta = amountSpans[2];
        if (amountSpans.length >= 4) min_ofer = (amountSpans[3].match(/\d+/) || [''])[0];

        if (!pvp && !con_desc) {
            const currencies = (text.match(/[\$\€]\s*[\d\.\,]+|(?:\d{1,3}(?:[\.\,]\d{3})+|\d+[\.\,]\d+)/g) || [])
                .map(x => normalizeMoneyText(safeTrim(x)));
            if (currencies.length > 0) pvp = currencies[0];
            if (currencies.length > 1) con_desc = currencies[1];
        }
        if (!con_desc) con_desc = pvp;

        if (!oferta) {
            const pm = text.match(/\b\d{1,3}(?:[\,\.]\d{1,2})?\s*%/);
            if (pm) oferta = safeTrim(pm[0]).replace(/\s+/g, '');
        }

        const nums = cells
            .map(t => safeTrim(t).replace(/\./g, '').replace(/\s+/g, ''))
            .filter(t => /^[0-9]{1,3}$/.test(t))
            .map(t => parseInt(t, 10))
            .filter(n => !Number.isNaN(n) && n > 0 && n <= 999);

        if (!min_ofer && nums.length) {
            const priceToNum = (s) => {
                if (!s) return null;
                const m = String(s).match(/[-\d\.\,]+/);
                if (!m) return null;
                let num = m[0];
                if (num.includes('.') && num.includes(',')) num = num.replace(/\./g, '').replace(/,/g, '.');
                else if (num.includes(',') && !num.includes('.')) num = num.replace(/,/g, '.');
                const f = parseFloat(num.replace(/[^\d\.\-]/g, ''));
                return Number.isNaN(f) ? null : f;
            };
            const pvpN = priceToNum(pvp);
            const conN = priceToNum(con_desc);

            for (const n of nums) {
                if (sku && String(sku) === String(n)) continue;
                if (pvpN != null && Math.abs(pvpN - n) < 0.001) continue;
                if (conN != null && Math.abs(conN - n) < 0.001) continue;
                min_ofer = String(n);
                break;
            }
        }

        let stock = 'no';
        let stock_raw = '';

        if (upper.includes('SIN STOCK') || upper.includes('AGOTAD') || upper.includes('NO DISPONIBLE') || upper.includes('NO HAY')) {
            stock = 'no';
        } else if (/\bD\b/.test(text) || upper.includes('DISPONIBLE') || upper.includes('EN STOCK') || upper.includes('HAY STOCK')) {
            stock = 'si';
        }

        const stockEl = row.querySelector('.product-stock-indicator,[class*="stock"],svg,circle,[aria-label],[title]');
        if (stockEl) {
            const a = safeTrim(stockEl.getAttribute('aria-label') || '');
            const t = safeTrim(stockEl.getAttribute('title') || '');
            stock_raw = safeTrim(stockEl.innerText || '') || '';
            const mix = (stock_raw + ' ' + a + ' ' + t).toUpperCase();
            if (mix.includes('SIN STOCK') || mix.includes('AGOTAD') || mix.includes('NO DISPONIBLE')) stock = 'no';
            if (mix.includes('DISPONIBLE') && !mix.includes('NO DISPONIBLE')) stock = 'si';
            if (safeTrim(stock_raw).toUpperCase() === 'D') stock = 'si';
        }

        let url = '';
        const a = row.querySelector('a[href]');
        if (a) url = a.getAttribute('href') || '';

        return {
            timestamp: new Date().toISOString(),
            query: queryStr || '',
            producto,
            pvp,
            con_desc,
            precio_c_desc: con_desc,
            oferta,
            stock,
            stock_raw,
            min: min_ofer || '',
            min_ofer: min_ofer || '',
            sku: sku || '',
            url: url || ''
        };
    }, query || '');

    if (!rec) return null;

    if (rec.url && !/^https?:\/\//i.test(rec.url)) {
        try { rec.url = new URL(rec.url, await page.url()).toString(); } catch { }
    }

    postProcessPriceRecord(rec);

    rec.producto = safeTrim(rec.producto);
    rec.sku = safeTrim(rec.sku);
    rec.pvp = normalizeMoneyText(rec.pvp);
    rec.con_desc = normalizeMoneyText(rec.con_desc);
    rec.precio_c_desc = normalizeMoneyText(rec.precio_c_desc);
    rec.oferta = normalizeMoneyText(rec.oferta);
    rec.stock = (rec.stock === 'si') ? 'si' : 'no';
    rec.min = safeTrim(rec.min);
    rec.min_ofer = safeTrim(rec.min_ofer);

    const up = (rec.producto || '').toUpperCase();
    if (!rec.producto || up.includes('MATERIAL NO ENCONTRADO') || up.includes('BUSCAR MATERIAL')) return null;

    return rec;
}

async function scrapeAllRowsOnCurrentResults(page, query, opts = {}) {
    const {
        maxScrollPasses = 120, // INCREASED FOR SLOWER SCROLL
        stallPassesToStop = 5,
        scrollStepFactor = 0.60, // SLOWED DOWN from 0.85 to 0.60 to catch missed items
        debug = false,
    } = opts;

    let rowLoc = page.locator('[role="row"][data-rowindex]');
    if (await rowLoc.count().catch(() => 0) === 0) rowLoc = page.locator('.MuiTableRow-root');
    if (await rowLoc.count().catch(() => 0) === 0) rowLoc = page.locator('table tbody tr');
    if (await rowLoc.count().catch(() => 0) === 0) rowLoc = page.locator('[role="row"]');

    const scrollContainer = await findResultsScrollContainer(page);
    const results = [];
    const seenKeys = new Set();

    const makeKey = (r) => {
        const sku = (r.sku || '').trim();
        const url = (r.url || '').trim();
        const name = (r.producto || '').trim().toUpperCase();
        // Fallback robusto para detectar unicidad si falta SKU
        if (sku || url) return `${sku}|${url}`;
        return `${name}`; // Strict dedup on name if no ID available
    };

    if (!scrollContainer) {
        const count = await rowLoc.count().catch(() => 0);
        if (debug) console.log(`[SCRAPE] No scroll container. Rows in DOM: ${count}`);
        for (let i = 0; i < count; i++) {
            const rec = await extractRowRecord(page, rowLoc.nth(i), query).catch(() => null);
            if (!rec) continue;
            const key = makeKey(rec);
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            results.push(rec);
        }
        return results;
    }

    let stalls = 0;

    try {
        await scrollContainer.evaluate(node => { node.scrollTop = 0; });
        await page.waitForTimeout(200);
    } catch { }

    for (let pass = 0; pass < maxScrollPasses; pass++) {
        const count = await rowLoc.count().catch(() => 0);
        if (debug) console.log(`[SCRAPE] Pass ${pass + 1} - rowLoc.count()=${count}`);

        let addedThisPass = 0;
        for (let i = 0; i < count; i++) {
            const row = rowLoc.nth(i);
            const isVisible = await row.isVisible().catch(() => false);
            if (!isVisible) continue;

            const rec = await extractRowRecord(page, row, query).catch(() => null);
            if (!rec) continue;

            const key = makeKey(rec);
            if (seenKeys.has(key)) continue;

            seenKeys.add(key);
            results.push(rec);
            addedThisPass++;
        }

        if (addedThisPass === 0) stalls++;
        else stalls = 0;

        if (stalls >= stallPassesToStop) {
            if (debug) console.log(`[SCRAPE] Stalled for ${stalls} passes. Stopping.`);
            break;
        }

        const didScroll = await scrollContainer.evaluate((node, factor) => {
            const before = node.scrollTop || 0;
            // Smaller step to avoid skipping items in virtual list
            const step = Math.max(80, Math.floor((node.clientHeight || 600) * factor));
            node.scrollTop = before + step;
            const after = node.scrollTop || 0;

            const atBottom = (node.scrollTop + node.clientHeight) >= (node.scrollHeight - 2);
            return { before, after, atBottom, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
        }, scrollStepFactor).catch(() => null);

        await page.waitForTimeout(200);

        if (!didScroll) break;
        if (debug) console.log(`[SCRAPE] Scroll ${didScroll.before} -> ${didScroll.after} (atBottom=${didScroll.atBottom})`);

        if (didScroll.atBottom) {
            await page.waitForTimeout(300);
        }
    }

    return results;
}

/// =========== Pagination ===========
async function getPaginationCurrentPage(page) {
    try {
        const selected = page.locator('ul[class*="MuiPagination-ul"] .Mui-selected, ul[class*="MuiPagination-ul"] button[aria-current="true"]').first();
        if (await selected.count().catch(() => 0) > 0) {
            const t = safeTrim(await selected.innerText().catch(() => ''));
            const n = parseInt(t, 10);
            if (!Number.isNaN(n)) return n;
        }
    } catch { }
    return null;
}

async function getNextButton(page) {
    const ul = page.locator('ul[class*="MuiPagination-ul"]').first();
    if (await ul.count().catch(() => 0) === 0) return null;

    let nextBtn = ul.locator('button[aria-label="Go to next page"], button[aria-label*="next"], button[aria-label*="Siguiente"], button[aria-label*="Next"]').first();
    if (await nextBtn.count().catch(() => 0) > 0) return nextBtn;

    const buttons = ul.locator('button');
    const c = await buttons.count().catch(() => 0);
    for (let i = c - 1; i >= 0; i--) {
        const b = buttons.nth(i);
        const label = safeTrim(await b.getAttribute('aria-label').catch(() => ''));
        const txt = safeTrim(await b.innerText().catch(() => ''));
        if (label && /next|siguiente/i.test(label)) return b;
        if (!txt || !/^\d+$/.test(txt)) nextBtn = b;
    }
    return nextBtn || null;
}

async function isButtonDisabled(btn) {
    if (!btn) return true;
    const disabled = await btn.isDisabled().catch(() => false);
    if (disabled) return true;
    const attr = await btn.getAttribute('disabled').catch(() => null);
    if (attr !== null) return true;
    const aria = await btn.getAttribute('aria-disabled').catch(() => null);
    if (aria && aria.toLowerCase() === 'true') return true;
    return false;
}

async function scrapeWithPagination(page, query) {
    const allProducts = [];
    const globalSeen = new Set();

    await waitForResultsStable(page, 30000).catch(() => { });
    await page.waitForTimeout(350);

    let pageNum = 1;
    let safety = 0;

    while (safety++ < MAX_PAGES) {
        const currentUiPage = await getPaginationCurrentPage(page);
        const tag = `${query}_P${currentUiPage || pageNum}`;

        console.log(`[PAGINATION] Procesando página ${currentUiPage || pageNum}...`);

        await waitForResultsStable(page, 15000).catch(() => { });
        const pageProducts = await scrapeAllRowsOnCurrentResults(page, tag, { debug: false });

        for (const p of pageProducts) {
            const key = ((p.sku || '').trim() || (p.url || '').trim() || (p.producto || '').trim().toUpperCase());
            // More lenient dedup to avoid losing variants
            const k2 = `${key}`;
            if (globalSeen.has(k2)) continue;
            globalSeen.add(k2);
            allProducts.push(p);
        }

        console.log(`[PAGINATION] Página ${currentUiPage || pageNum}: ${pageProducts.length} rows scraped (total unique: ${allProducts.length}).`);

        const paginationUl = page.locator('ul[class*="MuiPagination-ul"]').first();
        if (await paginationUl.count().catch(() => 0) === 0) {
            console.log('[PAGINATION] No se detectó paginación (Página única). Terminando.');
            break;
        }

        const nextBtn = await getNextButton(page);
        const disabled = await isButtonDisabled(nextBtn);
        if (!nextBtn || disabled) {
            console.log('[PAGINATION] Botón "Siguiente" no disponible o deshabilitado. Fin de paginación.');
            break;
        }

        const beforePage = await getPaginationCurrentPage(page);
        const beforeSig = await page.evaluate(() => {
            const row = document.querySelector('[role="row"][data-rowindex], .MuiTableRow-root, table tbody tr, [role="row"]');
            if (!row) return '';
            return (row.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        }).catch(() => '');

        console.log('[PAGINATION] Click en "Siguiente"...');
        await nextBtn.click({ force: true });

        const start = Date.now();
        let changed = false;

        while (Date.now() - start < 30000) {
            await page.waitForTimeout(250);

            const afterPage = await getPaginationCurrentPage(page);
            const afterSig = await page.evaluate(() => {
                const row = document.querySelector('[role="row"][data-rowindex], .MuiTableRow-root, table tbody tr, [role="row"]');
                if (!row) return '';
                return (row.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140);
            }).catch(() => '');

            if (beforePage != null && afterPage != null && afterPage !== beforePage) { changed = true; break; }
            if (beforeSig && afterSig && afterSig !== beforeSig) { changed = true; break; }
        }

        if (!changed) {
            console.warn('[PAGINATION] Warning: No se detectó cambio claro tras click next. Intento continuar igual.');
            await saveDiagnostic(page, 'pagination-nochange');
        }

        await waitForResultsStable(page, 20000).catch(() => { });
        pageNum++;
    }

    return allProducts;
}

/// =========== LOGIN ===========
async function loginDelSud(page) {
    console.log('[LOGIN] Navegando a:', LOGIN_URL);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
    await saveDiagnostic(page, 'page-loaded');
    await tryCloseCookieBanners(page);

    const emailCandidates = [
        'input[placeholder="Ingresá tu correo electrónico"]',
        'input[placeholder*="correo"]',
        'input[type="email"]',
        'input[name*="email"]',
        'input[id*="email"]',
        'form input'
    ];

    let emailOk = false;
    for (const sel of emailCandidates) {
        if (await page.locator(sel).count().catch(() => 0) > 0) {
            emailOk = await ensureFocusAndType(page, sel, EMAIL);
            if (emailOk) break;
        }
    }

    const passCandidates = [
        'input[placeholder="Ingresá tu contraseña"]',
        'input[placeholder*="contrase"]',
        'input[type="password"]',
        'input[name*="pass"]',
        'input[id*="pass"]'
    ];

    let passOk = false;
    for (const sel of passCandidates) {
        if (await page.locator(sel).count().catch(() => 0) > 0) {
            passOk = await ensureFocusAndType(page, sel, PASS);
            if (passOk) break;
        }
    }

    const submitCandidates = [
        'button:has-text("Ingresar")',
        'button:has-text("Iniciar")',
        'button[type="submit"]',
        'button.btn-primary',
        'text="Ingresar"',
        'text="Iniciar sesión"'
    ];

    let submitted = false;
    for (const sel of submitCandidates) {
        if (await page.locator(sel).count().catch(() => 0) > 0) {
            try { await page.locator(sel).first().click({ force: true, timeout: 3000 }); }
            catch { await page.locator(sel).first().click({ force: true }); }
            submitted = true;
            break;
        }
    }
    if (!submitted) {
        try { await page.keyboard.press('Enter'); } catch { }
    }

    console.log('[LOGIN] Credenciales enviadas. Esperando redirección...');
    try {
        await Promise.race([
            page.waitForSelector('button:has-text("Subir archivo")', { timeout: 15000 }),
            page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15000 })
        ]);
        console.log('[LOGIN] Login detectado exitoso.');
    } catch {
        console.warn('[LOGIN] Warning: no se detectó transición clara post-login. Continuando...');
    }

    await page.waitForTimeout(800);
    await saveDiagnostic(page, 'after-login');
}

/// =========== RUNNERS ===========
async function runBatch(items) {
    console.log('>>> MODO BATCH (EXPERIMENTAL) ACTIVADO <<<');

    let browser = null;
    let pedsecPath = null;

    try {
        const fileData = generatePedsecFromJSON(items, RAW_CLIENT_CODE);
        pedsecPath = fileData.pedsecPath;

        let chosenExe = candidateChromePaths().find(p => fs.existsSync(p));
        const args = [
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-dev-shm-usage',
            '--window-position=-2400,-2400', // <--- VENTANA FUERA DE PANTALLA
            '--window-size=1920,1080'        // <--- TAMAÑO DE MONITOR GRANDE
        ];
        const launchOpts = { headless: PLAYWRIGHT_HEADLESS, args };
        if (chosenExe) launchOpts.executablePath = chosenExe;

        browser = await chromium.launch(launchOpts);
        const context = await browser.newContext();
        const page = await context.newPage();

        await loginDelSud(page);

        console.log('[FLOW] Abriendo modal "Subir archivo"...');
        const opened = await clickSubirArchivo(page);
        if (!opened) throw new Error('No se pudo abrir el modal de subida');

        console.log('[FLOW] Adjuntando PED (ped.txt)...');
        const uploaded = await uploadFileInDialog(page, pedsecPath);
        if (!uploaded) throw new Error('Fallo al adjuntar archivo PED al input');

        const confirmed = await confirmUploadButton(page);
        if (!confirmed) throw new Error('Timeout esperando confirmar botón Subir habilitado');

        console.log('[FLOW] Esperando resultados...');
        await waitForResultsStable(page, 30000).catch(() => { });
        console.log(`[WAIT] Espera extra ${EXTRA_WAIT_AFTER_TABLE_MS}ms para carga completa...`);
        await page.waitForTimeout(EXTRA_WAIT_AFTER_TABLE_MS);

        const allProducts = await scrapeWithPagination(page, 'BATCH_UPLOAD');

        // ✅ NAME-SURGICAL linking from JSON input (desc/ean preserved in fileData.validItems)
        const linked = linkEansToProducts(allProducts, fileData.validItems || []);

        // Keep both sku and linked ean; also set ean field for downstream usage
        const mappedProducts = linked.map(p => {
            p.ean = p.ean_linked || p.sku || '';
            return p;
        });

        console.log('@@@PILLIGENCE_TABLE@@@' + JSON.stringify({ data: mappedProducts }));
        console.log(`[APP] Datos emitidos (${mappedProducts.length} registros).`);

    } catch (e) {
        console.error('[BATCH ERROR]', e && (e.stack || e.message || e));
    } finally {
        if (pedsecPath && fs.existsSync(pedsecPath)) { try { fs.unlinkSync(pedsecPath); } catch { } }
        if (browser && !KEEP_BROWSER_OPEN) await browser.close().catch(() => { });
        console.log('--- FIN BUSQUEDA ---');
        process.exit(0);
    }
}

async function runManual() {
    console.log('>>> MODO MANUAL ACTIVADO <<<');

    let browser = null;
    let pedsecPath = null;

    try {
        let fileData = null;
        try {
            fileData = await prepareFiles();
        } catch (err) {
            console.error('[FILE ERROR]', err.message);
            process.exit(1);
        }

        pedsecPath = fileData.pedsecPath;

        let chosenExe = candidateChromePaths().find(p => fs.existsSync(p));
        const args = [
            '--no-first-run',
            '--no-default-browser-check',
            '--window-position=-2400,-2400', // <--- VENTANA FUERA DE PANTALLA
            '--window-size=1920,1080'        // <--- TAMAÑO DE MONITOR GRANDE
        ];
        const launchOpts = { headless: PLAYWRIGHT_HEADLESS, args };
        if (chosenExe) launchOpts.executablePath = chosenExe;

        browser = await chromium.launch(launchOpts);
        const context = await browser.newContext();
        const page = await context.newPage();

        await loginDelSud(page);

        console.log('[FLOW] Abriendo modal "Subir archivo"...');
        const opened = await clickSubirArchivo(page);
        if (!opened) throw new Error('No se pudo abrir el modal de subida');

        console.log('[FLOW] Adjuntando PED (ped.txt)...');
        const uploaded = await uploadFileInDialog(page, pedsecPath);
        if (!uploaded) throw new Error('Fallo al adjuntar archivo PED al input');

        const confirmed = await confirmUploadButton(page);
        if (!confirmed) console.warn('[FLOW] No se pudo confirmar la subida automáticamente. Intentalo manual.');
        else console.log('[FLOW] Click en "Subir" (confirmación) exitoso.');

        console.log('[FLOW] Esperando resultados...');
        await waitForResultsStable(page, 30000).catch(() => { });
        console.log(`[WAIT] Espera extra ${EXTRA_WAIT_AFTER_TABLE_MS}ms para carga completa...`);
        await page.waitForTimeout(EXTRA_WAIT_AFTER_TABLE_MS);

        const allProducts = await scrapeWithPagination(page, 'MANUAL_UPLOAD');

        // ✅ NAME-SURGICAL linking from user's input file
        const linkedProducts = linkEansToProducts(allProducts, fileData.items || []);

        console.log('\n[SCRAPE] Productos encontrados:');
        if (linkedProducts.length === 0) {
            console.log('[SCRAPE] No se encontraron filas.');
            await saveDiagnostic(page, 'manual-empty');
        } else {
            linkedProducts.forEach((row, index) => {
                const nombre = row.producto || '';
                const unitario = row.precio_c_desc || row.con_desc || '0.00';
                const publico = row.pvp || '0.00';
                const stock = (row.stock || 'no').toUpperCase();
                const minimo = row.min_ofer || row.min || '1';

                const eanLinked = row.ean_linked || '';

                console.log(`--- [ Producto #${index + 1} ] ---`);
                console.log(`Nombre       : ${nombre}`);
                console.log(`$ Unitario   : ${unitario}`);
                console.log(`$ Público    : ${publico}`);
                console.log(`Stock        : ${stock}`);
                console.log(`Mínimo       : ${minimo}`);
                console.log(`EAN (Linked): ${eanLinked}`);
                if (LINK_DEBUG) {
                    console.log(`Link method : ${row.link_method || ''} (score=${row.link_score || 0})`);
                    if (row.sku) console.log(`SKU scraped : ${row.sku}`);
                    if (row.link_detail) console.log(`Detail       : ${JSON.stringify(row.link_detail)}`);
                    if (row._link_debug) console.log(`Dbg         : ${JSON.stringify(row._link_debug)}`);
                }
                console.log('');
            });
            console.log(`[SCRAPE] Total items: ${linkedProducts.length}`);
        }

        if (KEEP_BROWSER_OPEN) {
            console.log('[EXIT] Navegador abierto.');
            await new Promise(() => { });
        } else {
            await browser.close();
            process.exit(0);
        }

    } catch (err) {
        console.error('[ERROR]', err && (err.stack || err.message || err));
        if (pedsecPath && fs.existsSync(pedsecPath)) { try { fs.unlinkSync(pedsecPath); } catch { } }
        try { if (browser && !KEEP_BROWSER_OPEN) await browser.close(); } catch { }
        process.exit(1);
    }
}

/// =========== ENTRY POINT ===========
const isTTY = process.stdin.isTTY;
const forcedMode = process.env.SCRAPER_MODE; // 'BATCH' or 'MANUAL'

if (forcedMode === 'MANUAL' || (isTTY && !forcedMode)) {
    runManual();
} else if (forcedMode === 'BATCH') {
    console.log('@@@READY@@@');
    console.log('[ENTRY] Modo BATCH forzado por ENV. Esperando JSON...');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.on('line', (line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('BATCH_JSON:')) {
            try {
                const jsonStr = trimmed.replace('BATCH_JSON:', '').trim();
                const items = JSON.parse(jsonStr);
                runBatch(items);
            } catch (e) {
                console.error('[ENTRY] Error parsing JSON:', e);
                process.exit(1);
            }
        }
    });
} else {
    let batchStarted = false;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

    const fallbackTimer = setTimeout(() => {
        if (!batchStarted) {
            console.log('[ENTRY] Timeout esperando BATCH. Fallback a Manual.');
            rl.removeAllListeners('line');
            runManual();
        }
    }, 1500);

    console.log('@@@READY@@@');

    rl.on('line', (line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('BATCH_JSON:')) {
            clearTimeout(fallbackTimer);
            batchStarted = true;
            try {
                const jsonStr = trimmed.replace('BATCH_JSON:', '').trim();
                const items = JSON.parse(jsonStr);
                runBatch(items);
            } catch (e) {
                console.error('[ENTRY] Error parsing JSON:', e);
                process.exit(1);
            }
        }
    });
}