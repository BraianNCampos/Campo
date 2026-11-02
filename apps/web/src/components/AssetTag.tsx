'use client';

import { displayTag } from '@/lib/tags';
import { useLiveStore } from '@/store/live-store';

/** Tag del activo (`TNK-101`) en monoespaciado; sin tag, su id técnico. Va junto al nombre en toda la interfaz. */
export function AssetTag({ id, className = '' }: { id: string; className?: string }) {
  const tag = useLiveStore((s) => displayTag(id, s.catalog[id]));
  return (
    <span data-testid={`tag-${id}`} data-tag={tag} className={`font-mono text-[11px] font-medium tracking-wide text-muted ${className}`}>
      {tag}
    </span>
  );
}
