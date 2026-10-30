import { LAYOUT_LIMITS, assetMetadataError, unknownConnections } from './asset-metadata';

const err = (m: Record<string, unknown>, self = 'tk-01') => assetMetadataError(m, self);

describe('assetMetadataError: layout', () => {
  it.each([
    [{ x: 0, z: 0 }],
    [{ x: -1000, z: 1000, y: -1000, rotY: -3600, scale: 0.05 }],
    [{ x: 1.5, z: -2.25, y: 3, rotY: 90, scale: 50 }],
    [{ x: 0, z: 0, y: 0, rotY: 0, scale: 1 }],
  ])('válido %j', (layout) => {
    expect(err({ layout })).toBeNull();
  });

  it('metadata sin layout ni connectsTo (claves libres) es válida', () => {
    expect(err({})).toBeNull();
    expect(err({ capacityL: 5000, unit: '%', anidado: { a: [1, 2] } })).toBeNull();
  });

  it.each([
    ['no es objeto', 'x', 'debe ser un objeto'],
    ['es null', null, 'debe ser un objeto'],
    ['es lista', [1, 2], 'debe ser un objeto'],
    ['falta x', { z: 1 }, 'layout.x es obligatorio'],
    ['falta z', { x: 1 }, 'layout.z es obligatorio'],
    ['x cadena', { x: '1', z: 1 }, 'layout.x'],
    ['x NaN', { x: Number.NaN, z: 1 }, 'layout.x'],
    ['x Infinity', { x: Infinity, z: 1 }, 'layout.x'],
    ['x fuera de rango', { x: 1000.01, z: 1 }, 'layout.x'],
    ['z fuera de rango', { x: 1, z: -1001 }, 'layout.z'],
    ['y fuera de rango', { x: 1, z: 1, y: 1001 }, 'layout.y'],
    ['y cadena', { x: 1, z: 1, y: 'a' }, 'layout.y'],
    ['y null', { x: 1, z: 1, y: null }, 'layout.y'],
    ['rotY absurda', { x: 1, z: 1, rotY: 1e9 }, 'layout.rotY'],
    ['rotY NaN', { x: 1, z: 1, rotY: Number.NaN }, 'layout.rotY'],
    ['scale 0', { x: 1, z: 1, scale: 0 }, 'layout.scale'],
    ['scale bajo el mínimo', { x: 1, z: 1, scale: 0.049 }, 'layout.scale'],
    ['scale sobre el máximo', { x: 1, z: 1, scale: 50.1 }, 'layout.scale'],
    ['scale negativa', { x: 1, z: 1, scale: -1 }, 'layout.scale'],
    ['clave desconocida', { x: 1, z: 1, rot: 3 }, 'layout.rot no es un campo válido'],
  ])('inválido: %s', (_n, layout, msg) => {
    expect(err({ layout })).toContain(msg);
  });

  it('los límites exportados son los del contrato', () => {
    expect(LAYOUT_LIMITS).toMatchObject({
      maxCoord: 1000,
      minScale: 0.05,
      maxScale: 50,
      maxConnections: 32,
    });
  });
});

describe('assetMetadataError: connectsTo', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `a-${i}`);

  it('válido: vacío, ids correctos, exactamente 32', () => {
    expect(err({ connectsTo: [] })).toBeNull();
    expect(err({ connectsTo: ['pump-01', 'valve_02', '9x'] })).toBeNull();
    expect(err({ connectsTo: ids(32) })).toBeNull();
  });

  it.each([
    ['no es lista', 'pump-01', 'debe ser una lista'],
    ['es objeto', { a: 1 }, 'debe ser una lista'],
    ['null', null, 'debe ser una lista'],
    ['33 elementos', ids(33), 'como máximo 32'],
    ['id no cadena', [5], 'connectsTo[0]'],
    ['id con mayúsculas', ['Pump'], 'connectsTo[0]'],
    ['id con espacios', ['a b'], 'connectsTo[0]'],
    ['id vacío', [''], 'connectsTo[0]'],
    ['id de 65 caracteres', ['a'.repeat(65)], 'connectsTo[0]'],
    ['id con ruta', ['../x'], 'connectsTo[0]'],
    ['duplicado', ['a', 'b', 'a'], 'connectsTo[2]: "a" está repetido'],
    [
      'a sí mismo',
      ['pump-01', 'tk-01'],
      'connectsTo[1]: un activo no puede conectarse consigo mismo',
    ],
  ])('inválido: %s', (_n, connectsTo, msg) => {
    expect(err({ connectsTo })).toContain(msg);
  });

  it('el chequeo de uno mismo usa el id que se pasa', () => {
    expect(err({ connectsTo: ['tk-01'] }, 'otro')).toBeNull();
  });

  it('layout y connectsTo se validan juntos', () => {
    expect(err({ layout: { x: 1, z: 1 }, connectsTo: ['a'] })).toBeNull();
    expect(err({ layout: { x: 1 }, connectsTo: ['a'] })).toContain('layout.z');
    expect(err({ layout: { x: 1, z: 1 }, connectsTo: 'a' })).toContain('connectsTo');
  });
});

describe('unknownConnections', () => {
  it('devuelve los ids que no están en la planta', () => {
    expect(unknownConnections({ connectsTo: ['a', 'b', 'c'] }, new Set(['b']))).toEqual(['a', 'c']);
    expect(unknownConnections({}, new Set())).toEqual([]);
    expect(unknownConnections({ connectsTo: [] }, new Set())).toEqual([]);
  });
});
