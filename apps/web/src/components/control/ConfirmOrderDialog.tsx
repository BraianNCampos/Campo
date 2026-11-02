'use client';

import type { OrderCommand } from '@campo/shared';
import { COMMAND_LABEL, orderText } from '@/lib/control/flow';
import { Modal, ModalActions } from '../admin/Modal';
import { Alert, Button, Spinner } from '../admin/ui';
import { IconCheck, IconClock, IconCritical, IconLock, IconWarning } from '../icons';
import { useOrderFlow } from './useOrderFlow';

export interface OrderRequest {
  plant: string;
  asset: string;
  /** nombre y tag para el título */
  name: string;
  tag: string;
  command: OrderCommand;
  target?: number;
}

/**
 * Segundo paso de la orden (docs §14.3): muestra el resumen que calculó el servidor, las advertencias y, si hay, el
 * enclavamiento que la bloquea; la confirmación vale 60 s (cuenta regresiva) y recién «Confirmar» ejecuta.
 */
export function ConfirmOrderDialog({ req, onClose, now }: { req: OrderRequest; onClose: () => void; now?: () => number }) {
  const flow = useOrderFlow(req, now);
  const { status, preview, countdown } = flow;
  const stop = req.command === 'stop';
  const expired = !!countdown?.expired;
  const blocked = preview?.blocked ?? null;
  const busy = status === 'previewing' || status === 'executing';
  const canConfirm = status === 'ready' && !!preview && !blocked && !expired;
  const title = `${orderText(req)}: ${req.tag}`;

  return (
    <Modal title={title} onClose={onClose} closable={status !== 'executing'} size="sm" alert>
      <div data-testid="confirm-dialog" data-status={status} className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          {req.name} · <span className="font-mono">{req.tag}</span>
        </p>

        {status === 'previewing' && (
          <p role="status" className="flex items-center gap-3 text-sm text-muted">
            <Spinner className="size-5" /> Revisando si la orden se puede dar…
          </p>
        )}

        {status === 'error' && (
          <Alert tone="error" role="alert">
            <span data-testid="confirm-error">{flow.error}</span>
          </Alert>
        )}

        {preview && (status === 'ready' || status === 'executing') && (
          <>
            <p data-testid="confirm-summary" className="rounded-lg border border-line bg-bg px-3 py-2.5 text-base font-semibold">
              {preview.summary || orderText(req)}
            </p>

            {blocked ? (
              <Alert tone="error" role="alert">
                <span className="flex items-start gap-2" data-testid="confirm-blocked">
                  <IconLock className="mt-0.5 shrink-0 text-lg" />
                  <span>
                    <strong>No se puede dar esta orden.</strong> {blocked}
                  </span>
                </span>
              </Alert>
            ) : (
              preview.warnings.length > 0 && (
                <ul data-testid="confirm-warnings" className="flex flex-col gap-1.5" aria-label="Advertencias">
                  {preview.warnings.map((w, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-warn">
                      <IconWarning className="mt-0.5 shrink-0 text-base" /> <span className="text-fg">{w}</span>
                    </li>
                  ))}
                </ul>
              )
            )}

            {status === 'ready' && countdown && (
              <div data-testid="confirm-countdown" data-seconds={countdown.seconds} aria-live="off">
                <p className={`flex items-center gap-2 text-sm font-semibold ${expired ? 'text-crit' : 'text-muted'}`}>
                  <IconClock className="text-base" />
                  {expired ? 'La confirmación venció. Revisá la orden de nuevo.' : `Confirmá en ${countdown.seconds} s: después la orden vence.`}
                </p>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bg ring-1 ring-line ring-inset" aria-hidden="true">
                  <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${Math.round(countdown.fraction * 100)}%` }} />
                </div>
              </div>
            )}
          </>
        )}

        {status === 'done' && (
          <Alert tone="success" role="status">
            <span data-testid="confirm-done" className="flex items-center gap-2">
              <IconCheck className="text-base" /> Orden enviada. Seguí su avance en el registro.
            </span>
          </Alert>
        )}

        <ModalActions>
          {status === 'done' ? (
            <Button variant="primary" onClick={onClose} data-autofocus="">
              Listo
            </Button>
          ) : (
            <>
              <Button onClick={onClose} disabled={status === 'executing'}>
                Cancelar
              </Button>
              {(status === 'error' || expired) && (
                <Button onClick={flow.reload} data-testid="confirm-reload">
                  Revisar de nuevo
                </Button>
              )}
              {status !== 'error' && (
                <Button
                  variant={stop ? 'danger' : 'primary'}
                  disabled={!canConfirm}
                  busy={busy}
                  onClick={flow.confirm}
                  data-testid="confirm-go"
                >
                  {stop ? <IconCritical className="text-base" /> : null}
                  {stop ? 'Detener ahora' : `Confirmar y ${COMMAND_LABEL[req.command].toLowerCase()}`}
                </Button>
              )}
            </>
          )}
        </ModalActions>
      </div>
    </Modal>
  );
}
