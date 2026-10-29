'use client';

import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AuditEntry } from '@campo/shared';
import { getAdminApi } from '@/lib/admin';
import { errorMessage } from '@/lib/admin/errors';
import { formatAbsoluteTime, formatRelativeTime, prettyJson } from '@/lib/admin/format';
import { IconAudit, IconChevron, IconRefresh } from '../icons';
import { useNow } from '../hooks';
import { RequireSection } from './AdminShell';
import { TextField } from './fields';
import { Alert, Badge, Button, card, cardList, EmptyState, ErrorState, LoadingBlock, PageHeader, tableWrap, td, th } from './ui';

const PAGE = 50;

export const ACTION_LABEL: Record<string, string> = {
  'user.create': 'Usuario creado',
  'user.update': 'Usuario modificado',
  'user.plants': 'Plantas de usuario',
  'user.revoke': 'Sesiones revocadas',
  'me.password': 'Cambio de contraseña',
  'plant.create': 'Planta creada',
  'plant.update': 'Planta renombrada',
  'plant.delete': 'Planta eliminada',
  'asset.create': 'Activo creado',
  'asset.update': 'Activo modificado',
  'asset.delete': 'Activo eliminado',
  'rule.create': 'Regla creada',
  'rule.update': 'Regla modificada',
  'rule.delete': 'Regla eliminada',
  'alarm.ack': 'Alarma reconocida',
};

const actionTone = (a: string) => (a.endsWith('.delete') || a === 'user.revoke' ? 'warning' : a.endsWith('.create') ? 'success' : 'neutral');

interface Page {
  key: string;
  entries: AuditEntry[];
  hasMore: boolean;
  error?: unknown;
}

function AuditContent() {
  const [draft, setDraft] = useState({ actor: '', action: '' });
  const [applied, setApplied] = useState({ actor: '', action: '' });
  const [tick, setTick] = useState(0);
  const key = `${tick}|${applied.actor}|${applied.action}`;
  const [page, setPage] = useState<Page>({ key: '', entries: [], hasMore: false });
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const now = useNow(30_000);

  useEffect(() => {
    let cancelled = false;
    getAdminApi()
      .listAudit({ limit: PAGE, actor: applied.actor || undefined, action: applied.action || undefined })
      .then(
        (entries) => !cancelled && setPage({ key, entries, hasMore: entries.length >= PAGE }),
        (error: unknown) => !cancelled && setPage({ key, entries: [], hasMore: false, error }),
      );
    return () => {
      cancelled = true;
    };
  }, [key, applied]);

  const loading = page.key !== key;
  const entries = loading ? [] : page.entries;

  const loadMore = useCallback(async () => {
    const last = page.entries[page.entries.length - 1];
    if (!last) return;
    setMoreBusy(true);
    setMoreError(null);
    try {
      const next = await getAdminApi().listAudit({ limit: PAGE, before: last.id, actor: applied.actor || undefined, action: applied.action || undefined });
      setPage((p) => ({ ...p, entries: [...p.entries, ...next], hasMore: next.length >= PAGE }));
    } catch (e) {
      setMoreError(errorMessage(e));
    } finally {
      setMoreBusy(false);
    }
  }, [page.entries, applied]);

  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });

  function apply(e: FormEvent) {
    e.preventDefault();
    setApplied({ actor: draft.actor.trim(), action: draft.action.trim() });
    setOpen(new Set());
  }

  const detailBtn = (e: AuditEntry) => (
    <Button onClick={() => toggle(e.id)} aria-expanded={open.has(e.id)} aria-controls={`audit-detail-${e.id}`} className="px-3">
      <IconChevron className={`text-base transition-transform ${open.has(e.id) ? 'rotate-90' : ''}`} />
      {open.has(e.id) ? 'Ocultar' : 'Detalle'}
      <span className="sr-only"> de {ACTION_LABEL[e.action] ?? e.action}</span>
    </Button>
  );
  const detail = (e: AuditEntry) =>
    open.has(e.id) && (
      <pre id={`audit-detail-${e.id}`} data-testid="audit-detail" className="overflow-x-auto rounded-lg border border-line bg-bg p-3 font-mono text-xs leading-relaxed">
        {prettyJson(e.detail)}
      </pre>
    );
  const when = (e: AuditEntry) => (
    <time dateTime={new Date(e.ts).toISOString()}>
      <span className="block font-semibold">{formatRelativeTime(e.ts, now)}</span>
      <span className="block text-xs text-muted">{formatAbsoluteTime(e.ts)}</span>
    </time>
  );
  const actionBadge = (e: AuditEntry) => (
    <span className="flex flex-col items-start gap-0.5">
      <Badge tone={actionTone(e.action)}>{ACTION_LABEL[e.action] ?? e.action}</Badge>
      <span className="font-mono text-xs text-muted">{e.action}</span>
    </span>
  );

  return (
    <>
      <PageHeader
        title="Auditoría"
        description="Quién hizo qué y cuándo. Registro de sólo lectura, sin contraseñas ni tokens."
        actions={
          <Button onClick={() => setTick((t) => t + 1)}>
            <IconRefresh className="text-base" /> Actualizar
          </Button>
        }
      />
      <form role="search" aria-label="Filtros de auditoría" onSubmit={apply} className="mb-4 grid gap-3 rounded-2xl border border-line bg-surface p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <TextField label="Actor" placeholder="correo o id de usuario" value={draft.actor} onChange={(e) => setDraft({ ...draft, actor: e.target.value })} autoComplete="off" />
        <div>
          <TextField label="Acción" placeholder="p. ej. user.create o asset." value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} list="audit-actions" autoComplete="off" autoCapitalize="none" />
          <datalist id="audit-actions">
            {Object.keys(ACTION_LABEL).map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" className="flex-1">
            Filtrar
          </Button>
          <Button
            onClick={() => {
              setDraft({ actor: '', action: '' });
              setApplied({ actor: '', action: '' });
            }}
          >
            Limpiar
          </Button>
        </div>
      </form>

      {page.error != null && !loading && <ErrorState error={page.error} onRetry={() => setTick((t) => t + 1)} />}
      {loading && <LoadingBlock label="Cargando auditoría…" />}
      {!loading && page.error == null && entries.length === 0 && (
        <EmptyState icon={<IconAudit />} title="Sin registros">
          {applied.actor || applied.action ? 'Ningún registro coincide con los filtros.' : 'Todavía no se ha registrado ninguna acción.'}
        </EmptyState>
      )}
      {entries.length > 0 && (
        <>
          <div className={tableWrap}>
            <table className="w-full" data-testid="audit-table">
              <caption className="sr-only">Registro de auditoría, más recientes primero</caption>
              <thead className="border-b border-line">
                <tr>
                  <th scope="col" className={th}>Cuándo</th>
                  <th scope="col" className={th}>Actor</th>
                  <th scope="col" className={th}>Acción</th>
                  <th scope="col" className={th}>Objetivo</th>
                  <th scope="col" className={`${th} text-right`}>Detalle</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {entries.map((e) => (
                  <Fragment key={e.id}>
                    <tr data-testid="audit-row">
                      <td className={td}>{when(e)}</td>
                      <td className={`${td} break-all`}>{e.actorEmail ?? <span className="text-muted">Sistema</span>}</td>
                      <td className={td}>{actionBadge(e)}</td>
                      <td className={`${td} font-mono text-xs break-all`}>{e.target}</td>
                      <td className={`${td} text-right`}>{detailBtn(e)}</td>
                    </tr>
                    {open.has(e.id) && (
                      <tr>
                        <td colSpan={5} className="bg-bg/40 px-3 pb-3">
                          {detail(e)}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <ul className={cardList}>
            {entries.map((e) => (
              <li key={e.id} className={card} data-testid="audit-card">
                <div className="flex items-start justify-between gap-2">
                  {actionBadge(e)}
                  <div className="text-right">{when(e)}</div>
                </div>
                <p className="mt-2 text-sm break-all">{e.actorEmail ?? <span className="text-muted">Sistema</span>}</p>
                <p className="font-mono text-xs break-all text-muted">{e.target}</p>
                <div className="mt-2 flex flex-col gap-2">
                  {detailBtn(e)}
                  {detail(e)}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-col items-center gap-2">
            {moreError && <Alert tone="error" className="w-full">{moreError}</Alert>}
            {page.hasMore ? (
              <Button onClick={() => void loadMore()} busy={moreBusy} className="w-full sm:w-auto">
                Cargar más
              </Button>
            ) : (
              <p className="text-sm text-muted">Fin del registro ({entries.length} {entries.length === 1 ? 'entrada' : 'entradas'}).</p>
            )}
          </div>
        </>
      )}
    </>
  );
}

export function AuditPanel() {
  return (
    <RequireSection section="audit">
      <AuditContent />
    </RequireSection>
  );
}
