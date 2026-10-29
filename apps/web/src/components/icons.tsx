import type { SVGProps } from 'react';
import type { AssetKind } from '@/lib/assets';
import type { AssetStatus } from '@/lib/status';

type P = SVGProps<SVGSVGElement>;

function Svg({ children, ...p }: P) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...p}
    >
      {children}
    </svg>
  );
}

export const IconCheck = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8 12.5 2.8 2.8L16 9.5" />
  </Svg>
);
export const IconWarning = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5 2.8 19.5h18.4L12 3.5Z" />
    <path d="M12 10v4.5M12 17.2v.1" />
  </Svg>
);
export const IconCritical = (p: P) => (
  <Svg {...p}>
    <path d="M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2L8.2 3Z" />
    <path d="M12 7.5v5.5M12 16.2v.1" />
  </Svg>
);
export const IconQuestion = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2 1-1.2 1.9M12 16.8v.1" />
  </Svg>
);
export const IconOffline = (p: P) => (
  <Svg {...p}>
    <path d="M3 3l18 18" />
    <path d="M8.5 8.6A10 10 0 0 0 2.5 11.5M5.6 14.4a6.5 6.5 0 0 1 4-2M12 19.2v.1M16.4 12.3a6.5 6.5 0 0 1 2 1.6M13.5 6.1a10 10 0 0 1 8 5.4" />
  </Svg>
);
export const IconWifi = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 9a15 15 0 0 1 19 0M5.8 12.5a10 10 0 0 1 12.4 0M9 16a5 5 0 0 1 6 0M12 19.5v.1" />
  </Svg>
);
export const IconBell = (p: P) => (
  <Svg {...p}>
    <path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15L6 16.5ZM10 21h4" />
  </Svg>
);
export const IconTank = (p: P) => (
  <Svg {...p}>
    <path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" />
    <ellipse cx="12" cy="6" rx="7" ry="2.5" />
    <path d="M5 13c2.5 1.5 4.5-1.5 7 0s4.5 1.5 7 0" />
  </Svg>
);
export const IconPump = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="12" r="6" />
    <path d="M11 6v6l4 2M17 9h4M3 12h2M11 18v3" />
  </Svg>
);
export const IconValve = (p: P) => (
  <Svg {...p}>
    <path d="M3 8v8l9-4-9-4ZM21 8v8l-9-4 9-4ZM12 12V5M9 5h6" />
  </Svg>
);
export const IconCube = (p: P) => (
  <Svg {...p}>
    <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3ZM12 12l8-4.5M12 12 4 7.5M12 12v9" />
  </Svg>
);
export const IconGrid = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </Svg>
);
export const IconDownload = (p: P) => (
  <Svg {...p}>
    <path d="M12 4v11M7.5 11 12 15.5 16.5 11M5 20h14" />
  </Svg>
);
export const IconPower = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v8M6.8 6.5a8 8 0 1 0 10.4 0" />
  </Svg>
);
export const IconPause = (p: P) => (
  <Svg {...p}>
    <rect x="6.5" y="5" width="4" height="14" rx="1" />
    <rect x="13.5" y="5" width="4" height="14" rx="1" />
  </Svg>
);
export const IconLogout = (p: P) => (
  <Svg {...p}>
    <path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9" />
  </Svg>
);

export const STATUS_ICON: Record<AssetStatus, (p: P) => React.JSX.Element> = {
  ok: IconCheck,
  warning: IconWarning,
  critical: IconCritical,
  uncertain: IconQuestion,
  bad: IconOffline,
};

export const KIND_ICON: Record<AssetKind, (p: P) => React.JSX.Element> = {
  tank: IconTank,
  pump: IconPump,
  valve: IconValve,
  other: IconGrid,
};
