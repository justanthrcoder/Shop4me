#!/usr/bin/env node

// SuizoSCRAPERFILE.js
// Versión Híbrida FINAL IMPROVED + FIX MATCHING (BATCH/MANUAL) + EAN LINKING FIX
// FIX PRINCIPAL: Normalización de sinónimos (CPS=CAPS) y uso de ean_linked de Del Sud.
// FIX TIMEOUT: Uso de noWaitAfter: true en el botón Enviar.
// WINDOW: Posición negativa y tamaño Full HD forzado.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawnSync } = require('child_process');

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
const TARGET_URL = 'https://web1.suizoargentina.com/importacion';


/// =========== Utilidades de Matching (Node-side) ===========

function tokenize(str) {
    // Mapa de sinónimos comunes en farmacia para mejorar el matching
    const SYNONYMS = {
        'CPS': 'CAPS', 'CP': 'CAPS', 'COM': 'CAPS', 'COMP': 'CAPS', 'TBS': 'CAPS',
        'GR': 'G', 'GRS': 'G', 'GS': 'G',
        'ML': 'ML', 'CC': 'ML',
        'X': '' // Ignorar la 'X' de separación (ej: 30 X 10)
    };

    return (str || '')
        .toUpperCase()
        .replace(/[^A-Z0-9\s]/g, ' ')
        .split(/\s+/)
        .map(t => SYNONYMS[t] || t) // Normalizar sinónimos
        .filter(t => {
            if (!t) return false;
            // FIX: permitir números de 1 dígito (5 vs 8 ml), pero NO letras sueltas tipo "X" (ya filtrada arriba)
            if (t.length <= 1) return /^\d$/.test(t);
            // Ignora números largos (precios/totales)
            if (/^\d+$/.test(t) && t.length >= 5) return false;
            return true;
        });
}

function normalizeExact(str) {
    // Normaliza para un “match exacto” tolerante a espacios / signos:
    // conserva números y letras, colapsa espacios
    return (str || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function calculateScore(rowName, inputFileDesc) {
    const rowTokens = tokenize(rowName);
    const fileTokens = tokenize(inputFileDesc);

    if (rowTokens.length === 0 || fileTokens.length === 0) return 0;

    let matches = 0;

    // Bonificación si la PRIMERA palabra (marca usualmente) coincide
    if (rowTokens[0] === fileTokens[0]) {
        matches += 0.5;
    }

    for (const ft of fileTokens) {
        if (rowTokens.includes(ft)) {
            matches++;
        } else {
            if (rowTokens.some(rt => rt.includes(ft) || ft.includes(rt))) {
                matches += 0.8;
            }
        }
    }

    const union = new Set([...rowTokens, ...fileTokens]).size;
    // Evitar división por cero
    if (union === 0) return 0;

    return matches / union;
}

function findBestMatch(rowName, itemsToMatch) {
    const rowNorm = normalizeExact(rowName);
    if (rowNorm) {
        for (const item of itemsToMatch) {
            if (normalizeExact(item.desc) === rowNorm) return item; // exact match fuerte
        }
    }

    let bestItem = null;
    let bestScore = 0;
    let secondBest = 0;

    for (const item of itemsToMatch) {
        const score = calculateScore(rowName, item.desc);
        if (score > bestScore) {
            secondBest = bestScore;
            bestScore = score;
            bestItem = item;
        } else if (score > secondBest) {
            secondBest = score;
        }
    }

    // Umbrales ajustados para ser más permisivos con "CPS" vs "CAPS" si la marca coincide
    const THRESHOLD = 0.25;
    const MARGIN = 0.05;

    if (bestScore >= 0.50) return bestItem;            // match fuerte
    if (bestScore < THRESHOLD) return null;            // match débil
    if ((bestScore - secondBest) < MARGIN) return null; // ambiguo
    return bestItem;
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

function convertTxtToPedsec(inputPath) {
    if (!fs.existsSync(inputPath)) {
        throw new Error('Archivo no existe: ' + inputPath);
    }

    const content = fs.readFileSync(inputPath, 'utf8');
    const lines = content.split(/\r?\n/).filter(l => l && l.trim().length > 0);

    const pedsecLines = [];
    const itemsInMemory = [];

    console.log(`[CONVERT] Procesando ${lines.length} líneas del TXT...`);

    for (const line of lines) {
        if (!line.trim()) continue;

        const parts = line.split(',');

        if (parts.length >= 5) {
            const eanRaw = parts[0].trim().replace(/"/g, '');
            const qtyRaw = parts[4] ? parts[4].trim().replace(/"/g, '') : '0';
            const descRaw = parts.slice(5).join(',').trim().replace(/"/g, '');

            if (eanRaw && eanRaw.length > 0) {
                const ean = eanRaw.padEnd(13, ' ').substring(0, 13);
                let descClean = descRaw.toUpperCase().replace(/\s+/g, ' ').trim();
                const descPadded = descClean.padEnd(30, ' ').substring(0, 30);
                let qtyNum = parseInt(qtyRaw, 10);
                if (isNaN(qtyNum)) qtyNum = 0;
                const qtyPadded = qtyNum.toString().padStart(3, '0').substring(0, 3);

                const pedsecLine = `${ean}${descPadded}${qtyPadded}`;
                pedsecLines.push(pedsecLine);

                itemsInMemory.push({
                    ean: eanRaw,
                    qty: qtyNum.toString(),
                    desc: descClean
                });
            }
        }
    }

    if (pedsecLines.length === 0) {
        throw new Error('[CONVERT] No se generaron líneas válidas. Revisa el formato del archivo TXT.');
    }

    console.log('\n==========================================================');
    console.log('   PREVIEW DEL ARCHIVO PEDSEC GENERADO (Primeras 3 líneas)');
    console.log('==========================================================');
    const previewCount = Math.min(3, pedsecLines.length);
    for (let i = 0; i < previewCount; i++) {
        console.log(`Línea ${i + 1}: "${pedsecLines[i]}"`);
    }
    console.log('==========================================================\n');

    const tempDir = os.tmpdir();
    const tempFileName = `pedido_suizo_${Date.now()}.pedsec`;
    const pedsecPath = path.join(tempDir, tempFileName);
    fs.writeFileSync(pedsecPath, pedsecLines.join('\r\n'), 'utf8');

    return {
        pedsecPath: pedsecPath,
        items: itemsInMemory,
        count: pedsecLines.length
    };
}

function generatePedsecFromJSON(items) {
    const pedsecLines = [];
    const validItems = [];

    console.log(`[CONVERT] Procesando ${items.length} items JSON...`);

    for (const item of items) {
        // FIX: Priorizamos ean_linked (que viene de Del Sud u otro scraper previo) sobre el ean original si existe
        const finalEan = (item.ean_linked && item.ean_linked.length > 5) ? item.ean_linked : item.ean;
        const eanRaw = (finalEan || '').trim().replace(/"/g, '');

        let qtyNum = parseInt(item.qty, 10);
        if (isNaN(qtyNum) || qtyNum < 1) qtyNum = 1;
        const qtyRaw = qtyNum.toString();
        const descRaw = (item.name || '').trim().replace(/"/g, '');

        if (eanRaw && eanRaw.length > 0) {
            const ean = eanRaw.padEnd(13, ' ').substring(0, 13);
            let descClean = descRaw.toUpperCase().replace(/\s+/g, ' ').trim();
            const descPadded = descClean.padEnd(30, ' ').substring(0, 30);
            const qtyPadded = qtyRaw.padStart(3, '0').substring(0, 3);

            const pedsecLine = `${ean}${descPadded}${qtyPadded}`;
            pedsecLines.push(pedsecLine);

            validItems.push({
                ean: eanRaw, // Guardamos el EAN "bueno" para el matching posterior
                qty: qtyNum.toString(),
                desc: descClean
            });
        }
    }

    if (pedsecLines.length === 0) throw new Error('[CONVERT] No se generaron líneas válidas desde JSON.');

    const tempDir = os.tmpdir();
    const tempFileName = `pedido_suizo_${Date.now()}.pedsec`;
    const pedsecPath = path.join(tempDir, tempFileName);
    fs.writeFileSync(pedsecPath, pedsecLines.join('\r\n'), 'utf8');

    return { pedsecPath, validItems, count: pedsecLines.length };
}

async function prepareFiles() {
    console.log('--- Paso 1: Selección y Conversión de Archivo ---');
    let txtPath = pickFileNative();
    if (!txtPath) {
        console.log('\n!!! No se detectó selección. Pegá la ruta del archivo TXT: !!!');
        txtPath = await new Promise(resolve => {
            const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
            rl2.question('Ruta TXT > ', ans => { rl2.close(); resolve(ans && ans.trim()); });
        });
    }

    if (!txtPath) throw new Error('No se seleccionó archivo.');
    txtPath = txtPath.replace(/^"|"$/g, '');
    console.log('Archivo TXT seleccionado:', txtPath);

    const result = convertTxtToPedsec(txtPath);
    console.log('-------------------------------------------');
    console.log(`[CONVERT] Archivo .pedsec generado: ${result.pedsecPath}`);
    console.log(`[CONVERT] Contiene ${result.count} productos.`);
    console.log('-------------------------------------------');

    return result;
}


/// =========== Utilidades Playwright & AD BLOCKER ===========

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
        'button:has-text("Aceptar")', 'button:has-text("Aceptar todo")', 'button:has-text("Aceptar cookies")',
        'button:has-text("Acepto")',
        '.cookie-banner button', '.qc-cmp2-summary-buttons .qc-cmp2-summary-buttons__button--accept'
    ];
    for (const s of banners) {
        try {
            const el = page.locator(s);
            if (await el.count() > 0) {
                try { await el.first().click({ force: true, timeout: 2000 }); }
                catch (e) { try { await el.first().click({ force: true }); } catch (_) { } }
                await page.waitForTimeout(200);
            }
        } catch (e) { }
    }
}

// === FUNCIÓN AGRESIVA PARA PUBLICIDAD ===
async function attemptCloseAds(page) {
    console.log('[FLOW] Iniciando barrido agresivo de publicidad (Check continuo por 5s)...');

    const adSelectors = [
        '#cerrar-modal-1',
        '[id^="cerrar-modal"]',
        'a.modal-close',
        'a[title="Cerrar"]',
        'button.close',
        'button[aria-label="Close"]',
        'div.modal.in button.close',
        '.modal-footer .btn-default',
        '#cboxClose',
        '.fancybox-close'
    ];

    const maxAttempts = 10;

    for (let i = 0; i < maxAttempts; i++) {
        let closedSomething = false;

        for (const sel of adSelectors) {
            try {
                const loc = page.locator(sel);
                if (await loc.count() > 0) {
                    const visibleLoc = loc.first();
                    if (await visibleLoc.isVisible()) {
                        console.log(`[AD-BLOCK] Publicidad detectada con selector: "${sel}". Cerrando...`);
                        await visibleLoc.click({ force: true, timeout: 2000 });
                        closedSomething = true;
                        await page.waitForTimeout(600);
                    }
                }
            } catch (e) { }
        }

        if (!closedSomething) await page.waitForTimeout(500);
    }
    console.log('[FLOW] Fin barrido de publicidad.');
}

async function ensureFocusAndType(page, selector, text, opts = { charDelay: 8 }) {
    try { await page.waitForSelector(selector, { timeout: Math.max(1000, PAGE_WAIT_TIMEOUT) }); } catch (e) { }
    try { await page.focus(selector); }
    catch (e) {
        try {
            await page.evaluate(sel => {
                const el = document.querySelector(sel);
                if (el) { el.focus(); return true; }
                return false;
            }, selector);
        } catch (e2) { }
    }

    try {
        await page.evaluate(sel => {
            const el = document.querySelector(sel);
            if (!el) return false;
            if ('value' in el) el.value = '';
            return true;
        }, selector);
    } catch (e) { }

    for (const ch of String(text)) {
        await page.keyboard.type(ch, { delay: opts.charDelay });
    }

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
        return true;
    } catch (e) {
        try { await page.fill(selector, String(text)); return true; }
        catch (e2) { return false; }
    }
}

function candidateChromePaths() {
    const envPath = CHROME_PATH;
    return [
        envPath,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ].filter(Boolean);
}


/// =========== FUNCIONES DE MATCHING EN CONTEXTO BROWSER (INJECT) ===========

const injectedScoreFunctions = `
  function tokenize(str) {
    const SYNONYMS = {
        'CPS': 'CAPS', 'CP': 'CAPS', 'COM': 'CAPS', 'COMP': 'CAPS', 'TBS': 'CAPS',
        'GR': 'G', 'GRS': 'G', 'GS': 'G',
        'ML': 'ML', 'CC': 'ML',
        'X': '' 
    };

    return (str || '')
      .toUpperCase()
      .replace(/[^A-Z0-9\\s]/g, ' ')
      .split(/\\s+/)
      .map(t => SYNONYMS[t] || t)
      .filter(t => {
        if (!t) return false;
        // FIX: permitir números de 1 dígito, ignorar vacíos
        if (t.length <= 1) return /^\\d$/.test(t);
        // Ignora números largos (precios/totales)
        if (/^\\d+$/.test(t) && t.length >= 5) return false;
        return true;
      });
  }

  function normalizeExact(str) {
    return (str || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
  }

  function calculateScore(rowName, inputFileDesc) {
    const rowTokens = tokenize(rowName);
    const fileTokens = tokenize(inputFileDesc);
    if (rowTokens.length === 0 || fileTokens.length === 0) return 0;

    let matches = 0;
    
    // Boost si la marca (primer token) coincide
    if (rowTokens[0] === fileTokens[0]) matches += 0.5;

    for (const ft of fileTokens) {
      if (rowTokens.includes(ft)) matches++;
      else if (rowTokens.some(rt => rt.includes(ft) || ft.includes(rt))) matches += 0.8;
    }

    const union = new Set([...rowTokens, ...fileTokens]).size;
    if (union === 0) return 0;
    return matches / union;
  }

  function findBestMatch(rowName, itemsToMatch) {
    const rowNorm = normalizeExact(rowName);
    if (rowNorm) {
      for (const item of itemsToMatch) {
        if (normalizeExact(item.desc) === rowNorm) return item;
      }
    }

    let bestItem = null;
    let bestScore = 0;
    let secondBest = 0;

    for (const item of itemsToMatch) {
      const score = calculateScore(rowName, item.desc);
      if (score > bestScore) {
        secondBest = bestScore;
        bestScore = score;
        bestItem = item;
      } else if (score > secondBest) {
        secondBest = score;
      }
    }

    const THRESHOLD = 0.25; // Bajado para aceptar CPS vs CAPS
    const MARGIN = 0.05;

    if (bestScore >= 0.50) return bestItem;
    if (bestScore < THRESHOLD) return null;
    if ((bestScore - secondBest) < MARGIN) return null;
    return bestItem;
  }

  function extractNombreProductoFromRow(row) {
    const tds = Array.from(row.querySelectorAll('td'));
    const textLooksLikeMoney = (txt) => /^[\\$\\s\\d\\.\\,]+$/.test((txt || '').replace(/\\s+/g, ' '));
    const getText = (el) => (el?.innerText || '').trim().replace(/\\s+/g, ' ');

    const posibleNombre = tds.find(td => {
      const txt = (td.innerText || '').trim();
      if (!txt) return false;
      if (td.querySelector('input, a, img')) return false;
      if (td.classList.contains('m') || td.classList.contains('oferta')) return false;
      if (td.classList.contains('d') || td.classList.contains('suprecio') || td.classList.contains('totallinea')) return false;
      if (textLooksLikeMoney(txt)) return false;
      if (/^[\\d\\.,]+$/.test(txt)) return false;
      return true;
    });

    return posibleNombre ? getText(posibleNombre) : '';
  }

  function extractEan13FromRow(row) {
    const hay = [
      row.getAttribute('data-ean') || '',
      row.innerText || '',
      row.innerHTML || ''
    ].join(' ');
    const m = hay.match(/\\b\\d{13}\\b/);
    return m ? m[0] : '';
  }
`;


/// =========== Helpers: update qty (unificado) ===========

async function updateQuantitiesWithSafeMatching(page, productsList) {
    await page.addScriptTag({ content: injectedScoreFunctions });

    const stats = await page.evaluate((itemsToMatch) => {
        const rows = Array.from(document.querySelectorAll('table tbody tr'));
        const byEan = Object.create(null);

        for (const it of itemsToMatch) {
            // FIX: Usar ean_linked si está disponible en itemsToMatch
            const e = (it.ean_linked || it.ean || '').trim();
            if (e) byEan[e] = it;
        }

        let matched = 0, updated = 0, ambiguous = 0, noName = 0;

        for (const row of rows) {
            const input = row.querySelector('input.cant');
            if (!input) continue;

            // 1) Match exacto por EAN si aparece en la fila
            const eanInRow = extractEan13FromRow(row);
            let match = (eanInRow && byEan[eanInRow]) ? byEan[eanInRow] : null;

            // 2) Fallback: match por nombre limpio (NO row.innerText completo)
            if (!match) {
                const nombre = extractNombreProductoFromRow(row);
                if (!nombre) { noName++; continue; }
                match = findBestMatch(nombre, itemsToMatch);
                if (!match) { ambiguous++; continue; }
            }

            matched++;
            const targetVal = parseInt(match.qty, 10) || 0;
            const currentVal = parseInt(input.value, 10) || 0;

            if (currentVal !== targetVal) {
                input.value = String(targetVal);
                input.dispatchEvent(new Event('change', { bubbles: true }));
                updated++;
            }
        }

        return { totalRows: rows.length, matched, updated, ambiguous, noName };
    }, productsList);

    console.log(`[FLOW] Qty update stats: matched=${stats.matched} updated=${stats.updated} ambiguous=${stats.ambiguous} noName=${stats.noName}`);
}


/// =========== EJECUCIÓN (Lógica Doble) ===========

// --- MODO BATCH (Experimental) ---
async function runBatch(items) {
    console.log('>>> MODO BATCH (EXPERIMENTAL) ACTIVADO <<<');
    let browser = null;
    try {
        // 1. Generar PEDSEC
        // Esto crea un archivo con el EAN correcto (linked) y la descripción
        const fileData = generatePedsecFromJSON(items);
        const pedsecPath = fileData.pedsecPath;
        const productsList = fileData.validItems;

        // 2. Browser
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

        // 3. Login
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2000);

        await tryCloseCookieBanners(page);

        const userSel = 'input[name*="user" i], input[type="text"]';
        if (await page.locator(userSel).count() > 0) {
            await ensureFocusAndType(page, userSel, SUIZO_USER);
            await page.waitForTimeout(1000);
        }

        const passSel = 'input[type="password"]';
        if (await page.locator(passSel).count() > 0) {
            await ensureFocusAndType(page, passSel, SUIZO_PASS);
            await page.waitForTimeout(1000);
        }

        const submitSel = 'button:has-text("Ingresar"), button:has-text("Iniciar"), button[type="submit"]';
        if (await page.locator(submitSel).count() > 0) await page.locator(submitSel).first().click();
        else await page.keyboard.press('Enter');

        console.log('[FLOW] Login enviado. Esperando carga de dashboard...');
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

        await attemptCloseAds(page);

        // 4. Importación y Upload
        console.log('[FLOW] Verificando si es necesario navegar a Importación...');
        if (page.url().toLowerCase().includes('importacion')) {
            console.log('[FLOW] Ya estamos en la página de importación.');
        } else {
            const linkImp = page.locator('a[href*="importacion"], a:has-text("Importación")');
            if (await linkImp.count() > 0 && await linkImp.first().isVisible()) {
                console.log('[FLOW] Click en menú Importación (sin recarga forzada)...');
                await linkImp.first().click();
                await page.waitForLoadState('domcontentloaded');
            } else {
                console.log('[FLOW] Menú no detectado, navegando URL directa...');
                await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
            }
        }

        const fileInputSelector = 'input[type="file"][name="file"]';
        await page.waitForSelector(fileInputSelector, { timeout: 30000 });
        await page.setInputFiles(fileInputSelector, pedsecPath);

        const btnSelector = 'input[type="submit"][value="Enviar"], button:has-text("Enviar")';

        // FIX: Evitar el timeout de 30000ms en click forzando noWaitAfter
        console.log('[FLOW] Click en Enviar (con bypass de espera automática)...');
        await page.locator(btnSelector).first().click({ noWaitAfter: true });

        // Esperar manualmente a que aparezca la tabla o cambie la URL con un timeout largo (60s)
        console.log('[FLOW] Archivo enviado. Esperando procesamiento del servidor (máx 60s)...');
        await Promise.race([
            page.waitForSelector('table tbody tr', { timeout: 60000 }),
            page.waitForURL('**/carro**', { timeout: 60000 }),
            page.waitForTimeout(15000) // Mínimo esperar 15s si es muy lento
        ]).catch(e => console.log('[FLOW] Aviso: Espera de tabla excedida o procesando fondo. Continuando scrape...'));

        // 5. Ver Carro
        if (productsList.length >= 300) {
            const verCarroSelector = 'a:has-text("Ver Carro Completo")';
            if (await page.locator(verCarroSelector).count() > 0 && await page.locator(verCarroSelector).first().isVisible()) {
                await page.locator(verCarroSelector).first().click();
                await page.waitForLoadState('networkidle').catch(() => { });
            }
        }
        await page.waitForSelector('table tbody tr', { timeout: 20000 }).catch(() => { });

        // 6. Actualizar Cantidades (safe matching)
        await updateQuantitiesWithSafeMatching(page, productsList);
        await page.waitForTimeout(1000);

        // 7. Scrape CON PRECIOS, OFERTAS Y STOCK
        await page.addScriptTag({ content: injectedScoreFunctions });

        const scrapedRows = await page.evaluate((itemsToMatch) => {
            const rows = Array.from(document.querySelectorAll('table tbody tr'));
            const result = [];
            const getText = (el) => (el?.innerText || '').trim().replace(/\s+/g, ' ');
            const textLooksLikeMoney = (txt) => /^[\$\s\d\.\,]+$/.test((txt || '').replace(/\s+/g, ' '));

            const byEan = Object.create(null);
            for (const it of itemsToMatch) {
                // FIX CRÍTICO: Usar el EAN vinculado (el de Del Sud) como clave
                const e = (it.ean || '').trim();
                // En generatePedsecFromJSON ya pusimos ean_linked en it.ean
                if (e) byEan[e] = it;
            }

            const getEanForRow = (row, nombreProducto) => {
                // 1. Si la tabla de Suizo muestra un EAN, usarlo
                const eanInRow = extractEan13FromRow(row);
                if (eanInRow && byEan[eanInRow]) return eanInRow;

                // 2. Si no, hacer matching borroso con nombre para recuperar el EAN original
                const match = findBestMatch(nombreProducto, itemsToMatch);
                return match ? match.ean : '';
            };

            rows.forEach((row) => {
                const tds = Array.from(row.querySelectorAll('td'));
                if (!tds.length) return;

                const faltasEl = row.querySelector('td b.red');
                const faltas = getText(faltasEl);
                const stockStatus = (faltas && faltas.length > 0) ? 'no' : 'si';

                let nombreProducto = '';
                const posibleNombre = tds.find(td => {
                    const txt = (td.innerText || '').trim();
                    if (!txt) return false;
                    if (td.querySelector('input, a, img')) return false;
                    if (td.classList.contains('m') || td.classList.contains('oferta')) return false;
                    if (td.classList.contains('d') || td.classList.contains('suprecio') || td.classList.contains('totallinea')) return false;
                    if (textLooksLikeMoney(txt)) return false;
                    if (/^[\d\.\,]+$/.test(txt)) return false;
                    return true;
                });
                if (posibleNombre) nombreProducto = getText(posibleNombre);

                if (!nombreProducto) return;

                // filtro basura
                if (/^[\-\$\s\d\.\,]+$/.test(nombreProducto)) return;
                if (/saldo|cuenta|total|cr[ée]dito/i.test(nombreProducto)) return;

                const matchedEan = getEanForRow(row, nombreProducto);

                // Oferta
                const ofertaCell = row.querySelector('td.m.oferta');
                let ofertaTexto = '';
                let ofertaValor = '';
                if (ofertaCell) {
                    const b = ofertaCell.querySelector('b');
                    ofertaTexto = getText(b || ofertaCell).replace(/[¡!]/g, '').trim();
                    let next = ofertaCell.nextElementSibling;
                    while (next && next.tagName !== 'TD') next = next.nextElementSibling;
                    if (next) ofertaValor = getText(next);
                }

                // Precios
                const totalCell = row.querySelector('td.d.totallinea');
                const precioDescCell = row.querySelector('td.d.suprecio'); // Precio Farmacia
                let totalLinea = getText(totalCell);
                let precioConDescuento = getText(precioDescCell);
                let suPrecio = ''; // Precio Público

                if (precioDescCell) {
                    let prev = precioDescCell.previousElementSibling;
                    while (prev && prev.tagName !== 'TD') prev = prev.previousElementSibling;
                    if (prev) suPrecio = getText(prev);
                }
                if (!suPrecio) {
                    const idx2 = tds.findIndex(td => td.classList.contains('suprecio'));
                    if (idx2 > 0) {
                        for (let i = idx2 - 1; i >= 0; i--) {
                            const td = tds[i];
                            if (td.classList.contains('d') && !td.classList.contains('suprecio') && !td.classList.contains('totallinea')) {
                                suPrecio = getText(td);
                                break;
                            }
                        }
                    }
                }

                result.push({
                    index: result.length + 1,
                    ean: matchedEan,
                    stock: stockStatus,
                    faltas: faltas || '',
                    nombreProducto: nombreProducto || '',
                    ofertaTexto: ofertaTexto || '',
                    ofertaValor: ofertaValor || '',
                    suPrecio: suPrecio || '',
                    precioConDescuento: precioConDescuento || '',
                    total: totalLinea || ''
                });
            });

            return result;
        }, productsList);

        console.log(`[SCRAPE] Extracción finalizada: ${scrapedRows.length} items.`);
        console.log('@@@PILLIGENCE_TABLE@@@ ' + JSON.stringify({ data: scrapedRows }));

        try { fs.unlinkSync(pedsecPath); } catch (e) { }

    } catch (e) {
        console.error('[BATCH ERROR]', e);
    } finally {
        if (browser && !KEEP_BROWSER_OPEN) await browser.close();
        console.log('--- FIN BUSQUEDA ---');
        process.exit(0);
    }
}


// --- MODO MANUAL (Original) ---
async function runManual() {
    console.log('>>> MODO MANUAL ACTIVADO <<<');
    try {
        console.log('=== 01-login-y-importacion-suizo ===');

        // 1. Preparar archivos
        let fileData = null;
        try {
            fileData = await prepareFiles();
        } catch (err) {
            console.error('[FILE ERROR]', err.message);
            process.exit(1);
        }

        const pedsecPath = fileData.pedsecPath;
        const productsList = fileData.items;
        const pedsecLineCount = fileData.count || 0;

        console.log(`[CONVERT] Cantidad de líneas en PEDSEC: ${pedsecLineCount}`);

        let browser = null;
        let chosenExe = candidateChromePaths().find(p => fs.existsSync(p));
        const args = [
            '--no-first-run',
            '--no-default-browser-check',
            '--window-position=-2400,-2400', // <--- VENTANA FUERA DE PANTALLA
            '--window-size=1920,1080'        // <--- TAMAÑO DE MONITOR GRANDE
        ];
        const launchOpts = { headless: PLAYWRIGHT_HEADLESS, args };
        if (chosenExe) launchOpts.executablePath = chosenExe;

        try {
            browser = await chromium.launch(launchOpts);
        } catch (e) {
            console.error('[LAUNCH] fallo:', e.message);
            process.exit(2);
        }

        try {
            const context = await browser.newContext();
            const page = await context.newPage();
            page.on('console', msg => { if (msg.type() === 'log') console.log('PAGE LOG:', msg.text()); });

            // 2. Login
            console.log('[FLOW] navegando a login:', LOGIN_URL);
            await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
            await page.waitForTimeout(2000);

            await saveDiagnostic(page, 'login_page');
            await tryCloseCookieBanners(page);

            const userSel = 'input[aria-label="Usuario"], input[name*="user" i], input[type="text"]';
            if (await page.locator(userSel).count() > 0) {
                await ensureFocusAndType(page, userSel, SUIZO_USER);
                await page.waitForTimeout(1000);
            }

            const passSel = 'input[aria-label*="contrase" i], input[type="password"]';
            if (await page.locator(passSel).count() > 0) {
                await ensureFocusAndType(page, passSel, SUIZO_PASS);
                await page.waitForTimeout(1000);
            }

            const submitSel = 'button:has-text("Ingresar"), button:has-text("Iniciar"), button[type="submit"]';
            if (await page.locator(submitSel).count() > 0) await page.locator(submitSel).first().click();
            else await page.keyboard.press('Enter');

            console.log('[FLOW] Login enviado. Esperando autenticación y dashboard...');
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

            await attemptCloseAds(page);

            // 4. Importación
            console.log('[FLOW] Verificando ubicación...');
            if (page.url().toLowerCase().includes('importacion')) {
                console.log('[FLOW] Ya estamos en la página de importación.');
            } else {
                const linkImp = page.locator('a[href*="importacion"], a:has-text("Importación")');
                if (await linkImp.count() > 0 && await linkImp.first().isVisible()) {
                    console.log('[FLOW] Click en menú Importación (sin recarga forzada)...');
                    await linkImp.first().click();
                    await page.waitForLoadState('domcontentloaded');
                } else {
                    console.log('[FLOW] Menú no detectado, navegando URL directa...');
                    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
                }
            }
            await saveDiagnostic(page, 'importacion_page');

            // 5. Upload
            const fileInputSelector = 'input[type="file"][name="file"]';
            console.log('[FLOW] Esperando input de archivo...');
            await page.waitForSelector(fileInputSelector, { timeout: 60000 });

            await page.setInputFiles(fileInputSelector, pedsecPath);
            const btnSelector = 'input[type="submit"][value="Enviar"], button:has-text("Enviar")';

            // FIX: Evitar timeout de 30s forzando noWaitAfter
            console.log('[FLOW] Click en Enviar (con bypass de espera automática)...');
            await page.locator(btnSelector).first().click({ noWaitAfter: true });

            console.log('[FLOW] Archivo enviado. Esperando respuesta del servidor (máx 60s)...');
            await Promise.race([
                page.waitForSelector('table tbody tr', { timeout: 60000 }),
                page.waitForURL('**/carro**', { timeout: 60000 }),
                page.waitForTimeout(10000)
            ]).catch(() => { });

            await saveDiagnostic(page, 'archivo_enviado');

            // 6. Ver Carro
            if (pedsecLineCount >= 300) {
                const verCarroSelector = 'a:has-text("Ver Carro Completo")';
                if (await page.locator(verCarroSelector).count() > 0 && await page.locator(verCarroSelector).first().isVisible()) {
                    await page.locator(verCarroSelector).first().click();
                    await page.waitForLoadState('networkidle').catch(() => { });
                }
            }
            await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(() => { });

            // 7. Actualizar cantidades (safe matching)
            console.log('[FLOW] Actualizando cantidades (safe match)...');
            await updateQuantitiesWithSafeMatching(page, productsList);

            // 8. Scrape (con matching fix)
            await page.addScriptTag({ content: injectedScoreFunctions });

            const scrapedRows = await page.evaluate((itemsToMatch) => {
                const rows = Array.from(document.querySelectorAll('table tbody tr'));
                const result = [];
                const getText = (el) => (el?.innerText || '').trim().replace(/\s+/g, ' ');
                const textLooksLikeMoney = (txt) => /^[\$\s\d\.\,]+$/.test((txt || '').replace(/\s+/g, ' '));

                const byEan = Object.create(null);
                for (const it of itemsToMatch) {
                    const e = (it.ean || '').trim();
                    if (e) byEan[e] = it;
                }

                const getEanForRow = (row, nombreProducto) => {
                    const eanInRow = extractEan13FromRow(row);
                    if (eanInRow && byEan[eanInRow]) return eanInRow;
                    const match = findBestMatch(nombreProducto, itemsToMatch);
                    return match ? match.ean : '';
                };

                rows.forEach((row) => {
                    const tds = Array.from(row.querySelectorAll('td'));
                    if (!tds.length) return;

                    const faltasEl = row.querySelector('td b.red');
                    const faltas = getText(faltasEl);
                    const stockStatus = (faltas && faltas.length > 0) ? 'no' : 'si';

                    let nombreProducto = '';
                    const posibleNombre = tds.find(td => {
                        const txt = (td.innerText || '').trim();
                        if (!txt) return false;
                        if (td.querySelector('input, a, img')) return false;
                        if (td.classList.contains('m') || td.classList.contains('oferta')) return false;
                        if (td.classList.contains('d') || td.classList.contains('suprecio') || td.classList.contains('totallinea')) return false;
                        if (textLooksLikeMoney(txt)) return false;
                        if (/^[\d\.\,]+$/.test(txt)) return false;
                        return true;
                    });
                    if (posibleNombre) nombreProducto = getText(posibleNombre);
                    if (!nombreProducto) return;

                    const matchedEan = getEanForRow(row, nombreProducto);

                    const ofertaCell = row.querySelector('td.m.oferta');
                    let ofertaTexto = '';
                    let ofertaValor = '';
                    if (ofertaCell) {
                        const b = ofertaCell.querySelector('b');
                        ofertaTexto = getText(b || ofertaCell).replace(/[¡!]/g, '').trim();

                        let next = ofertaCell.nextElementSibling;
                        while (next && next.tagName !== 'TD') next = next.nextElementSibling;
                        if (next) ofertaValor = getText(next);
                    }

                    const totalCell = row.querySelector('td.d.totallinea');
                    const precioDescCell = row.querySelector('td.d.suprecio');
                    let totalLinea = getText(totalCell);
                    let precioConDescuento = getText(precioDescCell);
                    let suPrecio = '';

                    if (precioDescCell) {
                        let prev = precioDescCell.previousElementSibling;
                        while (prev && prev.tagName !== 'TD') prev = prev.previousElementSibling;
                        if (prev) suPrecio = getText(prev);
                    }
                    if (!suPrecio) {
                        const idx = tds.findIndex(td => td.classList.contains('suprecio'));
                        if (idx > 0) {
                            for (let i = idx - 1; i >= 0; i--) {
                                const td = tds[i];
                                if (td.classList.contains('d') && !td.classList.contains('suprecio') && !td.classList.contains('totallinea')) {
                                    suPrecio = getText(td);
                                    break;
                                }
                            }
                        }
                    }

                    result.push({
                        index: result.length + 1,
                        stock: stockStatus,
                        faltas: faltas || '',
                        nombreProducto: nombreProducto || '',
                        ofertaTexto: ofertaTexto || '',
                        ofertaValor: ofertaValor || '',
                        suPrecio: suPrecio || '',
                        precioConDescuento: precioConDescuento || '',
                        total: totalLinea || '',
                        ean: matchedEan
                    });
                });

                return result;
            }, productsList);

            console.log('\n[SCRAPE] Productos en carro:');
            if (scrapedRows.length === 0) {
                console.log('[SCRAPE] No se encontraron filas.');
            } else {
                for (const row of scrapedRows) {
                    const minMatch = (row.ofertaTexto || '').match(/Min\.?:?\s*(\d+)/i);
                    const minimo = minMatch ? minMatch[1] : '1';

                    console.log(`--- [ Producto #${row.index} ] ---`);
                    console.log(`Nombre       : ${row.nombreProducto}`);
                    console.log(`$ Unitario   : ${row.precioConDescuento || '0.00'}`);
                    console.log(`$ Público    : ${row.suPrecio || '0.00'}`);
                    console.log(`$ Sin Desc.  : ${row.total || ''}`);
                    console.log(`Stock        : ${String(row.stock || '').toUpperCase()}`);
                    console.log(`Mínimo       : ${minimo}`);
                    console.log(`EAN (Linked): ${row.ean || ''}`);
                    console.log('');
                }
                console.log(`[SCRAPE] Total items: ${scrapedRows.length}`);
            }

            try { await context.storageState({ path: STATE_FILE }); } catch (e) { }

            if (KEEP_BROWSER_OPEN) {
                console.log('[EXIT] Navegador abierto.');
                await new Promise(() => { });
            } else {
                console.log('[EXIT] Cerrando navegador...');
                await browser.close();
                process.exit(0);
            }

        } catch (err) {
            console.error('[ERROR]', err);
            try { if (browser && !KEEP_BROWSER_OPEN) await browser.close(); } catch (e) { }
            process.exit(1);
        }
    } catch (outerErr) {
        console.error('[FATAL]', outerErr);
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