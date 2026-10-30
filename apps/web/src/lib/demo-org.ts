import type { ModuleId, OrgSummary } from '@campo/shared';
import { MODULE_IDS } from '@campo/shared';

/**
 * Identidad de cliente en el modo demo (sin backend). Compartida por el stream simulado y por el
 * `MockAdminApi` para que ambos coincidan. `null` = personal de Campos Ingeniería (plataforma).
 */
export type DemoOrgId = 'campos-demo' | 'cliente-tanques';

const KEY = 'campo.demoOrg';

export const DEMO_ORGS: Record<DemoOrgId, OrgSummary> = {
  'campos-demo': { id: 'campos-demo', name: 'Agroindustria Ejemplo', modules: [...MODULE_IDS] },
  'cliente-tanques': { id: 'cliente-tanques', name: 'Cliente Solo Tanques', modules: ['tanks'] satisfies ModuleId[] },
};

/** Planta de cada cliente demo. */
export const DEMO_PLANT_OF: Record<DemoOrgId, string> = { 'campos-demo': 'demo', 'cliente-tanques': 'tanques' };

export function getDemoOrgId(): DemoOrgId | null {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    if (v === 'platform') return null;
    if (v === 'cliente-tanques' || v === 'campos-demo') return v;
  } catch {
    /* sin almacenamiento: valor por defecto */
  }
  return 'campos-demo';
}

export function setDemoOrgId(id: DemoOrgId | null): void {
  try {
    globalThis.localStorage?.setItem(KEY, id ?? 'platform');
  } catch {
    /* sin almacenamiento */
  }
}
