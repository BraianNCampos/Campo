'use client';

import type { ReactNode } from 'react';
import type { Limit } from '@campo/shared';
import { metricMeta } from '@/lib/metrics';
import { deviationModel } from '@/lib/modules/deviation';
import { fmtNum } from '@/lib/modules/kpis';
import type { Scale } from '@/lib/modules/scale';
import type { Faceplate as FaceplateData, StsTone } from '@/lib/modules/unit';
import type { CardStatus } from '@/lib/modules/status';
import { DeviationBarView } from '../modules/DeviationBar';
import { RangeBar } from '../modules/RangeBar';
import { statusColor } from '../modules/StatusChip';
import { IconCritical, IconPause, IconPower, IconWarning } from '../icons';

const STS_ICON: Record<StsTone, typeof IconPower> = { idle: IconPause, active: IconPower, fault: IconCritical };

function Cell({ label, testid, children, wide }: { label: string; testid: string; children: ReactNode; wide?: boolean }) {
  return (
    <div data-testid={testid} className={`rounded-xl border border-line bg-bg px-3 py-2.5 ${wide ? 'col-span-2 sm:col-span-1' : ''}`}>
      <dt className="font-mono text-[11px] font-semibold tracking-wider text-muted">{label}</dt>
      <dd className="mt-0.5 min-h-8 text-xl leading-tight font-bold tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * Panel frontal (*faceplate*) de la unidad (ISA-101 nivel 3): PV, SP, OP, MODE y STS con barra de desviación respecto del
 * SP (o barra de rango si no hay SP). Cada variable lleva su sigla en monoespaciado.
 */
export function Faceplate({
  data, status, severity, metricLabelOf, scale, limits, name,
}: {
  data: FaceplateData;
  status: CardStatus;
  severity?: 'warning' | 'critical';
  metricLabelOf: string;
  scale: Scale | undefined;
  limits: readonly Limit[];
  name: string;
}) {
  const meta = metricMeta(data.pv.metric);
  const dev = scale ? deviationModel({ value: data.pv.value, setpoint: data.sp, limits, scale, alarm: status === 'alarm' }) : null;
  const StsIcon = STS_ICON[data.sts.tone];
  const noData = status === 'nodata' || data.pv.value === undefined;
  return (
    <section aria-label={`Panel frontal de ${name}`} data-testid="faceplate" className="rounded-2xl border border-line bg-surface p-4 md:p-5">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Cell label="PV · Valor de proceso" testid="fp-pv" wide>
          {noData ? (
            <span className="text-muted">Sin datos</span>
          ) : (
            <>
              <span className="font-mono text-[32px]">{fmtNum(data.pv.value, meta.decimals)}</span>
              {meta.unit && <span className="ml-1 text-base font-medium text-muted">{meta.unit}</span>}
            </>
          )}
        </Cell>
        <Cell label="SP · Setpoint" testid="fp-sp">
          {data.sp === undefined ? <span className="text-muted">—</span> : <><span className="font-mono">{fmtNum(data.sp, meta.decimals)}</span>{meta.unit && <span className="ml-1 text-sm font-medium text-muted">{meta.unit}</span>}</>}
        </Cell>
        <Cell label="OP · Salida" testid="fp-op">
          {data.op ? (
            <>
              <span className="font-mono">{fmtNum(data.op.value, 0)}</span>
              <span className="ml-1 text-sm font-medium text-muted">%</span>
              {data.op.source === 'valve' && <span className="block text-[11px] font-normal text-muted">apertura de la válvula</span>}
            </>
          ) : (
            <span className="text-muted">—</span>
          )}
        </Cell>
        <Cell label="MODE · Modo" testid="fp-mode">
          {data.mode ? data.mode.label : <span className="text-muted">—</span>}
        </Cell>
        <Cell label="STS · Estado" testid="fp-sts">
          <span className={`inline-flex items-center gap-1.5 ${data.sts.tone === 'fault' ? 'text-crit' : data.sts.tone === 'idle' ? 'text-muted' : ''}`} data-code={data.sts.code ?? ''}>
            {data.sts.code !== null && <StsIcon className="text-lg" />}
            {data.sts.label}
          </span>
        </Cell>
      </dl>

      {!noData && scale && (
        <div className="mt-4" data-testid="fp-bar">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted">
            {status === 'alarm' && <IconCritical className="text-sm text-crit" />}
            {status === 'near' && <IconWarning className="text-sm text-warn" />}
            Desviación respecto del SP · {metricLabelOf}
          </p>
          {dev ? (
            <DeviationBarView model={dev} label={`${metricLabelOf} de ${name}`} unit={meta.unit} decimals={meta.decimals} height={16} big />
          ) : (
            <RangeBar value={data.pv.value} scale={scale} limits={limits} color={statusColor(status, severity)} label={`${metricLabelOf} de ${name}`} unit={meta.unit} height={16} big />
          )}
          {!dev && <p className="mt-1 text-xs text-muted">Este equipo no tiene SP: mostramos el valor sobre su escala y los límites de alarma.</p>}
        </div>
      )}
    </section>
  );
}
