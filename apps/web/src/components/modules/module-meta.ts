import type { ModuleId } from '@campo/shared';
import { IconBolt, IconCube, IconFlame, IconGauge, IconGear, IconTank, IconThermo } from '../icons';

export const MODULE_ICON: Record<ModuleId, (p: React.SVGProps<SVGSVGElement>) => React.JSX.Element> = {
  tanks: IconTank,
  climate: IconThermo,
  energy: IconBolt,
  gas: IconFlame,
  machines: IconGear,
  flow: IconGauge,
  view3d: IconCube,
};

/** Nombre corto para la barra inferior móvil. */
export const MODULE_SHORT: Record<ModuleId, string> = {
  tanks: 'Tanques',
  climate: 'Clima',
  energy: 'Energía',
  gas: 'Gases',
  machines: 'Máquinas',
  flow: 'Presión',
  view3d: 'Vista 3D',
};
