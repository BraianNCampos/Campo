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

export const IconUsers = (p: P) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 19.5c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.4c1.8.7 3 2.4 3 5.1" />
  </Svg>
);
export const IconUser = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.5 20c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6" />
  </Svg>
);
export const IconPlant = (p: P) => (
  <Svg {...p}>
    <path d="M3 20.5h18M5 20.5V10l5 3V10l5 3V6h4v14.5M8.5 17h.1M12.5 17h.1" />
  </Svg>
);
export const IconRules = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5" />
  </Svg>
);
export const IconAudit = (p: P) => (
  <Svg {...p}>
    <path d="M8 4.5H6a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5V6A1.5 1.5 0 0 0 18 4.5h-2" />
    <rect x="8" y="3" width="8" height="3.5" rx="1" />
    <path d="M8.5 11.5h7M8.5 15h5" />
  </Svg>
);
export const IconSettings = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconEdit = (p: P) => (
  <Svg {...p}>
    <path d="M4 20l1-4L16.5 4.5a2 2 0 0 1 3 3L8 19l-4 1ZM14.5 6.5l3 3" />
  </Svg>
);
export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5" />
  </Svg>
);
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const IconChevron = (p: P) => (
  <Svg {...p}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);
export const IconBack = (p: P) => (
  <Svg {...p}>
    <path d="M15 5l-7 7 7 7" />
  </Svg>
);
export const IconKey = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="3.6" />
    <path d="M10.6 12.4 19 4M16 7l2.5 2.5M13.5 9.5 15 11" />
  </Svg>
);
export const IconRefresh = (p: P) => (
  <Svg {...p}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />
  </Svg>
);
export const IconInfo = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.8v.1" />
  </Svg>
);
export const IconHome = (p: P) => (
  <Svg {...p}>
    <path d="M4 11.5 12 4l8 7.5M6 10v10h12V10" />
  </Svg>
);

export const IconNoData = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
    <path d="M8.5 12h7" />
  </Svg>
);
export const IconSensor = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="9" r="3" />
    <path d="M6.5 5.5a8 8 0 0 0 0 7M17.5 5.5a8 8 0 0 1 0 7M12 12v8.5M9 20.5h6" />
  </Svg>
);
export const IconUpload = (p: P) => (
  <Svg {...p}>
    <path d="M12 16V5M7.5 9 12 4.5 16.5 9M5 20h14" />
  </Svg>
);
export const IconEye = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </Svg>
);

export const IconThermo = (p: P) => (
  <Svg {...p}>
    <path d="M10 14.5V5a2 2 0 1 1 4 0v9.5a4 4 0 1 1-4 0Z" />
    <path d="M12 9v7" />
  </Svg>
);
export const IconBolt = (p: P) => (
  <Svg {...p}>
    <path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" />
  </Svg>
);
export const IconFlame = (p: P) => (
  <Svg {...p}>
    <path d="M12 21c-3.6 0-6-2.4-6-5.6 0-3 2.2-4.6 3.4-6.9.6 1.2 1.1 1.8 1.9 2.2C11 7.6 12.3 5.2 13 3c3.6 2.2 5 5.4 5 8.4 0 1.1-.2 1.9-.4 2.6" />
    <path d="M12 21c2.4 0 4-1.5 4-3.7 0-1.4-.9-2.4-2-3.3-.5 1-1.1 1.5-2 1.8-.9-.6-1.5-1.4-1.8-2.5-1 1.2-1.6 2.4-1.6 3.7 0 2.3 1.5 4 3.4 4Z" />
  </Svg>
);
export const IconGear = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 3.5v2.600M12 17.900v2.600M3.5 12h2.600M17.9 12h2.600M6 6l1.8 1.800M16.2 16.2 18 18M6 18l1.8-1.800M16.2 7.8 18 6" />
    <circle cx="12" cy="12" r="6.6" />
  </Svg>
);
export const IconGauge = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 17.500a8.5 8.5 0 1 1 15 0" />
    <path d="M12 13.5 15.5 8.500M12 17.500v.1M6 14l.1.1M18 14l-.1.1M12 7.500v.1" />
  </Svg>
);
export const IconDroplet = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.500c3.4 4 5.5 6.8 5.5 9.800a5.5 5.5 0 0 1-11 0c0-3 2.1-5.8 5.5-9.800Z" />
    <path d="M9.5 14a2.6 2.6 0 0 0 2.3 2.3" />
  </Svg>
);
export const IconMonitor = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="12" rx="1.5" />
    <path d="M8.5 20h7M12 16.500V20" />
  </Svg>
);
export const IconNear = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.500v5" />
    <path d="M12 16.200v.1" />
  </Svg>
);
export const IconTrendUp = (p: P) => (
  <Svg {...p}>
    <path d="m4 16 5.5-5.5 3.5 3.500L20 7M14.5 7H20v5.5" />
  </Svg>
);
export const IconMore = (p: P) => (
  <Svg {...p}>
    <circle cx="6" cy="12" r="1.3" />
    <circle cx="12" cy="12" r="1.3" />
    <circle cx="18" cy="12" r="1.3" />
  </Svg>
);
export const IconExternal = (p: P) => (
  <Svg {...p}>
    <path d="M13 5h6v6M19 5l-8 8M18 14v4.500a1.5 1.5 0 0 1-1.5 1.500h-10A1.5 1.5 0 0 1 5 18.500v-10A1.5 1.5 0 0 1 6.5 7H11" />
  </Svg>
);
export const IconPlay = (p: P) => (
  <Svg {...p}>
    <path d="M7 4.500v15l12-7.500L7 4.500Z" />
  </Svg>
);

export const STATUS_ICON: Record<AssetStatus, (p: P) => React.JSX.Element> = {
  ok: IconCheck,
  warning: IconWarning,
  critical: IconCritical,
  uncertain: IconQuestion,
  bad: IconOffline,
  nodata: IconNoData,
};

export const KIND_ICON: Record<AssetKind, (p: P) => React.JSX.Element> = {
  tank: IconTank,
  pump: IconPump,
  valve: IconValve,
  sensor: IconSensor,
  climate: IconThermo,
  energy: IconBolt,
  gas: IconFlame,
  machine: IconGear,
  pressure: IconGauge,
  flow: IconDroplet,
  other: IconGrid,
};
