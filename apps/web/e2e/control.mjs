// E2E de tags, niveles 3-4 y Control de llenado (modo demo, sin backend): tags junto al nombre, detalle de la unidad
// (/m/tanks/tnk-101) y del equipo (/equipo), orden de llenado en DOS PASOS (vista previa → confirmación con cuenta
// regresiva → ejecutar), enclavamientos visibles, detener, registro de órdenes en vivo, rol de consulta y cliente sin el
// módulo. Capturas en e2e/screenshots/control-*.png. Uso: npm run e2e:control   (SKIP_BUILD=1 reutiliza el build)
import path from 'node:path';
import { createChecker, launchBrowser, pollUntil, shots, sleep, startApp } from './lib.mjs';

const PORT = Number(process.env.E2E_CONTROL_PORT ?? 3224);
const { state, check } = createChecker();
const { base: BASE, server } = await startApp(PORT);
const browser = await launchBrowser();
const shot = (page, name) => page.screenshot({ path: path.join(shots, `control-${name}.png`), timeout: 120_000 });

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  return errors;
}
const count = (page, sel) => page.locator(sel).count();
const text = async (page, sel) => ((await page.locator(sel).first().textContent({ timeout: 3000 }).catch(() => null)) ?? '').replace(/\s+/g, ' ').trim();
const level = async (page, id) => Number((await text(page, `[data-testid="control-level-${id}"]`)).replace(',', '.'));
const setTarget = async (page, id, v) => {
  await page.locator(`[data-testid="control-input-${id}"]`).fill(String(v));
};
const withRole = (ctx, role, org = 'campos-demo') =>
  ctx.addInitScript(([r, o]) => {
    localStorage.setItem('campo.demoRole', r);
    localStorage.setItem('campo.demoOrg', o);
  }, [role, org]);
const orderRows = (page) => page.locator('[data-testid="order-row"]');
const firstStatus = async (page) => (await orderRows(page).first().getAttribute('data-status').catch(() => null)) ?? '';

try {
  // ───────────────────────── ESCRITORIO: administrador del cliente con todos los módulos ─────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = watchErrors(page);

    // Tags junto al nombre (nivel 2)
    await page.goto(`${BASE}/m/tanks`, { waitUntil: 'load' });
    await page.locator('[data-testid="asset-card-tk-01"]').waitFor({ timeout: 30_000 });
    check((await text(page, '[data-testid="tag-tk-01"]')) === 'TNK-101', 'tags: la tarjeta de tk-01 muestra TNK-101');
    check((await text(page, '[data-testid="tag-silo-01"]')) === 'TNK-301', 'tags: el silo-01 muestra TNK-301 y aparece en Tanques');
    check((await page.locator('[data-testid="tag-tk-01"]').evaluate((el) => getComputedStyle(el).fontFamily)).toLowerCase().includes('mono'), 'tags: en tipografía monoespaciada');

    // Nivel 3: enlace desde la tarjeta
    await page.locator('[data-testid="unit-link-tk-01"]').click();
    await page.locator('[data-testid="unit-screen"] [data-testid="faceplate"]').waitFor({ timeout: 20_000 });
    check(new URL(page.url()).pathname === '/m/tanks/tnk-101', `nivel 3: la URL usa el tag en minúsculas (${new URL(page.url()).pathname})`);
    check((await text(page, '[data-testid="unit-tag"]')) === 'TNK-101' && (await text(page, '[data-testid="unit-name"]')) === 'Tanque 01', 'nivel 3: cabecera con nombre y tag');
    for (const k of ['pv', 'sp', 'op', 'mode', 'sts']) check((await count(page, `[data-testid="fp-${k}"]`)) === 1, `nivel 3: faceplate con ${k.toUpperCase()}`);
    check((await count(page, '[data-testid="fp-bar"] [data-testid="deviation-bar"]')) === 1, 'nivel 3: barra de desviación respecto del SP');
    check((await count(page, '[data-testid="unit-trend"] canvas')) >= 1, 'nivel 3: tendencia');
    check((await count(page, '[data-testid="related-valve-01"]')) === 1 && (await count(page, '[data-testid="related-pump-01"]')) === 1, 'nivel 3: válvula y bomba asociadas');
    const pv0 = await text(page, '[data-testid="fp-pv"]');
    check(!!(await pollUntil(async () => (await text(page, '[data-testid="fp-pv"]')) !== pv0, 10_000)), 'nivel 3: PV en vivo');
    await shot(page, 'unit-desktop');

    // Ruta directa (el tag también funciona escrito en mayúsculas)
    await page.goto(`${BASE}/m/tanks/TNK-101`, { waitUntil: 'load' });
    check(!!(await page.locator('[data-testid="faceplate"]').waitFor({ timeout: 20_000 }).then(() => true, () => false)), 'nivel 3: ruta directa por tag');
    await page.goto(`${BASE}/m/tanks/tnk-999`, { waitUntil: 'load' });
    check(!!(await page.locator('[data-testid="unit-notfound"]').waitFor({ timeout: 20_000 }).then(() => true, () => false)), 'nivel 3: tag inexistente → «No encontramos ese equipo»');

    // Nivel 4
    await page.goto(`${BASE}/m/tanks/tnk-101`, { waitUntil: 'load' });
    await page.locator('[data-testid="unit-equipment-link"]').click();
    await page.locator('[data-testid="equipment-screen"] [data-testid="interlock-panel"]').waitFor({ timeout: 20_000 });
    check(new URL(page.url()).pathname === '/m/tanks/tnk-101/equipo', 'nivel 4: /equipo');
    check(!!(await pollUntil(async () => (await count(page, '[data-testid^="interlock-"][data-ok]')) >= 5, 10_000)), 'nivel 4: permisos de enclavamiento');
    check((await count(page, '[data-testid="setpoint-input"]')) === 1, 'nivel 4: un administrador puede ajustar el setpoint');
    await page.locator('[data-testid="setpoint-input"]').fill('150');
    await page.locator('[data-testid="setpoint-save"]').click();
    check(/dentro de la escala/.test(await page.locator('[data-testid="setpoint-panel"]').textContent()), 'nivel 4: valida el setpoint contra la escala');
    await page.locator('[data-testid="setpoint-input"]').fill('65');
    await page.locator('[data-testid="setpoint-save"]').click();
    await page.getByRole('button', { name: 'Cambiar setpoint' }).click();
    check(!!(await pollUntil(async () => /65[.,]0 %/.test(await text(page, '[data-testid="setpoint-current"]')), 10_000)), 'nivel 4: el setpoint pasó a 65 % (con confirmación)');
    await shot(page, 'equipment-desktop');
    await page.goto(`${BASE}/m/tanks/pmp-101/equipo`, { waitUntil: 'load' });
    await page.locator('[data-testid="motor-panel"]').waitFor({ timeout: 20_000 });
    check(/rpm|\d/.test(await text(page, '[data-testid="motor-rpm"]')) && (await count(page, '[data-testid="motor-current"]')) === 1 && (await count(page, '[data-testid="motor-hours"]')) === 1, 'nivel 4: panel de motor de la bomba (rpm, corriente, horas)');

    // ── Control de llenado ──
    await page.goto(`${BASE}/m/control`, { waitUntil: 'load' });
    await page.locator('[data-testid="control-card-tk-01"]').waitFor({ timeout: 30_000 });
    check((await count(page, '[data-testid^="control-card-"]')) === 4, 'control: 4 tanques habilitados');
    check((await text(page, '[data-testid="control-tag-tk-01"]')) === 'TNK-101', 'control: tags en las tarjetas');
    check((await count(page, '[data-testid="order-log-empty"]')) === 1, 'control: registro de órdenes vacío al empezar');

    // elegir un tanque con margen para llenar
    const candidates = [];
    for (const id of ['tk-01', 'tk-02', 'tk-03', 'tk-04']) candidates.push([id, await level(page, id)]);
    const pick = candidates.filter(([, l]) => l >= 20 && l <= 70).sort((a, b) => a[1] - b[1])[0] ?? candidates.sort((a, b) => a[1] - b[1])[0];
    const [id, l0] = pick;
    const target = Math.min(80, Math.round(l0 + 12));
    await setTarget(page, id, target);
    check((await text(page, `[data-testid="control-target-${id}"]`)) === String(target), `control: objetivo elegido ${target} % en ${id} (nivel ${l0} %)`);

    // Paso 1: la vista previa NO ejecuta
    await page.locator(`[data-testid="control-fill-${id}"]`).click();
    await page.locator('[data-testid="confirm-dialog"][data-status="ready"]').waitFor({ timeout: 15_000 });
    check(/Llenar/.test(await text(page, '[data-testid="confirm-summary"]')), `control: resumen de la orden (${(await text(page, '[data-testid="confirm-summary"]')).slice(0, 80)})`);
    const secs = Number(await page.locator('[data-testid="confirm-countdown"]').getAttribute('data-seconds'));
    check(secs > 50 && secs <= 60, `control: cuenta regresiva de 60 s (${secs} s)`);
    check((await count(page, '[data-testid="confirm-warnings"] li')) >= 1, 'control: advertencias visibles');
    check((await count(page, '[data-testid="order-row"]')) === 0, 'control: antes de confirmar no hay ninguna orden en el registro');
    await shot(page, 'confirm-desktop');
    // un segundo después la cuenta bajó
    await sleep(1500);
    check(Number(await page.locator('[data-testid="confirm-countdown"]').getAttribute('data-seconds')) < secs, 'control: la cuenta regresiva avanza');

    // Paso 2: confirmar ejecuta
    await page.locator('[data-testid="confirm-go"]').click();
    await page.locator('[data-testid="confirm-done"]').waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Listo' }).click();
    check(!!(await pollUntil(async () => (await count(page, '[data-testid="order-row"]')) === 1, 10_000)), 'control: la orden aparece en el registro');
    const seen = new Set();
    await pollUntil(async () => {
      seen.add(await firstStatus(page));
      return seen.has('running');
    }, 20_000, 150);
    check(seen.has('running'), `control: estados observados ${[...seen].join(' → ')} (llega a «En curso»)`);
    const who = await text(page, '[data-testid="order-row"]');
    check(/@campo\.demo/.test(who) && /TNK-/.test(who), 'control: el registro dice quién y qué equipo');
    // mientras corre: enclavamiento «orden en curso» y STS
    check(!!(await pollUntil(async () => (await page.locator(`[data-testid="control-fill-${id}"]`).isDisabled()), 8000)), 'control: con una orden en curso no se puede dar otra');
    check(/orden en curso/i.test(await text(page, `[data-testid="control-reasons-${id}"]`)), 'control: se explica por qué (orden en curso)');
    check(!(await page.locator(`[data-testid="control-stop-${id}"]`).isDisabled()), 'control: «Detener» sigue disponible');
    await shot(page, 'running-desktop');
    // el nivel se mueve hacia el objetivo
    const moved = await pollUntil(async () => (await level(page, id)) > l0 + 3, 20_000);
    check(!!moved, `control: el nivel de ${id} sube hacia el objetivo`);
    check(!!(await pollUntil(async () => (await firstStatus(page)) === 'done', 40_000)), 'control: la orden termina («Terminada»)');
    check(/objetivo alcanzado/i.test(await text(page, '[data-testid="order-outcome"]')), 'control: resultado «Nivel objetivo alcanzado»');

    // Detener: llenar de nuevo y detener a mitad
    const l1 = await level(page, id);
    await setTarget(page, id, Math.min(85, Math.round(l1 + 25)));
    await page.locator(`[data-testid="control-fill-${id}"]`).click();
    await page.locator('[data-testid="confirm-dialog"][data-status="ready"]').waitFor({ timeout: 15_000 });
    await page.locator('[data-testid="confirm-go"]').click();
    await page.locator('[data-testid="confirm-done"]').waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Listo' }).click();
    await pollUntil(async () => (await text(page, `[data-testid="control-active-${id}"]`)).includes('En curso'), 15_000, 150);
    await page.locator(`[data-testid="control-stop-${id}"]`).click();
    await page.locator('[data-testid="confirm-dialog"][data-status="ready"]').waitFor({ timeout: 15_000 });
    check(/Detener ahora/.test(await text(page, '[data-testid="confirm-go"]')), 'control: detener también pide confirmación');
    await page.locator('[data-testid="confirm-go"]').click();
    await page.locator('[data-testid="confirm-done"]').waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Listo' }).click();
    const cancelled = await pollUntil(async () => (await page.locator('[data-testid="order-row"][data-status="cancelled"]').count()) >= 1, 20_000);
    check(!!cancelled, 'control: detener cancela la orden en curso (queda «Cancelada»)');
    check((await count(page, '[data-testid="order-row"][data-status="done"]')) >= 2, 'control: el registro conserva las órdenes terminadas');

    // Cancelar desde el registro
    const l2 = await level(page, id);
    await setTarget(page, id, Math.min(85, Math.round(l2 + 20)));
    await page.locator(`[data-testid="control-fill-${id}"]`).click();
    await page.locator('[data-testid="confirm-dialog"][data-status="ready"]').waitFor({ timeout: 15_000 });
    await page.locator('[data-testid="confirm-go"]').click();
    await page.locator('[data-testid="confirm-done"]').waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Listo' }).click();
    await page.locator('[data-testid="order-cancel"]').first().waitFor({ timeout: 15_000 });
    await page.locator('[data-testid="order-cancel"]').first().click();
    check(!!(await pollUntil(async () => (await count(page, `[data-testid="order-row"][data-status="cancelled"]`)) >= 2, 20_000)), 'control: «Cancelar» del registro envía un stop');
    await shot(page, 'log-desktop');
    check(errors.length === 0, `escritorio: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }

  // ───────────────────────── MÓVIL ─────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${BASE}/m/control`, { waitUntil: 'load' });
    await page.locator('[data-testid="control-card-tk-01"]').waitFor({ timeout: 30_000 });
    const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(!over, 'móvil control: sin desborde horizontal');
    const small = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('[data-testid="module-screen"] button, [data-testid="module-screen"] input, [data-testid="module-screen"] summary')) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height && (r.width < 43.5 || r.height < 43.5)) out.push(`${el.tagName}[${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 20)}] ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return out;
    });
    check(small.length === 0, `móvil control: targets ≥44px${small.length ? ' → ' + small.slice(0, 5).join('; ') : ''}`);
    await page.locator('[data-testid="control-fill-tk-01"], [data-testid="control-drain-tk-01"]').first().scrollIntoViewIfNeeded();
    await shot(page, 'mobile');
    await page.goto(`${BASE}/m/tanks/tnk-101`, { waitUntil: 'load' });
    await page.locator('[data-testid="faceplate"]').waitFor({ timeout: 30_000 });
    check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'móvil nivel 3: sin desborde horizontal');
    await shot(page, 'unit-mobile');
    check(errors.length === 0, `móvil: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }

  // ───────────────────────── ROL DE CONSULTA (viewer): sólo lectura ─────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await withRole(ctx, 'viewer');
    const page = await ctx.newPage();
    await page.goto(`${BASE}/m/control`, { waitUntil: 'load' });
    await page.locator('[data-testid="control-card-tk-01"]').waitFor({ timeout: 30_000 });
    check((await count(page, '[data-testid="control-readonly-tk-01"]')) === 1, 'viewer: las tarjetas son de solo lectura');
    check((await count(page, '[data-testid^="control-fill-"], [data-testid^="control-stop-"]')) === 0, 'viewer: sin botones de llenar ni detener');
    check((await count(page, '[data-testid="order-log"]')) === 1, 'viewer: ve el registro de órdenes');
    await page.goto(`${BASE}/m/tanks/tnk-101`, { waitUntil: 'load' });
    await page.locator('[data-testid="faceplate"]').waitFor({ timeout: 30_000 });
    check((await count(page, '[data-testid="unit-equipment-link"]')) === 0, 'viewer: no ve el enlace al detalle del equipo');
    await page.goto(`${BASE}/m/tanks/tnk-101/equipo`, { waitUntil: 'load' });
    check(!!(await page.locator('[data-testid="equipment-forbidden"]').waitFor({ timeout: 20_000 }).then(() => true, () => false)), 'viewer: el nivel 4 le dice que es para operación');
    await ctx.close();
  }

  // ───────────────────────── OPERADOR: ve el nivel 4 pero no cambia el setpoint ─────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await withRole(ctx, 'operator');
    const page = await ctx.newPage();
    await page.goto(`${BASE}/m/tanks/tnk-101/equipo`, { waitUntil: 'load' });
    await page.locator('[data-testid="setpoint-panel"]').waitFor({ timeout: 30_000 });
    check((await count(page, '[data-testid="setpoint-readonly"]')) === 1 && (await count(page, '[data-testid="setpoint-input"]')) === 0, 'operador: el setpoint es de solo lectura');
    await ctx.close();
  }

  // ───────────────────────── CLIENTE SIN EL MÓDULO ─────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await withRole(ctx, 'admin', 'cliente-tanques');
    const page = await ctx.newPage();
    await page.goto(`${BASE}/m/control`, { waitUntil: 'load' });
    check(!!(await page.locator('[data-testid="module-not-contracted"]').waitFor({ timeout: 30_000 }).then(() => true, () => false)), 'cliente solo tanques: «Control de llenado» no está contratado');
    await page.goto(`${BASE}/m/tanks/tnk-101`, { waitUntil: 'load' });
    check(!!(await page.locator('[data-testid="faceplate"]').waitFor({ timeout: 30_000 }).then(() => true, () => false)), 'cliente solo tanques: sí ve el detalle de la unidad');
    await ctx.close();
  }
} catch (e) {
  console.error(e);
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}

console.log(state.failures === 0 ? '\nE2E CONTROL OK' : `\nE2E CONTROL: ${state.failures} fallo(s)`);
process.exit(state.failures === 0 ? 0 : 1);
