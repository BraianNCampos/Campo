import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_CONFIG, parseEnv } from './app-config';

/**
 * @nestjs/config carga .env en process.env; APP_CONFIG expone la configuración ya validada y tipada.
 * `validate` hace fallar el arranque pronto si el entorno es inválido.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      validate: (env: Record<string, unknown>) => {
        parseEnv(env as Record<string, string | undefined>);
        return env;
      },
    }),
  ],
  providers: [{ provide: APP_CONFIG, useFactory: () => parseEnv(process.env) }],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
