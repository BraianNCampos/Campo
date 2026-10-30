'use client';

import { MODULES } from '@campo/shared';
import { isModuleId } from '@/lib/modules/nav';
import { useActiveModuleIds } from './derived';
import { ModuleScreen } from './ModuleScreen';
import { NotContracted } from './NoModules';
import { View3dScreen } from './View3dScreen';

/** `/m/[module]`: sólo se muestra si el cliente lo contrató; si no, «Este módulo no está contratado». */
export function ModuleRoute({ module }: { module: string }) {
  const active = useActiveModuleIds();
  if (!isModuleId(module) || !active.includes(module)) {
    return <NotContracted label={MODULES.find((m) => m.id === module)?.label} />;
  }
  if (module === 'view3d') return <View3dScreen />;
  return <ModuleScreen module={MODULES.find((m) => m.id === module)!} />;
}
