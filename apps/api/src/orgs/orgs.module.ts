import { Module } from '@nestjs/common';
import { OrgsController } from './orgs.controller';
import { OrgsService } from './orgs.service';

/** OrgsRepository lo provee AuthModule (global): AccessService lo necesita para resolver el cliente de cada sesión. */
@Module({ controllers: [OrgsController], providers: [OrgsService] })
export class OrgsModule {}
