// E2E de clientes y módulos (modo demo): recorre cada módulo del cliente con todos los módulos en escritorio
// 1440x900 y móvil 390x844, cambia a «Cliente solo tanques» y a plataforma con «Ver como», y prueba el modo pared.
// Capturas en e2e/screenshots/modules-*.png. Uso: npm run e2e:modules   (SKIP_BUILD=1 reutiliza el build)
import path from 'node:path';
import { createChecker, launchBrowser, pollUntil, shots, sleep, startApp } from './lib.mjs';

const PORT = Number(process.env.E2E_MODULES_PORT ?? 3220);
const { state, check } = createChecker();
const { base: BASE, server } = await startApp(PORT);
const browser = await launchBrowser();
const shot = (page, name) => page.screenshot({ path: path.join(shots, `modules-${name}.png`), timeout: 120_000 }); // WebGL por software: con la máquina cargada tarda
const MODULES = ['tanks', 'climate', 'energy', 'gas', 'machines', 'flow', 'view3d'];
const LABEL = { tanks: 'Tanques y llenado', climate: 'Temperatura y humedad', energy: 'Energía', gas: 'Consumo de gases', machines: 'Estado de máquinas', flow: 'Presión y caudal', view3d: 'Vista 3D' };

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
    const main = document.querySelector('#main');
    if (main && main.scrollWidth > main.clientWidth + 1) over.push(`main ${main.scrollWidth}>${main.clientWidth}`);
    return over;
  });
}

async function smallTargets(page, scope = 'body') {
  return page.evaluate((sel) => {
    const out = [];
    const rootEl = document.querySelector(sel);
    if (!rootEl) return out;
    for (const el of rootEl.querySelectorAll('a[href], button, input, select, textarea, [role="tab"], summary')) {
      if (el.closest('.sr-only') || el.closest('canvas')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width < 43.5 || r.height < 43.5) {
        const name = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 28);
        out.push(`${el.tagName.toLowerCase()}[${name}] ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return out;
  }, scope);
}

async function audit(page, label) {
  const over = await overflow(page);
  check(over.length === 0, `${label}: sin desborde horizontal${over.length ? ' → ' + over.join(', ') : ''}`);
  const small = await smallTargets(page);
  check(small.length === 0, `${label}: targets ≥44px${small.length ? ' → ' + small.slice(0, 6).join('; ') : ''}`);
}

const count = (page, sel) => page.locator(sel).count();
const openModule = async (page, id) => {
  await page.goto(`${BASE}/m/${id}`, { waitUntil: 'load' });
  await page.locator(`[data-testid="module-screen"][data-module="${id}"]`).waitFor({ timeout: 30_000 });
};
const mobileCtx = () =>
  browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });

try {
  // ───────────────────────── ESCRITORIO: cliente con todos los módulos ─────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = watchErrors(page);

    await page.goto(BASE, { waitUntil: 'load' });
    const landed = await pollUntil(async () => new URL(page.url()).pathname === '/m/tanks', 20_000);
    check(!!landed, `escritorio: «/» redirige al primer módulo activo (${new URL(page.url()).pathname})`);
    await page.locator('[data-testid="sidebar"]').waitFor({ timeout: 20_000 });
    check((await count(page, '[data-testid="sidebar"] [data-testid^="module-nav-"]')) === 7, 'escritorio: la barra lateral tiene 7 módulos');
    const sidebarLabels = await page.locator('[data-testid="sidebar"] [data-testid^="module-nav-"]').allTextContents();
    check(MODULES.every((m) => sidebarLabels.some((t) => t.includes(LABEL[m]))), 'escritorio: cada módulo con su nombre');
    check((await count(page, '[data-testid="sidebar"] a[href="/alarmas"]')) === 1 && (await count(page, '[data-testid="sidebar"] a[href="/pared"]')) === 1, 'escritorio: Alarmas y Modo pared en la barra lateral');
    check((await count(page, '[data-testid="view-as"]')) >= 1, 'escritorio: selector «Ver como» en modo demo');

    for (const id of MODULES) {
      await page.locator(`[data-testid="sidebar"] [data-testid="module-nav-${id}"]`).click();
      await page.locator(`[data-testid="module-screen"][data-module="${id}"]`).waitFor({ timeout: 30_000 });
      if (id === 'view3d') {
        await page.locator('[data-testid="scene"] canvas').first().waitFor({ state: 'visible', timeout: 30_000 });
        await page.locator('[data-testid="asset-row-tk-01"]').waitFor({ timeout: 15_000 });
        check((await count(page, '[data-testid^="asset-row-"]')) === 20, 'escritorio view3d: lista con los 20 activos de la planta');
      } else {
        await page.locator('[data-testid^="asset-card-"]').first().waitFor({ timeout: 20_000 });
        await page.locator('[data-testid^="kpi-"]').first().waitFor({ timeout: 10_000 });
        check((await count(page, '[data-testid="kpi-strip"] > div')) >= 4, `escritorio ${id}: franja de resumen con ≥4 números`);
        check((await count(page, '[role="tab"]')) === 3, `escritorio ${id}: pestañas En vivo · Alarmas · Reglas`);
      }
      await sleep(id === 'view3d' ? 2500 : 4500);
      await shot(page, `${id}-desktop`);
      await audit(page, `escritorio ${id}`);
    }

    // Tanques en detalle
    await openModule(page, 'tanks');
    await page.locator('[data-testid^="asset-card-"]').first().waitFor();
    check((await count(page, '[data-testid^="asset-card-"]')) === 8, 'tanques: 8 tarjetas (4 tanques, 2 bombas, 2 válvulas)');
    const kt = await page.locator('[data-testid="kpi-strip"]').textContent();
    check(/Capacidad total/.test(kt) && /240/.test(kt) && /Nivel más bajo/.test(kt), `tanques: capacidad total 240 m³ y nivel más bajo (${kt.replace(/\s+/g, ' ').slice(0, 110)})`);
    const v1 = await page.locator('[data-testid="value-tk-01"]').textContent();
    const changed = await pollUntil(async () => (await page.locator('[data-testid="value-tk-01"]').textContent()) !== v1, 8000);
    check(!!changed, 'tanques: el valor de tk-01 cambia en vivo');
    check((await count(page, '[data-testid="asset-card-tk-01"] [role="meter"]')) === 1 && (await count(page, '[data-testid="asset-card-tk-01"] [data-testid="limit-mark"]')) >= 2, 'tanques: barra con la escala y marcas en los límites');
    const attention = await pollUntil(async () => (await count(page, '[data-testid^="asset-card-"][data-status="alarm"], [data-testid^="asset-card-"][data-status="near"]')) > 0, 60_000);
    check(!!attention, 'tanques: aparece algún activo «Cerca del límite» o en «Alarma»');
    await page.locator('[data-testid="filter-attention"]').click();
    const nAtt = await count(page, '[data-testid^="asset-card-"]');
    const lbl = await page.locator('[data-testid="filter-attention"]').textContent();
    check(nAtt >= 1 && nAtt < 8 && lbl.includes(`(${nAtt})`), `tanques: filtro «Requieren atención» muestra ${nAtt} (${lbl.trim()})`);
    await shot(page, 'tanks-attention-desktop');
    await page.locator('[data-testid="filter-all"]').click();
    const badge = await page.locator('[data-testid="module-badge-tanks"]').textContent({ timeout: 5000 }).catch(() => null);
    check(badge !== null && Number(badge) >= 1, `tanques: insignia de atención en la barra lateral (${badge})`);
    check((await page.locator('[data-testid="status-tk-01"], [data-testid^="status-"]').first().textContent())?.match(/En rango|Cerca del límite|Alarma/) !== null, 'tanques: estado con texto (En rango / Cerca del límite / Alarma)');

    await page.locator('[data-testid="module-tab-alarms"]').click();
    const alarmsShown = await pollUntil(async () => (await count(page, '[data-testid="alarm-item"]')) > 0, 60_000);
    check(!!alarmsShown, 'tanques: pestaña Alarmas lista alarmas del módulo');
    await shot(page, 'tanks-alarms-desktop');
    await page.locator('[data-testid="module-tab-rules"]').click();
    const href = await page.locator('[data-testid="rules-link"]').getAttribute('href');
    check(href === '/admin/rules?plant=demo&module=tanks', `tanques: pestaña Reglas enlaza a ${href}`);
    await shot(page, 'tanks-rules-desktop');

    // Plantilla maestra: el pie global de alarmas está en todas las pantallas
    for (const id of ['climate', 'view3d']) {
      await page.locator(`[data-testid="sidebar"] [data-testid="module-nav-${id}"]`).click();
      await page.locator(`[data-testid="module-screen"][data-module="${id}"]`).waitFor();
      check((await count(page, '[data-testid="alarm-footer"]')) === 1 && (await count(page, 'header')) >= 1, `plantilla: ${id} hereda cabecera, navegación y pie de alarmas`);
    }
    const foot = await pollUntil(async () => (await count(page, '[data-testid="footer-alarm"]')) > 0, 60_000);
    const ft = await page.locator('[data-testid="alarm-footer"]').textContent();
    check(!!foot && /Críticas/.test(ft) && /Advertencias/.test(ft) && /límite/.test(ft), `plantilla: el pie muestra conteo por prioridad y alarmas con valor y límite (${ft.replace(/\s+/g, ' ').slice(0, 110)})`);
    check((await page.locator('[data-testid="footer-all"]').getAttribute('href')) === '/alarmas', 'plantilla: el pie enlaza a la lista completa');
    await openModule(page, 'tanks');
    await shot(page, 'master-layout-desktop');

    // Alto contraste para luz solar
    await page.locator('[data-testid="theme-toggle"]').click();
    check((await page.locator('html').getAttribute('data-theme')) === 'contrast', 'alto contraste: se activa desde el menú de usuario');
    await page.locator('[data-testid^="asset-card-"]').first().waitFor();
    await sleep(2500);
    await shot(page, 'tanks-contrast-desktop');
    const bgc = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check(bgc === 'rgb(255, 255, 255)', `alto contraste: fondo claro (${bgc})`);
    await page.reload({ waitUntil: 'load' });
    await page.locator('[data-testid="module-screen"]').waitFor();
    check((await page.locator('html').getAttribute('data-theme')) === 'contrast', 'alto contraste: se recuerda tras recargar');
    await audit(page, 'escritorio tanques (alto contraste)');
    await page.locator('[data-testid="theme-toggle"]').click();
    check((await page.locator('html').getAttribute('data-theme')) === null, 'alto contraste: se puede volver al tema oscuro');

    // Alarmas globales
    await page.locator('[data-testid="nav-alarms"]').click();
    await page.locator('h1', { hasText: 'Alarmas' }).waitFor();
    check(!!(await pollUntil(async () => (await count(page, '[data-testid="alarm-item"]')) > 0, 30_000)), 'alarmas globales: lista de alarmas de la planta');

    // Modo pared
    await page.locator('[data-testid="nav-wall"]').click();
    await page.locator('[data-testid="wall"]').waitFor({ timeout: 20_000 });
    check((await count(page, '[data-testid="sidebar"]')) === 0, 'pared: sin menús');
    await page.locator('[data-testid="wall-interval-10"]').click();
    const m0 = await page.locator('[data-testid="wall"]').getAttribute('data-module');
    await page.locator('[data-testid^="wall-card-"]').first().waitFor({ timeout: 15_000 });
    await sleep(2500);
    await shot(page, 'wall-landscape');
    const rotated = await pollUntil(async () => (await page.locator('[data-testid="wall"]').getAttribute('data-module')) !== m0, 16_000, 300);
    check(!!rotated, `pared: rota entre módulos (${m0} → ${await page.locator('[data-testid="wall"]').getAttribute('data-module')})`);
    await page.locator('[data-testid="wall-pause"]').click();
    const m1 = await page.locator('[data-testid="wall"]').getAttribute('data-module');
    await sleep(11_500);
    check((await page.locator('[data-testid="wall"]').getAttribute('data-module')) === m1 && (await page.locator('[data-testid="wall"]').getAttribute('data-paused')) === 'true', 'pared: en pausa no rota');
    check((await count(page, '[data-testid="wall-clock"]')) === 1 && (await count(page, '[data-testid="wall-connection"]')) === 1, 'pared: reloj y estado de conexión');
    await page.keyboard.press('Escape');
    const left = await pollUntil(async () => !new URL(page.url()).pathname.startsWith('/pared'), 8000);
    check(!!left, 'pared: Esc sale del modo pared');

    check(errors.length === 0, `escritorio: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }

  // ───────────────────────── PARED vertical (TV girada) y toque largo ─────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 1400 } });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${BASE}/pared`, { waitUntil: 'load' });
    await page.locator('[data-testid^="wall-card-"]').first().waitFor({ timeout: 30_000 });
    await sleep(2500);
    await shot(page, 'wall-portrait');
    const over = await overflow(page);
    const clipped = await page.evaluate(() => {
      const w = document.querySelector('[data-testid="wall"]');
      return w ? w.scrollHeight > w.clientHeight + 1 : true;
    });
    check(over.length === 0 && !clipped, `pared vertical: sin desborde ni recortes${over.length ? ' → ' + over.join(', ') : ''}`);
    check(errors.length === 0, `pared vertical: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    // toque corto = pausa; toque largo = salir
    const box = await page.locator('[data-testid^="wall-card-"]').first().boundingBox();
    await page.mouse.click(box.x + 20, box.y + 20);
    check((await page.locator('[data-testid="wall"]').getAttribute('data-paused')) === 'true', 'pared: un toque pausa');
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await sleep(1000);
    await page.mouse.up();
    check(!!(await pollUntil(async () => !new URL(page.url()).pathname.startsWith('/pared'), 6000)), 'pared: toque largo sale');
    await ctx.close();
  }

  // ───────────────────────── ESCRITORIO: «Ver como» cliente solo tanques y plataforma ─────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(BASE, { waitUntil: 'load' });
    await page.locator('[data-testid="sidebar"]').waitFor({ timeout: 20_000 });

    await page.locator('[data-testid="sidebar"] [data-testid="view-as"]').selectOption('cliente-tanques');
    const tk = await pollUntil(async () => new URL(page.url()).pathname === '/m/tanks' && (await count(page, '[data-testid^="asset-card-"]')) > 0, 30_000);
    check(!!tk, 'solo tanques: «Ver como» recarga y deja en /m/tanks');
    check((await count(page, '[data-testid="sidebar"]')) === 0, 'solo tanques: sin barra lateral de secciones');
    check((await count(page, '[data-testid^="module-nav-"]')) === 0, 'solo tanques: no existe ningún otro módulo en la navegación');
    check((await count(page, '[data-testid^="asset-card-"]')) === 2, 'solo tanques: 2 tarjetas (tk-a, tk-b)');
    check((await count(page, '[data-testid="plant-select"]:visible')) === 0, 'solo tanques: con una sola planta no hay selector');
    check((await count(page, '[role="tab"]')) === 3, 'solo tanques: la pantalla conserva sus pestañas');
    await sleep(3000);
    await shot(page, 'tanks-only-desktop');
    await audit(page, 'solo tanques (escritorio)');
    for (const id of ['climate', 'energy', 'view3d']) {
      await page.goto(`${BASE}/m/${id}`, { waitUntil: 'load' });
      const nc = await page.locator('[data-testid="module-not-contracted"]').waitFor({ timeout: 20_000 }).then(() => true, () => false);
      check(nc && (await count(page, '[data-testid="module-screen"]')) === 0, `solo tanques: /m/${id} → «Este módulo no está contratado»`);
    }
    await shot(page, 'not-contracted-desktop');
    await page.goto(`${BASE}/pared`, { waitUntil: 'load' });
    await page.locator('[data-testid="wall-module"]').waitFor({ timeout: 20_000 });
    check((await count(page, '[data-testid^="wall-dot-"]')) === 0, 'solo tanques: el modo pared no rota (un solo módulo)');
    await page.goto(`${BASE}/m/tanks`, { waitUntil: 'load' });

    await page.locator('[data-testid="view-as"]').first().selectOption('platform');
    const pf = await pollUntil(async () => (await count(page, '[data-testid="plant-select"]:visible')) > 0, 30_000);
    check(!!pf, 'plataforma: aparece el selector de planta con las dos plantas');
    const groups = await page.locator('[data-testid="plant-select"]:visible optgroup').evaluateAll((g) => g.map((x) => x.label));
    check(groups.length === 2 && groups.includes('Agroindustria Ejemplo') && groups.includes('Cliente Solo Tanques'), `plataforma: plantas agrupadas por cliente (${groups.join(' | ')})`);
    await page.locator('[data-testid="plant-select"]:visible').selectOption('demo');
    const all = await pollUntil(async () => (await count(page, '[data-testid="sidebar"] [data-testid^="module-nav-"]')) === 7, 20_000);
    check(!!all, 'plataforma: en la planta del cliente completo ve los 7 módulos');
    await shot(page, 'platform-desktop');
    await page.locator('[data-testid="plant-select"]:visible').selectOption('tanques');
    const one = await pollUntil(async () => (await count(page, '[data-testid="sidebar"]')) === 0, 20_000);
    check(!!one, 'plataforma: en la planta del cliente solo tanques ve solo ese módulo');
    check(errors.length === 0, `Ver como: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }

  // ───────────────────────── MÓVIL ─────────────────────────
  {
    const ctx = await mobileCtx();
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(BASE, { waitUntil: 'load' });
    await page.locator('[data-testid="bottom-bar"]').waitFor({ timeout: 30_000 });
    const dests = await page.locator('[data-testid="bottom-bar"] > a, [data-testid="bottom-bar"] > button').count();
    check(dests <= 4 && dests >= 2, `móvil: barra inferior con ${dests} destinos (máx. 4)`);
    check((await count(page, 'canvas')) === 0, 'móvil: sin canvas 3D por defecto');
    for (const id of MODULES) {
      const direct = page.locator(`[data-testid="bottom-bar"] [data-testid="module-nav-${id}"]`);
      if ((await direct.count()) === 0) {
        await page.locator('[data-testid="nav-more"]').tap();
        await page.locator(`[data-testid="more-sheet"] [data-testid="module-nav-${id}"]`).tap();
      } else await direct.tap();
      await page.locator(`[data-testid="module-screen"][data-module="${id}"]`).waitFor({ timeout: 30_000 });
      if (id === 'view3d') {
        check((await count(page, 'canvas')) === 0, 'móvil view3d: el canvas no se monta hasta pedirlo');
        await page.locator('[data-testid="tab-3d"]').tap();
        await page.getByRole('button', { name: 'Ver 3D' }).tap();
        check(!!(await pollUntil(async () => (await count(page, 'canvas')) > 0, 25_000)), 'móvil view3d: «Ver 3D» carga el canvas');
      } else await page.locator('[data-testid^="asset-card-"]').first().waitFor({ timeout: 20_000 });
      await sleep(id === 'view3d' ? 3000 : 3500);
      await shot(page, `${id}-mobile`);
      await audit(page, `móvil ${id}`);
    }
    check((await count(page, '[data-testid="alarm-footer"]')) === 1, 'móvil: pie global de alarmas fijo');
    await page.locator('[data-testid="nav-more"]').tap();
    await shot(page, 'more-sheet-mobile');
    await page.keyboard.press('Escape').catch(() => {});
    // KPI y filtros en móvil
    await page.goto(`${BASE}/m/tanks`, { waitUntil: 'load' });
    await page.locator('[data-testid="filter-attention"]').waitFor({ timeout: 20_000 });
    await page.locator('[data-testid="filter-attention"]').tap();
    await sleep(500);
    await shot(page, 'tanks-attention-mobile');
    await page.locator('[data-testid="module-tab-alarms"]').tap();
    await sleep(500);
    await shot(page, 'tanks-alarms-mobile');
    // modo pared en móvil (vertical)
    await page.goto(`${BASE}/m/tanks`, { waitUntil: 'load' });
    await page.locator('[data-testid="user-menu-button"]').tap();
    await page.locator('#user-menu [data-testid="theme-toggle"]').tap();
    await page.locator('[data-testid^="asset-card-"]').first().waitFor();
    await sleep(2500);
    await shot(page, 'tanks-contrast-mobile');
    await audit(page, 'móvil tanques (alto contraste)');
    await page.locator('#user-menu [data-testid="theme-toggle"]').tap(); // el menú sigue abierto: se vuelve al tema oscuro
    await page.goto(`${BASE}/pared`, { waitUntil: 'load' });
    await page.locator('[data-testid^="wall-card-"]').first().waitFor({ timeout: 20_000 });
    check((await count(page, '[data-testid="alarm-footer"]')) === 0 && (await count(page, '[data-testid="master-layout"]')) === 0 && (await count(page, '[data-testid="wall"] > header')) === 1, 'móvil pared: la plantilla se oculta a propósito (sólo la cabecera propia del modo pared)');
    await sleep(1500);
    await shot(page, 'wall-mobile');
    const ow = await overflow(page);
    check(ow.length === 0, `móvil pared: sin desborde${ow.length ? ' → ' + ow.join(', ') : ''}`);
    check(errors.length === 0, `móvil: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }

  // ───────────────────────── MÓVIL: cliente solo tanques ─────────────────────────
  {
    const ctx = await mobileCtx();
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(BASE, { waitUntil: 'load' });
    await page.locator('[data-testid="bottom-bar"]').waitFor({ timeout: 30_000 });
    await page.locator('[data-testid="user-menu-button"]').tap();
    await shot(page, 'user-menu-mobile');
    await page.locator('#user-menu [data-testid="view-as"]').selectOption('cliente-tanques');
    const ok = await pollUntil(async () => new URL(page.url()).pathname === '/m/tanks' && (await count(page, '[data-testid^="asset-card-"]')) > 0, 30_000);
    check(!!ok, 'móvil solo tanques: «Ver como» deja en /m/tanks');
    check((await count(page, '[data-testid="bottom-bar"]')) === 0, 'móvil solo tanques: sin barra inferior (un solo módulo)');
    await sleep(3000);
    await shot(page, 'tanks-only-mobile');
    await audit(page, 'móvil solo tanques');
    await page.goto(`${BASE}/m/energy`, { waitUntil: 'load' });
    check(await page.locator('[data-testid="module-not-contracted"]').waitFor({ timeout: 20_000 }).then(() => true, () => false), 'móvil solo tanques: otro módulo → no contratado');
    check(errors.length === 0, `móvil solo tanques: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }
} catch (e) {
  console.error(e);
  state.failures++;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}

console.log(state.failures === 0 ? '\nE2E MODULES OK' : `\nE2E MODULES: ${state.failures} fallo(s)`);
process.exit(state.failures === 0 ? 0 : 1);
