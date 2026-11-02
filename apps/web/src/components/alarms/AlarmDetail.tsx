'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ModuleId } from '@campo/shared';
import { METRICS } from '@campo/shared';
import type { AlarmJournalEntry } from '@/lib/admin/alarms-api';
import { lifecycleOf, type LiveAlarm } from '@/lib/alarm-lifecycle';
import { getAlarmsApi } from '@/live/alarm-api';
import { useLiveStore } from '@/store/live-store';
import { useLoad } from '../admin/hooks';
import { focusableIn, nextFocusTarget } from '../admin/focus';
import { ApiErrorAlert, LoadingBlock } from '../admin/ui';
import { IconCheck, IconClose, IconPause, IconRules } from '../icons';
import { KindBadge, LifecycleBadge, PriorityBadge } from './badges';
import { alarmTitle, effectiveKind, limitText, remainingText, trendHref, unitOf, valueText } from './model';

const EVENT_LABEL: Record<string, string> = {
  activated: 'Se activó',
  acknowledged: 'Reconocida',
  cleared: 'Volvió a normal',
  closed: 'Cerrada',
  shelved: 'Postergada',
  unshelved: 'Volvió a la lista',
  reannounced: 'Se avisó de nuevo',
  suppressed: 'Suprimida por estado',
};

const time = (ts: number) => new Date(ts).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function Section({ title, children, testid }: { title: string; children: React.ReactNode; testid?: string }) {
  return (
    <section data-testid={testid} className="border-t border-line pt-4">
      <h3 className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Journal({ id, lifecycle }: { id: string; lifecycle: string }) {
  const j = useLoad(() => getAlarmsApi().journal(id), [id, lifecycle]);
  if (j.error != null) return <ApiErrorAlert error={j.error} />;
  if (!j.data) return <LoadingBlock label="Cargando el diario…" />;
  if (j.data.length === 0) return <p className="text-sm text-muted">Todavía no hay movimientos registrados.</p>;
  return (
    <ol className="flex flex-col" data-testid="journal">
      {j.data.map((e: AlarmJournalEntry, i) => (
        <li key={`${e.ts}-${i}`} data-event={e.event} className="relative flex gap-3 pb-3 last:pb-0">
          <span aria-hidden className="mt-1.5 size-2.5 shrink-0 rounded-full border border-fg/60 bg-surface" />
          <div className="min-w-0 text-sm">
            <p className="font-semibold">{EVENT_LABEL[e.event] ?? e.event}</p>
            <p className="font-mono text-xs text-muted">{time(e.ts)}{e.actor ? ` · ${e.actor}` : ' · sistema'}</p>
            {e.detail && <p className="text-xs text-muted">{e.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface DetailProps {
  alarm: LiveAlarm;
  name: string;
  now: number;
  canAck: boolean;
  canShelve: boolean;
  canRules: boolean;
  catalog: Parameters<typeof trendHref>[1];
  modules: readonly ModuleId[];
  plant: string;
  onAck(id: string): void;
  onShelve(a: LiveAlarm): void;
  onUnshelve(a: LiveAlarm): void;
  onClose(): void;
}

/** Detalle de una alarma: panel lateral en escritorio, hoja inferior en móvil. Racionalización, valores, tendencia y diario. */
export function AlarmDetail(p: DetailProps) {
  const a = p.alarm;
  const life = lifecycleOf(a);
  const panel = useRef<HTMLDivElement>(null);
  const live = useLiveStore((s) => s.assets[a.asset]?.values[a.metric]);
  const closeRef = useRef(p.onClose);
  useEffect(() => {
    closeRef.current = p.onClose;
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      const el = panel.current;
      if (!el) return;
      // un diálogo abierto encima (postergar) maneja sus propias teclas
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-alarm-detail])')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
      } else if (e.key === 'Tab') {
        const next = nextFocusTarget(focusableIn(el), document.activeElement, e.shiftKey, el);
        if (next) {
          e.preventDefault();
          next.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  const r = a.rationale;
  const trend = trendHref(a, p.catalog, p.modules);
  const m = METRICS[a.metric];
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-end justify-end bg-black/60 lg:bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        data-alarm-detail
        data-testid="alarm-detail"
        aria-labelledby="alarm-detail-title"
        tabIndex={-1}
        className="flex max-h-[88dvh] w-full flex-col rounded-t-2xl border border-line bg-surface shadow-2xl lg:max-h-none lg:h-full lg:w-[27rem] lg:rounded-none lg:border-y-0 lg:border-r-0"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 pt-4 pb-3">
          <div className="min-w-0">
            <h2 id="alarm-detail-title" className="text-lg font-bold">{p.name}</h2>
            <p className="font-mono text-xs text-muted">{a.asset} · {m?.label ?? a.metric}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <PriorityBadge severity={a.severity} />
              <KindBadge kind={effectiveKind(a)} />
              <LifecycleBadge lifecycle={life} />
            </div>
          </div>
          <button type="button" aria-label="Cerrar detalle" data-autofocus onClick={p.onClose} className="-mt-1 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-lg text-xl text-muted hover:bg-surface-2 hover:text-fg">
            <IconClose />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <p className="text-base font-semibold" data-testid="detail-title">{alarmTitle(a)}</p>

          <Section title="Por qué importa" testid="rationale">
            {r?.consequence || r?.response ? (
              <dl className="flex flex-col gap-3 text-sm">
                {r.consequence && (
                  <div>
                    <dt className="font-semibold text-muted">Si no se atiende</dt>
                    <dd data-testid="rationale-consequence">{r.consequence}</dd>
                  </div>
                )}
                {r.response && (
                  <div>
                    <dt className="font-semibold text-muted">Qué hacer</dt>
                    <dd data-testid="rationale-response">{r.response}</dd>
                  </div>
                )}
              </dl>
            ) : (
              <p className="text-sm text-muted">
                Esta alarma todavía no tiene consecuencia ni acción indicadas.
                {p.canRules && (
                  <>
                    {' '}
                    <Link prefetch={false} href={`/admin/rules?plant=${encodeURIComponent(p.plant)}`} className="inline-flex min-h-11 items-center gap-1 font-semibold text-fg underline">
                      <IconRules className="text-base" /> Cargarlas en la regla
                    </Link>
                  </>
                )}
              </p>
            )}
          </Section>

          <Section title="Valores">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-muted">Al activarse</dt><dd className="font-mono text-base font-semibold tabular-nums">{valueText(a)}</dd></div>
              <div><dt className="text-muted">Ahora</dt><dd className="font-mono text-base font-semibold tabular-nums" data-testid="detail-live">{live === undefined ? '—' : `${live.toFixed(m?.decimals ?? 1)}${unitOf(a.metric) ? ` ${unitOf(a.metric)}` : ''}`}</dd></div>
              <div><dt className="text-muted">Límite</dt><dd className="font-mono tabular-nums">{limitText(a)}</dd></div>
              <div><dt className="text-muted">Regla</dt><dd className="truncate font-mono text-xs" title={a.ruleId}>{a.ruleId || '—'}</dd></div>
            </dl>
            {trend && (
              <Link prefetch={false} href={trend} data-testid="trend-link" className="mt-3 inline-flex min-h-11 items-center rounded-lg border border-line bg-surface-2 px-4 text-sm font-semibold hover:bg-line">
                Ver tendencia
              </Link>
            )}
          </Section>

          {life === 'shelved' && (
            <Section title="Postergada" testid="shelved-info">
              <p className="text-sm">{a.shelvedReason || 'Sin motivo registrado.'}</p>
              <p className="mt-1 text-xs text-muted">{remainingText(a.shelvedUntil, p.now)}{a.shelvedUntil ? ` · hasta ${time(a.shelvedUntil)}` : ''}</p>
            </Section>
          )}

          <Section title="Diario" testid="journal-section">
            <Journal id={a.id} lifecycle={life} />
          </Section>
        </div>

        {(life !== 'closed' && (p.canAck || p.canShelve)) && (
          <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3">
            {p.canAck && (life === 'unacked' || life === 'rtn_unacked') && (
              <button type="button" data-testid="detail-ack" onClick={() => p.onAck(a.id)} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-bold text-bg hover:brightness-110">
                <IconCheck className="text-lg" /> Reconocer
              </button>
            )}
            {p.canShelve && (life === 'unacked' || life === 'acked') && (
              <button type="button" data-testid="detail-shelve" onClick={() => p.onShelve(a)} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-line bg-surface-2 px-4 text-sm font-semibold hover:bg-line">
                <IconPause className="text-lg" /> Postergar
              </button>
            )}
            {p.canShelve && life === 'shelved' && (
              <button type="button" data-testid="detail-unshelve" onClick={() => p.onUnshelve(a)} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-line bg-surface-2 px-4 text-sm font-semibold hover:bg-line">
                Reactivar
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
