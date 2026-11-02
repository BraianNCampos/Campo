import { describe, expect, it } from 'vitest';
import type { AssetDef } from '@campo/shared';
import { validateSetpoint, withSetpoint } from './setpoint';

describe('ajuste de setpoint', () => {
  const scale = { min: 0, max: 100 };
  it('acepta números dentro de la escala (coma decimal incluida)', () => {
    expect(validateSetpoint('65', scale, 60)).toEqual({ value: 65 });
    expect(validateSetpoint('62,55', scale, 60, 1)).toEqual({ value: 62.6 });
    expect(validateSetpoint('0', scale, 60)).toEqual({ value: 0 });
  });
  it('rechaza vacío, no numérico, fuera de escala y sin cambio', () => {
    expect(validateSetpoint('', scale).error).toMatch(/Ingresá el valor/);
    expect(validateSetpoint('abc', scale).error).toMatch(/Ingresá un número/);
    expect(validateSetpoint('101', scale).error).toMatch(/de 0 a 100/);
    expect(validateSetpoint('-1', scale).error).toMatch(/escala/);
    expect(validateSetpoint('60', scale, 60).error).toMatch(/mismo valor/);
  });
  it('sin escala conocida sólo exige un número', () => {
    expect(validateSetpoint('500', undefined)).toEqual({ value: 500 });
  });
  it('withSetpoint no pisa otras claves', () => {
    const def: AssetDef = { plant: 'p', id: 't', name: 't', type: 'tank', model3dRef: null, metadata: { capacityM3: 60, setpoints: { temp: 20 } } };
    expect(withSetpoint(def, 'level', 70).metadata).toEqual({ capacityM3: 60, setpoints: { temp: 20, level: 70 } });
    expect(def.metadata).toEqual({ capacityM3: 60, setpoints: { temp: 20 } }); // no muta
  });
});
