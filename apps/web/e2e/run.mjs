// E2E: `next build && next start` + Playwright (escritorio y móvil) + capturas.
// Uso: npm run e2e         (SKIP_BUILD=1 para reutilizar .next)
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'e2e', 'screenshots');
const PORT = Number(process.env.E2E_PORT ?? 3217);
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForServer(timeoutMs = 60_000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      http
        .get(BASE, (res) => {
          res.resume();
          resolve();
        })
        .on('error', () => (Date.now() - t0 > timeoutMs ? reject(new Error('server timeout')) : setTimeout(probe, 400)));
    };
    probe();
  });
}

async function pollUntil(fn, timeoutMs, everyMs = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  return null;
}

if (!process.env.SKIP_BUILD) {
  const b = spawnSync('npx', ['next', 'build'], { cwd: root, stdio: 'inherit', env: { ...process.env, NEXT_PUBLIC_MOCK: '1' } });
  if (b.status !== 0) process.exit(b.status ?? 1);
}
const server = spawn('npx', ['next', 'start', '-p', String(PORT), '-H', '127.0.0.1'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NEXT_PUBLIC_MOCK: '1' },
});
server.stderr.on('data', (d) => process.stderr.write(d));

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});

async function textOf(page, testid) {
  return (await page.locator(`[data-testid="${testid}"]`).first().textContent({ timeout: 2000 }).catch(() => null))?.trim() ?? null;
}

try {
  await waitForServer();

  // ───────── Escritorio ─────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'allow' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));

    await page.goto(BASE, { waitUntil: 'load' });
    const canvas = page.locator('canvas').first();
    await canvas.waitFor({ state: 'visible', timeout: 30_000 });
    const box = await canvas.boundingBox();
    check(!!box && box.width > 400 && box.height > 300, `escritorio: canvas 3D presente (${Math.round(box?.width ?? 0)}x${Math.round(box?.height ?? 0)})`);

    await page.locator('[data-testid="row-value-tk-01"]').waitFor({ timeout: 10_000 });
    const v1 = await textOf(page, 'row-value-tk-01');
    const changed = await pollUntil(async () => (await textOf(page, 'row-value-tk-01')) !== v1, 8000);
    check(!!changed, `escritorio: el valor de tk-01 cambia con el tiempo (${v1} → ${await textOf(page, 'row-value-tk-01')})`);

    const p1 = await textOf(page, 'row-value-pump-01');
    check(p1 !== null && p1 !== '—', `escritorio: pump-01 muestra rpm (${p1})`);

    const alarm = await pollUntil(async () => (await page.locator('[data-testid="alarm-item"]').count()) > 0, 25_000);
    check(!!alarm, 'escritorio: aparecen alarmas simuladas (level>90 / <10)');
    const badge = await textOf(page, 'alarm-count');
    check(!!badge && Number(badge) > 0, `escritorio: contador de alarmas = ${badge}`);

    // selección por clic en 3D: busca un punto del canvas que seleccione un equipo distinto
    await page.locator('[data-testid="asset-row-pump-02"]').click();
    const titleBefore = await page.locator('[data-testid="asset-panel"] h2').first().textContent();
    let picked = null;
    if (box) {
      outer: for (let gy = 0.25; gy <= 0.85; gy += 0.08) {
        for (let gx = 0.1; gx <= 0.9; gx += 0.05) {
          await page.mouse.click(box.x + box.width * gx, box.y + box.height * gy);
          await sleep(60);
          const t = (await page.locator('[data-testid="asset-panel"] h2').first().textContent().catch(() => null)) ?? null;
          if (t && t !== titleBefore) {
            picked = t.trim();
            break outer;
          }
        }
      }
    }
    check(!!picked, `escritorio: clic en 3D selecciona un equipo y abre su panel (${picked})`);
    await sleep(400);

    // dejar correr la simulación y capturar
    await page.locator('[data-testid="asset-row-tk-04"]').click();
    await sleep(6000);
    await page.screenshot({ path: path.join(shots, 'desktop-1440x900.png') });

    // manifest + SW + offline
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    const manifest = await (await ctx.request.get(BASE + manifestHref)).json();
    check(manifest.display === 'standalone' && manifest.icons?.length >= 3, `PWA: manifest válido (${manifest.name})`);
    const swReady = await page.evaluate(async () => {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 8000))]);
      return !!reg?.active;
    });
    check(swReady, 'PWA: service worker activo');
    await sleep(1500);
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'load' }).catch(() => {});
    const offlineOk = await pollUntil(async () => (await page.locator('h1', { hasText: 'Campo' }).count()) > 0, 10_000);
    check(!!offlineOk, 'PWA: con red cortada la app carga desde el shell cacheado');
    const chip = await pollUntil(async () => ((await textOf(page, 'connection-chip')) ?? '').includes('Sin conexión'), 5000);
    check(!!chip, 'PWA: indicador "Sin conexión" visible');
    await page.screenshot({ path: path.join(shots, 'desktop-offline.png') });
    await ctx.setOffline(false);

    check(errors.length === 0, `escritorio: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }

  // ───────── Móvil 390x844 ─────────
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));

    await page.goto(BASE, { waitUntil: 'load' });
    await page.locator('[data-testid^="asset-card-"]').first().waitFor({ timeout: 15_000 });
    const cards = await page.locator('[data-testid^="asset-card-"]').count();
    check(cards === 8, `móvil: ${cards} tarjetas de activo`);
    check((await page.locator('canvas').count()) === 0, 'móvil: NO hay <canvas> (3D no montado por defecto)');

    const m1 = await textOf(page, 'value-tk-01');
    const mChanged = await pollUntil(async () => (await textOf(page, 'value-tk-01')) !== m1, 8000);
    check(!!mChanged, `móvil: el valor de tk-01 cambia (${m1} → ${await textOf(page, 'value-tk-01')})`);

    const tabs = await page.locator('nav[aria-label="Navegación principal"] button').all();
    let tabsOk = tabs.length === 3;
    for (const t of tabs) {
      const b = await t.boundingBox();
      if (!b || b.height < 44 || b.width < 44) tabsOk = false;
    }
    check(tabsOk, 'móvil: navegación inferior con 3 pestañas y touch targets ≥44px');

    await sleep(9000);
    await page.screenshot({ path: path.join(shots, 'mobile-summary-390x844.png') });
    await page.screenshot({ path: path.join(shots, 'mobile-summary-full.png'), fullPage: false });

    await page.locator('[data-testid="tab-alarms"]').tap();
    const hasAlarm = await pollUntil(async () => (await page.locator('[data-testid="alarm-item"]').count()) > 0, 20_000);
    check(!!hasAlarm, 'móvil: lista de alarmas con elementos');
    await sleep(300);
    await page.screenshot({ path: path.join(shots, 'mobile-alarms-390x844.png') });
    const ack = page.getByRole('button', { name: 'Reconocer' }).first();
    const ab = await ack.boundingBox();
    check(!!ab && ab.height >= 44, `móvil: botón Reconocer ≥44px (${Math.round(ab?.height ?? 0)}px)`);
    await ack.tap();
    const acked = await pollUntil(async () => (await page.getByRole('button', { name: 'Reconocida' }).count()) > 0, 3000);
    check(!!acked, 'móvil: ack local marca la alarma como reconocida');
    await page.screenshot({ path: path.join(shots, 'mobile-alarms-acked.png') });

    await page.locator('[data-testid="tab-3d"]').tap();
    await sleep(300);
    check((await page.locator('canvas').count()) === 0, 'móvil: pestaña 3D sin canvas hasta pulsar "Ver 3D"');
    await page.screenshot({ path: path.join(shots, 'mobile-3d-optin.png') });
    await page.getByRole('button', { name: 'Ver 3D' }).tap();
    const c3d = await pollUntil(async () => (await page.locator('canvas').count()) > 0, 20_000);
    check(!!c3d, 'móvil: "Ver 3D" carga el canvas con import dinámico');
    await sleep(3000);
    await page.screenshot({ path: path.join(shots, 'mobile-3d.png') });
    check(errors.length === 0, `móvil: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }

  // ───────── Login (vista previa) ─────────
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login?preview=1`, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Entrar' }).waitFor();
    await page.screenshot({ path: path.join(shots, 'login-390x844.png') });
    await page.goto(`${BASE}/login`, { waitUntil: 'load' });
    const redirected = await pollUntil(async () => new URL(page.url()).pathname === '/', 5000);
    check(!!redirected, 'login: en modo demo /login redirige a /');
    await ctx.close();
  }
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}

console.log(failures === 0 ? '\nE2E OK' : `\nE2E: ${failures} fallo(s)`);
process.exit(failures === 0 ? 0 : 1);
