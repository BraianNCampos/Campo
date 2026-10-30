import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

/** Iconos propios de la administración de clientes (mismo trazo que `../icons`). */
function Svg({ children, ...p }: P) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...p}>
      {children}
    </svg>
  );
}

/** Cliente: dos edificios. */
export const IconOrg = (p: P) => (
  <Svg {...p}>
    <path d="M4 20.5V8.5l7-3.5v15.5M11 20.5h9v-9l-5-2.5M3 20.5h18M7 10.5v.1M7 14v.1M7 17.5v.1M15 14v.1M15 17.5v.1" />
  </Svg>
);

/** Módulo: pieza que encastra. */
export const IconModule = (p: P) => (
  <Svg {...p}>
    <path d="M9 4.5h6v4h-6zM4.5 11h6v6h-6zM13.5 11h6v6h-6z" />
  </Svg>
);

export const IconMail = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
    <path d="m4 7 8 6 8-6" />
  </Svg>
);
