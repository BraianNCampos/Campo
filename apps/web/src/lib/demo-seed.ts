import type { AssetDef, AssetType, Limit } from '@campo/shared';

/**
 * Catálogo y límites de los clientes de demostración (modo demo sin backend). Coinciden con las semillas
 * SQL de `060_orgs.sql` (docs/architecture.md §11.3). Compartido por el stream simulado y el MockAdminApi.
 * `metadata.setpoints` (docs §12.4): nivel 60 % en tanques, temperatura 20 °C en clima, presión 6 bar en `pres-01`;
 * los simuladores (`PlantSimulator`, `SeedSimulator`) oscilan alrededor de estos valores.
 */
const a = (plant: string, id: string, name: string, type: AssetType, metadata: Record<string, unknown> = {}, model3dRef: string | null = null, tag?: string): AssetDef => ({
  plant, id, name, type, model3dRef, metadata, ...(tag ? { tag } : {}),
});

/** Control de llenado habilitado (docs §14.5): mínimo 10 %, máximo 90 %. */
const CONTROL_ON = { enabled: true, minTarget: 10, maxTarget: 90 } as const;

export const DEMO_ASSETS: Record<string, AssetDef[]> = {
  demo: [
    a('demo', 'tk-01', 'Tanque 01', 'tank', { capacityM3: 60, setpoints: { level: 60 }, control: { ...CONTROL_ON } }, 'tank', 'TNK-101'), // 'tank' = valor antiguo de texto libre (se trata como sin modelo)
    a('demo', 'tk-02', 'Tanque 02', 'tank', { capacityM3: 60, setpoints: { level: 60 }, control: { ...CONTROL_ON } }, null, 'TNK-102'),
    a('demo', 'tk-03', 'Tanque 03', 'tank', { capacityM3: 60, setpoints: { level: 60 }, control: { ...CONTROL_ON } }, null, 'TNK-103'),
    a('demo', 'tk-04', 'Tanque 04', 'tank', { capacityM3: 60, setpoints: { level: 60 }, control: { ...CONTROL_ON } }, null, 'TNK-104'),
    a('demo', 'pump-01', 'Bomba 01', 'pump', {}, null, 'PMP-101'),
    a('demo', 'pump-02', 'Bomba 02', 'pump', {}, null, 'PMP-102'),
    a('demo', 'valve-01', 'Válvula 01', 'valve', {}, null, 'VLV-101'),
    a('demo', 'valve-02', 'Válvula 02', 'valve', {}, null, 'VLV-102'),
    a('demo', 'clima-01', 'Cámara 1', 'climate', { setpoints: { temp: 20 }, layout: { x: -5.5, z: -9.4 } }, null, 'XMTR-101'),
    a('demo', 'clima-02', 'Depósito de insumos', 'climate', { setpoints: { temp: 20 }, layout: { x: -3.3, z: -9.4 } }, null, 'XMTR-102'),
    a('demo', 'en-linea1', 'Línea de producción 1', 'energy', { contractedKw: 220, layout: { x: -1.1, z: -9.4 } }, null, 'XMTR-103'),
    a('demo', 'en-compresores', 'Compresores', 'energy', { contractedKw: 130, layout: { x: 1.1, z: -9.4 } }, null, 'XMTR-104'),
    a('demo', 'en-clima', 'Climatización y frío', 'energy', { contractedKw: 118, layout: { x: 3.3, z: -9.4 } }, null, 'XMTR-105'),
    a('demo', 'en-calderas', 'Calderas y hornos', 'energy', { contractedKw: 90, layout: { x: 5.5, z: -9.4 } }, null, 'XMTR-106'),
    a('demo', 'gas-01', 'Gas natural', 'gas', { layout: { x: -5.5, z: -12.6 } }, null, 'XMTR-107'),
    a('demo', 'maq-01', 'Envasadora', 'machine', { layout: { x: -3.3, z: -12.6 } }, null, 'MTR-101'),
    a('demo', 'maq-02', 'Cinta transportadora', 'machine', { layout: { x: -1.1, z: -12.6 } }, null, 'MTR-102'),
    a('demo', 'maq-03', 'Mezcladora', 'machine', { layout: { x: 1.1, z: -12.6 } }, null, 'MTR-103'),
    a('demo', 'pres-01', 'Presión de aire comprimido', 'pressure', { setpoints: { pressure: 6 }, layout: { x: 3.3, z: -12.6 } }, null, 'XMTR-108'),
    a('demo', 'cau-01', 'Agua de proceso', 'flow', { layout: { x: 5.5, z: -12.6 } }, null, 'XMTR-109'),
    // kit industrial (docs §13, §14.5): silos, cintas y una nave decorativa
    a('demo', 'silo-01', 'Silo de granos 01', 'silo', { capacityM3: 120, setpoints: { level: 60 }, layout: { x: -8.5, z: 10.2 } }, null, 'TNK-301'),
    a('demo', 'silo-02', 'Silo de granos 02', 'silo', { capacityM3: 120, setpoints: { level: 60 }, layout: { x: -4.3, z: 10.2 } }, null, 'TNK-302'),
    a('demo', 'conv-01', 'Cinta de carga 01', 'conveyor', { layout: { x: 2, z: 10.2 } }, null, 'CONV-101'),
    a('demo', 'conv-02', 'Cinta de carga 02', 'conveyor', { layout: { x: 8.6, z: 10.2 } }, null, 'CONV-102'),
    // la nave aloja los instrumentos (dos filas); silos y cintas van delante de los tanques
    a('demo', 'nave-01', 'Nave de producción', 'structure', { layout: { x: -0.5, z: -11 }, structure: { kind: 'hall', width: 15, depth: 8, height: 4.5 } }),
  ],
  tanques: [
    a('tanques', 'tk-a', 'Agua de proceso', 'tank', { capacityM3: 40, setpoints: { level: 60 }, control: { ...CONTROL_ON } }, null, 'TNK-101'),
    a('tanques', 'tk-b', 'Gasoil', 'tank', { capacityM3: 40, setpoints: { level: 60 }, control: { ...CONTROL_ON } }, null, 'TNK-102'),
  ],
};

const lim = (asset: string, metric: string, operator: Limit['operator'], threshold: number, severity: Limit['severity']): Limit => ({
  asset, metric, operator, threshold, severity,
});

export const DEMO_LIMITS: Record<string, Limit[]> = {
  demo: [
    ...['tk-01', 'tk-02', 'tk-03', 'tk-04', 'silo-01', 'silo-02'].flatMap((id) => [
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

/**
 * Cañerías de la planta demo (los pares «de → a» que dibuja la escena a mano y que mueve `PlantSimulator`): sirven para
 * mostrar las válvulas y bombas asociadas a un tanque en el detalle de la unidad cuando el catálogo no trae `connectsTo`.
 */
export const DEMO_LINKS: Record<string, readonly (readonly [string, string])[]> = {
  demo: [
    ['tk-01', 'valve-01'], ['valve-01', 'pump-01'], ['pump-01', 'tk-03'],
    ['tk-02', 'valve-02'], ['valve-02', 'pump-02'], ['pump-02', 'tk-04'],
  ],
};
