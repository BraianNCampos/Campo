import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateAssetDto, CreatePlantDto, UpdateAssetDto, UpdatePlantDto } from './dto';

async function errors<T extends object>(cls: new () => T, body: unknown): Promise<string[]> {
  const dto = plainToInstance(cls, body);
  const errs = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errs.map((e) => e.property).sort();
}

const asset = { id: 'tk-01', name: 'Tanque', type: 'tank' };

describe('validación de plantas', () => {
  it('id con ID_PATTERN y nombre 1..100 (se recorta)', async () => {
    expect(await errors(CreatePlantDto, { id: 'norte', name: 'Norte' })).toEqual([]);
    expect(await errors(CreatePlantDto, { id: 'a'.repeat(64), name: 'x' })).toEqual([]);
    expect(await errors(CreatePlantDto, { id: 'a'.repeat(65), name: 'x' })).toEqual(['id']);
    expect(await errors(CreatePlantDto, { id: 'Norte', name: 'x' })).toEqual(['id']);
    expect(await errors(CreatePlantDto, { id: '-x', name: 'x' })).toEqual(['id']);
    expect(await errors(CreatePlantDto, { id: 'a/b', name: 'x' })).toEqual(['id']);
    expect(await errors(CreatePlantDto, { id: 'norte', name: '   ' })).toEqual(['name']);
    expect(await errors(CreatePlantDto, { id: 'norte', name: 'x'.repeat(101) })).toEqual(['name']);
    expect(await errors(CreatePlantDto, { id: 'norte', name: 5 })).toEqual(['name']);
    expect(await errors(CreatePlantDto, { id: 'norte', name: 'x', extra: 1 })).toEqual(['extra']);
    expect(await errors(UpdatePlantDto, { name: 'Nuevo' })).toEqual([]);
    expect(await errors(UpdatePlantDto, {})).toEqual(['name']);
  });
});

describe('validación de activos', () => {
  it('alta mínima y completa', async () => {
    expect(await errors(CreateAssetDto, asset)).toEqual([]);
    expect(
      await errors(CreateAssetDto, {
        ...asset,
        model3dRef: 'tank',
        metadata: { a: { b: [1, 2] } },
      }),
    ).toEqual([]);
    expect(await errors(CreateAssetDto, { ...asset, model3dRef: null, metadata: null })).toEqual(
      [],
    );
  });

  it('id con ID_PATTERN', async () => {
    for (const id of ['', 'TK', 'tk 01', '_x', 'a'.repeat(65), 'x*', '../x']) {
      expect(await errors(CreateAssetDto, { ...asset, id })).toEqual(['id']);
    }
  });

  it('tipos tank|pump|valve|sensor', async () => {
    for (const type of ['tank', 'pump', 'valve', 'sensor']) {
      expect(await errors(CreateAssetDto, { ...asset, type })).toEqual([]);
    }
    for (const type of ['Tank', 'motor', '', null, 1]) {
      expect(await errors(CreateAssetDto, { ...asset, type })).toEqual(['type']);
    }
  });

  it('model3dRef <= 200 caracteres', async () => {
    expect(await errors(CreateAssetDto, { ...asset, model3dRef: 'm'.repeat(200) })).toEqual([]);
    expect(await errors(CreateAssetDto, { ...asset, model3dRef: 'm'.repeat(201) })).toEqual([
      'model3dRef',
    ]);
    expect(await errors(CreateAssetDto, { ...asset, model3dRef: 5 })).toEqual(['model3dRef']);
    expect(await errors(CreateAssetDto, { ...asset, model3dRef: '' })).toEqual(['model3dRef']);
  });

  it('metadata: objeto JSON de <= 8 KB', async () => {
    const withBytes = (n: number) => ({ k: 'x'.repeat(n - '{"k":""}'.length) });
    expect(Buffer.byteLength(JSON.stringify(withBytes(8192)))).toBe(8192);
    expect(await errors(CreateAssetDto, { ...asset, metadata: withBytes(8192) })).toEqual([]);
    expect(await errors(CreateAssetDto, { ...asset, metadata: withBytes(8193) })).toEqual([
      'metadata',
    ]);
    // se mide en bytes UTF-8, no en caracteres
    expect(await errors(CreateAssetDto, { ...asset, metadata: { k: 'ñ'.repeat(4100) } })).toEqual([
      'metadata',
    ]);
    for (const metadata of ['texto', 5, true, [1, 2]]) {
      expect(await errors(CreateAssetDto, { ...asset, metadata })).toEqual(['metadata']);
    }
  });

  it('no admite campos extra (ni plant en el cuerpo)', async () => {
    expect(await errors(CreateAssetDto, { ...asset, plant: 'demo' })).toEqual(['plant']);
  });

  it('PATCH: todo opcional, sin id', async () => {
    expect(await errors(UpdateAssetDto, {})).toEqual([]);
    expect(await errors(UpdateAssetDto, { name: 'Nuevo' })).toEqual([]);
    expect(await errors(UpdateAssetDto, { type: 'pump', model3dRef: null, metadata: {} })).toEqual(
      [],
    );
    expect(await errors(UpdateAssetDto, { id: 'otro' })).toEqual(['id']);
    expect(await errors(UpdateAssetDto, { type: 'x' })).toEqual(['type']);
    expect(await errors(UpdateAssetDto, { name: '   ' })).toEqual(['name']);
    expect(await errors(UpdateAssetDto, { metadata: { k: 'x'.repeat(9000) } })).toEqual([
      'metadata',
    ]);
  });
});
