import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { PasswordRules } from '../common/password-rules';

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;

  /** Política: >= 12 caracteres y <= 72 bytes (la distinta-de-la-actual la comprueba el servicio). */
  @PasswordRules()
  newPassword!: string;
}
