import { beforeEach, describe, expect, it } from 'vitest';
import { readStoredPlant, resolveSelectedPlant, usePlantStore } from './plant-store';

const plants = [
  { id: 'demo', name: 'Demo', assets: 8 },
  { id: 'norte', name: 'Norte', assets: 2 },
];

describe('resolveSelectedPlant', () => {
  it('prioridad: actual → recordada → configurada → primera', () => {
    expect(resolveSelectedPlant(plants, 'norte', 'demo', 'demo')).toBe('norte');
    expect(resolveSelectedPlant(plants, null, 'norte', 'demo')).toBe('norte');
    expect(resolveSelectedPlant(plants, null, 'borrada', 'norte')).toBe('norte');
    expect(resolveSelectedPlant(plants, 'borrada', null, 'otra')).toBe('demo');
  });
  it('sin plantas → null', () => {
    expect(resolveSelectedPlant([], 'demo', 'demo', 'demo')).toBeNull();
  });
});

describe('usePlantStore', () => {
  beforeEach(() => {
    localStorage.clear();
    usePlantStore.getState().reset();
  });

  it('elige la última planta recordada al cargar y la guarda', () => {
    localStorage.setItem('campo.plant', 'norte');
    usePlantStore.getState().setPlants(plants);
    expect(usePlantStore.getState().selected).toBe('norte');
  });

  it('select cambia y recuerda; ignora plantas que el usuario no tiene', () => {
    const s = usePlantStore.getState();
    s.setPlants(plants);
    expect(usePlantStore.getState().selected).toBe('demo');
    usePlantStore.getState().select('norte');
    expect(usePlantStore.getState().selected).toBe('norte');
    expect(readStoredPlant()).toBe('norte');
    usePlantStore.getState().select('ajena');
    expect(usePlantStore.getState().selected).toBe('norte');
  });

  it('si la planta activa desaparece de la lista, pasa a otra; sin plantas queda null', () => {
    usePlantStore.getState().setPlants(plants);
    usePlantStore.getState().select('norte');
    usePlantStore.getState().setPlants([plants[0]!]);
    expect(usePlantStore.getState().selected).toBe('demo');
    usePlantStore.getState().setPlants([]);
    expect(usePlantStore.getState().selected).toBeNull();
  });

  it('refrescar la lista conserva la selección', () => {
    usePlantStore.getState().setPlants(plants);
    usePlantStore.getState().select('norte');
    usePlantStore.getState().setPlants([...plants, { id: 'sur', name: 'Sur', assets: 0 }]);
    expect(usePlantStore.getState().selected).toBe('norte');
  });
});
