import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { PlantParams } from '../common/params';

/** `?name=` de la subida: nombre visible del modelo (1–100 caracteres, sin caracteres de control). */
export class UploadModelQuery {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'name es obligatorio (?name=<nombre>)' })
  @IsNotEmpty({ message: 'name no puede estar vacío' })
  @MaxLength(100)
  @Matches(/^[^\p{Cc}]*$/u, { message: 'name no puede contener caracteres de control' })
  name!: string;
}

export class ModelParams {
  @IsUUID(undefined, { message: 'id debe ser un UUID' })
  id!: string;
}

export class PlantModelParams extends PlantParams {
  @IsUUID(undefined, { message: 'id debe ser un UUID' })
  id!: string;
}
