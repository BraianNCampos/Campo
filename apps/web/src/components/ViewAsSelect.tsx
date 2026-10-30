'use client';

import { useState } from 'react';
import { config } from '@/lib/env';
import { currentViewAs, switchViewAs, VIEW_AS_OPTIONS, type ViewAs } from '@/lib/view-as';

/**
 * Selector «Ver como» del modo demo: cambia el cliente con el que se mira Campo (o entra como personal de plataforma).
 * Sólo existe en modo demo. Cambiar recarga el estado (sesión, plantas y stream).
 */
export function ViewAsSelect({ className = '' }: { className?: string }) {
  const [value] = useState<ViewAs>(() => currentViewAs());
  if (!config.mock) return null;
  return (
    <label className={`flex flex-col gap-1 text-xs font-semibold text-muted ${className}`}>
      Ver como
      <select
        data-testid="view-as"
        defaultValue={value}
        onChange={(e) => switchViewAs(e.target.value as ViewAs)}
        className="min-h-11 w-full rounded-lg border border-line bg-bg px-2 text-sm font-semibold text-fg"
      >
        {VIEW_AS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
