/** Fragmentos que delatan un valor de ejemplo copiado de la documentación o de .env.example. */
const EXAMPLE_MARKERS = ['cambia', 'changeme', 'change-me', 'secret', 'example'];
const MIN_ADMIN_PASSWORD_PROD = 12;

const looksLikeExample = (value: string): string | undefined => {
  const v = value.toLowerCase();
  return EXAMPLE_MARKERS.find((m) => v.includes(m));
};

/**
 * Problemas de seguridad de la configuración (lista vacía = todo bien).
 * En producción son fatales (parseEnv lanza); en desarrollo sólo se advierten (main.ts).
 */
export function securityIssues(cfg: { jwtSecret: string; adminPassword?: string }): string[] {
  const issues: string[] = [];
  if (cfg.jwtSecret.length < 32) {
    issues.push('JWT_SECRET es demasiado corto (mínimo 32 caracteres)');
  }
  const jwtMarker = looksLikeExample(cfg.jwtSecret);
  if (jwtMarker) {
    issues.push(
      `JWT_SECRET parece un valor de ejemplo (contiene "${jwtMarker}"); genera uno aleatorio, p. ej. openssl rand -base64 48`,
    );
  }
  if (cfg.adminPassword !== undefined) {
    const pwMarker = looksLikeExample(cfg.adminPassword);
    if (pwMarker) {
      issues.push(
        `ADMIN_PASSWORD parece un valor de ejemplo (contiene "${pwMarker}"); define una contraseña propia`,
      );
    }
    if (cfg.adminPassword.length < MIN_ADMIN_PASSWORD_PROD) {
      issues.push(`ADMIN_PASSWORD debe tener al menos ${MIN_ADMIN_PASSWORD_PROD} caracteres`);
    }
  }
  return issues;
}
