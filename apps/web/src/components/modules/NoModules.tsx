import { IconGrid } from '../icons';

/** El cliente no tiene módulos contratados (o la planta no habilita ninguno). */
export function NoModules() {
  return (
    <div data-testid="no-modules" className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <IconGrid className="text-5xl text-muted" />
      <h1 className="text-xl font-bold">Sin módulos contratados</h1>
      <p className="text-muted">
        Tu cuenta todavía no tiene ningún módulo de Campo activo. Contactá a Campos Ingeniería y lo dejamos andando en tu planta.
      </p>
    </div>
  );
}

/** Se pidió por URL un módulo que el cliente no contrató. */
export function NotContracted({ label }: { label?: string }) {
  return (
    <div data-testid="module-not-contracted" className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <IconGrid className="text-5xl text-muted" />
      <h1 className="text-xl font-bold">Este módulo no está contratado</h1>
      <p className="text-muted">
        {label ? `«${label}» no forma parte de tu plan actual. ` : ''}Para sumarlo, contactá a Campos Ingeniería: activarlo es cuestión de conectar los sensores.
      </p>
    </div>
  );
}
