// E2E del catálogo vivo y los modelos 3D (modo demo, API en memoria): sube modelos GLB (válido y basura),
// crea activos con modelo, disposición y conexiones, y comprueba la vista previa, el 3D del panel y los
// estados "Sin datos" en escritorio 1440x900 y móvil 390x844. Capturas en e2e/screenshots/models-*.png.
// Uso: npm run e2e:models   (SKIP_BUILD=1 para reutilizar .next)
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecker, launchBrowser, shots, sleep, startApp } from './lib.mjs';

const PORT = Number(process.env.E2E_MODELS_PORT ?? 3219);
const { state, check } = createChecker();
const { base: BASE, server } = await startApp(PORT);
const browser = await launchBrowser();
const shot = (page, name) => page.screenshot({ path: path.join(shots, `models-${name}.png`) });
const here = path.dirname(fileURLToPath(import.meta.url));
const sampleTank = path.join(here, '../../../examples/models/sample-tank.glb');
const sampleValve = path.join(here, '../../../examples/models/sample-valve.glb');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'campo-e2e-'));
const garbage = path.join(tmp, 'basura.glb');
writeFileSync(garbage, 'esto no es un modelo 3d, es texto plano'.repeat(10));
const notGlb = path.join(tmp, 'nota.txt');
writeFileSync(notGlb, 'hola');
const huge = path.join(tmp, 'enorme.glb');
writeFileSync(huge, Buffer.alloc(10 * 1024 * 1024 + 1024));
// GLB válido para la API (cabecera y JSON correctos) pero sin geometría: el 3D no puede dibujarlo
const emptyGlb = path.join(tmp, 'vacio.glb');
{
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' } }));
  const pad = (4 - (json.length % 4)) % 4;
  const body = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + body.length, 8);
  head.writeUInt32LE(body.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  writeFileSync(emptyGlb, Buffer.concat([head, body]));
}

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  return errors;
}

async function overflow(page) {
  return page.evaluate(() => {
    const over = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > window.innerWidth + 1) over.push(`documento ${doc.scrollWidth}>${window.innerWidth}`);
    for (const el of document.querySelectorAll('#main, [role="dialog"], [role="alertdialog"]')) {
      if (el.scrollWidth > el.clientWidth + 1) over.push(`${el.id || el.getAttribute('role')} ${el.scrollWidth}>${el.clientWidth}`);
    }
    return over;
  });
}

async function smallTargets(page, scope) {
  return page.evaluate((sel) => {
    const out = [];
    const rootEl = document.querySelector(sel);
    if (!rootEl) return out;
    for (const el of rootEl.querySelectorAll('a[href], button, input, select, textarea, summary')) {
      if (el.closest('.sr-only')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const target = el.matches('input[type="checkbox"]') ? (el.closest('label') ?? el) : el;
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width < 43.5 || r.height < 43.5) out.push(`${el.tagName.toLowerCase()}[${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)}] ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  }, scope);
}

async function audit(page, label, scope = 'body') {
  const over = await overflow(page);
  check(over.length === 0, `${label}: sin desborde horizontal${over.length ? ' → ' + over.join(', ') : ''}`);
  const small = await smallTargets(page, scope);
  check(small.length === 0, `${label}: targets ≥44px${small.length ? ' → ' + small.slice(0, 6).join('; ') : ''}`);
}

/** Fracción de píxeles de un elemento que difieren del fondo (#0d141d): >0 = hay algo dibujado. */
async function paintedRatio(page, locator) {
  const png = await locator.screenshot();
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 13) + Math.abs(d[i + 1] - 20) + Math.abs(d[i + 2] - 29) > 60) n++;
    return n / (d.length / 4);
  }, png.toString('base64'));
}

const vis = (loc, timeout = 5000) => loc.waitFor({ state: 'visible', timeout }).then(() => true, () => false);
const toast = (page, re) => page.locator('[data-testid="toast"]').filter({ hasText: re }).first().waitFor({ timeout: 6000 }).then(() => true, () => false);

async function openNewAsset(page, tap = false) {
  const btn = page.getByRole('button', { name: 'Nuevo activo' });
  await (tap ? btn.tap() : btn.click());
  const dlg = page.getByRole('dialog', { name: 'Nuevo activo' });
  await dlg.waitFor();
  return dlg;
}

try {
  // ───────────────────────── ESCRITORIO ─────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = watchErrors(page);

    await page.goto(`${BASE}/admin/plants/demo`, { waitUntil: 'load' });
    await page.locator('[data-testid="models-panel"]').waitFor({ timeout: 30_000 });
    await page.locator('[data-testid="assets-table"]').waitFor();
    check(await vis(page.getByRole('heading', { name: 'Modelos 3D' })), 'admin: sección «Modelos 3D» en la página de la planta');
    check(await vis(page.getByText('Esta planta no tiene modelos 3D')), 'admin: lista de modelos vacía al principio');
    const previewCanvas = page.locator('[data-testid="preview-scene"] canvas');
    check(await vis(previewCanvas, 30_000), 'preview: en escritorio la vista previa 3D se muestra sola');
    await sleep(2500);
    const r0 = await paintedRatio(page, page.locator('[data-testid="preview-scene"]'));
    check(r0 > 0.02, `preview: la planta demo se dibuja (${(r0 * 100).toFixed(1)} % de píxeles)`);
    await shot(page, 'admin-preview-initial-desktop');

    // ── subida: archivo válido ──
    const fileInput = page.locator('[data-testid="models-panel"] input[type="file"]');
    await fileInput.setInputFiles(sampleTank);
    await page.locator('[data-testid="models-table"]').waitFor({ timeout: 10_000 });
    check(await toast(page, /sample-tank.*subido/), 'subida: aviso de éxito (aria-live)');
    const row = page.locator('[data-testid^="model-row-"]').first();
    const rowText = (await row.textContent()) ?? '';
    check(/sample-tank/.test(rowText) && /2,9 KB/.test(rowText), `subida: fila con nombre y tamaño legible (${rowText.replace(/\s+/g, ' ').slice(0, 70)})`);
    check((await row.locator('td').nth(3).textContent()) === '0', 'subida: 0 activos lo usan todavía');

    // ── subida: errores junto al control ──
    await fileInput.setInputFiles(garbage);
    const upErr = page.locator('[data-testid="upload-error"]');
    check(await vis(upErr), 'subida: un archivo basura muestra un error visible');
    check(/GLB no válido/.test((await upErr.textContent()) ?? ''), `subida: error de la API en español («${((await upErr.textContent()) ?? '').slice(0, 60)}»)`);
    await shot(page, 'upload-garbage-error-desktop');
    await fileInput.setInputFiles(notGlb);
    check(/\.glb/.test((await upErr.textContent()) ?? ''), 'subida: extensión incorrecta rechazada en cliente');
    await fileInput.setInputFiles(huge);
    check(/máximo es 10 MB/.test((await upErr.textContent()) ?? ''), 'subida: >10 MB rechazado en cliente antes de enviar');
    check((await page.locator('[data-testid^="model-row-"]').count()) === 1, 'subida: los rechazados no aparecen en la lista');
    await fileInput.setInputFiles(sampleTank);
    check(await toast(page, /ya estaba/), 'subida: el mismo contenido se deduplica (aviso)');
    check((await page.locator('[data-testid^="model-row-"]').count()) === 1, 'subida: sigue habiendo un solo modelo');
    await fileInput.setInputFiles(emptyGlb);
    await page.locator('[data-testid^="model-row-"]').nth(1).waitFor();

    // ── crear activo con modelo, disposición y conexiones ──
    let dlg = await openNewAsset(page);
    await dlg.getByLabel('Id', { exact: true }).fill('tk-nuevo');
    await dlg.getByLabel('Nombre').fill('Tanque nuevo');
    await dlg.getByLabel('Modelo 3D').selectOption({ label: 'sample-tank (2,9 KB)' });
    await dlg.getByLabel('Posición X (m)').fill('6');
    await dlg.getByLabel('Posición Z (m)').fill('9');
    await dlg.getByLabel('Rotación (°)').fill('45');
    await dlg.getByLabel('Escala').fill('3,5');
    await dlg.getByRole('checkbox', { name: /Bomba 02/ }).check();
    const meta = dlg.getByLabel('Metadatos (JSON)');
    let json = JSON.parse(await meta.inputValue());
    check(json.layout?.x === 6 && json.layout?.z === 9 && json.layout?.rotY === 45 && json.layout?.scale === 3.5 && json.connectsTo?.[0] === 'pump-02', `form: los campos se reflejan en el JSON avanzado (${JSON.stringify(json)})`);
    // editar el JSON a mano (clave propia) y volver a tocar un campo: no se pierde
    await meta.fill(JSON.stringify({ ...json, notas: 'a mano' }, null, 2));
    await dlg.getByLabel('Posición X (m)').fill('7');
    json = JSON.parse(await meta.inputValue());
    check(json.notas === 'a mano' && json.layout.x === 7, 'form: editar un campo no pisa las claves escritas a mano en el JSON');
    // y al revés: el JSON actualiza los campos
    await meta.fill(JSON.stringify({ ...json, layout: { ...json.layout, z: 10 } }, null, 2));
    check((await dlg.getByLabel('Posición Z (m)').inputValue()) === '10', 'form: editar el JSON actualiza los campos');
    // validación de rangos
    await dlg.getByLabel('Escala').fill('99');
    check(await vis(dlg.getByText(/Escala: entre 0,05 y 50/)), 'form: la escala fuera de rango se marca en el campo');
    await dlg.getByRole('button', { name: 'Crear activo' }).click();
    check(await vis(dlg.getByText('Revisa la disposición')), 'form: no guarda con valores no válidos');
    await dlg.getByLabel('Escala').fill('3,5');
    await shot(page, 'asset-form-desktop');
    await dlg.getByRole('button', { name: 'Crear activo' }).click();
    await dlg.waitFor({ state: 'detached' });
    check(await toast(page, /tk-nuevo creado/), 'form: activo creado');
    const tr = page.locator('[data-testid="asset-row-tk-nuevo"]');
    const trText = (await tr.textContent()) ?? '';
    check(/sample-tank/.test(trText) && /X 7 · Z 10/.test(trText) && /1 conexión/.test(trText), `tabla: modelo, disposición y conexión (${trText.replace(/\s+/g, ' ').slice(0, 100)})`);
    check((await page.locator('[data-testid^="model-row-"]').filter({ hasText: 'sample-tank' }).locator('td').nth(3).textContent()) === '1', 'modelos: ahora 1 activo usa el modelo');

    // activo con un modelo que no se puede dibujar + conexión a un activo inexistente (aviso de la API)
    dlg = await openNewAsset(page);
    await dlg.getByLabel('Id', { exact: true }).fill('sen-1');
    await dlg.getByLabel('Nombre').fill('Sonda sin datos');
    await dlg.getByLabel('Tipo').selectOption('sensor');
    await dlg.getByLabel('Modelo 3D').selectOption({ label: 'vacio (87 B)' }).catch(async () => {
      const labels = await dlg.getByLabel('Modelo 3D').locator('option').allTextContents();
      await dlg.getByLabel('Modelo 3D').selectOption({ label: labels.find((l) => l.startsWith('vacio')) });
    });
    await dlg.getByLabel('Posición X (m)').fill('-4');
    await dlg.getByLabel('Posición Z (m)').fill('9');
    await dlg.getByLabel('Escala').fill('1');
    const meta2 = dlg.getByLabel('Metadatos (JSON)');
    const j2 = JSON.parse(await meta2.inputValue());
    await meta2.fill(JSON.stringify({ ...j2, connectsTo: ['tk-nuevo', 'fantasma'] }, null, 2));
    check(await vis(dlg.getByText('fantasma (no existe)')), 'form: un conectado inexistente se muestra para poder quitarlo');
    await dlg.getByRole('button', { name: 'Crear activo' }).click();
    await dlg.waitFor({ state: 'detached' });
    const warn = page.locator('[data-testid="asset-warnings"]');
    check(await vis(warn), 'form: se muestran los warnings de la API');
    check(/fantasma/.test((await warn.textContent()) ?? ''), 'form: el aviso nombra el activo inexistente');
    await sleep(2500);
    await shot(page, 'admin-after-edit-desktop');
    const r1 = await paintedRatio(page, page.locator('[data-testid="preview-scene"]'));
    check(r1 > 0.02, `preview: refleja el catálogo editado (${(r1 * 100).toFixed(1)} % de píxeles)`);
    check((await page.locator('[data-testid="preview-scene"] .scene-label[data-model="glb"]').count()) === 1, 'preview: tk-nuevo se dibuja con su modelo GLB (etiqueta data-model=glb)');
    await audit(page, 'admin plantas (escritorio)');

    // ── borrar un modelo en uso → 409 con la lista ──
    await page.getByRole('button', { name: 'Eliminar modelo sample-tank' }).click();
    const del = page.getByRole('alertdialog');
    await del.getByRole('button', { name: 'Eliminar modelo' }).click();
    const delErr = del.getByRole('alert');
    check(await vis(delErr), 'borrar modelo en uso: error 409 dentro del diálogo');
    check(/tk-nuevo/.test((await delErr.textContent()) ?? ''), `borrar modelo en uso: lista los activos (${((await delErr.textContent()) ?? '').slice(0, 80)})`);
    await shot(page, 'model-delete-409-desktop');
    await del.getByRole('button', { name: 'Cancelar' }).click();
    // modelo libre → se borra tras confirmar
    await page.locator('[data-testid="models-panel"] input[type="file"]').setInputFiles(sampleValve);
    const freeRow = page.locator('[data-testid^="model-row-"]').filter({ hasText: 'sample-valve' });
    await freeRow.waitFor();
    await freeRow.getByRole('button', { name: /Eliminar modelo/ }).click();
    const del2 = page.getByRole('alertdialog');
    await del2.waitFor();
    check(/no se puede deshacer/.test((await del2.textContent()) ?? ''), 'borrar modelo libre: pide confirmación');
    await del2.getByRole('button', { name: 'Eliminar modelo' }).click();
    await del2.waitFor({ state: 'detached' });
    check((await page.locator('[data-testid^="model-row-"]').filter({ hasText: 'sample-valve' }).count()) === 0, 'borrar modelo libre: desaparece de la lista');

    // ── dashboard (navegación interna: el estado demo en memoria se conserva) ──
    await page.getByRole('link', { name: 'Volver al panel' }).click();
    await page.waitForURL(`${BASE}/`);
    await page.locator('[data-testid="plant-select"], [aria-label="Activos"]').first().waitFor();
    await page.locator('[data-testid="asset-row-tk-nuevo"]').waitFor({ timeout: 30_000 });
    await page.locator('[data-testid="asset-row-tk-01"]').waitFor();
    check((await page.locator('[data-testid^="asset-row-"]').count()) === 10, 'lista: 8 activos de demo + 2 nuevos');
    const st = (id) => page.locator(`[data-testid="row-status-${id}"]`).textContent();
    check((await st('tk-nuevo')) === 'Sin datos' && (await st('sen-1')) === 'Sin datos', 'lista escritorio: los activos nuevos sin telemetría salen como «Sin datos»');
    check((await page.locator('[data-testid="row-value-tk-nuevo"]').count()) === 0, 'lista escritorio: «Sin datos» no muestra valor');
    check((await page.getByText('Esperando datos').count()) === 0, 'lista escritorio: ya no aparece «Esperando datos…»');
    await page.locator('[data-testid="scene"] canvas').waitFor({ timeout: 30_000 });
    await sleep(4000);
    const r2 = await paintedRatio(page, page.locator('[data-testid="scene"]'));
    check(r2 > 0.03, `3D de la planta: canvas con píxeles (${(r2 * 100).toFixed(1)} %)`);
    check((await page.locator('[data-testid="scene"] .scene-label[data-model="glb"]').count()) === 1, '3D: tk-nuevo usa su GLB');
    await page.locator('[data-testid="asset-row-tk-nuevo"]').click();
    const panel = page.locator('[data-testid="asset-panel"]');
    check(await vis(panel), 'panel: se abre al seleccionar un activo con GLB');
    check(/Sin datos/.test((await panel.textContent()) ?? '') && (await page.locator('[data-testid="model-unavailable"]').count()) === 0, 'panel: «Sin datos» y sin aviso de modelo');
    await shot(page, 'dashboard-desktop');
    await page.locator('[data-testid="asset-row-sen-1"]').click();
    check(await vis(page.locator('[data-testid="model-unavailable"]')), 'panel: un modelo que no se puede dibujar → aviso discreto «Modelo no disponible»');
    check((await page.locator('[data-testid="scene"] canvas').count()) === 1, '3D: el fallo del modelo no rompe el canvas');
    await shot(page, 'dashboard-model-unavailable-desktop');
    check(errors.filter((e) => !/emptyGlb|vacio/.test(e)).length === 0, `escritorio: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }

  // ───────────────────────── MÓVIL 390x844 ─────────────────────────
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${BASE}/admin/plants/demo`, { waitUntil: 'load' });
    await page.locator('[data-testid="models-panel"]').waitFor({ timeout: 30_000 });
    check(await vis(page.getByRole('button', { name: 'Ver vista previa' })), 'móvil: la vista previa 3D es opt-in («Ver vista previa»)');
    check((await page.locator('canvas').count()) === 0, 'móvil: no hay canvas hasta pedirla');
    await audit(page, 'móvil admin planta (modelos vacíos)', '#main');
    await shot(page, 'admin-mobile');

    await page.locator('[data-testid="models-panel"] input[type="file"]').setInputFiles(sampleTank);
    await page.locator('[data-testid^="model-card-"]').first().waitFor({ timeout: 10_000 });
    await page.locator('[data-testid="models-panel"] input[type="file"]').setInputFiles(garbage);
    check(await vis(page.locator('[data-testid="upload-error"]')), 'móvil: el error de subida se ve');
    await audit(page, 'móvil panel de modelos con error', '#main');
    await shot(page, 'models-panel-mobile');

    const dlg = await openNewAsset(page, true);
    await dlg.getByLabel('Id', { exact: true }).fill('sen-m');
    await dlg.getByLabel('Nombre').fill('Sensor móvil');
    await dlg.getByLabel('Tipo').selectOption('sensor');
    await dlg.getByLabel('Modelo 3D').selectOption('__upload__');
    check(await vis(dlg.locator('[data-testid="model-uploader"]')), 'móvil: «Subir nuevo…» muestra el cargador dentro del formulario');
    await dlg.getByLabel('Posición X (m)').fill('-8');
    await dlg.getByLabel('Posición Z (m)').fill('9');
    await audit(page, 'móvil formulario de activo', '[role="dialog"]');
    await shot(page, 'asset-form-mobile');
    await dlg.getByRole('button', { name: 'Crear activo' }).tap();
    await dlg.waitFor({ state: 'detached' });
    await page.locator('[data-testid="asset-card-sen-m"]').waitFor();
    await page.getByRole('button', { name: 'Ver vista previa' }).tap();
    await page.locator('[data-testid="preview-scene"] canvas').waitFor({ timeout: 30_000 });
    await sleep(2500);
    await page.locator('[data-testid="plant-preview"]').scrollIntoViewIfNeeded();
    await shot(page, 'admin-preview-mobile');
    await audit(page, 'móvil admin planta con vista previa', '#main');

    await page.getByRole('link', { name: 'Panel', exact: true }).tap();
    await page.waitForURL(`${BASE}/`);
    await page.locator('[data-testid="tab-summary"]').waitFor();
    const card = page.locator('[data-testid="asset-card-sen-m"]');
    await card.waitFor({ timeout: 30_000 });
    check(/Sin datos/.test((await card.textContent()) ?? ''), 'móvil: la tarjeta del activo nuevo dice «Sin datos»');
    check((await page.locator('[data-testid^="asset-card-"]').count()) === 9, 'móvil: 8 de demo + 1 nueva');
    check((await page.locator('canvas').count()) === 0, 'móvil: el dashboard sigue sin canvas por defecto');
    await card.scrollIntoViewIfNeeded();
    await audit(page, 'móvil dashboard', '#main');
    await shot(page, 'dashboard-mobile');
    check(errors.length === 0, `móvil: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }
} catch (e) {
  console.error(e);
  state.failures++;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}

console.log(state.failures === 0 ? '\nE2E MODELS OK' : `\nE2E MODELS: ${state.failures} fallo(s)`);
process.exit(state.failures === 0 ? 0 : 1);
