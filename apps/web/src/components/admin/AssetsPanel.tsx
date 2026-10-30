'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { AssetDef, AssetType, ModelInfo } from '@campo/shared';
import { getAdminApi } from '@/lib/admin';
import { modelIdOf, parseConnectsTo, parseLayout } from '@/lib/catalog';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { IconBack, IconEdit, IconGrid, IconPlus, IconPump, IconTank, IconTrash, IconValve } from '../icons';
import { RequireSection } from './AdminShell';
import { AssetDialog, TYPE_LABEL } from './AssetDialog';
import { useLoad } from './hooks';
import { ConfirmDialog } from './Modal';
import { ModelsPanel } from './ModelsPanel';
import { PlantPreview } from './PlantPreview';
import { Alert, Button, btn, card, cardList, EmptyState, ErrorState, LoadingBlock, PageHeader, tableWrap, td, th } from './ui';

const TYPE_ICON: Record<AssetType, typeof IconTank> = { tank: IconTank, pump: IconPump, valve: IconValve, sensor: IconGrid };

function AssetsContent() {
  const plantId = decodeURIComponent(String(useParams<{ plant: string }>().plant ?? ''));
  const role = useSessionStore((s) => s.me?.role);
  const plantName = usePlantStore((s) => s.plants.find((p) => p.id === plantId)?.name);
  const assets = useLoad(() => getAdminApi().listAssets(plantId), [plantId]);
  const models = useLoad(() => getAdminApi().listModels(plantId), [plantId]);
  const [dialog, setDialog] = useState<{ kind: 'edit'; asset: AssetDef } | { kind: 'create' } | { kind: 'delete'; asset: AssetDef } | null>(null);
  const [notice, setNotice] = useState<{ id: string; rules: number } | null>(null);
  const [warnings, setWarnings] = useState<{ id: string; items: string[] } | null>(null);
  const list = assets.data;
  const canEdit = role === 'admin' || role === 'engineer';
  const modelName = (ref: string | null) => {
    const id = modelIdOf(ref);
    return id ? (models.data?.find((m) => m.id === id)?.name ?? 'Modelo no encontrado') : 'Procedural'; // null o valor antiguo = procedural
  };
  const placement = (a: AssetDef) => {
    const l = parseLayout(a.metadata);
    const n = parseConnectsTo(a.metadata).length;
    return `${l ? `X ${l.x} · Z ${l.z}` : 'Automática'}${n > 0 ? ` · ${n} ${n === 1 ? 'conexión' : 'conexiones'}` : ''}`;
  };
  const addModel = (m: ModelInfo) => models.setData((prev) => [m, ...(prev ?? []).filter((x) => x.id !== m.id)]);

  const refresh = () => void useSessionStore.getState().refreshPlants();
  const upsert = (a: AssetDef, warn: string[] = []) => {
    setWarnings(warn.length > 0 ? { id: a.id, items: warn } : null);
    assets.setData((prev) => {
      const rest = (prev ?? []).filter((x) => x.id !== a.id);
      return [...rest, a].sort((x, y) => x.id.localeCompare(y.id, 'en', { numeric: true }));
    });
    refresh();
  };

  const rowActions = (a: AssetDef) => (
    <>
      <Button onClick={() => setDialog({ kind: 'edit', asset: a })} aria-label={`Editar ${a.id}`}>
        <IconEdit className="text-base" /> Editar
      </Button>
      <Button variant="danger" onClick={() => setDialog({ kind: 'delete', asset: a })} aria-label={`Eliminar ${a.id}`}>
        <IconTrash className="text-base" /> Eliminar
      </Button>
    </>
  );

  return (
    <>
      <Link href="/admin/plants" className={btn('ghost', '-ml-3 mb-1')}>
        <IconBack className="text-base" /> Plantas
      </Link>
      <PageHeader
        title={`Activos de ${plantName ?? plantId}`}
        description={
          <>
            Planta <span className="font-mono">{plantId}</span>. Los sensores publican por MQTT con el id del activo.
          </>
        }
        actions={
          canEdit && (
            <Button variant="primary" onClick={() => setDialog({ kind: 'create' })}>
              <IconPlus className="text-lg" /> Nuevo activo
            </Button>
          )
        }
      />
      {notice && (
        <Alert tone={notice.rules > 0 ? 'warning' : 'success'} onDismiss={() => setNotice(null)} className="mb-4" role="status">
          <span data-testid="affected-rules">
            Activo <span className="font-mono">{notice.id}</span> eliminado.{' '}
            {notice.rules > 0 ? (
              <>
                {notice.rules} {notice.rules === 1 ? 'regla de alarma lo nombra' : 'reglas de alarma lo nombran'} y {notice.rules === 1 ? 'sigue existiendo' : 'siguen existiendo'}:{' '}
                <Link href="/admin/rules" className="underline">revísalas en Reglas de alarma</Link>.
              </>
            ) : (
              'Ninguna regla de alarma lo nombraba.'
            )}
          </span>
        </Alert>
      )}
      {warnings && (
        <Alert tone="warning" onDismiss={() => setWarnings(null)} className="mb-4" role="status">
          <span data-testid="asset-warnings">
            Activo <span className="font-mono">{warnings.id}</span> guardado con avisos:
            <ul className="mt-1 list-disc space-y-0.5 pl-5 font-normal">
              {warnings.items.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </span>
        </Alert>
      )}
      <PlantPreview assets={list} />
      {assets.error != null && <ErrorState error={assets.error} onRetry={assets.reload} />}
      {assets.loading && !list && assets.error == null && <LoadingBlock label="Cargando activos…" />}
      {list && list.length === 0 && (
        <EmptyState icon={<IconTank />} title="Esta planta no tiene activos">Añade el primero con «Nuevo activo».</EmptyState>
      )}
      {list && list.length > 0 && (
        <>
          <div className={tableWrap}>
            <table className="w-full" data-testid="assets-table">
              <caption className="sr-only">Activos de la planta {plantId}</caption>
              <thead className="border-b border-line">
                <tr>
                  <th scope="col" className={th}>Id</th>
                  <th scope="col" className={th}>Nombre</th>
                  <th scope="col" className={th}>Tipo</th>
                  <th scope="col" className={th}>Modelo 3D</th>
                  <th scope="col" className={th}>Disposición</th>
                  <th scope="col" className={th}>Metadatos</th>
                  <th scope="col" className={`${th} text-right`}>Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.map((a) => {
                  const Icon = TYPE_ICON[a.type];
                  return (
                    <tr key={a.id} data-testid={`asset-row-${a.id}`}>
                      <td className={`${td} font-mono`}>{a.id}</td>
                      <td className={`${td} font-semibold`}>{a.name}</td>
                      <td className={td}>
                        <span className="inline-flex items-center gap-1.5">
                          <Icon className="text-lg text-muted" /> {TYPE_LABEL[a.type]}
                        </span>
                      </td>
                      <td className={`${td} text-muted`}>{modelName(a.model3dRef)}</td>
                      <td className={`${td} text-muted`}>{placement(a)}</td>
                      <td className={`${td} max-w-56 truncate font-mono text-xs text-muted`} title={JSON.stringify(a.metadata)}>
                        {Object.keys(a.metadata).length ? JSON.stringify(a.metadata) : '—'}
                      </td>
                      <td className={td}>
                        <div className="flex flex-wrap justify-end gap-2">{rowActions(a)}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className={cardList}>
            {list.map((a) => {
              const Icon = TYPE_ICON[a.type];
              return (
                <li key={a.id} className={card} data-testid={`asset-card-${a.id}`}>
                  <p className="flex items-center gap-2 text-base font-semibold">
                    <Icon className="text-xl text-muted" /> {a.name}
                  </p>
                  <p className="text-sm text-muted">
                    <span className="font-mono">{a.id}</span> · {TYPE_LABEL[a.type]}
                  </p>
                  <p className="text-sm text-muted">
                    Modelo: {modelName(a.model3dRef)} · {placement(a)}
                  </p>
                  {Object.keys(a.metadata).length > 0 && <p className="mt-1 font-mono text-xs break-all text-muted">{JSON.stringify(a.metadata)}</p>}
                  <div className="mt-3 grid grid-cols-2 gap-2">{rowActions(a)}</div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <ModelsPanel
        plant={plantId}
        models={models}
        assets={list}
        canEdit={canEdit}
        onChanged={(update) => models.setData((prev) => update(prev ?? []))}
      />
      {(dialog?.kind === 'create' || dialog?.kind === 'edit') && (
        <AssetDialog
          plant={plantId}
          asset={dialog.kind === 'edit' ? dialog.asset : undefined}
          assets={list ?? []}
          models={models.data ?? []}
          onClose={() => setDialog(null)}
          onSaved={upsert}
          onModelUploaded={addModel}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={`Eliminar activo ${dialog.asset.id}`}
          description="Se borra del catálogo. Las reglas de alarma que lo nombren seguirán existiendo; te diremos cuántas."
          confirmLabel="Eliminar activo"
          onConfirm={async () => {
            const { affectedRules } = await getAdminApi().deleteAsset(plantId, dialog.asset.id);
            assets.setData((prev) => (prev ?? []).filter((x) => x.id !== dialog.asset.id));
            setNotice({ id: dialog.asset.id, rules: affectedRules });
            refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

export function AssetsPanel() {
  return (
    <RequireSection section="plants">
      <AssetsContent />
    </RequireSection>
  );
}
