'use client';

import { useMemo, useState } from 'react';
import type { AssetDef, ModelInfo } from '@campo/shared';
import { getAdminApi } from '@/lib/admin';
import { formatBytes, modelUsage } from '@/lib/admin/models';
import { toast } from '@/store/toast-store';
import { IconCube, IconTrash } from '../icons';
import { ModelUploader } from './ModelUploader';
import { ConfirmDialog } from './Modal';
import type { Loaded } from './hooks';
import { Button, card, cardList, EmptyState, ErrorState, LoadingBlock, tableWrap, td, th } from './ui';

const when = (ts: number) => new Date(ts).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });

/** Modelos 3D (GLB) de la planta: lista con uso, subida y borrado con confirmación. */
export function ModelsPanel({
  plant,
  models,
  assets,
  canEdit,
  onChanged,
}: {
  plant: string;
  models: Loaded<ModelInfo[]>;
  assets: readonly AssetDef[] | undefined;
  canEdit: boolean;
  onChanged: (list: (prev: ModelInfo[]) => ModelInfo[]) => void;
}) {
  const [deleting, setDeleting] = useState<ModelInfo | null>(null);
  const usage = useMemo(() => modelUsage(assets ?? []), [assets]);
  const list = models.data;

  const remove = (m: ModelInfo) => (
    <Button variant="danger" onClick={() => setDeleting(m)} aria-label={`Eliminar modelo ${m.name}`}>
      <IconTrash className="text-base" /> Eliminar
    </Button>
  );
  const uses = (m: ModelInfo) => usage[m.id] ?? [];

  return (
    <section aria-labelledby="models-title" data-testid="models-panel" className="mt-8">
      <div className="mb-3">
        <h3 id="models-title" className="text-xl font-bold tracking-tight">
          Modelos 3D
        </h3>
        <p className="mt-1 text-sm text-muted">
          Archivos GLB de la planta. Cada activo puede usar uno en su formulario; si no, se dibuja el modelo genérico de su tipo.
        </p>
      </div>

      {canEdit && (
        <div className="mb-4">
          <ModelUploader plant={plant} onUploaded={(m) => onChanged((prev) => [m, ...prev.filter((x) => x.id !== m.id)])} />
        </div>
      )}

      {models.error != null && <ErrorState error={models.error} onRetry={models.reload} />}
      {models.loading && !list && models.error == null && <LoadingBlock label="Cargando modelos…" />}
      {list && list.length === 0 && (
        <EmptyState icon={<IconCube />} title="Esta planta no tiene modelos 3D">
          Sube un archivo .glb para usarlo en un activo.
        </EmptyState>
      )}
      {list && list.length > 0 && (
        <>
          <div className={tableWrap}>
            <table className="w-full" data-testid="models-table">
              <caption className="sr-only">Modelos 3D de la planta {plant}</caption>
              <thead className="border-b border-line">
                <tr>
                  <th scope="col" className={th}>Nombre</th>
                  <th scope="col" className={th}>Tamaño</th>
                  <th scope="col" className={th}>Subido</th>
                  <th scope="col" className={th}>Activos</th>
                  {canEdit && <th scope="col" className={`${th} text-right`}>Acciones</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.map((m) => (
                  <tr key={m.id} data-testid={`model-row-${m.id}`}>
                    <td className={`${td} font-semibold`}>{m.name}</td>
                    <td className={`${td} font-mono tabular-nums`}>{formatBytes(m.size)}</td>
                    <td className={`${td} text-muted`}>{when(m.createdAt)}</td>
                    <td className={td} title={uses(m).join(', ')}>
                      {uses(m).length}
                    </td>
                    {canEdit && (
                      <td className={td}>
                        <div className="flex justify-end">{remove(m)}</div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className={cardList}>
            {list.map((m) => (
              <li key={m.id} className={card} data-testid={`model-card-${m.id}`}>
                <p className="flex items-center gap-2 text-base font-semibold break-all">
                  <IconCube className="shrink-0 text-xl text-muted" /> {m.name}
                </p>
                <p className="text-sm text-muted">
                  {formatBytes(m.size)} · {when(m.createdAt)} · {uses(m).length} {uses(m).length === 1 ? 'activo' : 'activos'}
                </p>
                {canEdit && <div className="mt-3 grid">{remove(m)}</div>}
              </li>
            ))}
          </ul>
        </>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Eliminar modelo ${deleting.name}`}
          description={
            uses(deleting).length > 0
              ? `Lo usan ${uses(deleting).join(', ')}: la API no permitirá borrarlo hasta que cambies su modelo 3D.`
              : 'Se borra el archivo de la planta. Esta acción no se puede deshacer.'
          }
          confirmLabel="Eliminar modelo"
          onConfirm={async () => {
            await getAdminApi().deleteModel(plant, deleting.id);
            onChanged((prev) => prev.filter((x) => x.id !== deleting.id));
            toast.success(`Modelo «${deleting.name}» eliminado.`);
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
