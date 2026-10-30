import {
  Json,
  T_BIN,
  T_JSON,
  bigMeshGlb,
  glb,
  sampleGlbs,
  triangle,
  triangleGlb,
} from '../../test/support/glb';
import { ALLOWED_EXTENSIONS, GLB_LIMITS, exceedsDepth, validateGlb } from './glb-validator';

const err = (buf: Buffer): string => {
  const r = validateGlb(buf);
  if (r.ok) throw new Error('se esperaba un GLB inválido');
  return r.error;
};

describe('validateGlb: válidos', () => {
  const samples = sampleGlbs();

  it('hay GLB de ejemplo en el repo', () => {
    expect(samples.map((s) => s.name)).toEqual([
      'sample-pump.glb',
      'sample-static.glb',
      'sample-tank.glb',
      'sample-valve.glb',
    ]);
  });

  it.each(samples.map((s) => [s.name, s.data] as const))('%s es válido', (_n, data) => {
    const r = validateGlb(data);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.stats.nodes).toBeGreaterThan(0);
      expect(r.stats.vertices).toBeGreaterThan(0);
    }
  });

  it('el triángulo mínimo es válido y devuelve estadísticas', () => {
    expect(validateGlb(triangleGlb())).toEqual({
      ok: true,
      stats: { nodes: 1, meshes: 1, vertices: 3 },
    });
  });

  it('admite el relleno del JSON con NUL, un Uint8Array y bloques desconocidos tras el BIN', () => {
    expect(validateGlb(triangleGlb(undefined, { padByte: 0 })).ok).toBe(true);
    expect(validateGlb(new Uint8Array(triangleGlb())).ok).toBe(true);
    const extra = triangleGlb(undefined, { extraChunks: [[0x12345678, Buffer.alloc(8)]] });
    expect(validateGlb(extra).ok).toBe(true);
  });

  it('admite BIN con hasta 3 bytes de relleno sobre el byteLength del buffer', () => {
    const { json, bin } = triangle();
    json.buffers[0].byteLength = 41;
    json.bufferViews[1].byteLength = 5;
    json.accessors[1].count = 2;
    expect(validateGlb(glb(json, Buffer.concat([bin.subarray(0, 41), Buffer.alloc(3)]))).ok).toBe(
      true,
    );
  });

  it('admite sin bloque BIN cuando no hay buffers', () => {
    const json = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: {} }] }],
    };
    expect(validateGlb(glb(json)).ok).toBe(true);
  });

  it.each(ALLOWED_EXTENSIONS)('admite %s como extensión requerida', (ext) => {
    expect(validateGlb(triangleGlb((j) => (j.extensionsRequired = [ext]))).ok).toBe(true);
  });

  it('admite extensiones desconocidas sólo "usadas" (opcionales) y data URIs embebidos', () => {
    const g = triangleGlb((j) => {
      j.extensionsUsed = ['KHR_lights_punctual', 'KHR_materials_clearcoat'];
      j.images = [{ uri: 'data:image/png;base64,iVBORw0KGgo=' }];
      j.textures = [{ source: 0 }];
      j.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
    });
    expect(validateGlb(g).ok).toBe(true);
  });

  it('admite exactamente 2000 nodos y 200000 vértices', () => {
    const nodes = triangleGlb((j) => {
      for (let i = 1; i < 2000; i++) j.nodes.push({});
    });
    expect(validateGlb(nodes)).toMatchObject({ ok: true, stats: { nodes: 2000 } });
    expect(validateGlb(bigMeshGlb(200_000))).toMatchObject({
      ok: true,
      stats: { vertices: 200_000 },
    });
  });

  it('un accesor POSITION compartido por varias mallas cuenta una sola vez; las mallas sin nodo no cuentan', () => {
    const g = triangleGlb((j) => {
      j.meshes.push({ primitives: [{ attributes: { POSITION: 0 } }] }); // misma geometría
      j.nodes.push({ mesh: 1 });
      j.accessors.push({ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' });
      j.meshes.push({ primitives: [{ attributes: { POSITION: 2 } }] }); // sin nodo
    });
    expect(validateGlb(g)).toMatchObject({ ok: true, stats: { meshes: 2, vertices: 3 } });
  });

  it('acepta una jerarquía en árbol con varios niveles', () => {
    const g = triangleGlb((j) => {
      j.nodes = [{ children: [1, 2] }, { children: [3] }, { mesh: 0 }, {}];
    });
    expect(validateGlb(g).ok).toBe(true);
  });
});

describe('validateGlb: contenedor inválido', () => {
  const good = triangleGlb();

  it.each([
    ['vacío', Buffer.alloc(0), 'demasiado corto'],
    ['11 bytes', good.subarray(0, 11), 'demasiado corto'],
    [
      'magia incorrecta',
      glb({ asset: { version: '2.0' } }, null, { magic: 0x12345678 }),
      'no empieza por "glTF"',
    ],
    ['PNG', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), 'no empieza por "glTF"'],
    ['glTF de texto', Buffer.from('{"asset":{"version":"2.0"}}'), 'glTF de texto'],
    [
      'contenedor v1',
      triangleGlb(undefined, { version: 1 }),
      'Versión de contenedor GLB no soportada (1)',
    ],
    ['contenedor v3', triangleGlb(undefined, { version: 3 }), 'no soportada (3)'],
    [
      'longitud mayor que el archivo',
      triangleGlb(undefined, { headerLength: good.length + 4 }),
      'no coincide con el tamaño real',
    ],
    [
      'longitud menor que el archivo',
      triangleGlb(undefined, { headerLength: good.length - 4 }),
      'no coincide con el tamaño real',
    ],
    ['longitud 0', triangleGlb(undefined, { headerLength: 0 }), 'no coincide'],
    ['longitud 0xFFFFFFFF', triangleGlb(undefined, { headerLength: 0xffffffff }), 'no coincide'],
    ['primer bloque no JSON', triangleGlb(undefined, { firstType: T_BIN }), 'primer bloque'],
    ['sin bloques', glb({}, null, { headerLength: 12 }).subarray(0, 12), 'ningún bloque JSON'],
  ])('%s', (_n, buf, msg) => {
    expect(err(buf)).toContain(msg);
  });

  it('truncado: nunca es válido, en ningún punto de corte', () => {
    for (let cut = 0; cut < good.length; cut += 7) {
      expect(validateGlb(good.subarray(0, cut)).ok).toBe(false);
    }
    // incluso si el atacante arregla la longitud de la cabecera, el bloque queda cortado
    const cutBody = Buffer.from(good.subarray(0, good.length - 10));
    cutBody.writeUInt32LE(cutBody.length, 8);
    expect(err(cutBody)).toMatch(/declara \d+ bytes pero sólo quedan/);
  });

  it('bloque con cabecera incompleta al final', () => {
    expect(err(triangleGlb(undefined, { trailing: Buffer.alloc(5) }))).toContain('truncado');
  });

  it('bloque cuya longitud declarada excede el archivo', () => {
    const g = Buffer.from(good);
    g.writeUInt32LE(0xfffffff0, 12);
    expect(err(g)).toMatch(/declara 4294967280 bytes/);
  });

  it('segundo bloque JSON y BIN que no va justo tras el JSON', () => {
    expect(err(triangleGlb(undefined, { extraChunks: [[T_JSON, Buffer.from('{}  ')]] }))).toContain(
      'segundo bloque JSON',
    );
    const late = triangleGlb(
      undefined,
      {
        extraChunks: [
          [0x1, Buffer.alloc(4)],
          [T_BIN, Buffer.alloc(4)],
        ],
      },
      null,
    );
    expect(validateGlb(late).ok).toBe(false);
  });
});

describe('validateGlb: JSON', () => {
  it.each([
    ['sin cerrar', '{"asset":{"version":"2.0"'],
    ['coma final', '{"asset":{"version":"2.0",}}'],
    ['basura', 'esto no es json'],
  ])('mal formado (%s)', (_n, text) => {
    expect(err(glb(text))).toContain('El bloque JSON no es válido');
  });

  it('UTF-8 inválido', () => {
    const bytes = Buffer.concat([
      Buffer.from('{"asset":{"version":"2.0"},"x":"'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"}'),
    ]);
    expect(err(glb(bytes))).toContain('El bloque JSON no es válido');
  });

  it.each([['[]'], ['5'], ['"texto"'], ['null']])('debe ser un objeto (%s)', (text) => {
    expect(err(glb(text))).toMatch(/debe ser un objeto|no es válido/);
  });

  it('JSON vacío o sólo relleno', () => {
    expect(err(glb('', null, { noPad: true }))).toContain('vacío');
    expect(err(glb('    '))).toContain('vacío');
  });

  it('bloque JSON enorme: se rechaza por tamaño sin parsearlo', () => {
    const huge = `{"asset":{"version":"2.0"},"x":"${'a'.repeat(GLB_LIMITS.maxJsonBytes)}"}`;
    const t0 = Date.now();
    expect(err(glb(huge))).toContain('El bloque JSON ocupa');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('anidación maliciosa: se rechaza antes de parsear (rápido y sin agotar la pila)', () => {
    const n = GLB_LIMITS.maxJsonBytes - 10;
    for (const text of [
      '['.repeat(n),
      `{"a":${'['.repeat(100_000)}`,
      `{"asset":${'{"a":'.repeat(100_000)}`,
    ]) {
      const t0 = Date.now();
      expect(err(glb(text))).toContain('anida más de');
      expect(Date.now() - t0).toBeLessThan(1000);
    }
  });

  it('un JSON grande pero legítimo (muchos accesores) sigue siendo válido', () => {
    const g = triangleGlb((j) => {
      for (let i = 0; i < 5_000; i++)
        j.accessors.push({ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' });
    });
    expect(validateGlb(g).ok).toBe(true);
  });

  it('el límite de tamaño del archivo es 10 MiB', () => {
    const big = Buffer.alloc(GLB_LIMITS.maxBytes + 1);
    expect(err(big)).toContain('máximo');
  });
});

type Case = [string, (j: Json) => void, string];

describe('validateGlb: documento', () => {
  const cases: Case[] = [
    // asset / versión
    ['sin asset', (j) => delete j.asset, 'asset debe ser un objeto'],
    ['asset.version 1.0', (j) => (j.asset.version = '1.0'), 'asset.version debe ser "2.0"'],
    ['asset.version numérica', (j) => (j.asset.version = 2), 'asset.version debe ser "2.0"'],
    ['asset sin version', (j) => (j.asset = {}), 'asset.version'],
    // uri externas
    [
      'buffer con uri http',
      (j) => (j.buffers[0].uri = 'http://evil.example/x.bin'),
      'buffers[0].uri apunta a un recurso externo',
    ],
    [
      'buffer con uri https',
      (j) => (j.buffers[0].uri = 'https://evil.example/x.bin'),
      'recurso externo',
    ],
    ['buffer con uri relativa', (j) => (j.buffers[0].uri = 'datos.bin'), 'recurso externo'],
    ['buffer con uri file:', (j) => (j.buffers[0].uri = 'file:///etc/passwd'), 'recurso externo'],
    ['buffer con uri ftp', (j) => (j.buffers[0].uri = 'ftp://x/y'), 'recurso externo'],
    [
      'buffer con uri no cadena',
      (j) => (j.buffers[0].uri = 5),
      'buffers[0].uri debe ser una cadena',
    ],
    [
      'imagen con uri http',
      (j) => ((j.images = [{ uri: 'http://x/y.png' }]), (j.textures = [{ source: 0 }])),
      'images[0].uri apunta a un recurso externo',
    ],
    [
      'imagen sin uri ni bufferView',
      (j) => (j.images = [{}]),
      'images[0] no tiene uri ni bufferView',
    ],
    [
      'imagen con bufferView fuera de rango',
      (j) => (j.images = [{ bufferView: 9 }]),
      'images[0].bufferView: el índice 9 está fuera de rango',
    ],
    // extensiones
    [
      'Draco requerido',
      (j) => (j.extensionsRequired = ['KHR_draco_mesh_compression']),
      'Compresión Draco',
    ],
    [
      'meshopt requerido',
      (j) => (j.extensionsRequired = ['EXT_meshopt_compression']),
      'Compresión meshopt',
    ],
    [
      'Draco sólo en extensionsUsed',
      (j) => (j.extensionsUsed = ['KHR_draco_mesh_compression']),
      'Draco',
    ],
    [
      'Draco escondido en una primitiva',
      (j) =>
        (j.meshes[0].primitives[0].extensions = {
          KHR_draco_mesh_compression: { bufferView: 0, attributes: {} },
        }),
      'usa compresión Draco',
    ],
    [
      'meshopt escondido en un bufferView',
      (j) => (j.bufferViews[0].extensions = { EXT_meshopt_compression: {} }),
      'usa compresión meshopt',
    ],
    [
      'extensión requerida no permitida',
      (j) => (j.extensionsRequired = ['KHR_lights_punctual']),
      'no está permitida',
    ],
    [
      'extensión requerida con basura',
      (j) => (j.extensionsRequired = ['A'.repeat(500)]),
      'no está permitida',
    ],
    [
      'extensionsRequired no es lista',
      (j) => (j.extensionsRequired = 'KHR_texture_transform'),
      'extensionsRequired debe ser una lista',
    ],
    [
      'extensionsUsed con no-cadenas',
      (j) => (j.extensionsUsed = [1]),
      'extensionsUsed[0] debe ser una cadena',
    ],
    // límites
    [
      '2001 nodos',
      (j) => {
        for (let i = 1; i < 2001; i++) j.nodes.push({});
      },
      'tiene 2001 nodos',
    ],
    [
      'sin ninguna malla',
      (j) => {
        delete j.nodes[0].mesh;
      },
      'ninguna malla referenciada',
    ],
    [
      'sin nodos',
      (j) => {
        delete j.nodes;
        delete j.scenes;
        delete j.scene;
      },
      'ninguna malla referenciada',
    ],
    // accesores
    [
      'POSITION fuera de rango',
      (j) => (j.meshes[0].primitives[0].attributes.POSITION = 9),
      'meshes[0].primitives[0].attributes.POSITION: el índice 9 está fuera de rango',
    ],
    [
      'atributo con índice negativo',
      (j) => (j.meshes[0].primitives[0].attributes.NORMAL = -1),
      'debe ser un entero',
    ],
    [
      'atributo con índice decimal',
      (j) => (j.meshes[0].primitives[0].attributes.NORMAL = 0.5),
      'debe ser un entero',
    ],
    [
      'atributo con índice cadena',
      (j) => (j.meshes[0].primitives[0].attributes.NORMAL = '0'),
      'debe ser un entero',
    ],
    [
      'indices fuera de rango',
      (j) => (j.meshes[0].primitives[0].indices = 2),
      'indices: el índice 2 está fuera de rango',
    ],
    [
      'target morph fuera de rango',
      (j) => (j.meshes[0].primitives[0].targets = [{ POSITION: 7 }]),
      'targets[0].POSITION',
    ],
    [
      'accesor.bufferView fuera de rango',
      (j) => (j.accessors[0].bufferView = 5),
      'accessors[0].bufferView: el índice 5 está fuera de rango',
    ],
    [
      'accesor componentType inválido',
      (j) => (j.accessors[0].componentType = 1234),
      'componentType no válido',
    ],
    ['accesor type inválido', (j) => (j.accessors[0].type = 'VEC9'), 'type no válido'],
    [
      'accesor count 0',
      (j) => (j.accessors[0].count = 0),
      'accessors[0].count debe ser un entero >= 1',
    ],
    ['accesor count decimal', (j) => (j.accessors[0].count = 2.5), 'accessors[0].count'],
    ['accesor count gigante', (j) => (j.accessors[0].count = 1e15), 'se sale de su bufferView'],
    [
      'accesor byteOffset que desborda',
      (j) => (j.accessors[0].byteOffset = 30),
      'se sale de su bufferView',
    ],
    [
      'accesor byteOffset negativo',
      (j) => (j.accessors[0].byteOffset = -4),
      'accessors[0].byteOffset',
    ],
    [
      'accesor sin bufferView y count excesivo',
      (j) => {
        delete j.accessors[0].bufferView;
        j.accessors[0].count = 5_000_000;
      },
      'count',
    ],
    [
      'sparse con bufferView fuera de rango',
      (j) =>
        (j.accessors[0].sparse = {
          count: 1,
          indices: { bufferView: 8 },
          values: { bufferView: 0 },
        }),
      'sparse.indices.bufferView',
    ],
    [
      'sparse.count mayor que el accesor',
      (j) =>
        (j.accessors[0].sparse = {
          count: 99,
          indices: { bufferView: 0 },
          values: { bufferView: 0 },
        }),
      'sparse.count',
    ],
    ['accesor no es objeto', (j) => (j.accessors[1] = 7), 'accessors[1] debe ser un objeto'],
    // bufferViews / buffers
    [
      'bufferView.buffer fuera de rango',
      (j) => (j.bufferViews[0].buffer = 3),
      'bufferViews[0].buffer: el índice 3 está fuera de rango',
    ],
    [
      'bufferView se sale del buffer',
      (j) => (j.bufferViews[1].byteOffset = 40),
      'bufferViews[1] se sale de su buffer',
    ],
    [
      'bufferView byteLength 0',
      (j) => (j.bufferViews[0].byteLength = 0),
      'bufferViews[0].byteLength debe ser un entero >= 1',
    ],
    ['bufferView byteStride 3', (j) => (j.bufferViews[0].byteStride = 3), 'byteStride'],
    ['bufferView byteStride 256', (j) => (j.bufferViews[0].byteStride = 256), 'byteStride'],
    [
      'buffer.byteLength mayor que el BIN',
      (j) => (j.buffers[0].byteLength = 100),
      'supera el bloque BIN',
    ],
    [
      'buffer.byteLength mucho menor que el BIN',
      (j) => {
        j.buffers[0].byteLength = 20;
        j.bufferViews = [];
        j.accessors = [];
        j.meshes[0].primitives[0] = { attributes: {} };
      },
      'no coincide con el bloque BIN',
    ],
    ['buffer.byteLength 0', (j) => (j.buffers[0].byteLength = 0), 'buffers[0].byteLength'],
    [
      'segundo buffer sin uri',
      (j) => void j.buffers.push({ byteLength: 4 }),
      'sólo el buffer 0 puede apuntar al bloque BIN',
    ],
    ['buffers no es lista', (j) => (j.buffers = {}), 'buffers debe ser una lista'],
    // mallas / materiales / texturas
    [
      'malla sin primitivas',
      (j) => (j.meshes[0].primitives = []),
      'primitives debe ser una lista no vacía',
    ],
    [
      'primitiva sin attributes',
      (j) => delete j.meshes[0].primitives[0].attributes,
      'attributes debe ser un objeto',
    ],
    [
      'material fuera de rango',
      (j) => (j.meshes[0].primitives[0].material = 4),
      'material: el índice 4 está fuera de rango',
    ],
    ['mode inválido', (j) => (j.meshes[0].primitives[0].mode = 9), 'mode no válido'],
    [
      'textura de material fuera de rango',
      (j) => (j.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 3 }),
      'baseColorTexture.index: el índice 3 está fuera de rango',
    ],
    [
      'normalTexture fuera de rango',
      (j) => (j.materials[0].normalTexture = { index: 0 }),
      'normalTexture.index',
    ],
    [
      'textures[0].source fuera de rango',
      (j) => (j.textures = [{ source: 2 }]),
      'textures[0].source',
    ],
    [
      'textures[0].sampler fuera de rango',
      (j) => (j.textures = [{ sampler: 2 }]),
      'textures[0].sampler',
    ],
    // nodos
    [
      'nodo.mesh fuera de rango',
      (j) => (j.nodes[0].mesh = 5),
      'nodes[0].mesh: el índice 5 está fuera de rango',
    ],
    ['nodo.skin fuera de rango', (j) => (j.nodes[0].skin = 0), 'nodes[0].skin'],
    ['nodo.camera fuera de rango', (j) => (j.nodes[0].camera = 0), 'nodes[0].camera'],
    [
      'hijo fuera de rango',
      (j) => (j.nodes[0].children = [3]),
      'nodes[0].children[0]: el índice 3 está fuera de rango',
    ],
    ['children no es lista', (j) => (j.nodes[0].children = 1), 'children debe ser una lista'],
    ['nodo hijo de sí mismo', (j) => (j.nodes[0].children = [0]), 'hijo de sí mismo'],
    [
      'ciclo de 2 nodos',
      (j) => {
        j.nodes = [{ mesh: 0 }, { children: [2] }, { children: [1] }];
      },
      'Ciclo en la jerarquía',
    ],
    [
      'ciclo de 3 nodos fuera de la escena',
      (j) => {
        j.nodes = [{ mesh: 0 }, { children: [2] }, { children: [3] }, { children: [1] }];
      },
      'Ciclo en la jerarquía',
    ],
    [
      'nodo con dos padres (rombo)',
      (j) => {
        j.nodes = [{ mesh: 0, children: [1, 2] }, { children: [3] }, { children: [3] }, {}];
      },
      'más de un padre',
    ],
    [
      'nodo repetido en children',
      (j) => {
        j.nodes = [{ mesh: 0, children: [1, 1] }, {}];
      },
      'más de un padre',
    ],
    ['nodo no es objeto', (j) => void j.nodes.push(5), 'nodes[1] debe ser un objeto'],
    // escenas / skins / animaciones
    ['scene.nodes fuera de rango', (j) => (j.scenes[0].nodes = [4]), 'scenes[0].nodes[0]'],
    [
      'scene por defecto fuera de rango',
      (j) => (j.scene = 3),
      'scene: el índice 3 está fuera de rango',
    ],
    ['skin.joints fuera de rango', (j) => (j.skins = [{ joints: [9] }]), 'skins[0].joints[0]'],
    [
      'skin.inverseBindMatrices fuera de rango',
      (j) => (j.skins = [{ joints: [0], inverseBindMatrices: 9 }]),
      'inverseBindMatrices',
    ],
    [
      'animación: nodo objetivo fuera de rango',
      (j) =>
        (j.animations = [
          {
            samplers: [{ input: 0, output: 0 }],
            channels: [{ sampler: 0, target: { node: 9, path: 'rotation' } }],
          },
        ]),
      'target.node: el índice 9 está fuera de rango',
    ],
    [
      'animación: sampler fuera de rango',
      (j) =>
        (j.animations = [
          { samplers: [], channels: [{ sampler: 1, target: { node: 0, path: 'rotation' } }] },
        ]),
      'channels[0].sampler',
    ],
    [
      'animación: accesor fuera de rango',
      (j) => (j.animations = [{ samplers: [{ input: 0, output: 8 }], channels: [] }]),
      'samplers[0].output',
    ],
  ];

  it.each(cases)('%s', (_name, mutate, expected) => {
    expect(err(triangleGlb(mutate))).toContain(expected);
  });

  it('suma de vértices por encima del límite (una malla y varias)', () => {
    expect(err(bigMeshGlb(200_001))).toContain('200001 vértices');
    expect(err(bigMeshGlb(100_001, 2))).toContain('200002 vértices');
  });

  it('un accesor mentiroso (count enorme) no obliga a reservar memoria: se rechaza por rango', () => {
    const g = triangleGlb((j) => (j.accessors[0].count = 4_000_000_000));
    expect(err(g)).toContain('se sale de su bufferView');
  });

  it('BIN ausente con un buffer sin uri', () => {
    expect(err(triangleGlb(undefined, undefined, null))).toContain('no contiene bloque BIN');
  });

  it('con byteStride, el accesor debe caber contando el paso', () => {
    // 3 elementos de 12 bytes con paso 24: necesita 2*24+12 = 60 > 36
    const g = triangleGlb((j) => (j.bufferViews[0].byteStride = 24));
    expect(err(g)).toContain('necesita 60 bytes');
  });

  it('el mensaje de uri externa recorta URIs largas', () => {
    const m = err(triangleGlb((j) => (j.buffers[0].uri = `http://x/${'a'.repeat(1000)}`)));
    expect(m.length).toBeLessThan(250);
  });
});

describe('validateGlb: robustez', () => {
  it('no lanza ni se cuelga con bytes mutados al azar (fuzz determinista)', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const bases = [...sampleGlbs().map((s) => s.data), triangleGlb()];
    for (let i = 0; i < 400; i++) {
      const buf = Buffer.from(bases[i % bases.length]);
      const hits = 1 + Math.floor(rnd() * 6);
      for (let k = 0; k < hits; k++) buf[Math.floor(rnd() * buf.length)] = Math.floor(rnd() * 256);
      // a veces se arregla la longitud de la cabecera para llegar más hondo
      if (rnd() < 0.5) buf.writeUInt32LE(buf.length, 8);
      expect(() => validateGlb(buf)).not.toThrow();
    }
  });

  it('prefijos aleatorios y basura pura', () => {
    expect(validateGlb(Buffer.from('glTF')).ok).toBe(false);
    const noise = Buffer.alloc(4096);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 31 + 7) & 0xff;
    expect(validateGlb(noise).ok).toBe(false);
  });
});

describe('exceedsDepth', () => {
  const b = (s: string) => Buffer.from(s);
  it('cuenta objetos y listas', () => {
    expect(exceedsDepth(b('{"a":[1,[2,{"b":3}]]}'), 4)).toBe(false);
    expect(exceedsDepth(b('{"a":[1,[2,{"b":3}]]}'), 3)).toBe(true);
  });
  it('ignora corchetes dentro de cadenas, incluso con comillas escapadas', () => {
    expect(exceedsDepth(b('{"a":"[[[[[[[[[["}'), 1)).toBe(false);
    expect(exceedsDepth(b('{"a":"\\"[[[[[[[[["}'), 1)).toBe(false);
    expect(exceedsDepth(b('{"a":"\\\\"}'), 1)).toBe(false);
  });
  it('la profundidad vuelve a bajar al cerrar', () => {
    expect(exceedsDepth(b('[[[]]][[[]]][[[]]]'), 3)).toBe(false);
  });
});
