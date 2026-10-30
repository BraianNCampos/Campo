import { Logger } from '@nestjs/common';

// Silencia los logs de Nest durante los tests.
Logger.overrideLogger(false);

// Entorno mínimo válido para levantar AppModule en e2e (no hay .env en CI).
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret-123';
process.env.BCRYPT_ROUNDS ??= '4';
process.env.ADMIN_EMAIL ??= 'platform@campo.test'; // se siembra como platform_admin
process.env.ADMIN_PASSWORD ??= 'admin-password-123';
process.env.LOGIN_RATE_LIMIT ??= '50';
process.env.ALARM_RULES_REFRESH_MS ??= '3600000';
