// E2E de administración (modo demo, API en memoria): recorre cada pantalla en escritorio 1440x900 y
// móvil 390x844, comprueba desbordes, targets ≥44px y deja capturas en e2e/screenshots/admin-*.png.
// Uso: npm run e2e:admin   (SKIP_BUILD=1 para reutilizar .next)
import path from 'node:path';
import { createChecker, launchBrowser, pollUntil, shots, sleep, startApp } from './lib.mjs';

const PORT = Number(process.env.E2E_ADMIN_PORT ?? 3218);
const { state, check } = createChecker();
const { base: BASE, server } = await startApp(PORT);
const browser = await launchBrowser();
const shot = (page, name) => page.screenshot({ path: path.join(shots, `admin-${name}.png`) });

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => { console.log('  ! pageerror: ' + e.message.slice(0, 80)); errors.push(`pageerror: ${e.message}`); });
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  return errors;
}

/** Desborde horizontal del documento, del <main> y de los diálogos abiertos. */
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

/** Controles interactivos visibles menores de 44x44 px (casillas: se mide su etiqueta). */
async function smallTargets(page, scope = 'body') {
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
      if (r.width < 43.5 || r.height < 43.5) {
        const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || '').trim().slice(0, 28);
        out.push(`${el.tagName.toLowerCase()}[${name}] ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return out;
  }, scope);
}

async function audit(page, label, { scope = 'body', targets = true } = {}) {
  const over = await overflow(page);
  check(over.length === 0, `${label}: sin desborde horizontal${over.length ? ' → ' + over.join(', ') : ''}`);
  if (targets) {
    const small = await smallTargets(page, scope);
    check(small.length === 0, `${label}: targets ≥44px${small.length ? ' → ' + small.slice(0, 6).join('; ') : ''}`);
  }
}

const toastText = (page, re) => page.locator('[data-testid="toast"]').filter({ hasText: re }).first().waitFor({ timeout: 5000 }).then(() => true, () => false);
const vis = (loc, timeout = 4000) => loc.waitFor({ state: 'visible', timeout }).then(() => true, () => false);
const goSection = (page, href) => page.locator(`a[href="${href}"]:visible`).first().click();

async function fillUserForm(dialog, { email, password }) {
  await dialog.getByLabel('Correo').fill(email);
  await dialog.getByLabel('Contraseña inicial').fill(password);
}

try {
  // ───────────────────────── ESCRITORIO ─────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = watchErrors(page);

    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('a[href="/admin"]:visible, [data-testid="user-menu-button"]:visible', { timeout: 30_000 });
    // el enlace "Administración" está en la cabecera o dentro del menú de usuario, según el ancho
    let adminLink = page.getByRole('link', { name: 'Administración' }).first();
    if (!(await vis(adminLink, 1500))) {
      await page.locator('[data-testid="user-menu-button"]:visible').click();
      adminLink = page.getByRole('link', { name: 'Administración' }).first();
    }
    check(await vis(adminLink), 'escritorio: admin ve el enlace "Administración"');
    await shot(page, 'header-desktop');

    // ── Usuarios ──
    await adminLink.click();
    await page.waitForURL('**/admin/users');
    await page.getByRole('heading', { name: 'Usuarios', level: 2 }).waitFor();
    await page.locator('[data-testid="users-table"]').waitFor();
    check((await page.locator('[data-testid^="user-row-"]').count()) === 4, 'usuarios: 4 usuarios sembrados en la tabla');
    await audit(page, 'usuarios (escritorio)');
    await shot(page, 'users-desktop');

    await page.getByRole('button', { name: 'Nuevo usuario' }).click();
    let dlg = page.getByRole('dialog', { name: 'Nuevo usuario' });
    await dlg.waitFor();
    // foco atrapado: Tab repetido nunca sale del diálogo
    let escaped = false;
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      if (!(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')))) escaped = true;
    }
    check(!escaped, 'usuarios: el foco queda atrapado dentro del diálogo');
    await fillUserForm(dlg, { email: 'nuevo@campo.demo', password: 'corta' });
    await dlg.getByRole('button', { name: 'Crear usuario' }).click();
    check(await vis(dlg.getByText('Mínimo 12 caracteres')), 'usuarios: contraseña corta → error de validación en el formulario');
    await shot(page, 'user-create-error-desktop');
    await fillUserForm(dlg, { email: 'nuevo@campo.demo', password: 'clave-segura-123' });
    await dlg.getByLabel('Rol').selectOption('engineer');
    await dlg.getByRole('checkbox', { name: /demo/ }).check();
    await dlg.getByRole('button', { name: 'Crear usuario' }).click();
    check(await toastText(page, /nuevo@campo\.demo creado/), 'usuarios: aviso de éxito (aria-live) al crear');
    await page.locator('[data-testid="user-row-nuevo@campo.demo"]').waitFor();
    check(await page.locator('[data-testid="toasts"][aria-live="polite"]').count() === 1, 'usuarios: región aria-live="polite" presente');

    // duplicado → 409 junto al formulario
    await page.getByRole('button', { name: 'Nuevo usuario' }).click();
    dlg = page.getByRole('dialog', { name: 'Nuevo usuario' });
    await fillUserForm(dlg, { email: 'nuevo@campo.demo', password: 'clave-segura-123' });
    await dlg.getByRole('button', { name: 'Crear usuario' }).click();
    check(await vis(dlg.getByRole('alert').filter({ hasText: 'ya está registrado' })), 'usuarios: correo duplicado → 409 mostrado en el diálogo');
    await shot(page, 'user-create-409-desktop');
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached' });
    check(await page.getByRole('button', { name: 'Nuevo usuario' }).evaluate((el) => el === document.activeElement), 'usuarios: Esc cierra y devuelve el foco al botón que abrió');

    // gestionar admin (último admin) → 409
    const manage = page.getByRole('button', { name: 'Gestionar admin@campo.demo' });
    await manage.click();
    dlg = page.getByRole('dialog', { name: 'Gestionar usuario' });
    await dlg.getByLabel('Usuario activo').uncheck();
    check(await vis(dlg.getByText('último administrador activo')), 'usuarios: aviso de "último admin" en el diálogo');
    await dlg.getByRole('button', { name: 'Guardar rol y estado' }).click();
    const confirm = page.getByRole('alertdialog');
    await confirm.waitFor();
    check(((await confirm.textContent()) ?? '').includes('permisos a vos mismo'), 'usuarios: auto-degradarse pide confirmación expresa');
    await confirm.getByRole('button', { name: 'Sí, cambiar mi acceso' }).click();
    check(await vis(confirm.getByText('No se puede desactivar ni degradar al último admin activo')), 'usuarios: 409 de la API "último admin" visible en la confirmación');
    await shot(page, 'user-last-admin-desktop');
    await confirm.getByRole('button', { name: 'Cancelar' }).click();
    await shot(page, 'user-manage-desktop');
    await page.keyboard.press('Escape');

    // revocar sesiones de otro usuario (con confirmación)
    await page.getByRole('button', { name: 'Gestionar operador@campo.demo' }).click();
    dlg = page.getByRole('dialog', { name: 'Gestionar usuario' });
    await dlg.getByRole('button', { name: 'Revocar sesiones' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revocar sesiones' }).click();
    check(await toastText(page, /Sesiones de operador@campo\.demo revocadas/), 'usuarios: revocar sesiones tras confirmar');
    await dlg.getByLabel('Rol').selectOption('viewer');
    await dlg.getByRole('button', { name: 'Guardar rol y estado' }).click();
    check(await toastText(page, /Cambios guardados/), 'usuarios: cambio de rol guardado');
    await page.keyboard.press('Escape');

    // ── Plantas y activos ──
    await goSection(page, '/admin/plants');
    await page.locator('[data-testid="plants-table"]').waitFor();
    await audit(page, 'plantas (escritorio)');
    await page.getByRole('button', { name: 'Nueva planta' }).click();
    dlg = page.getByRole('dialog', { name: 'Nueva planta' });
    await dlg.getByLabel('Id').fill('Norte 1');
    await dlg.getByLabel('Nombre').fill('Planta Norte');
    await dlg.getByRole('button', { name: 'Crear planta' }).click();
    check(await vis(dlg.getByText('Usá minúsculas')), 'plantas: id inválido → error de validación');
    await dlg.getByLabel('Id').fill('norte');
    await dlg.getByRole('button', { name: 'Crear planta' }).click();
    await page.locator('[data-testid="plant-row-norte"]').waitFor();
    check(true, 'plantas: planta "norte" creada');

    // activos de norte (para probar el selector y el 3D con ids desconocidos)
    await page.getByRole('link', { name: 'Activos de Planta Norte' }).click();
    await page.getByRole('heading', { name: 'Activos de Planta Norte' }).waitFor();
    for (const [id, name, type] of [['tk-91', 'Tanque norte', 'tank'], ['bomba-x', 'Bomba externa', 'pump']]) {
      await page.getByRole('button', { name: 'Nuevo activo' }).click();
      dlg = page.getByRole('dialog', { name: 'Nuevo activo' });
      await dlg.getByLabel('Id', { exact: true }).fill(id);
      await dlg.getByLabel('Nombre').fill(name);
      await dlg.getByLabel('Tipo').selectOption(type);
      await dlg.getByRole('button', { name: 'Crear activo' }).click();
      await page.locator(`[data-testid="asset-row-${id}"]`).waitFor();
    }
    check(true, 'activos: tk-91 y bomba-x creados en la planta norte');

    // activos de demo: JSON inválido
    await page.getByRole('link', { name: 'Plantas', exact: true }).click();
    await page.getByRole('link', { name: 'Activos de Planta demo' }).click();
    await page.locator('[data-testid="assets-table"]').waitFor();
    check((await page.locator('[data-testid^="asset-row-"]').count()) === 20, 'activos: 20 activos de la planta demo');
    await audit(page, 'activos (escritorio)');
    await shot(page, 'assets-desktop');
    await page.getByRole('button', { name: 'Nuevo activo' }).click();
    dlg = page.getByRole('dialog', { name: 'Nuevo activo' });
    await dlg.getByLabel('Id', { exact: true }).fill('tk-05');
    await dlg.getByLabel('Nombre').fill('Tanque 05');
    await dlg.getByLabel('Metadatos (JSON)').fill('{"capacityL": 5000,}');
    await dlg.getByRole('button', { name: 'Crear activo' }).click();
    const jsonErr = dlg.getByText(/JSON no válido/);
    check(await vis(jsonErr), 'activos: metadata con JSON inválido → error claro junto al campo');
    check((await dlg.getByLabel('Metadatos (JSON)').getAttribute('aria-invalid')) === 'true', 'activos: el campo queda marcado aria-invalid');
    await shot(page, 'asset-json-error-desktop');
    await dlg.getByLabel('Metadatos (JSON)').fill('{"capacityL": 5000}');
    await dlg.getByRole('button', { name: 'Crear activo' }).click();
    await page.locator('[data-testid="asset-row-tk-05"]').waitFor();
    check(true, 'activos: con JSON válido se crea tk-05');
    // el id es inmutable al editar
    await page.getByRole('button', { name: 'Editar tk-05' }).click();
    dlg = page.getByRole('dialog', { name: 'Editar activo tk-05' });
    check(await dlg.getByLabel('Id', { exact: true }).isDisabled(), 'activos: el id está deshabilitado al editar');
    await page.keyboard.press('Escape');

    // ── Reglas ──
    await goSection(page, '/admin/rules');
    await page.locator('[data-testid="rules-table"]').waitFor();
    check((await page.locator('[data-testid^="rule-row-"]').count()) === 15, 'reglas: 15 reglas sembradas (demo)');
    await page.getByLabel('Severidad', { exact: true }).selectOption('critical');
    check((await page.locator('[data-testid^="rule-row-"]').count()) === 6, 'reglas: el filtro por severidad crítica deja 6');
    await page.getByLabel('Severidad', { exact: true }).selectOption('');
    await page.getByLabel('Activo', { exact: true }).fill('tk-01');
    check((await page.locator('[data-testid^="rule-row-"]').count()) === 3, 'reglas: filtro por activo tk-01 casa con los patrones tk-*');
    await page.getByLabel('Activo', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Nueva regla' }).click();
    dlg = page.getByRole('dialog', { name: 'Nueva regla de alarma' });
    await dlg.getByRole('button', { name: 'Crear regla' }).click();
    check(await vis(dlg.getByText('Indicá la métrica')), 'reglas: formulario vacío → errores de validación');
    await dlg.getByLabel('Planta').selectOption('demo');
    await dlg.getByLabel('Activo o patrón').fill('tk-05');
    await dlg.getByLabel('Métrica').fill('level');
    await dlg.getByLabel('Umbral').fill('95');
    await dlg.getByLabel('Severidad').selectOption('critical');
    await dlg.getByLabel('Mantener (s)').fill('3');
    await dlg.getByLabel('Histéresis').fill('2');
    check(((await dlg.locator('[data-testid="rule-preview"]').textContent()) ?? '').includes('93'), 'reglas: la vista previa explica la histéresis (se normaliza a 93)');
    await shot(page, 'rule-create-desktop');
    await dlg.getByRole('button', { name: 'Crear regla' }).click();
    check(await toastText(page, /Regla creada/), 'reglas: regla creada con aviso');
    check((await page.locator('[data-testid^="rule-row-"]').count()) === 16, 'reglas: aparece en la tabla (16)');
    const sw = page.getByRole('switch', { name: /tk-05 level > 95/ });
    await sw.click();
    check(await vis(page.getByRole('switch', { name: /tk-05 level > 95: inactiva/ })), 'reglas: el interruptor desactiva la regla');
    await audit(page, 'reglas (escritorio)');
    await shot(page, 'rules-desktop');

    // borrar tk-05 → affectedRules
    await goSection(page, '/admin/plants');
    await page.getByRole('link', { name: 'Activos de Planta demo' }).click();
    await page.getByRole('button', { name: 'Eliminar tk-05' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Eliminar activo' }).click();
    const notice = page.locator('[data-testid="affected-rules"]');
    await notice.waitFor();
    check(((await notice.textContent()) ?? '').includes('1 regla de alarma lo nombra'), 'activos: tras borrar tk-05 se informa de affectedRules (1 regla)');
    await shot(page, 'asset-deleted-desktop');

    // eliminar planta: requiere escribir el id y la API devuelve 409 si tiene activos
    await goSection(page, '/admin/plants');
    await page.getByRole('button', { name: 'Eliminar Planta Norte' }).click();
    const delDlg = page.getByRole('alertdialog');
    const delBtn = delDlg.getByRole('button', { name: 'Eliminar planta' });
    check(await delBtn.isDisabled(), 'plantas: borrar planta exige escribir el id (botón deshabilitado)');
    await delDlg.getByLabel(/Escribí "norte"/).fill('norte');
    await delBtn.click();
    check(await vis(delDlg.getByText(/tiene 2 activos/)), 'plantas: borrar planta con activos → 409 visible en el diálogo');
    await shot(page, 'plant-delete-409-desktop');
    await delDlg.getByRole('button', { name: 'Cancelar' }).click();

    // ── Auditoría ──
    await goSection(page, '/admin/audit');
    await page.locator('[data-testid="audit-table"]').waitFor();
    const auditText = (await page.locator('[data-testid="audit-table"]').textContent()) ?? '';
    check(['user.create', 'asset.create', 'rule.create', 'plant.create', 'asset.delete'].every((a) => auditText.includes(a)), 'auditoría: refleja usuario, planta, activo y regla creados/borrados');
    check(auditText.includes('nuevo@campo.demo') || auditText.includes('user:'), 'auditoría: muestra objetivos');
    const firstRow = page.locator('[data-testid="audit-row"]').first();
    await firstRow.getByRole('button', { name: /Detalle/ }).click();
    const detailTxt = (await page.locator('[data-testid="audit-detail"]').first().textContent()) ?? '';
    check(detailTxt.trim().startsWith('{') && detailTxt.includes('\n'), 'auditoría: el detalle se expande como JSON formateado');
    check(/hace|ahora/.test((await firstRow.textContent()) ?? ''), 'auditoría: tiempo relativo y absoluto');
    await shot(page, 'audit-desktop');
    await page.getByLabel('Acción').fill('rule.');
    await page.getByRole('button', { name: 'Filtrar' }).click();
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-testid="audit-row"]')];
      return rows.length > 0 && rows.every((r) => r.textContent.includes('rule.'));
    });
    check((await page.locator('[data-testid="audit-row"]').count()) >= 3, 'auditoría: el filtro por acción deja sólo reglas');
    await page.getByLabel('Actor').fill('nadie@x.com');
    await page.getByRole('button', { name: 'Filtrar' }).click();
    check(await vis(page.getByText('Ningún registro coincide')), 'auditoría: filtro sin resultados → estado vacío');
    await audit(page, 'auditoría (escritorio)');

    // ── Mi cuenta ──
    await goSection(page, '/admin/account');
    await page.getByRole('heading', { name: 'Mi cuenta', level: 2 }).waitFor();
    check(((await page.locator('[data-testid="account-email"]').textContent()) ?? '') === 'admin@campo.demo', 'cuenta: muestra los datos del usuario');
    const pw = (await page.locator('[data-testid="demo-password"]').textContent()) ?? '';
    await page.getByLabel('Contraseña actual').fill('incorrecta-123456');
    await page.getByLabel('Contraseña nueva', { exact: true }).fill('otra-clave-segura-1');
    await page.getByLabel('Repetí la contraseña nueva').fill('otra-clave-segura-2');
    await page.getByRole('button', { name: 'Cambiar contraseña' }).click();
    check(await vis(page.getByText('No coincide con la nueva contraseña')), 'cuenta: confirmación distinta → error de validación');
    await page.getByLabel('Repetí la contraseña nueva').fill('otra-clave-segura-1');
    await page.getByRole('button', { name: 'Cambiar contraseña' }).click();
    check(await vis(page.getByRole('alert').filter({ hasText: 'La contraseña actual no es correcta' })), 'cuenta: contraseña actual incorrecta → 400 junto al formulario');
    await shot(page, 'account-error-desktop');
    await page.getByLabel('Contraseña actual').fill(pw);
    await page.getByRole('button', { name: 'Cambiar contraseña' }).click();
    check(await toastText(page, /Contraseña cambiada/), 'cuenta: cambio de contraseña correcto');
    await audit(page, 'cuenta (escritorio)');
    await shot(page, 'account-desktop');

    // ── Volver al panel ──
    await page.getByRole('link', { name: 'Volver al panel' }).click();
    await page.waitForSelector('a[href="/admin"]:visible, [data-testid="user-menu-button"]:visible', { timeout: 20_000 });
    check(!page.url().includes('/admin'), 'volver al panel: se sale de la administración');

    // ── Roles ──
    await page.goto(`${BASE}/admin/account`, { waitUntil: 'load' });
    await page.getByLabel('Rol de esta sesión demo').selectOption('viewer');
    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Cambiar usuario y recargar' }).click()]);
    await page.getByRole('heading', { name: 'Mi cuenta', level: 2 }).waitFor();
    check((await page.locator('a[href="/admin/users"]').count()) === 0, 'roles: un visor no ve "Usuarios" en la navegación');
    await page.goto(`${BASE}/admin/users`, { waitUntil: 'load' });
    await page.getByText('No tenés acceso a esta sección').waitFor();
    check(true, 'roles: un visor que abre /admin/users ve un 403 amigable');
    await shot(page, 'forbidden-desktop');
    await page.goto(BASE, { waitUntil: 'load' });
    await page.getByText('Todavía no tenés plantas asignadas').waitFor({ timeout: 15_000 });
    check((await page.getByRole('link', { name: 'Administración' }).count()) === 0, 'roles: un visor no ve el enlace "Administración"');
    check(await vis(page.getByText('Pedile a un administrador')), 'roles: usuario sin plantas → estado vacío claro');
    await shot(page, 'no-plants-desktop');
    // engineer: ve plantas y reglas, no usuarios/auditoría
    await page.evaluate(() => localStorage.setItem('campo.demoRole', 'engineer'));
    await page.goto(`${BASE}/admin`, { waitUntil: 'load' });
    await page.waitForURL('**/admin/plants');
    const hrefs = await page.locator('aside a[href^="/admin"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    check(JSON.stringify(hrefs) === JSON.stringify(['/admin/plants', '/admin/rules', '/admin/account']), `roles: engineer ve ${hrefs.join(', ')}`);
    check((await page.getByRole('button', { name: 'Nueva planta' }).count()) === 0, 'roles: engineer no puede crear plantas');
    await page.evaluate(() => localStorage.removeItem('campo.demoRole'));

    check(errors.length === 0, `escritorio: sin errores de consola${errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''}`);
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

    await page.goto(BASE, { waitUntil: 'load' });
    await page.locator('[data-testid="user-menu-button"]:visible').waitFor({ timeout: 30_000 });
    await page.locator('[data-testid="user-menu-button"]').tap();
    check(await vis(page.getByRole('link', { name: 'Administración' })), 'móvil: el menú de usuario ofrece "Administración"');
    check(await vis(page.getByRole('link', { name: 'Mi cuenta' })), 'móvil: el menú de usuario ofrece "Mi cuenta"');
    await audit(page, 'menú de usuario (móvil)', { scope: '#user-menu' });
    await shot(page, 'header-menu-mobile');
    await page.getByRole('link', { name: 'Administración' }).tap();
    await page.waitForURL('**/admin/users');

    // navegación inferior con pestañas
    const tabs = await page.locator('nav[aria-label="Administración"]:visible a').count();
    check(tabs === 5, `móvil: ${tabs} pestañas de administración para admin`);
    await page.locator('[data-testid^="user-card-"]').first().waitFor();
    check((await page.locator('[data-testid="users-table"]:visible').count()) === 0, 'móvil: usuarios en tarjetas (sin tabla)');
    await audit(page, 'usuarios (móvil)');
    await shot(page, 'users-mobile');
    await page.getByRole('button', { name: 'Nuevo usuario' }).tap();
    let dlg = page.getByRole('dialog', { name: 'Nuevo usuario' });
    await dlg.waitFor();
    await fillUserForm(dlg, { email: 'movil@campo.demo', password: 'clave-segura-123' });
    await audit(page, 'diálogo nuevo usuario (móvil)', { scope: '[role="dialog"]' });
    await shot(page, 'user-create-mobile');
    await dlg.getByRole('button', { name: 'Crear usuario' }).tap();
    await page.locator('[data-testid="user-card-movil@campo.demo"]').waitFor();
    await page.getByRole('button', { name: 'Gestionar movil@campo.demo' }).tap();
    dlg = page.getByRole('dialog', { name: 'Gestionar usuario' });
    await dlg.waitFor();
    await audit(page, 'gestionar usuario (móvil)', { scope: '[role="dialog"]' });
    await shot(page, 'user-manage-mobile');
    await page.keyboard.press('Escape');

    await goSection(page, '/admin/plants');
    await page.locator('[data-testid="plant-card-demo"]').waitFor();
    await audit(page, 'plantas (móvil)');
    await shot(page, 'plants-mobile');
    await page.getByRole('link', { name: 'Activos de Planta demo' }).tap();
    await page.locator('[data-testid="asset-card-tk-01"]').waitFor();
    await audit(page, 'activos (móvil)');
    await shot(page, 'assets-mobile');
    await page.getByRole('button', { name: 'Editar tk-01' }).tap();
    dlg = page.getByRole('dialog', { name: 'Editar activo tk-01' });
    await dlg.getByLabel('Metadatos (JSON)').fill('{"x": }');
    await dlg.getByRole('button', { name: 'Guardar cambios' }).tap();
    await dlg.getByText(/JSON no válido/).waitFor();
    await audit(page, 'editar activo (móvil)', { scope: '[role="dialog"]' });
    await shot(page, 'asset-json-error-mobile');
    await page.keyboard.press('Escape');

    await goSection(page, '/admin/rules');
    await page.locator('[data-testid^="rule-card-"]').first().waitFor();
    await audit(page, 'reglas (móvil)');
    await shot(page, 'rules-mobile');
    await page.getByRole('button', { name: 'Nueva regla' }).tap();
    dlg = page.getByRole('dialog', { name: 'Nueva regla de alarma' });
    await dlg.getByLabel('Planta').selectOption('demo');
    await dlg.getByLabel('Activo o patrón').fill('pump-*');
    await dlg.getByLabel('Métrica').fill('rpm');
    await dlg.getByLabel('Umbral').fill('1600');
    await audit(page, 'nueva regla (móvil)', { scope: '[role="dialog"]' });
    await shot(page, 'rule-create-mobile');
    await dlg.getByRole('button', { name: 'Crear regla' }).tap();
    await toastText(page, /Regla creada/);

    await goSection(page, '/admin/audit');
    await page.locator('[data-testid="audit-card"]').first().waitFor();
    await audit(page, 'auditoría (móvil)');
    await page.locator('[data-testid="audit-card"]').first().getByRole('button', { name: /Detalle/ }).tap();
    await shot(page, 'audit-mobile');

    await goSection(page, '/admin/account');
    await page.getByRole('heading', { name: 'Mi cuenta', level: 2 }).waitFor();
    await audit(page, 'cuenta (móvil)');
    await shot(page, 'account-mobile');

    // selector de planta en el panel móvil, con 2 plantas, y activos desconocidos listados
    await goSection(page, '/admin/plants');
    await page.getByRole('button', { name: 'Nueva planta' }).tap();
    dlg = page.getByRole('dialog', { name: 'Nueva planta' });
    await dlg.getByLabel('Id').fill('sur');
    await dlg.getByLabel('Nombre').fill('Planta Sur');
    await dlg.getByRole('button', { name: 'Crear planta' }).tap();
    await page.getByRole('link', { name: 'Activos de Planta Sur' }).tap();
    await page.getByRole('button', { name: 'Nuevo activo' }).tap();
    dlg = page.getByRole('dialog', { name: 'Nuevo activo' });
    await dlg.getByLabel('Id', { exact: true }).fill('tk-77');
    await dlg.getByLabel('Nombre').fill('Tanque sur');
    await dlg.getByRole('button', { name: 'Crear activo' }).tap();
    await page.locator('[data-testid="asset-card-tk-77"]').waitFor();
    await page.getByRole('link', { name: 'Panel', exact: true }).tap();
    await page.locator('[data-testid="user-menu-button"]:visible').waitFor({ timeout: 20_000 });
    check(!page.url().includes('/admin'), 'móvil: "Panel" vuelve a la app');

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

console.log(state.failures === 0 ? '\nE2E ADMIN OK' : `\nE2E ADMIN: ${state.failures} fallo(s)`);
process.exit(state.failures === 0 ? 0 : 1);
