import { describe, expect, it } from 'vitest';
import { codeOf, controlErrorFromResponse, ControlApiError } from './errors';
import { parseInterlocks, parseOrderBody, parsePreview } from './http-api';

describe('errores del control en voseo', () => {
  it('409 device_offline y order_in_progress', () => {
    const a = controlErrorFromResponse(409, { error: 'device_offline' }) as ControlApiError;
    expect(a.code).toBe('device_offline');
    expect(a.message).toMatch(/no está enviando datos/);
    const b = controlErrorFromResponse(409, { statusCode: 409, message: 'order_in_progress' }) as ControlApiError;
    expect(b.code).toBe('order_in_progress');
    expect(b.message).toMatch(/Ya hay una orden en curso/);
  });
  it('429 (10 por minuto) y 503 control_unavailable', () => {
    expect(controlErrorFromResponse(429, {}).message).toMatch(/máximo es 10 por minuto/);
    const c = controlErrorFromResponse(503, { error: 'control_unavailable' }) as ControlApiError;
    expect(c.code).toBe('control_unavailable');
    expect(c.message).toMatch(/no logra comunicarse/);
    expect(controlErrorFromResponse(503, undefined).message).toMatch(/no logra comunicarse/);
  });
  it('403: módulo no contratado, equipo no habilitado y rol', () => {
    expect(controlErrorFromResponse(403, { error: 'module_disabled', module: 'control' }).message).toMatch(/no está contratado/);
    expect(controlErrorFromResponse(403, { error: 'control_disabled' }).message).toMatch(/no está habilitado/);
    expect(controlErrorFromResponse(403, { message: 'Forbidden resource' }).message).toMatch(/rol no permite/);
  });
  it('confirmación vencida o inválida; 409 con texto propio del servidor se respeta; nunca códigos en crudo', () => {
    expect(controlErrorFromResponse(409, { error: 'confirm_expired' }).message).toMatch(/venció/);
    expect(controlErrorFromResponse(409, { error: 'confirm_invalid' }).message).toMatch(/ya no sirve/);
    expect(controlErrorFromResponse(409, { message: 'El nivel ya está en el objetivo.' }).message).toBe('El nivel ya está en el objetivo.');
    expect(controlErrorFromResponse(409, { message: 'some_weird_code' }).message).not.toMatch(/some_weird_code/);
    expect(controlErrorFromResponse(500, {}).message).toMatch(/Error del servidor/);
  });
  it('codeOf lee error, code o message con forma de código', () => {
    expect(codeOf({ error: 'device_offline' })).toBe('device_offline');
    expect(codeOf({ code: 'order_in_progress' })).toBe('order_in_progress');
    expect(codeOf({ message: 'Hola mundo' })).toBeNull();
    expect(codeOf(null)).toBeNull();
  });
});

describe('parsers REST del control', () => {
  it('preview', () => {
    expect(parsePreview({ confirmId: 'c1', expiresAt: 5, summary: 's', warnings: ['a', 3, ''], blocked: null })).toEqual({ confirmId: 'c1', expiresAt: 5, summary: 's', warnings: ['a'], blocked: null });
    expect(parsePreview({ confirmId: 'c1', expiresAt: '2025-01-01T00:00:00Z', blocked: 'no' })?.blocked).toBe('no');
    expect(parsePreview({ expiresAt: 5 })).toBeNull();
    expect(parsePreview({ confirmId: 'c1' })).toBeNull();
  });
  it('interlocks acepta lista, {interlocks} o {items}', () => {
    const items = [{ id: 'a', label: 'A', ok: true }, { id: 'b', label: 'B', ok: false, reason: 'por esto' }, { nope: 1 }];
    const want = [{ id: 'a', label: 'A', ok: true }, { id: 'b', label: 'B', ok: false, reason: 'por esto' }];
    expect(parseInterlocks(items)).toEqual(want);
    expect(parseInterlocks({ interlocks: items })).toEqual(want);
    expect(parseInterlocks({ items })).toEqual(want);
    expect(parseInterlocks('x')).toEqual([]);
  });
  it('orden suelta o {order}', () => {
    const o = { id: 'o1', plant: 'p', asset: 'a', command: 'stop', status: 'pending', requestedBy: { id: 'u', email: 'e' }, requestedAt: 1, updatedAt: 1 };
    expect(parseOrderBody(o)?.id).toBe('o1');
    expect(parseOrderBody({ order: o })?.id).toBe('o1');
    expect(parseOrderBody({})).toBeNull();
  });
});
