import { MODULES } from '@campo/shared';
import { DEMO_ASSETS } from '@/lib/demo-seed';
import { assetSlug } from '@/lib/tags';
import { unitModule } from '@/lib/modules/unit';
import { UnitScreen } from '@/components/unit/UnitScreen';

/**
 * Solo en la exportación estática de la demo (NEXT_EXPORT=1): una página por equipo sembrado (módulo + tag en
 * minúsculas, igual que `generateStaticParams` de `/admin/plants/[plant]`); en la app normal no genera nada y las rutas se
 * resuelven al pedirlas, contra el catálogo de la planta.
 */
export function generateStaticParams() {
  if (process.env.NEXT_EXPORT !== '1') return [];
  const seen = new Set<string>();
  for (const defs of Object.values(DEMO_ASSETS)) {
    for (const d of defs) {
      const mod = unitModule(d);
      if (mod && MODULES.some((m) => m.id === mod)) seen.add(`${mod}/${assetSlug(d)}`);
    }
  }
  return [...seen].map((k) => {
    const [mod, tag] = k.split('/');
    return { module: mod!, tag: tag! };
  });
}

export default async function Page({ params }: { params: Promise<{ module: string; tag: string }> }) {
  const { module, tag } = await params;
  return <UnitScreen module={module} tag={tag} />;
}
