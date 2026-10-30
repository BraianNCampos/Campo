// E2E de clientes y módulos (modo demo, API en memoria). Dos recorridos, en escritorio 1440x900 y móvil 390x844:
//  1) personal de plataforma: crea un cliente con sólo Energía, su administrador, una planta y activos, edita módulos,
//     ve el 409 al borrar (tiene plantas y usuarios), lo desactiva y borra un cliente vacío;
//  2) administrador de `cliente-tanques`: no ve Clientes, no puede crear un activo de un módulo no contratado y sólo ve lo suyo.
// Comprueba desbordes, targets ≥44px y errores de consola; deja capturas en e2e/screenshots/orgs-*.png.
// Uso: npm run e2e:orgs   (SKIP_BUILD=1 para reutilizar .next)
import path from 'node:path';
import { createChecker, launchBrowser, shots, startApp } from './lib.mjs';

const PORT = Number(process.env.E2E_ORGS_PORT ?? 3221);
const { state, check } = createChecker();
const { base: BASE, server } = await startApp(PORT);
const browser = await launchBrowser();
const shot = (page, name) => page.screenshot({ path: path.join(shots, `orgs-${name}.png`) });

const MOBILE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};
const DESKTOP = { viewport: { width: 1440, height: 900 } };

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // las respuestas 4xx esperadas del mock no pasan por la red (es en memoria): cualquier error de consola cuenta
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
    for (const el of rootEl.querySelectorAll('a[href], button, input, select, textarea, [role="switch"], summary')) {
      if (el.closest('.sr-only')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const target = el.matches('input[type="checkbox"], input[type="radio"]') ? (el.closest('label') ?? el) : el;
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width < 43.5 || r.height < 43.5) out.push(`${el.tagName.toLowerCase()}[${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 28)}] ${Math.round(r.width)}x${Math.round(r.height)}`);
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

const vis = (loc, timeout = 5000) => loc.waitFor({ state: 'visible', timeout }).then(() => true, () => false);
const toast = (page, re) => page.locator('[data-testid="toast"]').filter({ hasText: re }).first().waitFor({ timeout: 6000 }).then(() => true, () => false);
/** Navegación interna (el estado del modo demo vive en memoria: un `goto` lo reinicia). */
const go = (page, href) => page.locator(`a[href="${href}"]:visible`).first().click();
const text = async (loc) => ((await loc.textContent()) ?? '').replace(/\s+/g, ' ').trim();

async function newContext(opts, org) {
  const ctx = await browser.newContext(opts);
  // identidad demo: sin cliente = personal de plataforma; si no, administrador del cliente elegido
  await ctx.addInitScript((o) => {
    localStorage.setItem('campo.demoOrg', o);
    localStorage.removeItem('campo.demoRole');
  }, org);
  const page = await ctx.newPage();
  return { ctx, page, errors: watchErrors(page) };
}

/** Elige el tipo por código aunque la opción esté desactivada (como lo haría una pestaña vieja o una llamada directa). */
const forceType = (dlg, value) =>
  dlg.getByLabel('Tipo').evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);

async function openNewOrg(page) {
  await page.getByRole('button', { name: 'Nuevo cliente' }).click();
  const dlg = page.getByRole('dialog', { name: 'Nuevo cliente' });
  await dlg.waitFor();
  return dlg;
}

try {
  // ═══════════════ PLATAFORMA · ESCRITORIO ═══════════════
  {
    const { ctx, page, errors } = await newContext(DESKTOP, 'platform');
    await page.goto(`${BASE}/admin/orgs`, { waitUntil: 'load' });
    await page.locator('[data-testid="orgs-table"]').waitFor({ timeout: 30_000 });
    check(await vis(page.getByRole('heading', { name: 'Clientes', level: 2 })), 'plataforma: la sección Clientes existe');
    check((await page.locator('aside a[href="/admin/orgs"]').count()) === 1, 'plataforma: "Clientes" en la navegación');
    const hrefs = await page.locator('aside a[href^="/admin"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    check(JSON.stringify(hrefs) === JSON.stringify(['/admin/orgs', '/admin/users', '/admin/plants', '/admin/rules', '/admin/audit', '/admin/account']), `plataforma: navegación ${hrefs.join(', ')}`);
    check((await text(page.locator('[data-testid="shell-role"]'))) === 'Campos Ingeniería', 'plataforma: la barra lateral muestra el rol');
    check((await page.locator('[data-testid^="org-row-"]').count()) === 2, 'clientes: los 2 clientes demo en la lista');
    const demoRow = await text(page.locator('[data-testid="org-row-campos-demo"]'));
    check(/Agroindustria Ejemplo/.test(demoRow) && /campos-demo/.test(demoRow) && /Tanques y llenado/.test(demoRow) && /Activo/.test(demoRow), `clientes: nombre, id, módulos y estado (${demoRow.slice(0, 90)}…)`);
    const tanksRow = await text(page.locator('[data-testid="org-row-cliente-tanques"]'));
    check(/Tanques y llenado/.test(tanksRow) && !/Energía/.test(tanksRow), 'clientes: cliente-tanques sólo con Tanques y llenado');
    await audit(page, 'clientes (escritorio)');
    await shot(page, 'list-desktop');

    // ── alta con validación ──
    let dlg = await openNewOrg(page);
    check((await dlg.getByRole('switch').count()) === 7, 'alta: un interruptor por módulo (7)');
    check(await vis(dlg.getByText('Potencia, consumo y factor de potencia por línea.')), 'alta: cada módulo muestra su descripción');
    await dlg.getByRole('button', { name: 'Crear cliente' }).click();
    check(await vis(dlg.getByText('El nombre es obligatorio')) && (await vis(dlg.getByText('Elegí al menos un módulo'))), 'alta: sin datos → errores junto a cada control');
    await dlg.getByLabel('Nombre').fill('Frigorífico del Sur');
    await dlg.getByLabel('Id del cliente').fill('Frigo Sur');
    await dlg.getByRole('switch', { name: 'Energía', exact: true }).click();
    await dlg.getByRole('button', { name: 'Crear cliente' }).click();
    check(await vis(dlg.getByText('Usá minúsculas')), 'alta: id con mayúsculas/espacios → error de validación');
    check((await dlg.getByRole('switch', { name: 'Energía', exact: true }).getAttribute('aria-checked')) === 'true', 'alta: el interruptor de Energía queda activado');
    await dlg.getByLabel('Id del cliente').fill('campos-demo');
    await dlg.getByRole('button', { name: 'Crear cliente' }).click();
    check(await vis(dlg.getByRole('alert').filter({ hasText: 'Ya existe un cliente' })), 'alta: id repetido → 409 dentro del diálogo');
    await dlg.getByLabel('Id del cliente').fill('frigo-sur');
    await shot(page, 'org-create-desktop');
    await dlg.getByRole('button', { name: 'Crear cliente' }).click();
    check(await toast(page, /Cliente Frigorífico del Sur creado/), 'alta: aviso de éxito');
    const frigoRow = await text(page.locator('[data-testid="org-row-frigo-sur"]'));
    check(/Energía/.test(frigoRow) && !/Tanques/.test(frigoRow) && /Activo/.test(frigoRow), `alta: aparece con sólo el módulo Energía (${frigoRow})`);

    // ── detalle y primer administrador ──
    await page.getByRole('link', { name: 'Abrir Frigorífico del Sur' }).click();
    await page.locator('[data-testid="org-detail"]').waitFor();
    const mods = await text(page.locator('[data-testid="org-modules"]'));
    check(/Energía/.test(mods) && !/Tanques/.test(mods), 'detalle: lista sólo los módulos activos');
    check(await vis(page.getByText('Creá el administrador del cliente')), 'detalle: sin usuarios → estado vacío con indicación');
    await audit(page, 'detalle de cliente (escritorio)');
    await shot(page, 'detail-desktop');
    await page.getByRole('button', { name: 'Crear administrador del cliente' }).click();
    dlg = page.getByRole('dialog', { name: 'Crear administrador del cliente' });
    await dlg.waitFor();
    await dlg.getByLabel('Correo').fill('jefe@frigosur.com');
    await dlg.getByLabel('Contraseña inicial').fill('corta1');
    check(await vis(dlg.getByText(/de 12 caracteres mínimos/)), 'administrador: indicador de fortaleza (faltan caracteres)');
    await dlg.getByRole('button', { name: 'Crear administrador' }).click();
    check(await vis(dlg.getByText(/Mínimo 12 caracteres/)), 'administrador: contraseña < 12 → error junto al campo');
    await dlg.getByLabel('Contraseña inicial').fill('Clave-muy-segura-2026');
    check(await vis(dlg.getByText(/Muy buena/)), 'administrador: el indicador pasa a «Muy buena»');
    await shot(page, 'org-admin-desktop');
    await dlg.getByRole('button', { name: 'Crear administrador' }).click();
    check(await toast(page, /jefe@frigosur\.com creado/), 'administrador: creado');
    check(await vis(page.locator('[data-testid="org-user-jefe@frigosur.com"]')), 'detalle: el administrador aparece en los usuarios del cliente');

    // ── planta y activos del cliente (enlaces filtrados por cliente) ──
    await page.getByRole('link', { name: 'Ver en Plantas y activos' }).click();
    await page.waitForURL('**/admin/plants?org=frigo-sur');
    await page.getByRole('button', { name: 'Nueva planta' }).waitFor();
    await page.waitForFunction(() => document.querySelector('[role="search"] select')?.value === 'frigo-sur', null, { timeout: 8000 }).catch(() => {});
    check((await page.getByRole('search').getByLabel('Cliente').inputValue()) === 'frigo-sur', 'plantas: el enlace llega filtrado por el cliente');
    await page.getByRole('button', { name: 'Nueva planta' }).click();
    dlg = page.getByRole('dialog', { name: 'Nueva planta' });
    check((await dlg.getByLabel('Cliente').inputValue()) === 'frigo-sur', 'plantas: el selector de cliente viene con el filtro elegido');
    await dlg.getByLabel('Cliente').selectOption('');
    await dlg.getByLabel('Id').fill('frio-1');
    await dlg.getByLabel('Nombre').fill('Planta Frío');
    await dlg.getByRole('button', { name: 'Crear planta' }).click();
    check(await vis(dlg.getByText('Elegí el cliente dueño de la planta')), 'plantas: el personal de plataforma debe elegir cliente');
    await dlg.getByLabel('Cliente').selectOption('frigo-sur');
    await dlg.getByRole('button', { name: 'Crear planta' }).click();
    await page.locator('[data-testid="plant-row-frio-1"]').waitFor();
    check((await page.locator('[data-testid^="plant-row-"]').count()) === 1, 'plantas: con el filtro sólo se ve la del cliente');
    await page.getByRole('link', { name: 'Activos de Planta Frío' }).click();
    await page.getByRole('heading', { name: 'Activos de Planta Frío' }).waitFor();

    dlg = await (async () => {
      await page.getByRole('button', { name: 'Nuevo activo' }).click();
      const d = page.getByRole('dialog', { name: 'Nuevo activo' });
      await d.waitFor();
      return d;
    })();
    await page.waitForFunction(() => document.querySelector('[role="dialog"] option[value="climate"][disabled]'), null, { timeout: 8000 }).catch(() => {});
    const tipo = dlg.getByLabel('Tipo');
    check(await dlg.locator('option[value="energy"]').isEnabled(), 'activos: Medidor de energía disponible (módulo Energía)');
    check(await dlg.locator('option[value="climate"]').isDisabled(), 'activos: el tipo del módulo Temperatura y humedad no está disponible');
    check(/Sensor de temperatura y humedad \(no contratado\)/.test(await text(dlg.locator('option[value="climate"]'))), 'activos: nombre del tipo + «no contratado»');
    check(await vis(dlg.getByText(/contactá a Campos Ingeniería/)), 'activos: indicación de cómo sumar el módulo');
    await dlg.getByLabel('Id', { exact: true }).fill('en-1');
    await dlg.getByLabel('Nombre').fill('Línea de frío');
    await tipo.selectOption('energy');
    check(await vis(dlg.getByLabel('Potencia contratada (kW)')) && (await dlg.getByLabel('Capacidad (m³)').count()) === 0, 'activos: energía muestra la potencia contratada (y no la capacidad)');
    const meta = dlg.getByLabel('Metadatos (JSON)');
    await meta.fill('{"notas": "a mano", "scale": {"pf": {"min": 0.5, "max": 1}}}');
    await dlg.getByLabel('Potencia contratada (kW)').fill('150');
    const kwScale = dlg.getByRole('group', { name: /Potencia \(kW\)/ });
    await kwScale.getByLabel('Mínimo').fill('0');
    await kwScale.getByLabel('Máximo').fill('180');
    let json = JSON.parse(await meta.inputValue());
    check(json.contractedKw === 150 && json.scale?.kw?.max === 180, `activos: los campos se reflejan en el JSON (${JSON.stringify(json)})`);
    check(json.notas === 'a mano' && json.scale?.pf?.min === 0.5, 'activos: no se pisan las claves ni las escalas escritas a mano');
    await meta.fill(JSON.stringify({ ...json, contractedKw: 160 }));
    check((await dlg.getByLabel('Potencia contratada (kW)').inputValue()) === '160', 'activos: editar el JSON actualiza el campo');
    await kwScale.getByLabel('Mínimo').fill('300');
    check(await vis(dlg.getByText(/el mínimo tiene que ser menor que el máximo/)), 'activos: escala con mínimo ≥ máximo → error junto al campo');
    await dlg.getByRole('button', { name: 'Crear activo' }).click();
    check(await dlg.isVisible(), 'activos: con la escala inválida no se guarda');
    await kwScale.getByLabel('Mínimo').fill('0');
    await dlg.getByLabel('Potencia contratada (kW)').fill('-5');
    check(await vis(dlg.getByText(/mayor que 0/)), 'activos: potencia ≤ 0 → error');
    await dlg.getByLabel('Potencia contratada (kW)').fill('160');
    await shot(page, 'asset-energy-desktop');
    await dlg.getByRole('button', { name: 'Crear activo' }).click();
    await page.locator('[data-testid="asset-row-en-1"]').waitFor();
    check(/Medidor de energía/.test(await text(page.locator('[data-testid="asset-row-en-1"]'))), 'activos: la tabla muestra el nombre del tipo (Medidor de energía)');

    // módulo no contratado: forzado por código → mensaje claro junto al selector
    await page.getByRole('button', { name: 'Nuevo activo' }).click();
    dlg = page.getByRole('dialog', { name: 'Nuevo activo' });
    await dlg.getByLabel('Id', { exact: true }).fill('cl-1');
    await dlg.getByLabel('Nombre').fill('Cámara 1');
    await forceType(dlg, 'climate');
    await dlg.getByRole('button', { name: 'Crear activo' }).click();
    check(await vis(dlg.getByText('Este módulo no está contratado, pedíselo a Campos Ingeniería')), 'activos: tipo de un módulo no contratado → mensaje claro');
    check((await dlg.getByLabel('Tipo').getAttribute('aria-invalid')) === 'true', 'activos: el selector de tipo queda marcado como inválido');
    await dlg.getByLabel('Tipo').scrollIntoViewIfNeeded();
    await shot(page, 'asset-module-error-desktop');
    await page.keyboard.press('Escape');

    // ── editar módulos ──
    await go(page, '/admin/orgs');
    await page.locator('[data-testid="org-row-frigo-sur"]').waitFor();
    await page.getByRole('button', { name: 'Editar Frigorífico del Sur' }).click();
    dlg = page.getByRole('dialog', { name: 'Editar cliente' });
    await dlg.waitFor();
    check(await dlg.getByLabel('Id del cliente').isDisabled(), 'edición: el id no se puede cambiar');
    await dlg.getByRole('switch', { name: 'Energía', exact: true }).click();
    await dlg.getByRole('switch', { name: 'Temperatura y humedad', exact: true }).click();
    check(await vis(dlg.getByText('Sacar un módulo no borra datos')), 'edición: aviso al sacar un módulo (no borra datos)');
    await dlg.getByRole('switch', { name: 'Energía', exact: true }).click();
    await dlg.getByRole('button', { name: 'Guardar cambios' }).click();
    check(await toast(page, /actualizado/), 'edición: módulos guardados');
    const frigo2 = await text(page.locator('[data-testid="org-row-frigo-sur"]'));
    check(/Energía/.test(frigo2) && /Temperatura y humedad/.test(frigo2), `edición: ahora con Energía y Temperatura y humedad (${frigo2})`);

    // con el módulo nuevo ya se puede crear un activo de clima
    await page.getByRole('link', { name: 'Abrir Frigorífico del Sur' }).click();
    await page.locator('[data-testid="org-plants"]').getByRole('link', { name: 'Activos de Planta Frío' }).click();
    await page.getByRole('button', { name: 'Nuevo activo' }).click();
    dlg = page.getByRole('dialog', { name: 'Nuevo activo' });
    await dlg.getByLabel('Id', { exact: true }).fill('cl-1');
    await dlg.getByLabel('Nombre').fill('Cámara 1');
    await dlg.getByLabel('Tipo').selectOption('climate');
    await dlg.getByRole('button', { name: 'Crear activo' }).click();
    await page.locator('[data-testid="asset-row-cl-1"]').waitFor();
    check(true, 'activos: tras activar el módulo se crea el sensor de temperatura y humedad');

    // ── borrado: 409 con lo que bloquea ──
    await go(page, '/admin/orgs');
    await page.getByRole('link', { name: 'Abrir Frigorífico del Sur' }).click();
    await page.locator('[data-testid="org-detail"]').waitFor();
    await page.getByRole('button', { name: 'Eliminar' }).first().click();
    let del = page.getByRole('alertdialog');
    const delBtn = del.getByRole('button', { name: 'Eliminar cliente' });
    check(await delBtn.isDisabled(), 'borrado: exige escribir el id (botón deshabilitado)');
    await del.getByLabel(/Escribí "frigo-sur"/).fill('frigo-sur');
    await delBtn.click();
    const conflict = del.getByRole('alert');
    check(await vis(conflict), 'borrado: con plantas y usuarios → 409 dentro del diálogo');
    const ctext = await text(conflict);
    check(/1 planta y 1 usuario/.test(ctext), `borrado: dice qué lo bloquea (${ctext.slice(0, 110)})`);
    await shot(page, 'org-delete-409-desktop');
    await del.getByRole('button', { name: 'Cancelar' }).click();

    // ── desactivar ──
    await page.getByRole('button', { name: 'Editar' }).first().click();
    dlg = page.getByRole('dialog', { name: 'Editar cliente' });
    await dlg.getByRole('switch', { name: 'Cliente activo' }).click();
    await dlg.getByRole('button', { name: 'Guardar cambios' }).click();
    const off = page.getByRole('alertdialog');
    await off.waitFor();
    check(/dejarán de poder iniciar sesión/.test(await text(off)), 'desactivar: la confirmación explica que corta el acceso de todos sus usuarios');
    await shot(page, 'org-deactivate-desktop');
    await off.getByRole('button', { name: 'Sí, desactivar cliente' }).click();
    check(await vis(page.getByText('Este cliente está inactivo')), 'desactivar: el detalle avisa que está inactivo');
    check(/Inactivo/.test(await text(page.locator('[data-testid="org-detail"]'))), 'desactivar: estado Inactivo');

    // ── cliente vacío: se borra ──
    await go(page, '/admin/orgs');
    dlg = await openNewOrg(page);
    await dlg.getByLabel('Nombre').fill('Temporal');
    await dlg.getByLabel('Id del cliente').fill('temporal');
    await dlg.getByRole('switch', { name: 'Tanques y llenado', exact: true }).click();
    await dlg.getByRole('button', { name: 'Crear cliente' }).click();
    await page.locator('[data-testid="org-row-temporal"]').waitFor();
    await page.getByRole('link', { name: 'Abrir Temporal' }).click();
    await page.locator('[data-testid="org-detail"]').waitFor();
    await page.getByRole('button', { name: 'Eliminar' }).first().click();
    del = page.getByRole('alertdialog');
    await del.getByLabel(/Escribí "temporal"/).fill('temporal');
    await del.getByRole('button', { name: 'Eliminar cliente' }).click();
    await page.waitForURL('**/admin/orgs');
    await page.locator('[data-testid="orgs-table"]').waitFor();
    check((await page.locator('[data-testid="org-row-temporal"]').count()) === 0, 'borrado: un cliente sin plantas ni usuarios se elimina');
    check(await toast(page, /Cliente Temporal eliminado/), 'borrado: aviso de éxito');

    // ── usuarios, plantas y auditoría desde la plataforma ──
    await go(page, '/admin/users');
    await page.locator('[data-testid="users-table"]').waitFor();
    check(/Cliente/.test(await text(page.locator('[data-testid="users-table"] thead'))), 'usuarios: la plataforma ve la columna Cliente');
    check((await page.locator('[data-testid^="user-row-"]').count()) === 10, 'usuarios: todos los clientes (10)');
    await page.getByRole('search').getByLabel('Cliente').selectOption('cliente-tanques');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="user-row-"]').length === 4);
    check(true, 'usuarios: el filtro por cliente deja los 4 de cliente-tanques');
    await page.getByRole('search').getByLabel('Cliente').selectOption('');
    await page.getByRole('button', { name: 'Nuevo usuario' }).click();
    dlg = page.getByRole('dialog', { name: 'Nuevo usuario' });
    await dlg.getByLabel('Correo').fill('nuevo@ejemplo.com');
    await dlg.getByLabel('Contraseña inicial').fill('clave-segura-123');
    check((await dlg.getByLabel('Rol').locator('option').allTextContents()).includes('Campos Ingeniería'), 'usuarios: la plataforma puede ofrecer el rol Campos Ingeniería');
    await dlg.getByRole('button', { name: 'Crear usuario' }).click();
    check(await vis(dlg.getByText('Elegí el cliente al que pertenece')), 'usuarios: hay que elegir cliente');
    await dlg.getByLabel('Cliente').selectOption('cliente-tanques');
    check(await vis(dlg.getByRole('checkbox', { name: /tanques/ })) && (await dlg.getByRole('checkbox', { name: /^Planta demo/ }).count()) === 0, 'usuarios: sólo se ofrecen las plantas del cliente elegido');
    await dlg.getByLabel('Rol').selectOption('platform_admin');
    check((await dlg.getByLabel('Cliente').count()) === 0, 'usuarios: platform_admin no lleva cliente');
    await dlg.getByRole('button', { name: 'Cancelar' }).click();

    await go(page, '/admin/audit');
    await page.locator('[data-testid="audit-table"]').waitFor();
    const auditText = await text(page.locator('[data-testid="audit-table"]'));
    check(/Cliente creado/.test(auditText) && /Frigorífico del Sur/.test(auditText), 'auditoría: la plataforma ve el cliente de cada acción');
    await page.getByRole('search').getByLabel('Cliente').selectOption('cliente-tanques');
    await page.getByRole('button', { name: 'Filtrar' }).click();
    await page.waitForFunction(() => {
      const cells = [...document.querySelectorAll('[data-testid="audit-org"]')];
      return cells.length > 0 && cells.every((c) => c.textContent.includes('Cliente Solo Tanques'));
    });
    check(true, 'auditoría: el filtro por cliente deja sólo sus acciones');
    await audit(page, 'auditoría con cliente (escritorio)');
    await shot(page, 'audit-desktop');

    await go(page, '/admin/account');
    await page.getByRole('heading', { name: 'Mi cuenta', level: 2 }).waitFor();
    check((await text(page.locator('[data-testid="account-org"]'))) === 'Campos Ingeniería', 'cuenta (plataforma): sin cliente propio');
    check((await page.locator('[data-testid="account-contact"]').count()) === 0, 'cuenta (plataforma): no pide sumar módulos');

    check(errors.length === 0, `plataforma escritorio: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }

  // ═══════════════ PLATAFORMA · ÚNICA PÁGINA CON PARÁMETROS DE LA URL ═══════════════
  {
    const { ctx, page, errors } = await newContext(DESKTOP, 'platform');
    await page.goto(`${BASE}/admin/rules?plant=demo&module=tanks`, { waitUntil: 'load' });
    await page.locator('[data-testid="rules-table"]').waitFor({ timeout: 30_000 });
    check((await page.getByRole('search').getByLabel('Planta').inputValue()) === 'demo', 'reglas: ?plant=demo preselecciona la planta');
    check(await vis(page.locator('[data-testid="module-filter"]').getByText('Tanques y llenado')), 'reglas: ?module=tanks muestra el filtro del módulo');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="rule-row-"]').length === 3);
    const conds = await page.locator('[data-testid^="rule-row-"]').evaluateAll((els) => els.map((e) => e.textContent));
    check(conds.every((c) => /tk-\*/.test(c)), 'reglas: sólo las reglas de activos del módulo (tk-*)');
    await shot(page, 'rules-module-desktop');
    await page.getByRole('button', { name: 'Nueva regla' }).click();
    const dlg = page.getByRole('dialog', { name: 'Nueva regla de alarma' });
    check((await dlg.getByLabel('Planta').inputValue()) === 'demo', 'reglas: la regla nueva arranca en la planta del enlace');
    await dlg.getByLabel('Activo o patrón').fill('tk-*');
    const sugg = dlg.locator('[data-testid="metric-suggestions"]');
    await sugg.waitFor();
    check((await text(sugg)) === 'Nivel (%)Temperatura (°C)', `reglas: métricas del tipo tanque (${await text(sugg)})`);
    await dlg.getByLabel('Activo o patrón').fill('pres-01');
    await dlg.getByLabel('Activo o patrón').fill('en-*');
    check((await dlg.locator('[data-testid="metric-suggestions"]').count()) === 0, 'reglas: con el filtro del módulo no se sugieren métricas de otros módulos');
    await dlg.getByLabel('Activo o patrón').fill('tk-*');
    await dlg.locator('[data-testid="metric-suggestions"]').getByRole('button', { name: 'Temperatura (°C)' }).click();
    check((await dlg.getByLabel('Métrica', { exact: true }).inputValue()) === 'temp' && (await vis(dlg.getByText('En °C. Rango habitual: -10 a 50.'))), 'reglas: elegir una métrica la completa y muestra su unidad');
    await shot(page, 'rule-metrics-desktop');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Quitar filtro' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="rule-row-"]').length === 15);
    check(true, 'reglas: «Quitar filtro» vuelve a las 15 reglas de la planta demo');
    check(errors.length === 0, `reglas con parámetros: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }

  // ═══════════════ ADMINISTRADOR DE cliente-tanques · ESCRITORIO ═══════════════
  {
    const { ctx, page, errors } = await newContext(DESKTOP, 'cliente-tanques');
    await page.goto(`${BASE}/admin`, { waitUntil: 'load' });
    await page.waitForURL('**/admin/users');
    await page.locator('[data-testid="users-table"]').waitFor({ timeout: 30_000 });
    check((await page.locator('a[href="/admin/orgs"]').count()) === 0, 'cliente: no ve "Clientes" en la navegación');
    check((await text(page.locator('[data-testid="shell-org"]'))) === 'Cliente Solo Tanques', 'cliente: la barra lateral muestra su cliente');
    check(!/Cliente/.test(await text(page.locator('[data-testid="users-table"] thead'))), 'usuarios: sin columna Cliente');
    check((await page.getByRole('search').count()) === 0, 'usuarios: sin filtro por cliente');
    check((await page.locator('[data-testid^="user-row-"]').count()) === 4 && (await page.locator('[data-testid="user-row-admin@campo.demo"]').count()) === 0, 'usuarios: sólo los 4 de su cliente');
    await page.getByRole('button', { name: 'Nuevo usuario' }).click();
    let dlg = page.getByRole('dialog', { name: 'Nuevo usuario' });
    check((await dlg.getByLabel('Cliente').count()) === 0, 'usuarios: el selector de cliente no existe para un admin de cliente');
    const roles = await dlg.getByLabel('Rol').locator('option').allTextContents();
    check(!roles.includes('Campos Ingeniería') && roles.length === 4, `usuarios: no se puede otorgar platform_admin (${roles.join(', ')})`);
    check((await dlg.getByRole('checkbox', { name: /Planta demo/ }).count()) === 0, 'usuarios: no ofrece plantas de otros clientes');
    await dlg.getByRole('button', { name: 'Cancelar' }).click();

    await page.goto(`${BASE}/admin/orgs`, { waitUntil: 'load' });
    check(await vis(page.getByText('No tenés acceso a esta sección'), 15_000), 'cliente: /admin/orgs muestra "No tenés acceso a esta sección"');
    await shot(page, 'forbidden-orgs-desktop');

    await page.goto(`${BASE}/admin/plants`, { waitUntil: 'load' });
    await page.locator('[data-testid="plants-table"]').waitFor();
    check((await page.locator('[data-testid^="plant-row-"]').count()) === 1 && (await page.locator('[data-testid="plant-row-tanques"]').count()) === 1, 'plantas: sólo la planta de su cliente');
    check((await page.getByRole('search').count()) === 0 && !/Cliente/.test(await text(page.locator('[data-testid="plants-table"] thead'))), 'plantas: sin filtro ni columna de cliente');
    await page.getByRole('button', { name: 'Nueva planta' }).click();
    check((await page.getByRole('dialog', { name: 'Nueva planta' }).getByLabel('Cliente').count()) === 0, 'plantas: al crear no se elige cliente');
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: /Activos de / }).click();
    await page.locator('[data-testid="assets-table"]').waitFor();
    check((await page.locator('[data-testid^="asset-row-"]').count()) === 2, 'activos: tk-a y tk-b');

    await page.getByRole('button', { name: 'Nuevo activo' }).click();
    dlg = page.getByRole('dialog', { name: 'Nuevo activo' });
    await dlg.waitFor();
    const enabled = await dlg.getByLabel('Tipo').locator('option:not([disabled])').allTextContents();
    check(JSON.stringify(enabled) === JSON.stringify(['Tanque', 'Bomba', 'Válvula', 'Sensor']), `activos: los tipos se limitan a Tanques y llenado + genéricos (${enabled.join(', ')})`);
    const blocked = await dlg.getByLabel('Tipo').locator('option[disabled]').allTextContents();
    check(blocked.length === 6 && blocked.every((b) => /no contratado/.test(b)), `activos: el resto figura como «no contratado» (${blocked.length})`);
    check(await vis(dlg.getByText(/Para sumarlo, contactá a Campos Ingeniería/)), 'activos: explica cómo sumar el módulo');
    await dlg.getByLabel('Id', { exact: true }).fill('cl-1');
    await dlg.getByLabel('Nombre').fill('Cámara');
    await forceType(dlg, 'climate');
    await dlg.getByRole('button', { name: 'Crear activo' }).click();
    check(await vis(dlg.getByText('Este módulo no está contratado, pedíselo a Campos Ingeniería')), 'activos: crear un tipo climate → «Este módulo no está contratado, pedíselo a Campos Ingeniería»');
    check((await page.locator('[data-testid="asset-row-cl-1"]').count()) === 0, 'activos: no se crea');
    await dlg.getByLabel('Tipo').scrollIntoViewIfNeeded();
    await shot(page, 'client-module-error-desktop');
    // tanque con capacidad y escala, sin pisar claves manuales
    await dlg.getByLabel('Tipo').selectOption('tank');
    await dlg.getByLabel('Id', { exact: true }).fill('tk-c');
    await dlg.getByLabel('Nombre').fill('Tanque C');
    await dlg.getByLabel('Metadatos (JSON)').fill('{"notas": "a mano"}');
    await dlg.getByLabel('Capacidad (m³)').fill('40');
    const nivel = dlg.getByRole('group', { name: /Nivel/ });
    await nivel.getByLabel('Mínimo').fill('0');
    await nivel.getByLabel('Máximo').fill('110');
    const json = JSON.parse(await dlg.getByLabel('Metadatos (JSON)').inputValue());
    check(json.capacityM3 === 40 && json.scale?.level?.max === 110 && json.notas === 'a mano', `activos: capacidad y escala por métrica en el JSON (${JSON.stringify(json)})`);
    check((await dlg.getByRole('group', { name: /Temperatura/ }).count()) === 1, 'activos: tanque ofrece escala de nivel y de temperatura');
    await shot(page, 'asset-tank-desktop');
    await dlg.getByRole('button', { name: 'Crear activo' }).click();
    await page.locator('[data-testid="asset-row-tk-c"]').waitFor();
    check(true, 'activos: el tanque con capacidad se crea');

    await page.goto(`${BASE}/admin/plants/demo`, { waitUntil: 'load' });
    check(await vis(page.getByRole('alert').filter({ hasText: 'No tenés acceso' }).first(), 15_000), 'aislamiento: abrir la planta de otro cliente → 403 genérico');
    check((await page.locator('[data-testid^="asset-row-"]').count()) === 0, 'aislamiento: no se filtra ningún activo ajeno');
    await shot(page, 'client-foreign-plant-desktop');

    await page.goto(`${BASE}/admin/rules`, { waitUntil: 'load' });
    await page.locator('[data-testid="rules-table"]').waitFor();
    check((await page.locator('[data-testid^="rule-row-"]').count()) === 2, 'reglas: sólo las 2 de su planta');
    await page.goto(`${BASE}/admin/audit`, { waitUntil: 'load' });
    await page.locator('[data-testid="audit-table"]').waitFor();
    check((await page.getByRole('search').getByLabel('Cliente').count()) === 0, 'auditoría: sin filtro por cliente');
    check(!/Agroindustria|campos-demo/.test(await text(page.locator('[data-testid="audit-table"]'))), 'auditoría: sólo acciones de su cliente');

    await page.goto(`${BASE}/admin/account`, { waitUntil: 'load' });
    await page.locator('[data-testid="account-modules"]').waitFor();
    check((await text(page.locator('[data-testid="account-org"]'))) === 'Cliente Solo Tanques', 'cuenta: muestra el cliente');
    const accMods = await text(page.locator('[data-testid="account-modules"]'));
    check(/Tanques y llenado/.test(accMods) && /Nivel de tanques, bombas y válvulas/.test(accMods), 'cuenta: módulos contratados con su descripción');
    check(/Para sumar más módulos, contactá a Campos Ingeniería/.test(await text(page.locator('[data-testid="account-contact"]'))), 'cuenta: texto para sumar más módulos');
    const href = await page.locator('[data-testid="account-contact"] a').getAttribute('href');
    check(/^mailto:info@camposingenieria\.ar/.test(href ?? ''), `cuenta: enlace mailto al correo por defecto (${href})`);
    await audit(page, 'cuenta de cliente (escritorio)');
    await shot(page, 'account-client-desktop');
    check(errors.length === 0, `cliente escritorio: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }

  // ═══════════════ PLATAFORMA · MÓVIL ═══════════════
  {
    const { ctx, page, errors } = await newContext(MOBILE, 'platform');
    await page.goto(`${BASE}/admin/orgs`, { waitUntil: 'load' });
    await page.locator('[data-testid^="org-card-"]').first().waitFor({ timeout: 30_000 });
    check((await page.locator('[data-testid="orgs-table"]:visible').count()) === 0, 'móvil: clientes en tarjetas (sin tabla)');
    check((await page.locator('nav[aria-label="Administración"]:visible a').count()) === 6, 'móvil: 6 pestañas para plataforma');
    await audit(page, 'clientes (móvil)');
    await shot(page, 'list-mobile');
    const dlg = await openNewOrg(page);
    await dlg.getByLabel('Nombre').fill('Cliente móvil');
    await dlg.getByLabel('Id del cliente').fill('movil');
    await dlg.getByRole('switch', { name: 'Energía', exact: true }).tap();
    await audit(page, 'nuevo cliente (móvil)', '[role="dialog"]');
    await shot(page, 'org-create-mobile');
    await dlg.getByRole('button', { name: 'Crear cliente' }).tap();
    await page.locator('[data-testid="org-card-movil"]').waitFor();
    await page.getByRole('link', { name: 'Abrir Cliente móvil' }).tap();
    await page.locator('[data-testid="org-detail"]').waitFor();
    await audit(page, 'detalle de cliente (móvil)');
    await shot(page, 'detail-mobile');
    await page.getByRole('button', { name: 'Crear administrador del cliente' }).tap();
    const adm = page.getByRole('dialog', { name: 'Crear administrador del cliente' });
    await adm.getByLabel('Correo').fill('jefa@movil.com');
    await adm.getByLabel('Contraseña inicial').fill('clave-segura-123');
    await audit(page, 'administrador del cliente (móvil)', '[role="dialog"]');
    await shot(page, 'org-admin-mobile');
    await adm.getByRole('button', { name: 'Crear administrador' }).tap();
    await page.locator('[data-testid="org-user-jefa@movil.com"]').waitFor();
    await page.getByRole('button', { name: 'Eliminar' }).first().tap();
    const del = page.getByRole('alertdialog');
    await del.getByLabel(/Escribí "movil"/).fill('movil');
    await del.getByRole('button', { name: 'Eliminar cliente' }).tap();
    await del.getByRole('alert').waitFor();
    await audit(page, 'borrado con 409 (móvil)', '[role="alertdialog"]');
    await shot(page, 'org-delete-409-mobile');
    await del.getByRole('button', { name: 'Cancelar' }).tap();
    await go(page, '/admin/users');
    await page.locator('[data-testid^="user-card-"]').first().waitFor();
    await audit(page, 'usuarios con cliente (móvil)');
    await shot(page, 'users-mobile');
    await go(page, '/admin/audit');
    await page.locator('[data-testid="audit-card"]').first().waitFor();
    await audit(page, 'auditoría con cliente (móvil)');
    check(errors.length === 0, `plataforma móvil: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }

  // ═══════════════ ADMINISTRADOR DE cliente-tanques · MÓVIL ═══════════════
  {
    const { ctx, page, errors } = await newContext(MOBILE, 'cliente-tanques');
    await page.goto(`${BASE}/admin/plants/tanques`, { waitUntil: 'load' });
    await page.locator('[data-testid="asset-card-tk-a"]').waitFor({ timeout: 30_000 });
    check((await page.locator('nav[aria-label="Administración"]:visible a').count()) === 5, 'móvil cliente: 5 pestañas (sin Clientes)');
    await audit(page, 'activos de cliente (móvil)');
    await page.getByRole('button', { name: 'Nuevo activo' }).tap();
    const dlg = page.getByRole('dialog', { name: 'Nuevo activo' });
    await dlg.getByLabel('Id', { exact: true }).fill('tk-m');
    await dlg.getByLabel('Nombre').fill('Tanque móvil');
    await dlg.getByLabel('Capacidad (m³)').fill('25');
    await audit(page, 'nuevo activo con datos del equipo (móvil)', '[role="dialog"]');
    await shot(page, 'asset-tank-mobile');
    await forceType(dlg, 'gas');
    await dlg.getByRole('button', { name: 'Crear activo' }).tap();
    await dlg.getByText('Este módulo no está contratado').waitFor();
    await audit(page, 'mensaje de módulo no contratado (móvil)', '[role="dialog"]');
    await dlg.getByLabel('Tipo').scrollIntoViewIfNeeded();
    await shot(page, 'client-module-error-mobile');
    await page.keyboard.press('Escape');
    await go(page, '/admin/account');
    await page.locator('[data-testid="account-modules"]').waitFor();
    await audit(page, 'cuenta de cliente (móvil)');
    await shot(page, 'account-client-mobile');
    check(errors.length === 0, `cliente móvil: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
    await ctx.close();
  }
} catch (e) {
  console.error(e);
  state.failures++;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}

console.log(state.failures === 0 ? '\nE2E ORGS OK' : `\nE2E ORGS: ${state.failures} fallo(s)`);
process.exit(state.failures === 0 ? 0 : 1);
