import { DEMO_ORGS, getDemoOrgId, setDemoOrgId, type DemoOrgId } from './demo-org';

/** Selector «Ver como» del modo demo: con qué cliente (o como personal de plataforma) se mira la app. */
export type ViewAs = DemoOrgId | 'platform';

export const VIEW_AS_OPTIONS: readonly { value: ViewAs; label: string }[] = [
  { value: 'campos-demo', label: 'Cliente con todos los módulos' },
  { value: 'cliente-tanques', label: 'Cliente solo tanques' },
  { value: 'platform', label: 'Campos Ingeniería (plataforma)' },
];

export function currentViewAs(): ViewAs {
  return getDemoOrgId() ?? 'platform';
}

/** Cliente demo elegido (o `null` = plataforma) → valor del selector. */
export const viewAsLabel = (v: ViewAs): string => VIEW_AS_OPTIONS.find((o) => o.value === v)?.label ?? DEMO_ORGS['campos-demo'].name;

/**
 * Cambia el cliente con el que se ve la demo y recarga el estado. La recarga completa reinicia sesión, plantas, stream y
 * API en memoria (mismo criterio que el cambio de rol demo), y `/` lleva al primer módulo del nuevo cliente.
 */
// eslint-disable-next-line @next/next/no-location-assign-relative-destination
export function switchViewAs(value: ViewAs, reload: () => void = () => window.location.assign('/') /* recarga completa a propósito */): void {
  setDemoOrgId(value === 'platform' ? null : value);
  reload();
}
