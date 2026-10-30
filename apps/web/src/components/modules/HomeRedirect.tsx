'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { landingHref } from '@/lib/modules/nav';
import { useActiveModuleIds } from './derived';
import { NoModules } from './NoModules';

/** `/` lleva al primer módulo activo; sin módulos contratados muestra un estado claro. */
export function HomeRedirect() {
  const router = useRouter();
  const ids = useActiveModuleIds();
  const href = landingHref(ids);
  useEffect(() => {
    if (href) router.replace(href);
  }, [href, router]);
  return href ? null : <NoModules />;
}
