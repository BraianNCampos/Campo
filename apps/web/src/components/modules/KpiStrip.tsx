import type { Kpi } from '@/lib/modules/kpis';

const TONE: Record<Kpi['tone'], string> = { neutral: 'text-fg', warn: 'text-warn', crit: 'text-crit' };

/** Franja de resumen: números grandes en mono, etiqueta pequeña. El color sólo aparece cuando un contador de atención es > 0. */
export function KpiStrip({ kpis, big = false }: { kpis: readonly Kpi[]; big?: boolean }) {
  if (kpis.length === 0) return null;
  return (
    <dl data-testid="kpi-strip" className={`grid gap-2 ${big ? 'grid-flow-col auto-cols-fr' : 'grid-cols-2 min-[900px]:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]'}`}>
      {kpis.map((k) => (
        <div key={k.key} data-testid={`kpi-${k.key}`} data-tone={k.tone} className={`rounded-xl border border-line bg-surface ${big ? 'px-[2vmin] py-[1.4vmin]' : 'px-4 py-3'} ${big ? '' : 'last:odd:col-span-2 min-[900px]:last:odd:col-span-1'}`}>
          <dt className={`font-semibold tracking-wide text-muted uppercase ${big ? 'text-[0.62em]' : 'text-[11px]'}`}>{k.label}</dt>
          <dd className={`mt-1 flex items-baseline gap-1.5 font-mono font-bold tabular-nums ${TONE[k.tone]} ${big ? 'text-[2.3em] leading-none' : 'text-[30px] leading-none'}`}>
            <span data-testid={`kpi-value-${k.key}`}>{k.value}</span>
            {k.unit && <span className={`font-sans font-medium text-muted ${big ? 'text-[0.4em]' : 'text-sm'}`}>{k.unit}</span>}
          </dd>
          {k.hint && <p className={`mt-1 truncate text-muted ${big ? 'text-[0.5em]' : 'text-xs'}`}>{k.hint}</p>}
        </div>
      ))}
    </dl>
  );
}
