import { describe, expect, it } from 'vitest';
import { contactHref, DEFAULT_CONTACT_EMAIL, resolveContactEmail } from './contact';

describe('correo de contacto', () => {
  it('por defecto info@camposingenieria.ar', () => {
    expect(DEFAULT_CONTACT_EMAIL).toBe('info@camposingenieria.ar');
    expect(resolveContactEmail(undefined)).toBe('info@camposingenieria.ar');
    expect(resolveContactEmail('  ')).toBe('info@camposingenieria.ar');
  });
  it('NEXT_PUBLIC_CONTACT_EMAIL manda si es un correo válido; si no, el de por defecto', () => {
    expect(resolveContactEmail(' ventas@ejemplo.com ')).toBe('ventas@ejemplo.com');
    expect(resolveContactEmail('no es un correo')).toBe(DEFAULT_CONTACT_EMAIL);
    expect(resolveContactEmail('a@b.co?cc=x@y.z')).toBe(DEFAULT_CONTACT_EMAIL);
  });
  it('mailto con asunto codificado', () => {
    expect(contactHref('a@b.co')).toBe('mailto:a@b.co');
    expect(contactHref('a@b.co', 'Sumar módulos')).toBe('mailto:a@b.co?subject=Sumar%20m%C3%B3dulos');
  });
});
