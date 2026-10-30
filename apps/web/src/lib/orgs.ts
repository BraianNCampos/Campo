import { MODULE_IDS, type Me, type ModuleId, type OrgSummary, type Plant } from '@campo/shared';
import { getToken } from './auth';
import { DEMO_ORGS, DEMO_PLANT_OF, getDemoOrgId } from './demo-org';
import { config } from './env';

/**
 * Identidad de cliente en modo demo: el cliente sale de `getDemoOrgId()` (nunca del rol). Sin cliente = personal de
 * plataforma, que siempre es `platform_admin`.
 */
export function withDemoOrg(me: Me, orgId = getDemoOrgId()): Me {
  if (orgId === null) return { ...me, org: null, role: 'platform_admin', plants: ['*'] };
  return { ...me, org: DEMO_ORGS[orgId], role: me.role === 'platform_admin' ? 'admin' : me.role };
}

/** Plantas visibles en demo: las del cliente elegido (o todas si es plataforma). */
export function demoPlants(all: readonly Plant[], orgId = getDemoOrgId()): Plant[] {
  if (orgId === null) return [...all];
  // `orgId` ausente (API en memoria aún sin clientes): las plantas sin dueño se atribuyen al cliente demo principal
  return all.filter((p) => p.orgId === orgId || (!p.orgId && (p.id === DEMO_PLANT_OF[orgId] || orgId === 'campos-demo')));
}

const isModule = (v: unknown): v is ModuleId => typeof v === 'string' && (MODULE_IDS as readonly string[]).includes(v);

/** Clientes y sus módulos, para que el personal de plataforma vea los módulos de la planta elegida. */
export async function loadOrgSummaries(me: Me, fetcher: typeof fetch = fetch): Promise<OrgSummary[]> {
  if (me.role !== 'platform_admin') return [];
  if (config.mock) return Object.values(DEMO_ORGS);
  try {
    const token = getToken();
    const res = await fetcher(`${config.apiUrl}/api/orgs`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (!res.ok) return [];
    const list: unknown = await res.json();
    if (!Array.isArray(list)) return [];
    return list
      .filter((o): o is { id: string; name: string; modules: unknown[] } => !!o && typeof o.id === 'string' && typeof o.name === 'string' && Array.isArray(o.modules))
      .map((o) => ({ id: o.id, name: o.name, modules: o.modules.filter(isModule) }));
  } catch {
    return [];
  }
}
