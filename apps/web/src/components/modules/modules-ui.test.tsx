import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODULE_IDS, type AlarmEvent, type AssetDef, type Limit, type ModuleId, type Plant } from '@campo/shared';
import { emptyBatch } from '@/lib/batcher';
import { clearHistory } from '@/store/history';
import { useLiveStore } from '@/store/live-store';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { AlarmList } from '../AlarmList';
import { groupPlantsByOrg, PlantSelect } from '../PlantSelect';
import { BottomBar } from '../shell/BottomBar';
import { MasterLayout } from '../shell/MasterLayout';
import { ThemeToggle } from '../ThemeToggle';
import { Sidebar } from '../shell/Sidebar';
import { ModuleCard } from './ModuleCard';
import { ModuleRoute } from './ModuleRoute';

let pathname = '/m/tanks';
let mobile = false;
vi.mock('next/navigation', () => ({ usePathname: () => pathname, useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

vi.mock('../hooks', async (orig) => ({ ...(await orig<typeof import('../hooks')>()), useIsMobile: () => mobile }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useLiveStore.getState().reset();
  clearHistory();
  useSessionStore.getState().clear();
  usePlantStore.getState().reset();
  pathname = '/m/tanks';
  mobile = false;
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = (el: React.ReactElement) => act(() => root.render(el));
const def = (id: string, type: AssetDef['type'], name = id, metadata: Record<string, unknown> = {}): AssetDef => ({ plant: 'demo', id, name, type, model3dRef: null, metadata });
const feed = (id: string, values: Record<string, number>) => {
  const b = emptyBatch();
  b.telemetry[id] = { ts: 1, quality: 'good', values };
  act(() => useLiveStore.getState().applyBatch(b));
};
const lim = (asset: string, metric: string, operator: Limit['operator'], threshold: number, severity: Limit['severity'] = 'warning'): Limit => ({ asset, metric, operator, threshold, severity });
const alarm = (over: Partial<AlarmEvent>): AlarmEvent => ({
  type: 'alarm', id: 'a1', ruleId: 'r', plant: 'demo', asset: 'tk-01', metric: 'level', severity: 'critical', state: 'active', value: 95, threshold: 90, ts: 100, message: 'Nivel alto', ...over,
});
const login = (modules: ModuleId[], role: 'admin' | 'viewer' = 'admin') =>
  act(() => useSessionStore.setState({ me: { id: 'u', email: 'a@b.c', role, plants: ['*'], org: { id: 'c', name: 'Cliente', modules } }, status: 'ready' }));

describe('tarjeta de módulo', () => {
  const setup = () => {
    act(() => {
      useLiveStore.getState().setCatalog([def('tk-01', 'tank', 'Tanque Norte', { capacityM3: 60 })]);
      useLiveStore.getState().setLimits([lim('tk-01', 'level', 'gt', 90, 'critical'), lim('tk-01', 'level', 'lt', 10)]);
    });
  };
  const card = () => host.querySelector('[data-testid="asset-card-tk-01"]')!;

  it('sin telemetría: «Sin datos», sin valor', () => {
    setup();
    render(<ModuleCard id="tk-01" />);
    expect(card().getAttribute('data-status')).toBe('nodata');
    expect(card().textContent).toContain('Sin datos');
    expect(card().querySelector('[data-testid="value-tk-01"]')).toBeNull();
  });
  it('en rango: texto, valor con unidad y decimales de METRICS, barra con marcas en los límites', () => {
    setup();
    feed('tk-01', { level: 50, temp: 19 });
    render(<ModuleCard id="tk-01" />);
    expect(card().getAttribute('data-status')).toBe('ok');
    expect(card().textContent).toContain('En rango');
    expect(card().querySelector('[data-testid="value-tk-01"]')?.textContent).toBe('50.0');
    const meter = card().querySelector('[role="meter"]')!;
    expect(meter.getAttribute('aria-valuemin')).toBe('0');
    expect(meter.getAttribute('aria-valuemax')).toBe('100');
    const marks = [...card().querySelectorAll<HTMLElement>('[data-testid="limit-mark"]')].map((m) => m.style.left);
    expect(marks).toEqual(['90%', '10%']);
    expect(card().textContent).toContain('Volumen');
    expect(card().textContent).toContain('30.0 m³ de 60');
  });
  it('cerca del límite (icono + texto) y alarma (roja) según el valor y las alarmas activas', () => {
    setup();
    feed('tk-01', { level: 84 });
    render(<ModuleCard id="tk-01" />);
    expect(card().getAttribute('data-status')).toBe('near');
    expect(card().textContent).toContain('Cerca del límite');
    expect(card().querySelector('[data-testid="status-tk-01"] svg')).not.toBeNull();
    const b = emptyBatch();
    b.alarms.push(alarm({}));
    act(() => useLiveStore.getState().applyBatch(b));
    expect(card().getAttribute('data-status')).toBe('alarm');
    expect(card().textContent).toContain('Alarma');
  });
  it('máquina: «En marcha» / «Detenida» en lugar de un número', () => {
    act(() => useLiveStore.getState().setCatalog([def('maq-01', 'machine', 'Envasadora')]));
    feed('maq-01', { state: 1 });
    render(<ModuleCard id="maq-01" />);
    expect(host.textContent).toContain('En marcha');
    feed('maq-01', { state: 0 });
    expect(host.textContent).toContain('Detenida');
  });
  it('la escala sale de metadata.scale', () => {
    act(() => useLiveStore.getState().setCatalog([def('tk-01', 'tank', 'T', { scale: { level: { min: 0, max: 200 } } })]));
    feed('tk-01', { level: 50 });
    render(<ModuleCard id="tk-01" />);
    expect(card().querySelector('[role="meter"]')?.getAttribute('aria-valuemax')).toBe('200');
  });
});

describe('módulo desactivado', () => {
  it('un cliente solo con tanques no accede a otro módulo por URL', () => {
    login(['tanks']);
    render(<ModuleRoute module="climate" />);
    expect(host.querySelector('[data-testid="module-not-contracted"]')?.textContent).toContain('Este módulo no está contratado');
    expect(host.querySelector('[data-testid="module-screen"]')).toBeNull();
  });
  it('un módulo inexistente también se trata como no contratado', () => {
    login([...MODULE_IDS]);
    render(<ModuleRoute module="nada" />);
    expect(host.querySelector('[data-testid="module-not-contracted"]')).not.toBeNull();
  });
  it('un módulo contratado muestra su pantalla con las pestañas En vivo · Alarmas · Reglas', () => {
    login(['tanks']);
    render(<ModuleRoute module="tanks" />);
    expect(host.querySelector('[data-testid="module-screen"][data-module="tanks"]')).not.toBeNull();
    expect([...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual(['En vivo', 'Alarmas', 'Reglas']);
  });
  it('la pestaña Reglas enlaza a /admin/rules con planta y módulo, sólo para admin', () => {
    login(['tanks']);
    act(() => usePlantStore.getState().setPlants([{ id: 'demo', name: 'Demo', assets: 1, orgId: 'c' }]));
    render(<ModuleRoute module="tanks" />);
    act(() => host.querySelector<HTMLElement>('[data-testid="module-tab-rules"]')!.click());
    expect(host.querySelector('[data-testid="rules-link"]')?.getAttribute('href')).toBe('/admin/rules?plant=demo&module=tanks');
    login(['tanks'], 'viewer');
    expect(host.querySelector('[data-testid="rules-link"]')).toBeNull();
    expect(host.querySelector('[data-testid="rules-readonly"]')).not.toBeNull();
  });
  it('filtros «Todos» y «Requieren atención» con sus contadores', () => {
    vi.useFakeTimers();
    login(['tanks']);
    act(() => {
      useLiveStore.getState().setCatalog([def('tk-01', 'tank', 'Uno'), def('tk-02', 'tank', 'Dos')]);
      useLiveStore.getState().setLimits([lim('tk-01', 'level', 'gt', 90), lim('tk-02', 'level', 'gt', 90)]);
    });
    feed('tk-01', { level: 50 });
    feed('tk-02', { level: 85 });
    render(<ModuleRoute module="tanks" />);
    expect(host.querySelector('[data-testid="filter-all"]')?.textContent).toContain('(2)');
    expect(host.querySelector('[data-testid="filter-attention"]')?.textContent).toContain('(1)');
    act(() => host.querySelector<HTMLElement>('[data-testid="filter-attention"]')!.click());
    expect(host.querySelectorAll('[data-testid^="asset-card-"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="asset-card-tk-02"]')).not.toBeNull();
    vi.useRealTimers();
  });
});

describe('navegación', () => {
  it('la barra lateral ofrece sólo los módulos activos, más Alarmas y Modo pared', () => {
    login(['tanks', 'energy']);
    render(<Sidebar moduleIds={['tanks', 'energy']} />);
    expect([...host.querySelectorAll('[data-testid^="module-nav-"]')].map((a) => a.getAttribute('href'))).toEqual(['/m/tanks', '/m/energy']);
    expect(host.querySelector('a[href="/alarmas"]')).not.toBeNull();
    expect(host.querySelector('a[href="/pared"]')).not.toBeNull();
    expect(host.querySelector('a[href="/m/climate"]')).toBeNull();
    expect(host.querySelector('[data-testid="module-nav-tanks"]')?.getAttribute('aria-current')).toBe('page');
  });
  it('insignia por módulo: ámbar con activos cerca del límite, roja con alarma crítica', () => {
    vi.useFakeTimers();
    login(['tanks', 'climate']);
    act(() => {
      useLiveStore.getState().setCatalog([def('tk-01', 'tank'), def('c1', 'climate')]);
      useLiveStore.getState().setLimits([lim('c1', 'temp', 'gt', 30)]);
    });
    feed('tk-01', { level: 50 });
    feed('c1', { temp: 28 });
    render(<Sidebar moduleIds={['tanks', 'climate']} />);
    expect(host.querySelector('[data-testid="module-badge-climate"]')?.getAttribute('data-tone')).toBe('warn');
    expect(host.querySelector('[data-testid="module-badge-tanks"]')).toBeNull();
    const b = emptyBatch();
    b.alarms.push(alarm({ asset: 'tk-01' }));
    act(() => useLiveStore.getState().applyBatch(b));
    act(() => vi.advanceTimersByTime(1100));
    expect(host.querySelector('[data-testid="module-badge-tanks"]')?.getAttribute('data-tone')).toBe('crit');
    vi.useRealTimers();
  });
  it('barra inferior móvil: con 7 módulos, 3 destinos + «Más»; con un módulo no hay barra', () => {
    login([...MODULE_IDS]);
    render(<BottomBar moduleIds={[...MODULE_IDS]} />);
    expect(host.querySelectorAll('[data-testid="bottom-bar"] > a')).toHaveLength(3);
    expect(host.querySelector('[data-testid="nav-more"]')).not.toBeNull();
    act(() => host.querySelector<HTMLElement>('[data-testid="nav-more"]')!.click());
    expect(host.querySelectorAll('[data-testid="more-sheet"] [data-testid^="module-nav-"]')).toHaveLength(4);
    render(<BottomBar moduleIds={['tanks']} />);
    expect(host.querySelector('[data-testid="bottom-bar"]')).toBeNull();
  });
});

describe('selector de planta', () => {
  const plants: Plant[] = [
    { id: 'demo', name: 'Planta demo', assets: 20, orgId: 'campos-demo' },
    { id: 'tanques', name: 'Tanques', assets: 2, orgId: 'cliente-tanques' },
    { id: 'norte', name: 'Norte', assets: 1, orgId: 'campos-demo' },
  ];
  it('agrupa por cliente, ordenado por nombre', () => {
    const g = groupPlantsByOrg(plants, { 'campos-demo': 'Agroindustria Ejemplo', 'cliente-tanques': 'Cliente Solo Tanques' });
    expect(g.map((x) => [x.name, x.plants.map((p) => p.id)])).toEqual([['Agroindustria Ejemplo', ['demo', 'norte']], ['Cliente Solo Tanques', ['tanques']]]);
  });
  it('platform_admin con plantas de dos clientes ve grupos; un admin de cliente no; con una planta se oculta', () => {
    act(() => {
      useSessionStore.setState({ me: { id: 'p', email: 'p@c', role: 'platform_admin', plants: ['*'], org: null }, orgs: [{ id: 'campos-demo', name: 'Agroindustria Ejemplo', modules: [] }, { id: 'cliente-tanques', name: 'Cliente Solo Tanques', modules: [] }] });
      usePlantStore.getState().setPlants(plants);
    });
    render(<PlantSelect />);
    expect([...host.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['Agroindustria Ejemplo', 'Cliente Solo Tanques']);
    login(['tanks']);
    expect(host.querySelectorAll('optgroup')).toHaveLength(0);
    act(() => usePlantStore.getState().setPlants([plants[0]!]));
    expect(host.querySelector('select')).toBeNull();
  });
});

describe('alarmas: reconocer según el rol', () => {
  it('con canAck=false no hay botón «Reconocer»', () => {
    const b = emptyBatch();
    b.alarms.push(alarm({}));
    act(() => useLiveStore.getState().applyBatch(b));
    render(<AlarmList canAck={false} />);
    expect(host.textContent).not.toContain('Reconocer');
    render(<AlarmList canAck />);
    expect(host.textContent).toContain('Reconocer');
  });
  it('el filtro limita las alarmas a los activos del módulo', () => {
    const b = emptyBatch();
    b.alarms.push(alarm({ id: 'a1', asset: 'tk-01' }), alarm({ id: 'a2', asset: 'c1' }));
    act(() => useLiveStore.getState().applyBatch(b));
    render(<AlarmList filter={(a) => a.asset === 'c1'} />);
    expect(host.querySelectorAll('[data-testid="alarm-item"]')).toHaveLength(1);
  });
});

describe('plantilla maestra bloqueada', () => {
  const content = <p data-testid="screen">contenido</p>;
  const setupPlant = () => act(() => usePlantStore.getState().setPlants([{ id: 'demo', name: 'Demo', assets: 1, orgId: 'c' }]));

  it('toda pantalla hereda cabecera, barra de navegación y pie global de alarmas', () => {
    login(['tanks', 'energy']);
    setupPlant();
    for (const p of ['/m/tanks', '/m/energy', '/alarmas', '/']) {
      pathname = p;
      render(<MasterLayout>{content}</MasterLayout>);
      expect(host.querySelector('header'), p).not.toBeNull();
      expect(host.querySelector('[data-testid="sidebar"]'), p).not.toBeNull();
      expect(host.querySelector('[data-testid="alarm-footer"]'), p).not.toBeNull();
      expect(host.querySelector('main [data-testid="screen"]'), p).not.toBeNull();
    }
  });
  it('la navegación sale sólo de los módulos del cliente (sin atajos extra)', () => {
    login(['tanks', 'gas']);
    setupPlant();
    render(<MasterLayout>{content}</MasterLayout>);
    const mods = [...host.querySelectorAll('a[href^="/m/"]')].map((a) => a.getAttribute('href'));
    expect([...new Set(mods)]).toEqual(['/m/tanks', '/m/gas']);
  });
  it('con un solo módulo: sin barra lateral, pero con cabecera y pie', () => {
    login(['tanks']);
    setupPlant();
    render(<MasterLayout>{content}</MasterLayout>);
    expect(host.querySelector('[data-testid="sidebar"]')).toBeNull();
    expect(host.querySelector('header')).not.toBeNull();
    expect(host.querySelector('[data-testid="alarm-footer"]')).not.toBeNull();
  });
  it('en móvil: pie de alarmas y barra inferior', () => {
    mobile = true;
    login(['tanks', 'gas']);
    setupPlant();
    render(<MasterLayout>{content}</MasterLayout>);
    expect(host.querySelector('[data-testid="alarm-footer"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="bottom-bar"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="sidebar"]')).toBeNull();
  });
  it('el modo pared oculta la plantilla a propósito', () => {
    login(['tanks', 'gas']);
    pathname = '/pared';
    render(<MasterLayout>{content}</MasterLayout>);
    expect(host.querySelector('[data-testid="screen"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="master-layout"]')).toBeNull();
    expect(host.querySelector('[data-testid="alarm-footer"]')).toBeNull();
    expect(host.querySelector('header')).toBeNull();
  });
  it('pie global: conteo por prioridad, las 3 más importantes con activo, valor y límite, y acceso a la lista completa', () => {
    login(['tanks']);
    setupPlant();
    act(() => useLiveStore.getState().setCatalog([def('tk-01', 'tank', 'Tanque Norte'), def('tk-02', 'tank', 'Tanque Sur')]));
    const b = emptyBatch();
    b.alarms.push(
      alarm({ id: 'a1', asset: 'tk-01', severity: 'critical', value: 95.2, threshold: 90, ts: 300 }),
      alarm({ id: 'a2', asset: 'tk-02', severity: 'warning', value: 8.5, threshold: 10, ts: 200 }),
      alarm({ id: 'a3', asset: 'tk-02', severity: 'warning', ts: 100 }),
      alarm({ id: 'a4', asset: 'tk-02', severity: 'warning', ts: 50 }),
    );
    act(() => useLiveStore.getState().applyBatch(b));
    render(<MasterLayout>{content}</MasterLayout>);
    const f = host.querySelector('[data-testid="alarm-footer"]')!;
    expect(f.querySelector('[data-testid="footer-critical"]')?.textContent).toContain('1');
    expect(f.querySelector('[data-testid="footer-warning"]')?.textContent).toContain('3');
    const entries = [...f.querySelectorAll('[data-testid="footer-alarm"]')];
    expect(entries).toHaveLength(3);
    expect(entries[0]?.getAttribute('data-severity')).toBe('critical');
    expect(entries[0]?.textContent).toContain('Tanque Norte');
    expect(entries[0]?.textContent).toContain('95.2 %');
    expect(entries[0]?.textContent).toContain('límite 90.0 %');
    expect(f.querySelector('[data-testid="footer-all"]')?.getAttribute('href')).toBe('/alarmas');
    expect(f.querySelector('[data-testid="footer-all"]')?.textContent).toContain('(4)');
  });
  it('sin alarmas el pie lo dice', () => {
    login(['tanks']);
    setupPlant();
    render(<MasterLayout>{content}</MasterLayout>);
    expect(host.querySelector('[data-testid="footer-empty"]')?.textContent).toContain('Sin alarmas activas');
  });
});

describe('interruptor de alto contraste', () => {
  it('activa el tema claro, lo recuerda y se puede apagar', () => {
    render(<ThemeToggle />);
    const btn = () => host.querySelector<HTMLElement>('[data-testid="theme-toggle"]')!;
    expect(btn().getAttribute('aria-checked')).toBe('false');
    act(() => btn().click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('contrast');
    expect(localStorage.getItem('campo.theme')).toBe('contrast');
    expect(btn().getAttribute('aria-checked')).toBe('true');
    expect(btn().textContent).toContain('Sí');
    act(() => btn().click());
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
