import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import helmet from 'helmet';
import { httpLogger } from './common/http-logger.middleware';
import { AppConfig } from './config/app-config';

/** Configuración común a producción y e2e: prefijo, validación, seguridad, WS nativo. */
export function configureApp(app: INestApplication, cfg: AppConfig): void {
  const express = app as NestExpressApplication;
  express.disable('x-powered-by');
  if (cfg.trustProxy) express.set('trust proxy', 1);

  app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.use(helmet());
  app.use(httpLogger);
  app.enableCors({
    origin: cfg.corsOrigins.includes('*') ? true : cfg.corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks();
}
