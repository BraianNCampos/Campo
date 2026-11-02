// E2E de la vista general de la planta (nivel 1), la barra de desviación y la tendencia a un clic (modo demo).
// Escritorio 1440x900 y móvil 390x844; capturas en e2e/screenshots/plant-*.png.
// Uso: npm run e2e:plant   (SKIP_BUILD=1 reutiliza el build; NEXT_DIST_DIR=.next-plant para construir aparte)
import path from 'node:path';
import { createChecker, launchBrowser, pollUntil, shots, sleep, startApp } from './lib.mjs';

const PORT = Number(process.env.E2E_PLANT_PORT ?? 3230);
const { state, check } = createChecker();
const { base: BASE, server } = await startApp(PORT);
const browser = await launchBrowser();
const shot = (page, name) => page.screenshot({ path: path.join(shots, `plant-${name}.png`), timeout: 120_000 });
const count = (page, sel) => page.locator(sel).count();

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  return errors;
}

async function audit(page, label) {
  const over = await page.evaluate(() => {
    const out = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > window.innerWidth + 1) out.push(`documento ${doc.scrollWidth}>${window.innerWidth}`);
    const main = document.querySelector('#main');
    if (main && main.scrollWidth > main.clientWidth + 1) out.push(`main ${main.scrollWidth}>${main.clientWidth}`);
    return out;
  });
  check(over.length === 0, `${label}: sin desborde horizontal${over.length ? ' → ' + over.join(', ') : ''}`);
  const small = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [role="tab"], summary')) {
      if (el.closest('.sr-only') || el.closest('canvas')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width < 43.5 || r.height < 43.5) out.push(`${el.tagName.toLowerCase()}[${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 28)}] ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
  check(small.length === 0, `${label}: targets ≥44px${small.length ? ' → ' + small.slice(0, 6).join('; ') : ''}`);
}

const mobileCtx = () =>
  browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });

try {
  // ───────────────────────── ESCRITORIO ─────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = watchErrors(page);

    await page.goto(BASE, { waitUntil: 'load' });
    await page.locator('[data-testid="plant-overview"]').waitFor({ timeout: 30_000 });
    check((await page.locator('[data-testid="plant-overview"]').getAttribute('data-mode')) === 'scene', 'escritorio: «/» muestra la vista general con la escena 3D (el cliente tiene view3d)');
    await page.locator('[data-testid="scene"] canvas').first().waitFor({ state: 'visible', timeout: 30_000 });
    check((await count(page, '[data-testid="plant-overview"] .glass')) >= 2, 'escritorio: paneles de vidrio sobre la escena');
    const blur = await page.locator('[data-testid="plant-overview"] .glass').first().evaluate((el) => getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter);
    check(/blur/.test(blur), `escritorio: el vidrio usa backdrop-filter (${blur})`);
    check((await count(page, '[data-testid^="overview-module-"]')) === 6, 'escritorio: una tarjeta por módulo con activos (6)');
    check((await count(page, '[data-testid="alarm-health"] li')) === 4, 'escritorio: tira de salud de alarmas con 4 indicadores');
    const lat = await pollUntil(async () => /\d/.test((await page.locator('[data-testid="overview-latency"]').textContent()) ?? ''), 10_000);
    check(!!lat, `escritorio: muestra estado de conexión y latencia (${await page.locator('[data-testid="overview-connection"]').textContent()})`);
    const text = await page.locator('[data-testid="plant-overview"]').evaluate((el) => [...el.querySelectorAll('section, ul')].map((n) => n.textContent).join(' '));
    check(!/°C|\bbar\b|\brpm\b|\bkW\b|m³|\d+(,\d)? ?%/.test(text), 'escritorio: sin valores de instrumentos en la vista general');
    await sleep(4000);
    await shot(page, 'overview-desktop');
    await audit(page, 'escritorio vista general');

    // alarma agregada: algún módulo pasa a «Cerca del límite» o «Alarma» y los números aparecen en la tira
    const attn = await pollUntil(async () => (await count(page, '[data-testid^="overview-module-"][data-attention]:not([data-attention="0"])')) > 0, 60_000);
    check(!!attn, 'escritorio: un módulo informa activos que requieren atención');
    const unacked = await pollUntil(async () => Number(await page.locator('[data-testid="health-unacked"]').getAttribute('data-count')) > 0, 60_000);
    check(!!unacked, 'escritorio: la tira cuenta alarmas sin reconocer');
    await shot(page, 'overview-desktop-alarms');

    await page.locator('[data-testid="overview-module-tanks"]').click();
    await page.waitForURL(`${BASE}/m/tanks`);
    check(true, 'escritorio: clic en la tarjeta del módulo lleva al nivel 2');

    // ── barra de desviación ──
    // recarga completa: el stream demo vuelve a arrancar con tk-04 y tk-02 cerca de sus límites (la ventana ámbar es corta)
    await page.goto(`${BASE}/m/tanks`, { waitUntil: 'load' });
    const nearEarly = await pollUntil(async () => (await count(page, '[data-testid="deviation-bar"][data-state="near"]')) > 0, 30_000, 100);
    await page.locator('[data-testid="asset-card-tk-01"]').waitFor({ timeout: 20_000 });
    check((await count(page, '[data-testid="asset-card-tk-01"] [data-testid="deviation-bar"]')) === 1, 'tanques: la tarjeta con SP usa la barra de desviación');
    const aria = await page.locator('[data-testid="asset-card-tk-01"] [data-testid="deviation-bar"] [role="meter"]').getAttribute('aria-valuetext');
    check(/por (encima|debajo) del SP|en el SP/.test(aria ?? ''), `tanques: texto accesible «${aria}»`);
    const near = nearEarly;
    check(!!near, 'tanques: la barra pasa a ámbar al llegar al 90 % de la distancia SP→límite');
    if (near) {
      const fill = await page.locator('[data-testid="deviation-bar"][data-state="near"] [data-testid="deviation-fill"]').first().evaluate((el) => getComputedStyle(el).backgroundColor);
      check(fill === 'rgb(229, 176, 0)', `tanques: relleno ámbar (${fill})`);
    }
    const red = await pollUntil(async () => (await count(page, '[data-testid="deviation-bar"][data-state="alarm"]')) > 0, 60_000);
    check(!!red, 'tanques: con alarma activa la barra se pone roja');
    if (red) {
      const fill = await page.locator('[data-testid="deviation-bar"][data-state="alarm"] [data-testid="deviation-fill"]').first().evaluate((el) => getComputedStyle(el).backgroundColor);
      check(fill === 'rgb(245, 106, 80)', `tanques: relleno rojo (${fill})`);
      check((await count(page, '[data-testid^="alarm-notice-"]')) > 0, 'tanques: la tarjeta en alarma muestra el aviso con icono y texto');
    }
    await shot(page, 'tanks-deviation-desktop');

    // pie por ciclo de vida
    const footer = await page.locator('[data-testid="alarm-footer"]').textContent();
    check((await count(page, '[data-testid="footer-unacked"]')) === 1 && (await count(page, '[data-testid="footer-rtn"]')) === 1 && (await count(page, '[data-testid="footer-shelved"]')) === 1, 'pie: cuenta sin reconocer, normalizadas sin reconocer y postergadas');
    check(/límite/.test(footer ?? ''), `pie: alarmas con descripción, valor y límite (${(footer ?? '').replace(/\s+/g, ' ').slice(0, 120)})`);

    // ── tendencia a un clic ──
    await page.locator('[data-testid="asset-card-tk-01"]').click({ position: { x: 150, y: 150 } });
    await page.locator('[data-testid="trend-panel"]').waitFor({ timeout: 10_000 });
    check((await page.locator('[data-testid="trend-panel"]').getAttribute('role')) === 'dialog', 'tendencia: se abre al hacer clic en cualquier parte de la tarjeta');
    const box = await page.locator('[data-testid="trend-panel"]').boundingBox();
    check(!!box && box.x > 800 && box.height > 600, `tendencia: panel lateral en escritorio (x=${Math.round(box?.x ?? 0)}, alto ${Math.round(box?.height ?? 0)})`);
    const legend = (await page.locator('[data-testid="trend-lines"] li').allTextContents()).join(' | ');
    check(/SP 60/.test(legend) && /HH 90/.test(legend) && /LO 10/.test(legend), `tendencia: líneas de SP y límites (${legend})`);
    check((await page.locator('canvas[data-testid="chart-tk-01-level"]').getAttribute('data-lines')) === '3', 'tendencia: la curva dibuja 3 líneas de referencia');
    check((await count(page, '[data-testid^="trend-window-"]')) === 4, 'tendencia: ventanas 15 min / 1 h / 6 h / 24 h');
    await sleep(3000);
    await shot(page, 'trend-desktop');
    await page.locator('[data-testid="trend-window-15m"]').click();
    check((await page.locator('[data-testid="trend-window-15m"]').getAttribute('aria-pressed')) === 'true', 'tendencia: cambia de ventana');
    await page.locator('[data-testid="trend-metric-temp"]').click();
    check((await page.locator('[data-testid="trend-panel"]').getAttribute('data-metric')) === 'temp', 'tendencia: selector de métrica secundaria (temperatura)');
    // foco atrapado
    for (let i = 0; i < 14; i++) await page.keyboard.press('Tab');
    check(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="trend-panel"]')), 'tendencia: el foco queda atrapado dentro del panel');
    await page.keyboard.press('Escape');
    check((await count(page, '[data-testid="trend-panel"]')) === 0, 'tendencia: Esc la cierra');
    check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'trend-open-tk-01'), 'tendencia: el foco vuelve a la tarjeta');
    await audit(page, 'escritorio tanques');

    // 3D: aviso de alarma sobre el equipo
    await page.goto(`${BASE}/m/view3d`, { waitUntil: 'load' });
    await page.locator('[data-testid="scene"] canvas').first().waitFor({ state: 'visible', timeout: 30_000 });
    const labelAlarm = await pollUntil(async () => (await count(page, '.scene-label[data-alarm]')) > 0, 60_000);
    check(!!labelAlarm, 'vista 3D: un equipo con alarma muestra el aviso («Alarma») en su etiqueta');
    await sleep(2500);
    await shot(page, 'view3d-alarm-desktop');

    check(errors.length === 0, `escritorio: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }

  // ───────────────────────── ESCRITORIO: cliente de un solo módulo ─────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(BASE, { waitUntil: 'load' });
    await page.locator('[data-testid="plant-overview"]').waitFor({ timeout: 30_000 });
    await page.locator('[data-testid="sidebar"] [data-testid="view-as"]').selectOption('cliente-tanques');
    const ok = await pollUntil(async () => new URL(page.url()).pathname === '/m/tanks' && (await count(page, '[data-testid^="asset-card-"]')) > 0, 30_000);
    check(!!ok, 'un solo módulo: «/» va directo a su pantalla (/m/tanks)');
    await page.goto(BASE, { waitUntil: 'load' });
    const direct = await pollUntil(async () => new URL(page.url()).pathname === '/m/tanks', 20_000);
    check(!!direct && (await count(page, '[data-testid="plant-overview"]')) === 0, 'un solo módulo: recargar «/» no muestra la vista general');
    check(errors.length === 0, `un solo módulo: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }

  // ───────────────────────── MÓVIL ─────────────────────────
  {
    const ctx = await mobileCtx();
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(BASE, { waitUntil: 'load' });
    await page.locator('[data-testid="plant-overview"]').waitFor({ timeout: 30_000 });
    check((await page.locator('[data-testid="plant-overview"]').getAttribute('data-mode')) === 'map', 'móvil: vista general con tarjetas (sin 3D por defecto)');
    check((await count(page, 'canvas')) === 0, 'móvil: sin canvas 3D por defecto');
    check((await count(page, '[data-testid^="overview-module-"]')) === 6, 'móvil: una tarjeta por módulo');
    await sleep(4000);
    await shot(page, 'overview-mobile');
    await audit(page, 'móvil vista general');
    await page.locator('[data-testid="overview-3d-open"]').scrollIntoViewIfNeeded();
    await page.locator('[data-testid="overview-3d-open"]').tap();
    await page.locator('[data-testid="overview-3d"] canvas').first().waitFor({ state: 'visible', timeout: 30_000 });
    check(true, 'móvil: el 3D se abre sólo a pedido');
    await sleep(2000);
    await shot(page, 'overview-mobile-3d');

    await page.goto(`${BASE}/m/tanks`, { waitUntil: 'load' });
    await page.locator('[data-testid="asset-card-tk-01"]').waitFor({ timeout: 30_000 });
    await sleep(2500);
    await page.locator('[data-testid="asset-card-tk-01"]').tap({ position: { x: 120, y: 120 } });
    await page.locator('[data-testid="trend-panel"]').waitFor({ timeout: 10_000 });
    const b = await page.locator('[data-testid="trend-panel"]').boundingBox();
    check(!!b && b.width >= 388 && b.y > 120 && Math.abs(b.y + b.height - 844) < 2, `móvil: la tendencia es una hoja inferior (${Math.round(b?.width ?? 0)}x${Math.round(b?.height ?? 0)} en y=${Math.round(b?.y ?? 0)})`);
    await sleep(2500);
    await shot(page, 'trend-mobile');
    await audit(page, 'móvil tendencia');
    await page.locator('[data-testid="trend-close"]').tap();
    check((await count(page, '[data-testid="trend-panel"]')) === 0, 'móvil: la hoja se cierra con el botón');
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

console.log(state.failures === 0 ? '\nE2E PLANT OK' : `\nE2E PLANT: ${state.failures} fallo(s)`);
process.exit(state.failures === 0 ? 0 : 1);
