import { parseEnv } from './app-config';
import { securityIssues } from './security-check';

const strong = 'k9Zr3vQ0xLw7TnE2bYhUc5AaPd8GmJsF4oXi1RtV6yBqNeH';
const prod = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://x',
  REDIS_URL: 'redis://x',
  JWT_SECRET: strong,
};

describe('arranque endurecido (NODE_ENV=production)', () => {
  it('arranca con secretos reales', () => {
    const cfg = parseEnv({
      ...prod,
      ADMIN_EMAIL: 'a@b.c',
      ADMIN_PASSWORD: 'Qe7!mZ2#pL9vXr4T',
    });
    expect(cfg.isProduction).toBe(true);
    expect(cfg.jwtExpiresIn).toBe('1h');
  });

  it.each(['cambia', 'changeme', 'secret', 'example'])(
    'rechaza un JWT_SECRET de ejemplo que contiene "%s"',
    (word) => {
      const jwt = `${strong.slice(0, 20)}-${word.toUpperCase()}-${strong.slice(20)}`;
      expect(() => parseEnv({ ...prod, JWT_SECRET: jwt })).toThrow(
        /JWT_SECRET parece un valor de ejemplo/,
      );
    },
  );

  it('rechaza el JWT_SECRET de .env.example', () => {
    expect(() =>
      parseEnv({
        ...prod,
        JWT_SECRET: 'cambia-esto-por-un-secreto-largo-de-al-menos-32-caracteres',
      }),
    ).toThrow(/openssl rand/);
  });

  it('rechaza un JWT_SECRET corto (también en desarrollo)', () => {
    expect(() => parseEnv({ ...prod, JWT_SECRET: 'corto' })).toThrow('32');
    expect(() => parseEnv({ JWT_SECRET: 'corto' })).toThrow('32');
  });

  it('rechaza un ADMIN_PASSWORD de ejemplo o menor de 12 caracteres', () => {
    const seed = { ADMIN_EMAIL: 'a@b.c' };
    expect(() => parseEnv({ ...prod, ...seed, ADMIN_PASSWORD: 'cambia-esta-contrasena' })).toThrow(
      /ADMIN_PASSWORD parece un valor de ejemplo/,
    );
    expect(() => parseEnv({ ...prod, ...seed, ADMIN_PASSWORD: 'Qe7!mZ2#pL9' })).toThrow('12');
  });

  it('el mensaje de error reúne todos los problemas', () => {
    expect(() =>
      parseEnv({
        ...prod,
        JWT_SECRET: 'changeme'.repeat(5),
        ADMIN_EMAIL: 'a@b.c',
        ADMIN_PASSWORD: 'example-password',
      }),
    ).toThrow(/Configuración insegura para producción: JWT_SECRET.*ADMIN_PASSWORD/);
  });
});

describe('desarrollo: sólo se advierte', () => {
  it('parseEnv no lanza con valores de ejemplo', () => {
    const cfg = parseEnv({
      JWT_SECRET: 'cambia-esto-por-un-secreto-largo-de-al-menos-32-caracteres',
      ADMIN_EMAIL: 'a@b.c',
      ADMIN_PASSWORD: 'cambia-esta-contrasena',
    });
    expect(cfg.isProduction).toBe(false);
    expect(
      securityIssues({ jwtSecret: cfg.jwtSecret, adminPassword: cfg.adminPassword }),
    ).toHaveLength(2);
  });

  it('sin problemas -> lista vacía', () => {
    expect(securityIssues({ jwtSecret: strong, adminPassword: 'Qe7!mZ2#pL9vXr4T' })).toEqual([]);
    expect(securityIssues({ jwtSecret: strong })).toEqual([]);
  });
});
