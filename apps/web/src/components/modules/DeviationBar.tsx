import type { Limit } from '@campo/shared';
import { deviationModel, deviationText, type DeviationModel, type DeviationState } from '@/lib/modules/deviation';
import type { Scale } from '@/lib/modules/scale';

const COLOR: Record<DeviationState, string> = {
  ok: 'var(--color-calm-bar)',
  near: 'var(--color-warn)',
  alarm: 'var(--color-crit)',
  nodata: 'var(--color-bad)',
};

const fmt = (v: number) => (Math.abs(v) >= 1000 ? Math.round(v).toString() : String(Math.round(v * 10) / 10));

/** Dibujo puro de un modelo ya calculado. */
export function DeviationBarView({
  model, label, unit = '', decimals = 1, height = 10, big = false,
}: {
  model: DeviationModel;
  label: string;
  unit?: string;
  decimals?: number;
  height?: number;
  big?: boolean;
}) {
  const text = deviationText(model, unit, decimals);
  const half = Math.abs(model.pos) * 50;
  const fill = model.pos < 0 ? { right: '50%', width: `${half}%` } : { left: '50%', width: `${half}%` };
  const valueNow = model.offset === undefined ? undefined : model.setpoint + model.offset;
  const min = model.low.at;
  const max = model.high.at;
  return (
    <div className="w-full" data-testid="deviation-bar" data-state={model.state} data-side={model.side}>
      <div
        role="meter"
        aria-label={`${label}: desviación respecto del SP`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={valueNow === undefined ? undefined : Math.min(max, Math.max(min, Math.round(valueNow * 10) / 10))}
        aria-valuetext={text}
        className="relative w-full overflow-hidden rounded-[3px] bg-bg ring-1 ring-line ring-inset"
        style={{ height }}
      >
        <div className="absolute top-0 h-full" data-testid="deviation-fill" style={{ ...fill, background: COLOR[model.state], transition: 'width 400ms ease-out' }} />
        {model.low.limit && <span data-testid="limit-mark" data-severity={model.low.limit.severity} className="absolute top-0 left-0 h-full w-[3px] bg-fg" aria-hidden="true" />}
        {model.high.limit && <span data-testid="limit-mark" data-severity={model.high.limit.severity} className="absolute top-0 right-0 h-full w-[3px] bg-fg" aria-hidden="true" />}
        <span data-testid="setpoint-mark" className="absolute top-0 left-1/2 h-full w-[2px] -translate-x-1/2 bg-fg" aria-hidden="true" />
      </div>
      <div className={`mt-1 grid grid-cols-3 font-mono text-muted tabular-nums ${big ? 'text-[length:inherit]' : 'text-[10.5px]'}`} aria-hidden="true">
        <span className="text-left">{model.low.limit ? `${model.low.tag} ${fmt(model.low.at)}` : ''}</span>
        <span className="text-center text-fg/90">SP {fmt(model.setpoint)}</span>
        <span className="text-right">{model.high.limit ? `${model.high.tag} ${fmt(model.high.at)}` : ''}</span>
      </div>
      <p className="sr-only">{text}</p>
    </div>
  );
}

/** Barra centrada en el SP (se calcula el modelo); `null` si no hay SP utilizable → el llamador usa la barra de rango. */
export function DeviationBar({
  value, setpoint, limits, scale, alarm, ...rest
}: {
  value: number | undefined;
  setpoint: number | undefined;
  limits: readonly Limit[];
  scale: Scale | undefined;
  alarm?: boolean;
  label: string;
  unit?: string;
  decimals?: number;
  height?: number;
  big?: boolean;
}) {
  const model = deviationModel({ value, setpoint, limits, scale, alarm });
  return model ? <DeviationBarView model={model} {...rest} /> : null;
}
