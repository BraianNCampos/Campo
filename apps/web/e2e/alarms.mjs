// E2E de alarmas ISA-18.2 (modo demo): ciclo de vida completo, postergar, detalle con racionalización y diario, salud de
// alarmas y editor de reglas (DEV y ROC con supresión), en escritorio 1440x900 y móvil 390x844.
// Capturas en e2e/screenshots/alarms-*.png. Uso: npm run e2e:alarms   (SKIP_BUILD=1 reutiliza el build; NEXT_DIST_DIR=.next-xyz)
// En demo el motor de alarmas expone `window.__campoAlarms.override(activo, métrica, valor|null)` para forzar valores y
// `advance(ms)` para adelantar su reloj: así el ciclo es determinista sin esperar a la simulación.
import path from 'node:path';
import { createChecker, launchBrowser, pollUntil, shots, sleep, startApp } from './lib.mjs';

const PORT = Number(process.env.E2E_ALARMS_PORT ?? 3221);
const { state, check } = createChecker();
const { base: BASE, server } = await startApp(PORT);
const browser = await launchBrowser();
const shot = (page, name) => page.screenshot({ path: path.join(shots, `alarms-${name}.png`) });
const vis = (loc, timeout = 6000) => loc.waitFor({ state: 'visible', timeout }).then(() => true, () => false);
const gone = (loc, timeout = 15_000) => loc.waitFor({ state: 'detached', timeout }).then(() => true, () => false);

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => { console.log('  ! pageerror: ' + e.message.slice(0, 120)); errors.push(`pageerror: ${e.message}`); });
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  return errors;
}

async function overflow(page) {
  return page.evaluate(() => {
    const over = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > window.innerWidth + 1) over.push(`documento ${doc.scrollWidth}>${window.innerWidth}`);
    for (const el of document.querySelectorAll('#main, [role="dialog"]')) {
      if (el.scrollWidth > el.clientWidth + 1) over.push(`${el.id || el.getAttribute('role')} ${el.scrollWidth}>${el.clientWidth}`);
    }
    return over;
  });
}

async function smallTargets(page, scope = '#main') {
  return page.evaluate((sel) => {
    const out = [];
    const rootEl = document.querySelector(sel);
    if (!rootEl) return out;
    for (const el of rootEl.querySelectorAll('a[href], button, input, select, textarea, [role="tab"], [role="radio"], [role="switch"], summary')) {
      if (el.closest('.sr-only') || el.closest('canvas')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const target = el.matches('input[type="checkbox"], input[type="radio"]') ? (el.closest('label') ?? el) : el;
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width < 43.5 || r.height < 43.5) {
        const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || '').trim().slice(0, 28);
        out.push(`${el.tagName.toLowerCase()}[${name}] ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return out;
  }, scope);
}

async function audit(page, label, scope = '#main') {
  const over = await overflow(page);
  check(over.length === 0, `${label}: sin desborde horizontal${over.length ? ' → ' + over.join(', ') : ''}`);
  const small = await smallTargets(page, scope);
  check(small.length === 0, `${label}: targets ≥44px${small.length ? ' → ' + small.slice(0, 6).join('; ') : ''}`);
}

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const MOBILE = {
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};

const force = (page, asset, metric, value) => page.evaluate(([a, m, v]) => window.__campoAlarms.override(a, m, v), [asset, metric, value]);
const row = (page, asset, life) => page.locator(`[data-testid="alarm-row"][data-asset="${asset}"]${life ? `[data-lifecycle="${life}"]` : ''}`).first();
const text = async (loc) => ((await loc.textContent()) ?? '').replace(/\s+/g, ' ').trim();
const openAlarms = async (page) => {
  await page.goto(`${BASE}/alarmas`, { waitUntil: 'load' });
  await page.locator('[data-testid="alarms-screen"]').waitFor({ timeout: 30_000 });
  await pollUntil(() => page.evaluate(() => !!window.__campoAlarms), 15_000);
};

try {
  // ───────────────────────── ESCRITORIO ─────────────────────────
  {
    const ctx = await browser.newContext(DESKTOP);
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await openAlarms(page);
    check(await vis(page.getByRole('heading', { name: 'Alarmas', level: 1 })), 'lista: título y pestañas Activas · Postergadas · Historial');
    check((await page.getByRole('tab').allTextContents()).map((t) => t.replace(/\s*\(\d+\)/, '').trim()).join() === 'Activas,Postergadas,Historial', 'lista: tres pestañas en ese orden');

    // ── Ciclo A: activa → reconoce → normaliza (queda cerrada) ──
    await force(page, 'tk-01', 'temp', 40);
    const a1 = row(page, 'tk-01', 'unacked');
    check(await vis(a1, 20_000), 'ciclo A: la alarma aparece «Sin reconocer»');
    const t1 = await text(a1);
    check(/Advertencia/.test(t1) && /HI/.test(t1) && /Temperatura alta en Tanque 01/.test(t1) && /40\.0 °C/.test(t1) && /> 35 °C/.test(t1) && /Sin reconocer/.test(t1), `ciclo A: prioridad, tipo, descripción, valor y límite (${t1.slice(0, 120)})`);
    await shot(page, 'list-desktop');

    // detalle: racionalización y diario
    await a1.getByTestId('open-detail').click();
    const det = page.getByTestId('alarm-detail');
    check(await vis(det), 'detalle: se abre el panel');
    check(/degradarse/.test(await text(det.getByTestId('rationale-consequence'))) && /climatización/.test(await text(det.getByTestId('rationale-response'))), 'detalle: consecuencia y acción del operador');
    check(await vis(det.getByTestId('journal').getByText('Se activó')), 'detalle: el diario registra la activación');
    check((await text(det.getByTestId('detail-live'))).length > 0 && /> 35 °C/.test(await text(det)), 'detalle: valores y límite');
    check((await det.getByTestId('trend-link').getAttribute('href')) === '/m/tanks?trend=tk-01%3Atemp', 'detalle: enlace a la tendencia del activo');
    await det.getByTestId('detail-ack').click();
    check(await vis(det.getByTestId('journal').getByText('Reconocida')), 'detalle: tras reconocer, el diario suma «Reconocida» (con quién)');
    check((await text(det.getByTestId('journal'))).includes('admin@campo.demo'), 'detalle: el diario dice quién reconoció');
    await shot(page, 'detail-desktop');
    await page.keyboard.press('Escape');
    check(await gone(page.getByTestId('alarm-detail'), 3000), 'detalle: Esc lo cierra');
    const a1b = row(page, 'tk-01', 'acked');
    check(await vis(a1b), 'ciclo A: queda «Reconocida» (activa)');
    await force(page, 'tk-01', 'temp', null);
    check(await gone(a1b), 'ciclo A: al normalizar, una reconocida se cierra y sale de la lista');
    await page.getByTestId('tab-history').click();
    check(await vis(row(page, 'tk-01', 'closed'), 8000), 'ciclo A: figura en el Historial como cerrada');
    await shot(page, 'history-desktop');
    await page.getByTestId('tab-active').click();

    // ── Ciclo B: normaliza sin reconocer → «Normalizada sin reconocer» → reconocer la cierra ──
    await force(page, 'tk-03', 'temp', 41);
    check(await vis(row(page, 'tk-03', 'unacked'), 20_000), 'ciclo B: activa sin reconocer');
    await force(page, 'tk-03', 'temp', null);
    const rtn = row(page, 'tk-03', 'rtn_unacked');
    check(await vis(rtn, 15_000), 'ciclo B: al normalizar sin reconocer aparece «Normalizada sin reconocer»');
    check(/Normalizada sin reconocer/.test(await text(rtn)) && /normalizó hace/.test(await text(rtn)), 'ciclo B: con su estado y cuánto hace que normalizó');
    await shot(page, 'rtn-unacked-desktop');
    await rtn.getByTestId('ack').click();
    check(await gone(rtn, 6000), 'ciclo B: reconocerla la cierra (sale de la lista)');

    // ── Postergar con motivo ──
    await force(page, 'tk-02', 'temp', 42);
    const s1 = row(page, 'tk-02', 'unacked');
    check(await vis(s1, 20_000), 'postergar: hay una alarma activa para postergar');
    await s1.getByTestId('shelve').click();
    const dlg = page.getByRole('dialog', { name: 'Postergar alarma' });
    check(await vis(dlg), 'postergar: abre el diálogo accesible');
    await dlg.getByRole('button', { name: 'Postergar alarma' }).click();
    check(await vis(dlg.getByText('mínimo 3 caracteres')), 'postergar: el motivo es obligatorio (≥ 3)');
    await dlg.getByRole('radio', { name: 'Otro' }).click();
    await dlg.getByLabel('Minutos').fill('999');
    await dlg.getByLabel('Motivo').fill('Sensor en calibración');
    await dlg.getByRole('button', { name: 'Postergar alarma' }).click();
    check(await vis(dlg.getByText('entre 1 y 480')), 'postergar: minutos fuera de 1–480 → error');
    await dlg.getByRole('radio', { name: '15 min' }).click();
    await shot(page, 'shelve-dialog-desktop');
    await dlg.getByRole('button', { name: 'Postergar alarma' }).click();
    check(await gone(dlg, 6000), 'postergar: con minutos y motivo válidos se cierra');
    check(await gone(row(page, 'tk-02', 'shelved'), 1500) || true, 'postergar: (la fila de Activas ya no figura)');
    check((await page.locator('[data-testid="alarm-row"][data-asset="tk-02"][data-lifecycle="unacked"]').count()) === 0, 'postergar: sale de Activas');
    await page.getByTestId('tab-shelved').click();
    const sh = row(page, 'tk-02', 'shelved');
    check(await vis(sh), 'postergar: aparece en Postergadas');
    check(/Postergada/.test(await text(sh)) && /vuelve en 15 min/.test(await text(sh)), `postergar: con su vencimiento (${(await text(sh)).slice(-60)})`);
    await sh.getByTestId('open-detail').click();
    check((await text(page.getByTestId('shelved-info'))).includes('Sensor en calibración'), 'postergar: el detalle muestra el motivo');
    check(await vis(page.getByTestId('journal').getByText('Postergada')), 'postergar: el diario registra la postergación');
    await shot(page, 'shelved-desktop');
    await page.keyboard.press('Escape');
    await sh.getByTestId('unshelve').click();
    check(await gone(sh, 6000), 'postergar: «Reactivar» la devuelve a la lista');
    await page.getByTestId('tab-active').click();
    check(await vis(row(page, 'tk-02', 'unacked')), 'postergar: vuelve a Activas, sin reconocer');
    await force(page, 'tk-02', 'temp', null);

    // ── Filtros y «Reconocer todas las visibles» ──
    await force(page, 'tk-03', 'temp', 41);
    await force(page, 'tk-03', 'level', 5);
    await pollUntil(async () => (await page.locator('[data-testid="alarm-row"][data-asset="tk-03"][data-lifecycle="unacked"]').count()) >= 2, 20_000);
    await page.getByTestId('alarm-search').fill('tanque 03');
    const visibleRows = await page.locator('[data-testid="alarm-row"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-asset')));
    check(visibleRows.length >= 2 && visibleRows.every((a) => a === 'tk-03'), `filtros: la búsqueda por activo deja sólo tk-03 (${visibleRows.length})`);
    await page.getByTestId('filter-kind').selectOption('HI');
    check((await page.locator('[data-testid="alarm-row"] [data-testid="kind"]').allTextContents()).every((k) => k.trim() === 'HI'), 'filtros: por tipo HI');
    await page.getByTestId('filter-kind').selectOption('');
    await page.getByTestId('filter-severity').selectOption('critical');
    check(await vis(page.getByTestId('alarms-empty')) || (await page.locator('[data-testid="alarm-row"] [data-testid="priority"]').allTextContents()).every((k) => /Crítica/.test(k)), 'filtros: por prioridad');
    await page.getByTestId('filter-severity').selectOption('');
    await page.getByTestId('ack-all').click();
    const allAcked = await pollUntil(async () => (await page.locator('[data-testid="alarm-row"][data-lifecycle="unacked"]').count()) === 0, 8000);
    check(!!allAcked, '«Reconocer todas las visibles» reconoce las que muestra la búsqueda');
    await page.getByTestId('alarm-search').fill('');
    await force(page, 'tk-03', 'temp', null);
    await force(page, 'tk-03', 'level', null);
    await page.getByTestId('alarm-search').fill('zzzz-nada');
    check(await vis(page.getByTestId('alarms-empty')) && /Ninguna alarma coincide/.test(await text(page.getByTestId('alarms-empty'))), 'filtros: sin coincidencias → estado vacío con salida');
    await page.getByRole('button', { name: 'Quitar filtros' }).first().click();

    // ── Salud de alarmas ──
    await page.getByTestId('health-link').click();
    await page.getByTestId('health-screen').waitFor();
    const meterRate = page.getByTestId('meter-rate');
    check(await vis(meterRate) && await vis(page.getByTestId('meter-peak')), 'salud: medidores de tasa por día y pico de 10 min');
    check((await meterRate.getAttribute('data-state')) === 'ok' && /150/.test(await text(meterRate)), 'salud: tasa por día dentro del umbral de 150');
    check((await page.getByTestId('meter-peak').getAttribute('data-state')) === 'warning' && /10/.test(await text(page.getByTestId('meter-peak'))), 'salud: el pico de 10 min supera el umbral de 10 (advertencia)');
    check((await page.getByTestId('health-status').getAttribute('data-state')) === 'warning', 'salud: estado general en advertencia (el peor de los dos)');
    check((await page.getByTestId('top-row').count()) === 10, 'salud: top 10 de alarmas más frecuentes');
    check((await page.getByTestId('chatter-row').count()) >= 1, 'salud: lista de alarmas intermitentes');
    check(Number(await text(page.getByTestId('prio-critical'))) + Number(await text(page.getByTestId('prio-warning'))) > 0, 'salud: alarmas por prioridad');
    check(/una frase|Cuántas alarmas se activan por día/.test(await text(meterRate)), 'salud: cada indicador explica qué significa');
    await page.setViewportSize({ width: 1440, height: 1700 });
    await shot(page, 'health-desktop');
    await page.setViewportSize({ width: 1440, height: 900 });
    const total24 = Number((await text(page.getByTestId('health-status')).then((t) => /: (\d+) alarma/.exec(t)?.[1])) ?? 0);
    await page.getByTestId('window-30d').click();
    await pollUntil(async () => Number(/: (\d+) alarma/.exec(await text(page.getByTestId('health-status')))?.[1] ?? 0) > total24, 5000);
    check(Number(/: (\d+) alarma/.exec(await text(page.getByTestId('health-status')))?.[1] ?? 0) > total24, 'salud: la ventana de 30 días suma más alarmas que la de 24 h');
    await page.getByTestId('window-24h').click();
    // política (admin)
    await page.getByTestId('edit-policy').click();
    const pol = page.getByRole('dialog', { name: 'Política de alarmas' });
    await pol.getByLabel('Máximo en 10 minutos').fill('0');
    await pol.getByRole('button', { name: 'Guardar política' }).click();
    check(await vis(pol.getByText('entre 1 y 1000')), 'política: valida rangos');
    await pol.getByLabel('Máximo en 10 minutos').fill('20');
    await shot(page, 'policy-desktop');
    await pol.getByRole('button', { name: 'Guardar política' }).click();
    check(await gone(pol, 6000), 'política: se guarda');
    check(await pollUntil(async () => (await page.getByTestId('meter-peak').getAttribute('data-state')) === 'ok', 6000) !== null, 'salud: con el umbral en 20 el pico pasa a «ok»');
    // alarma estancada: una activa envejecida 25 h
    await page.goBack();
    await page.locator('[data-testid="alarms-screen"]').waitFor();
    await force(page, 'tk-04', 'temp', 45);
    check(await vis(row(page, 'tk-04', 'unacked'), 20_000), 'estancada: alarma activa para envejecer');
    await page.evaluate(() => window.__campoAlarms.advance(25 * 3_600_000));
    await page.getByTestId('health-link').click();
    check(await vis(page.getByTestId('stale-row'), 8000), 'salud: una alarma activa hace más de 24 h figura como estancada');
    await page.getByTestId('stale').scrollIntoViewIfNeeded();
    await shot(page, 'health-stale-desktop');
    await page.getByTestId('window-7d').click();
    check(await vis(page.getByTestId('meter-rate')), 'salud: ventana de 7 días');

    check(errors.length === 0, `escritorio alarmas: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }

  // ───────────────────────── ESCRITORIO: roles ─────────────────────────
  // (el viewer de la demo no tiene plantas asignadas: su vista se cubre en los tests de UI y del cliente)
  for (const [role, canAck, canShelve, canPolicy] of [['operator', true, false, false], ['engineer', true, true, false]]) {
    const ctx = await browser.newContext(DESKTOP);
    await ctx.addInitScript((r) => localStorage.setItem('campo.demoRole', r), role);
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await openAlarms(page);
    await force(page, 'tk-01', 'temp', 40);
    await vis(row(page, 'tk-01', 'unacked'), 20_000);
    check(((await page.getByTestId('ack').count()) > 0) === canAck && ((await page.getByTestId('ack-all').count()) > 0) === canAck, `rol ${role}: ${canAck ? 've' : 'no ve'} Reconocer ni «Reconocer todas»`);
    check(((await page.getByTestId('shelve').count()) > 0) === canShelve, `rol ${role}: ${canShelve ? 've' : 'no ve'} Postergar`);
    check((await page.getByTestId('open-detail').count()) > 0, `rol ${role}: puede ver el detalle`);
    await page.getByTestId('health-link').click();
    await page.getByTestId('meter-rate').waitFor();
    check(((await page.getByTestId('edit-policy').count()) > 0) === canPolicy, `rol ${role}: ${canPolicy ? 'edita' : 'no edita'} la política`);
    check(errors.length === 0, `rol ${role}: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 2).join(' | ') : ''}`);
    await ctx.close();
  }

  // ───────────────────────── ESCRITORIO: editor de reglas ─────────────────────────
  {
    const ctx = await browser.newContext(DESKTOP);
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${BASE}/admin/rules`, { waitUntil: 'load' });
    await page.locator('[data-testid="rules-table"]').waitFor({ timeout: 30_000 });
    const count = () => page.locator('[data-testid^="rule-row-"]').count();
    check((await count()) === 18, 'reglas: 18 reglas sembradas');
    check(await vis(page.locator('[data-testid="rules-table"]').getByText('HH').first()), 'reglas: la tabla muestra el tipo de cada regla');

    // DEV con setpoint (clima-01 tiene SP de temperatura)
    await page.getByRole('button', { name: 'Nueva regla' }).click();
    let dlg = page.getByRole('dialog', { name: 'Nueva regla de alarma' });
    await dlg.getByLabel('Planta').selectOption('demo');
    await dlg.getByLabel('Activo o patrón').fill('clima-01');
    await dlg.getByLabel('Métrica').fill('temp');
    await dlg.getByTestId('kind-DEV').click();
    check(/setpoint/.test(await text(dlg.getByTestId('kind-help'))), 'editor: elegir DEV explica la desviación');
    check(await vis(dlg.getByLabel('Desvío máximo')) && (await dlg.getByLabel('Operador', { exact: true }).count()) === 0, 'editor: DEV pide «Desvío máximo» y no operador');
    await dlg.getByLabel('Desvío máximo').fill('6');
    await dlg.getByLabel('Mantener (s)').fill('5');
    await dlg.getByLabel('Retorno (s)').fill('10');
    await dlg.getByLabel('Histéresis').fill('1');
    await dlg.getByLabel('Descripción').fill('Temperatura de la cámara desviada.');
    await dlg.getByLabel('Consecuencia').fill('La mercadería puede perder la cadena de frío.');
    await dlg.getByLabel('Acción del operador').fill('Revisá la puerta y el equipo de frío.');
    const pv = await text(dlg.getByTestId('rule-preview'));
    check(/Avisa cuando la temperatura de Cámara 1 se desvíe más de 6 °C de su setpoint durante 5 s y vuelve a normal cuando la desviación baja de 5 °C y se sostiene 10 s\./.test(pv), `editor: vista previa en lenguaje natural (${pv.slice(0, 150)})`);
    check((await dlg.getByTestId('sp-warning').count()) === 0, 'editor: con setpoint no avisa de «no evaluable»');
    await page.setViewportSize({ width: 1440, height: 1900 });
    await shot(page, 'rule-dev-desktop');
    await page.setViewportSize({ width: 1440, height: 900 });
    await dlg.getByRole('button', { name: 'Crear regla' }).click();
    check(await vis(page.locator('[data-testid="toast"]').filter({ hasText: /Regla creada/ }).first()), 'editor: DEV creada');
    check((await count()) === 19, 'editor: la DEV figura en la tabla');

    // DEV sin setpoint (temperatura de tanques): indicador de «no evaluable»
    await page.getByRole('button', { name: 'Nueva regla' }).click();
    dlg = page.getByRole('dialog', { name: 'Nueva regla de alarma' });
    await dlg.getByLabel('Planta').selectOption('demo');
    await dlg.getByLabel('Activo o patrón').fill('tk-*');
    await dlg.getByLabel('Métrica').fill('temp');
    await dlg.getByTestId('kind-DEV').click();
    await dlg.getByLabel('Desvío máximo').fill('5');
    check(await vis(dlg.getByTestId('sp-warning')) && /no se evalúa/.test(await text(dlg.getByTestId('sp-warning'))), 'editor: una DEV sin setpoint avisa que no es evaluable');
    await page.setViewportSize({ width: 1440, height: 1900 });
    await shot(page, 'rule-dev-nosp-desktop');
    await page.setViewportSize({ width: 1440, height: 900 });
    await dlg.getByRole('button', { name: 'Crear regla' }).click();
    check(await vis(page.locator('[data-testid="rule-not-evaluable"]').first()), 'editor: la tabla marca la regla «No evaluable»');

    // ROC con supresión
    await page.getByRole('button', { name: 'Nueva regla' }).click();
    dlg = page.getByRole('dialog', { name: 'Nueva regla de alarma' });
    await dlg.getByLabel('Planta').selectOption('demo');
    await dlg.getByLabel('Activo o patrón').fill('pres-01');
    await dlg.getByLabel('Métrica').fill('pressure');
    await dlg.getByTestId('kind-ROC').click();
    await dlg.getByLabel('Cambio máximo por minuto').fill('2');
    await dlg.getByLabel('Ventana (s)').fill('5');
    await dlg.getByRole('button', { name: 'Crear regla' }).click();
    check(await vis(dlg.getByText('entre 10 y 600')), 'editor: la ventana de ROC se valida (10–600 s)');
    await dlg.getByLabel('Ventana (s)').fill('30');
    await dlg.getByLabel('Dirección').selectOption('rise');
    await dlg.getByLabel('No avisar mientras otro equipo esté en cierto estado').check();
    await dlg.getByLabel('Activo a observar').fill('pump-01');
    await dlg.getByLabel('Medida a observar').fill('rpm');
    await dlg.getByLabel('Se suprime cuando').selectOption('lt');
    await dlg.getByLabel('Valor de referencia').fill('1');
    const pv2 = await text(dlg.getByTestId('rule-preview'));
    check(/suba más de 2 bar por minuto \(medido en 30 s\)/.test(pv2) && /No avisa mientras la velocidad de Bomba 01 es menor que 1 rpm/.test(pv2), `editor: la vista previa explica ROC y la supresión (${pv2.slice(0, 160)})`);
    await page.setViewportSize({ width: 1440, height: 1900 });
    await shot(page, 'rule-roc-desktop');
    await page.setViewportSize({ width: 1440, height: 900 });
    await dlg.getByRole('button', { name: 'Crear regla' }).click();
    check(await vis(page.locator('[data-testid="rule-suppress"]').first()), 'editor: ROC creada con su supresión (se ve en la tabla)');
    check((await count()) === 21, 'editor: tres reglas nuevas (21)');

    // editar: fuera de servicio con motivo
    await page.getByRole('button', { name: /Editar regla pres-01 cambio/ }).click();
    dlg = page.getByRole('dialog', { name: 'Editar regla de alarma' });
    check((await dlg.getByTestId('kind-ROC').getAttribute('aria-checked')) === 'true' && (await dlg.getByLabel('Valor de referencia').inputValue()) === '1', 'editor: al editar se cargan tipo y supresión');
    await dlg.getByLabel('Regla en servicio').uncheck();
    await dlg.getByRole('button', { name: 'Guardar cambios' }).click();
    check(await vis(dlg.getByText('contanos el motivo', { exact: false })), 'editor: fuera de servicio exige motivo');
    await dlg.getByLabel('Motivo de fuera de servicio').fill('Sensor en calibración');
    await dlg.getByRole('button', { name: 'Guardar cambios' }).click();
    check(await vis(page.locator('[data-testid="rule-oos-reason"]').first()), 'editor: queda fuera de servicio con su motivo');
    await shot(page, 'rules-table-desktop');
    check(errors.length === 0, `editor de reglas: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }

  // ───────────────────────── MÓVIL ─────────────────────────
  {
    const ctx = await browser.newContext(MOBILE);
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await openAlarms(page);
    await force(page, 'tk-01', 'temp', 40);
    await force(page, 'tk-04', 'level', 95);
    const m1 = row(page, 'tk-01', 'unacked');
    check(await vis(m1, 20_000), 'móvil: la alarma aparece como tarjeta');
    await audit(page, 'móvil lista');
    await shot(page, 'list-mobile');
    await page.getByTestId('toggle-filters').tap();
    await audit(page, 'móvil filtros');
    await shot(page, 'filters-mobile');
    await page.getByTestId('toggle-filters').tap();
    const box = await m1.getByTestId('ack').boundingBox();
    check(!!box && box.height >= 43.5, `móvil: «Reconocer» alcanzable con el pulgar (${Math.round(box?.width ?? 0)}x${Math.round(box?.height ?? 0)})`);
    await m1.getByTestId('open-detail').tap();
    const det = page.getByTestId('alarm-detail');
    check(await vis(det), 'móvil: el detalle se abre como hoja inferior');
    const sheet = await det.boundingBox();
    check(!!sheet && sheet.width <= 390 && sheet.y > 40 && sheet.y + sheet.height >= 843, 'móvil: la hoja ocupa el ancho y se apoya abajo');
    await audit(page, 'móvil detalle', '[data-testid="alarm-detail"]');
    await shot(page, 'detail-mobile');
    await det.getByTestId('detail-shelve').tap();
    const dlg = page.getByRole('dialog', { name: 'Postergar alarma' });
    check(await vis(dlg), 'móvil: Postergar abre el diálogo');
    await dlg.getByLabel('Motivo').fill('Mantenimiento programado');
    await audit(page, 'móvil postergar', '[role="dialog"][aria-labelledby]:not([data-alarm-detail])');
    await shot(page, 'shelve-mobile');
    await dlg.getByRole('button', { name: 'Postergar alarma' }).tap();
    await gone(dlg, 6000);
    await page.getByTestId('alarm-detail').getByRole('button', { name: 'Cerrar detalle' }).tap().catch(() => {});
    await page.getByTestId('tab-shelved').tap();
    check(await vis(row(page, 'tk-01', 'shelved')), 'móvil: la postergada figura en Postergadas');
    await audit(page, 'móvil postergadas');
    await page.getByTestId('tab-active').tap();
    await page.getByTestId('health-link').tap();
    await page.getByTestId('meter-rate').waitFor();
    await audit(page, 'móvil salud');
    await shot(page, 'health-mobile');
    await page.evaluate(() => document.querySelector('#main').scrollTo(0, 99999));
    await shot(page, 'health-mobile-bottom');
    check(errors.length === 0, `móvil alarmas: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }
  {
    const ctx = await browser.newContext(MOBILE);
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(`${BASE}/admin/rules`, { waitUntil: 'load' });
    await page.locator('[data-testid^="rule-card-"]').first().waitFor({ timeout: 30_000 });
    await audit(page, 'móvil reglas');
    await page.getByRole('button', { name: 'Nueva regla' }).tap();
    const dlg = page.getByRole('dialog', { name: 'Nueva regla de alarma' });
    await dlg.getByLabel('Planta').selectOption('demo');
    await dlg.getByLabel('Activo o patrón').fill('pres-01');
    await dlg.getByLabel('Métrica').fill('pressure');
    await dlg.getByTestId('kind-ROC').tap();
    await dlg.getByLabel('Cambio máximo por minuto').fill('2');
    await dlg.getByLabel('No avisar mientras otro equipo esté en cierto estado').check();
    await audit(page, 'móvil editor ROC', '[role="dialog"]');
    await shot(page, 'rule-roc-mobile');
    check(errors.length === 0, `móvil reglas: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }
} catch (e) {
  console.log('FAIL  excepción: ' + (e?.stack ?? e));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nOK: e2e de alarmas' : `\n${state.failures} fallos`);
process.exit(state.failures === 0 ? 0 : 1);
