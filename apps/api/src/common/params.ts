import { ID_PATTERN } from '@campo/shared';
import { Matches } from 'class-validator';

const MSG = 'debe cumplir ^[a-z0-9][a-z0-9_-]{0,63}$';

export class PlantParams {
  @Matches(ID_PATTERN, { message: `plant ${MSG}` })
  plant!: string;
}

export class AssetParams extends PlantParams {
  @Matches(ID_PATTERN, { message: `asset ${MSG}` })
  asset!: string;
}
