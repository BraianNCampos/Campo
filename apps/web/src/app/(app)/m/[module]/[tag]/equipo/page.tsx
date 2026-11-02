import { MODULES } from '@campo/shared';
import { DEMO_ASSETS } from '@/lib/demo-seed';
import { assetSlug } from '@/lib/tags';
import { unitModule } from '@/lib/modules/unit';
import { EquipmentScreen } from '@/components/unit/EquipmentScreen';

/** Igual que el nivel 3: una página por equipo sembrado solo en la exportación estática de la demo. */
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
  return <EquipmentScreen module={module} tag={tag} />;
}
