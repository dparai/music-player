import type { ReactNode } from "react";

interface IconProps {
  size?: number;
}

function Svg({ size = 24, fill, children }: IconProps & { fill?: boolean; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const PlayIcon = (p: IconProps) => (
  <Svg {...p} fill><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></Svg>
);

export const PauseIcon = (p: IconProps) => (
  <Svg {...p} fill><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></Svg>
);

export const PrevIcon = (p: IconProps) => (
  <Svg {...p} fill><rect x="5" y="5" width="2.4" height="14" rx="1" /><path d="M19 6.2v11.6a.8.8 0 0 1-1.25.66l-8.3-5.8a.8.8 0 0 1 0-1.32l8.3-5.8A.8.8 0 0 1 19 6.2z" /></Svg>
);

export const NextIcon = (p: IconProps) => (
  <Svg {...p} fill><rect x="16.6" y="5" width="2.4" height="14" rx="1" /><path d="M5 6.2v11.6a.8.8 0 0 0 1.25.66l8.3-5.8a.8.8 0 0 0 0-1.32l-8.3-5.8A.8.8 0 0 0 5 6.2z" /></Svg>
);

export const ShuffleIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22" />
    <path d="m18 2 4 4-4 4" />
    <path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2" />
    <path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8" />
    <path d="m18 14 4 4-4 4" />
  </Svg>
);

export const MixIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="9" cy="12" r="6" /><circle cx="15" cy="12" r="6" /></Svg>
);

export const DiscIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.5" /></Svg>
);

export const LibraryIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 15V6" />
    <path d="M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
    <path d="M12 12H3" />
    <path d="M16 6H3" />
    <path d="M12 18H3" />
  </Svg>
);

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></Svg>
);

export const MoreIcon = (p: IconProps) => (
  <Svg {...p} fill><circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" /></Svg>
);

export const LogoutIcon = (p: IconProps) => (
  <Svg {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></Svg>
);

export const LyricsIcon = (p: IconProps) => (
  <Svg {...p}><path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h13" /></Svg>
);

export const NoteIcon =(p: IconProps) => (
  <Svg {...p}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></Svg>
);
