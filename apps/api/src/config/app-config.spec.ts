import { parseEnv } from './app-config';

const base = { JWT_SECRET: 'x'.repeat(32) };

describe('parseEnv', () => {
  it('aplica valores por defecto', () => {
    const c = parseEnv(base);
    expect(c).toMatchObject({
      port: 3001,
      nodeEnv: 'development',
      wsCoalesceMs: 100,
      wsPingIntervalMs: 25_000,
      corsOrigins: ['http://localhost:3000'],
      alarmEngineEnabled: true,
    });
  });

  it('exige JWT_SECRET de al menos 32 caracteres', () => {
    expect(() => parseEnv({})).toThrow('JWT_SECRET');
    expect(() => parseEnv({ JWT_SECRET: 'corto' })).toThrow('32');
  });

  it('exige DATABASE_URL y REDIS_URL en producción y prohíbe CORS "*"', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production' })).toThrow('DATABASE_URL');
    const prod = {
      ...base,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
    };
    expect(parseEnv(prod).isProduction).toBe(true);
    expect(() => parseEnv({ ...prod, CORS_ORIGINS: '*' })).toThrow('CORS');
  });

  it('valida números y booleanos', () => {
    expect(() => parseEnv({ ...base, PORT: 'abc' })).toThrow('PORT');
    expect(() => parseEnv({ ...base, PORT: '70000' })).toThrow('PORT');
    expect(() => parseEnv({ ...base, ALARM_ENGINE_ENABLED: 'quizas' })).toThrow(
      'ALARM_ENGINE_ENABLED',
    );
    expect(parseEnv({ ...base, ALARM_ENGINE_ENABLED: 'false' }).alarmEngineEnabled).toBe(false);
  });

  it('admin semilla: email y contraseña juntos, contraseña >= 8', () => {
    expect(() => parseEnv({ ...base, ADMIN_EMAIL: 'a@b.c' })).toThrow('ADMIN_EMAIL');
    expect(() => parseEnv({ ...base, ADMIN_EMAIL: 'a@b.c', ADMIN_PASSWORD: 'corta' })).toThrow('8');
    const c = parseEnv({ ...base, ADMIN_EMAIL: 'Admin@B.c', ADMIN_PASSWORD: 'larga-larga' });
    expect(c.adminEmail).toBe('admin@b.c');
  });

  it('separa múltiples orígenes CORS', () => {
    expect(parseEnv({ ...base, CORS_ORIGINS: 'https://a.com, https://b.com' }).corsOrigins).toEqual(
      ['https://a.com', 'https://b.com'],
    );
  });
});
