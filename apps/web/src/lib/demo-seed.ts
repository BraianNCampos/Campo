import type { AssetDef, AssetType, Limit } from '@campo/shared';

/**
 * Catálogo y límites de los clientes de demostración (modo demo sin backend). Coinciden con las semillas
 * SQL de `060_orgs.sql` (docs/architecture.md §11.3). Compartido por el stream simulado y el MockAdminApi.
 */
const a = (plant: string, id: string, name: string, type: AssetType, metadata: Record<string, unknown> = {}, model3dRef: string | null = null): AssetDef => ({
  plant, id, name, type, model3dRef, metadata,
});

export const DEMO_ASSETS: Record<string, AssetDef[]> = {
  demo: [
    a('demo', 'tk-01', 'Tanque 01', 'tank', { capacityM3: 60 }, 'tank'), // 'tank' = valor antiguo de texto libre (se trata como sin modelo)
    a('demo', 'tk-02', 'Tanque 02', 'tank', { capacityM3: 60 }),
    a('demo', 'tk-03', 'Tanque 03', 'tank', { capacityM3: 60 }),
    a('demo', 'tk-04', 'Tanque 04', 'tank', { capacityM3: 60 }),
    a('demo', 'pump-01', 'Bomba 01', 'pump'),
    a('demo', 'pump-02', 'Bomba 02', 'pump'),
    a('demo', 'valve-01', 'Válvula 01', 'valve'),
    a('demo', 'valve-02', 'Válvula 02', 'valve'),
    a('demo', 'clima-01', 'Cámara 1', 'climate'),
    a('demo', 'clima-02', 'Depósito de insumos', 'climate'),
    a('demo', 'en-linea1', 'Línea de producción 1', 'energy', { contractedKw: 220 }),
    a('demo', 'en-compresores', 'Compresores', 'energy', { contractedKw: 130 }),
    a('demo', 'en-clima', 'Climatización y frío', 'energy', { contractedKw: 118 }),
    a('demo', 'en-calderas', 'Calderas y hornos', 'energy', { contractedKw: 90 }),
    a('demo', 'gas-01', 'Gas natural', 'gas'),
    a('demo', 'maq-01', 'Envasadora', 'machine'),
    a('demo', 'maq-02', 'Cinta transportadora', 'machine'),
    a('demo', 'maq-03', 'Mezcladora', 'machine'),
    a('demo', 'pres-01', 'Presión de aire comprimido', 'pressure'),
    a('demo', 'cau-01', 'Agua de proceso', 'flow'),
  ],
  tanques: [
    a('tanques', 'tk-a', 'Agua de proceso', 'tank', { capacityM3: 40 }),
    a('tanques', 'tk-b', 'Gasoil', 'tank', { capacityM3: 40 }),
  ],
};

const lim = (asset: string, metric: string, operator: Limit['operator'], threshold: number, severity: Limit['severity']): Limit => ({
  asset, metric, operator, threshold, severity,
});

export const DEMO_LIMITS: Record<string, Limit[]> = {
  demo: [
    ...['tk-01', 'tk-02', 'tk-03', 'tk-04'].flatMap((id) => [
      lim(id, 'level', 'gt', 90, 'critical'),
      lim(id, 'level', 'lt', 10, 'warning'),
      lim(id, 'temp', 'gt', 35, 'warning'),
    ]),
    ...['clima-01', 'clima-02'].flatMap((id) => [lim(id, 'temp', 'gt', 30, 'warning'), lim(id, 'humidity', 'gt', 80, 'warning')]),
    lim('en-linea1', 'kw', 'gt', 198, 'warning'), lim('en-linea1', 'kw', 'gt', 220, 'critical'),
    lim('en-compresores', 'kw', 'gt', 117, 'warning'), lim('en-compresores', 'kw', 'gt', 130, 'critical'),
    lim('en-clima', 'kw', 'gt', 106, 'warning'), lim('en-clima', 'kw', 'gt', 118, 'critical'),
    lim('en-calderas', 'kw', 'gt', 81, 'warning'), lim('en-calderas', 'kw', 'gt', 90, 'critical'),
    lim('pres-01', 'pressure', 'gt', 8, 'critical'), lim('pres-01', 'pressure', 'lt', 2, 'warning'),
  ],
  tanques: ['tk-a', 'tk-b'].flatMap((id) => [lim(id, 'level', 'gt', 90, 'critical'), lim(id, 'level', 'lt', 10, 'warning')]),
};
