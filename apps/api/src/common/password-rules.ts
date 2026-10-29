import { MinLength, ValidationOptions, IsString, registerDecorator } from 'class-validator';

/** Política mínima de contraseñas. bcrypt sólo usa los primeros 72 bytes: se rechaza lo que excede. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_BYTES = 72;

/** El string no puede superar `max` bytes en UTF-8. */
export function MaxBytes(max: number, options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) =>
    registerDecorator({
      name: 'maxBytes',
      target: target.constructor,
      propertyName: propertyName as string,
      options: { message: `${String(propertyName)} no puede superar ${max} bytes`, ...options },
      validator: {
        validate: (v: unknown) => typeof v === 'string' && Buffer.byteLength(v, 'utf8') <= max,
      },
    });
}

/** Política de contraseña nueva: string, ≥ 12 caracteres y ≤ 72 bytes. */
export const PasswordRules = () => (target: object, key: string) => {
  IsString()(target, key);
  MinLength(PASSWORD_MIN_LENGTH, {
    message: `${key} debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`,
  })(target, key);
  MaxBytes(PASSWORD_MAX_BYTES)(target, key);
};
