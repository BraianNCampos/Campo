import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { JsonLogger } from './common/json-logger';
import { APP_CONFIG, AppConfig } from './config/app-config';
import { securityIssues } from './config/security-check';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Nivel provisional hasta leer la configuración.
    logger: new JsonLogger('info'),
  });
  const cfg = app.get<AppConfig>(APP_CONFIG);
  app.useLogger(new JsonLogger(cfg.logLevel));
  configureApp(app, cfg);
  // En producción parseEnv ya abortó si había problemas; en desarrollo sólo se advierte.
  for (const issue of securityIssues(cfg)) {
    new Logger('security').warn({ msg: 'configuración insegura (no apta para producción)', issue });
  }
  await app.listen(cfg.port, cfg.host);
  new Logger('bootstrap').log({ msg: 'api escuchando', host: cfg.host, port: cfg.port });
}

bootstrap().catch((err: Error) => {
  process.stderr.write(
    JSON.stringify({ level: 'error', msg: 'fallo al arrancar', error: err.message }) + '\n',
  );
  process.exit(1);
});
