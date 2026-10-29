import { JsonLogger } from './json-logger';

describe('JsonLogger', () => {
  const make = (level: 'debug' | 'info' | 'warn' | 'error' = 'info') => {
    const lines: string[] = [];
    return { lines, logger: new JsonLogger(level, (l) => lines.push(l)) };
  };

  it('emite JSON con nivel, contexto y mensaje', () => {
    const { lines, logger } = make();
    logger.log('hola', 'Ctx');
    const e = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(e).toMatchObject({ level: 'info', msg: 'hola', context: 'Ctx' });
    expect(typeof e.time).toBe('string');
  });

  it('redacta claves sensibles (password, token, hash...)', () => {
    const { lines, logger } = make();
    logger.log(
      { msg: 'x', password: 'secreta', accessToken: 't', passwordHash: 'h', email: 'a@b.c' },
      'Ctx',
    );
    expect(lines[0]).not.toContain('secreta');
    const e = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(e).toMatchObject({
      password: '[redacted]',
      accessToken: '[redacted]',
      passwordHash: '[redacted]',
      email: 'a@b.c',
    });
  });

  it('respeta el nivel mínimo', () => {
    const { lines, logger } = make('warn');
    logger.log('no');
    logger.debug('no');
    logger.warn('si');
    logger.error('si');
    expect(lines).toHaveLength(2);
  });
});
