import { describe, expect, it } from 'vitest';
import { errorFromResponse, humanizeValidation, kindForStatus } from './errors';

describe('humanizeValidation', () => {
  it('traduce mensajes por defecto de class-validator', () => {
    expect(humanizeValidation('email must be an email').text).toBe('Correo: no es una dirección de correo válida');
    expect(humanizeValidation('threshold must be a number conforming to the specified constraints')).toEqual({ field: 'threshold', text: 'Umbral: debe ser un número' });
    expect(humanizeValidation('forSeconds must not be greater than 86400').text).toBe('Duración (s): no puede ser mayor que 86400');
    expect(humanizeValidation('role must be one of the following values: admin, engineer').text).toContain('admitidos: admin, engineer');
    expect(humanizeValidation('property foo should not exist')).toEqual({ field: 'foo', text: 'Campo no permitido: foo' });
    expect(humanizeValidation('newPassword must be longer than or equal to 12 characters').text).toBe('Contraseña nueva: mínimo 12 caracteres');
  });

  it('sustituye sólo el nombre del campo en los mensajes ya en español', () => {
    expect(humanizeValidation('password debe tener al menos 12 caracteres').text).toBe('Contraseña debe tener al menos 12 caracteres');
    expect(humanizeValidation('plants: ids de planta inválidos').text).toBe('Plantas: ids de planta inválidos');
    expect(humanizeValidation('plant inválida').text).toBe('Planta inválida');
  });

  it('deja intactos los mensajes sin campo conocido', () => {
    expect(humanizeValidation('Algo raro').text).toBe('Algo raro');
  });
});

describe('errorFromResponse', () => {
  it('400 con lista → mensaje resumen, detalles y campos', () => {
    const e = errorFromResponse(400, { statusCode: 400, message: ['email must be an email', 'password debe tener al menos 12 caracteres'], error: 'Bad Request' });
    expect(e.kind).toBe('validation');
    expect(e.message).toBe('Revisa los datos del formulario.');
    expect(e.details).toHaveLength(2);
    expect(e.fields.email).toContain('Correo');
    expect(e.fields.password).toContain('Contraseña');
  });

  it('400 con un único mensaje lo usa tal cual', () => {
    expect(errorFromResponse(400, { message: 'La contraseña actual no es correcta' }).message).toBe('La contraseña actual no es correcta');
  });

  it('403/404/409: usa el texto del servidor si está en español y uno por defecto si es el inglés de Nest', () => {
    expect(errorFromResponse(409, { message: 'El email ya está registrado' }).message).toBe('El email ya está registrado');
    expect(errorFromResponse(403, { message: 'Forbidden resource' }).message).toMatch(/permisos/);
    expect(errorFromResponse(404, { message: 'Not Found' }).message).toMatch(/No se encontró/);
    expect(errorFromResponse(403, { message: 'No tiene acceso a esta planta' }).kind).toBe('forbidden');
  });

  it('401 y 5xx: mensajes genéricos; nunca trazas', () => {
    expect(errorFromResponse(401, {}).kind).toBe('unauthorized');
    const e = errorFromResponse(500, { message: 'TypeError: x is not a function\n    at foo (/app/dist/main.js:1:1)', stack: 'secret' });
    expect(e.message).toBe('Error del servidor (500). Inténtalo de nuevo en unos minutos.');
    expect(JSON.stringify(e)).not.toContain('secret');
  });

  it('cuerpo no JSON o mensajes enormes se ignoran', () => {
    expect(errorFromResponse(409, undefined).message).toMatch(/conflicto/);
    expect(errorFromResponse(409, { message: 'x'.repeat(500) }).message).toMatch(/conflicto/);
  });

  it('kindForStatus', () => {
    expect(kindForStatus(0)).toBe('network');
    expect(kindForStatus(502)).toBe('server');
    expect(kindForStatus(418)).toBe('unknown');
  });
});
