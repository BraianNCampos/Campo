import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** GLB de ejemplo (examples/models) como ArrayBuffer independiente. */
export function sampleGlb(name: 'sample-tank' | 'sample-pump' | 'sample-valve' | 'sample-static'): ArrayBuffer {
  const buf = readFileSync(resolve(here, '../../../../../examples/models', `${name}.glb`));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
