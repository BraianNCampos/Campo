'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { AssetDef, AssetType } from '@campo/shared';
import { getAdminApi, ASSET_TYPES } from '@/lib/admin';
import { prettyJson } from '@/lib/admin/format';
import { validateAssetForm, type AssetForm, type FieldErrors, parseMetadata } from '@/lib/admin/validation';
import { usePlantStore } from '@/store/plant-store';
import { useSessionStore } from '@/store/session-store';
import { toast } from '@/store/toast-store';
import { IconBack, IconEdit, IconGrid, IconPlus, IconPump, IconTank, IconTrash, IconValve } from '../icons';
import { RequireSection } from './AdminShell';
import { SelectField, TextAreaField, TextField } from './fields';
import { useLoad, useSubmit } from './hooks';
import { ConfirmDialog, Modal, ModalActions } from './Modal';
import { Alert, ApiErrorAlert, Button, btn, card, cardList, EmptyState, ErrorState, LoadingBlock, PageHeader, tableWrap, td, th } from './ui';

export const TYPE_LABEL: Record<AssetType, string> = { tank: 'Tanque', pump: 'Bomba', valve: 'Válvula', sensor: 'Sensor' };
const TYPE_ICON: Record<AssetType, typeof IconTank> = { tank: IconTank, pump: IconPump, valve: IconValve, sensor: IconGrid };

function AssetDialog({ plant, asset, onClose, onSaved }: { plant: string; asset?: AssetDef; onClose: () => void; onSaved: (a: AssetDef) => void }) {
  const editing = !!asset;
  const [form, setForm] = useState<AssetForm>({
    id: asset?.id ?? '',
    name: asset?.name ?? '',
    type: asset?.type ?? 'tank',
    model3dRef: asset?.model3dRef ?? '',
    metadataText: asset && Object.keys(asset.metadata).length > 0 ? prettyJson(asset.metadata) : '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [metaTouched, setMetaTouched] = useState(false);
  const { busy, error, run } = useSubmit();
  const set = <K extends keyof AssetForm>(k: K, v: AssetForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const liveMeta = parseMetadata(form.metadataText);
  const metaError = (metaTouched || errors.metadata) && !liveMeta.ok ? liveMeta.error : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { errors: errs, value } = validateAssetForm(form, { editing });
    setErrors(errs);
    setMetaTouched(true);
    if (!value) return;
    const api = getAdminApi();
    const saved = await run(() =>
      asset
        ? api.updateAsset(plant, asset.id, { name: value.name, type: value.type, model3dRef: value.model3dRef, metadata: value.metadata })
        : api.createAsset(plant, value),
    );
    if (saved) {
      toast.success(editing ? `Activo ${saved.id} actualizado.` : `Activo ${saved.id} creado.`);
      onSaved(saved);
      onClose();
    }
  }

  return (
    <Modal title={editing ? `Editar activo ${asset.id}` : 'Nuevo activo'} onClose={onClose} closable={!busy}>
      <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        <TextField
          label="Id"
          value={form.id}
          onChange={(e) => set('id', e.target.value)}
          disabled={editing}
          error={errors.id}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          hint={editing ? 'El id no se puede cambiar una vez creado.' : 'Es el que publica el sensor en MQTT (p. ej. tk-05). No se podrá cambiar.'}
          data-autofocus={editing ? undefined : ''}
        />
        <TextField label="Nombre" value={form.name} onChange={(e) => set('name', e.target.value)} error={errors.name} autoComplete="off" data-autofocus={editing ? '' : undefined} />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="Tipo" value={form.type} onChange={(e) => set('type', e.target.value as AssetType)} error={errors.type}>
            {ASSET_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </SelectField>
          <TextField label="Modelo 3D (opcional)" value={form.model3dRef} onChange={(e) => set('model3dRef', e.target.value)} error={errors.model3dRef} autoComplete="off" placeholder="tank" />
        </div>
        <TextAreaField
          label="Metadatos (JSON)"
          rows={5}
          value={form.metadataText}
          onChange={(e) => set('metadataText', e.target.value)}
          onBlur={() => setMetaTouched(true)}
          error={metaError}
          spellCheck={false}
          placeholder='{"capacityL": 5000}'
          hint="Objeto JSON con datos libres del equipo. Déjalo vacío para {}."
        />
        <ApiErrorAlert error={error} />
        <ModalActions>
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {editing ? 'Guardar cambios' : 'Crear activo'}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function AssetsContent() {
  const plantId = decodeURIComponent(String(useParams<{ plant: string }>().plant ?? ''));
  const role = useSessionStore((s) => s.me?.role);
  const plantName = usePlantStore((s) => s.plants.find((p) => p.id === plantId)?.name);
  const assets = useLoad(() => getAdminApi().listAssets(plantId), [plantId]);
  const [dialog, setDialog] = useState<{ kind: 'edit'; asset: AssetDef } | { kind: 'create' } | { kind: 'delete'; asset: AssetDef } | null>(null);
  const [notice, setNotice] = useState<{ id: string; rules: number } | null>(null);
  const list = assets.data;

  const refresh = () => void useSessionStore.getState().refreshPlants();
  const upsert = (a: AssetDef) => {
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
          (role === 'admin' || role === 'engineer') && (
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
                      <td className={`${td} font-mono text-muted`}>{a.model3dRef ?? '—'}</td>
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
                    {a.model3dRef ? <> · modelo <span className="font-mono">{a.model3dRef}</span></> : null}
                  </p>
                  {Object.keys(a.metadata).length > 0 && <p className="mt-1 font-mono text-xs break-all text-muted">{JSON.stringify(a.metadata)}</p>}
                  <div className="mt-3 grid grid-cols-2 gap-2">{rowActions(a)}</div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {dialog?.kind === 'create' && <AssetDialog plant={plantId} onClose={() => setDialog(null)} onSaved={upsert} />}
      {dialog?.kind === 'edit' && <AssetDialog plant={plantId} asset={dialog.asset} onClose={() => setDialog(null)} onSaved={upsert} />}
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
