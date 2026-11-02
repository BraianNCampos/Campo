'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { ASSET_KINDS } from '@campo/shared';
import { DEMO_LINKS } from '@/lib/demo-seed';
import { relatedAssets, relatedSummary, unitModule } from '@/lib/modules/unit';
import { assetHref, displayTag } from '@/lib/tags';
import { useLiveStore } from '@/store/live-store';
import { useActiveModuleIds } from '../modules/derived';
import { IconChevron, KIND_ICON } from '../icons';

function Row({ id }: { id: string }) {
  const def = useLiveStore((s) => s.catalog[id]);
  const values = useLiveStore((s) => s.assets[id]?.values);
  const active = useActiveModuleIds();
  if (!def) return null;
  const Icon = KIND_ICON[def.type];
  const mod = unitModule(def);
  const linkable = !!mod && active.includes(mod);
  const body = (
    <>
      <Icon className="shrink-0 text-xl text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">
          {def.name} <span className="font-mono text-[11px] font-medium text-muted" data-testid={`related-tag-${id}`}>{displayTag(id, def)}</span>
        </span>
        <span className="block text-xs text-muted">{ASSET_KINDS[def.type].label}</span>
      </span>
      <span className="text-right font-mono text-sm font-semibold tabular-nums" data-testid={`related-value-${id}`}>{relatedSummary(def, values)}</span>
      {linkable && <IconChevron className="shrink-0 text-base text-muted" />}
    </>
  );
  return (
    <li data-testid={`related-${id}`}>
      {linkable ? (
        <Link prefetch={false} href={assetHref(mod!, def)} className="flex min-h-11 items-center gap-3 rounded-xl border border-line bg-bg px-3 py-2 hover:bg-surface-2">
          {body}
        </Link>
      ) : (
        <div className="flex min-h-11 items-center gap-3 rounded-xl border border-line bg-bg px-3 py-2">{body}</div>
      )}
    </li>
  );
}

/** Válvulas, bombas y flujos asociados a la unidad (por `connectsTo` o por las cañerías de la demo), con su estado en vivo. */
export function RelatedList({ id }: { id: string }) {
  const catalog = useLiveStore((s) => s.catalog);
  const plant = useLiveStore((s) => s.plant);
  const ids = useMemo(() => relatedAssets(id, catalog, DEMO_LINKS[plant] ?? []), [id, catalog, plant]);
  return (
    <section aria-label="Válvulas y flujos asociados" data-testid="related" className="rounded-2xl border border-line bg-surface p-4 md:p-5">
      <h2 className="text-base font-bold">Válvulas y flujos asociados</h2>
      {ids.length === 0 ? (
        <p data-testid="related-empty" className="mt-2 text-sm text-muted">
          Este equipo no tiene válvulas, bombas ni caudalímetros asociados. Se asocian en Administración, en «Conectado a».
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {ids.map((r) => (
            <Row key={r} id={r} />
          ))}
        </ul>
      )}
    </section>
  );
}
