'use client';

import { useId, useRef, useState, type DragEvent } from 'react';
import type { ModelInfo } from '@campo/shared';
import { getAdminApi } from '@/lib/admin';
import { errorMessage } from '@/lib/admin/errors';
import { formatBytes, MODEL_MAX_BYTES, modelNameFromFile, validateModelFile } from '@/lib/admin/models';
import { toast } from '@/store/toast-store';
import { IconUpload } from '../icons';
import { Alert } from './ui';

/**
 * Subida de un `.glb` a la planta: input accesible + arrastrar y soltar, validación en cliente (extensión y
 * tamaño) antes de enviar, barra de progreso y errores de la API (400/413) junto al control.
 */
export function ModelUploader({
  plant,
  onUploaded,
  compact = false,
}: {
  plant: string;
  onUploaded: (model: ModelInfo, created: boolean) => void;
  compact?: boolean;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ name: string; ratio: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  async function upload(file: File | undefined) {
    if (!file || busy) return;
    const problem = validateModelFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(true);
    setProgress({ name: file.name, ratio: 0 });
    try {
      const { model, created } = await getAdminApi().uploadModel(plant, file, modelNameFromFile(file.name), {
        onProgress: (loaded, total) => setProgress({ name: file.name, ratio: total > 0 ? loaded / total : 0 }),
      });
      toast.success(created ? `Modelo «${model.name}» subido.` : `El modelo «${model.name}» ya estaba en la planta (mismo contenido).`);
      onUploaded(model, created);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setProgress(null);
      if (input.current) input.current.value = ''; // permite volver a elegir el mismo archivo
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void upload(e.dataTransfer.files[0]);
  };
  const pct = Math.round((progress?.ratio ?? 0) * 100);

  return (
    <div className="flex flex-col gap-2" data-testid="model-uploader">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-3 text-center ${compact ? 'py-3' : 'py-5'} ${
          dragging ? 'border-accent bg-accent/10' : 'border-line bg-bg/40'
        }`}
      >
        {!compact && <IconUpload className="text-3xl text-muted" />}
        <p className="text-sm text-muted">
          Arrastrá acá un archivo <span className="font-mono">.glb</span> (máx. {formatBytes(MODEL_MAX_BYTES)}) o
        </p>
        <label
          htmlFor={inputId}
          className={`inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-line bg-surface-2 px-4 text-sm font-semibold hover:bg-line focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-accent ${
            busy ? 'pointer-events-none opacity-50' : ''
          }`}
        >
          <IconUpload className="text-base" /> Elegí un archivo .glb
          <input
            ref={input}
            id={inputId}
            type="file"
            accept=".glb,model/gltf-binary"
            disabled={busy}
            className="sr-only"
            onChange={(e) => void upload(e.target.files?.[0])}
          />
        </label>
      </div>
      {progress && (
        <div>
          <div className="mb-1 flex justify-between gap-2 text-xs text-muted">
            <span className="truncate">Subiendo {progress.name}…</span>
            <span className="font-mono tabular-nums">{pct} %</span>
          </div>
          <div
            role="progressbar"
            aria-label={`Subiendo ${progress.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="h-2 overflow-hidden rounded-full bg-surface-2"
          >
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      {error && (
        <Alert tone="error" onDismiss={() => setError(null)}>
          <span data-testid="upload-error">{error}</span>
        </Alert>
      )}
    </div>
  );
}
