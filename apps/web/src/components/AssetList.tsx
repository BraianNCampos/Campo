'use client';

import { useMemo } from 'react';
import { kindLabel, kindPlural, primaryMetric, resolveKind, type AssetKind } from '@/lib/assets';
import { formatMetric } from '@/lib/metrics';
import { STATUS_META } from '@/lib/status';
import { useLiveStore } from '@/store/live-store';
import { useUiStore } from '@/store/ui-store';
import { EmptyAssets } from './EmptyAssets';
import { KIND_ICON, STATUS_ICON } from './icons';
import { UncatalogedTag } from './StatusBadge';
import { useAsset } from './useAsset';

function Row({ id }: { id: string }) {
  const { state, kind, status, name, uncataloged } = useAsset(id);
  const selected = useUiStore((s) => s.selectedId === id);
  const select = useUiStore((s) => s.select);
  const KIcon = KIND_ICON[kind];
  const SIcon = STATUS_ICON[status];
  const m = STATUS_META[status];
  const metric = primaryMetric(kind);
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => select(selected ? null : id)}
        data-testid={`asset-row-${id}`}
        className={`flex min-h-11 w-full items-center gap-3 rounded-xl border px-3 py-1.5 text-left transition-colors ${
          selected ? 'border-accent bg-accent/10' : 'border-transparent hover:bg-surface-2'
        }`}
      >
        <KIcon className="shrink-0 text-xl text-muted" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{name}</span>
          <span className={`flex flex-wrap items-center gap-x-1.5 text-xs font-medium ${m.text}`}>
            <span className="flex items-center gap-1" data-testid={`row-status-${id}`}>
              <SIcon className="text-sm" />
              {m.label}
            </span>
            {uncataloged && <UncatalogedTag />}
          </span>
        </span>
        {status !== 'nodata' && (
          <span data-testid={`row-value-${id}`} className="font-mono text-sm font-semibold tabular-nums">
            {formatMetric(metric, state?.values[metric])}
          </span>
        )}
      </button>
    </li>
  );
}

/** Lista de activos agrupada por tipo (escritorio). */
export function AssetList() {
  const ids = useLiveStore((s) => s.assetIds);
  const catalog = useLiveStore((s) => s.catalog);
  const groups = useMemo(() => {
    const out = new Map<AssetKind, string[]>();
    const { assets } = useLiveStore.getState(); // el tipo sólo se deduce de los valores para activos fuera del catálogo
    for (const id of ids) {
      const k = resolveKind(id, assets[id]?.values, catalog[id]?.type);
      out.set(k, [...(out.get(k) ?? []), id]);
    }
    return out;
  }, [ids, catalog]);
  return (
    <nav aria-label="Activos" className="flex h-full min-h-0 flex-col rounded-2xl border border-line bg-surface">
      <h2 className="px-4 pt-3 pb-1 text-sm font-semibold">Activos</h2>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {ids.length === 0 && <EmptyAssets />}
        {[...groups.entries()].map(([kind, list]) => (
          <section key={kind} aria-label={kindLabel(kind)}>
            <h3 className="px-2 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">{kindPlural(kind)}</h3>
            <ul className="flex flex-col gap-0.5">
              {list.map((id) => (
                <Row key={id} id={id} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  );
}
