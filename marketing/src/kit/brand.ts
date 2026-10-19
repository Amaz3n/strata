import { loadFont as loadSans } from "@remotion/google-fonts/DMSans";
import { loadFont as loadMono } from "@remotion/google-fonts/DMMono";

// Arc's typefaces, the same two app/layout.tsx loads.
const sans = loadSans("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] });
const mono = loadMono("normal", { weights: ["400"], subsets: ["latin"] });

export const fonts = {
  sans: sans.fontFamily,
  mono: mono.fontFamily,
};

// Mirrors the light-theme tokens in app/globals.css. UI replicas use these so
// the product on screen looks like the product; only the canvas behind it
// (background, chips, titles) is marketing.
export const tokens = {
  background: "oklch(0.98 0.004 260)",
  foreground: "oklch(0.14 0.02 260)",
  card: "oklch(1 0 0)",
  primary: "oklch(0.48 0.22 264)",
  primaryForeground: "oklch(0.99 0 0)",
  muted: "oklch(0.95 0.006 260)",
  mutedForeground: "oklch(0.48 0.01 260)",
  accent: "oklch(0.92 0.03 255)",
  accentForeground: "oklch(0.30 0.08 260)",
  border: "oklch(0.91 0.006 260)",
  lineStrong: "oklch(0.84 0.008 260)",
  success: "oklch(0.62 0.18 145)",
  warning: "oklch(0.66 0.15 60)",
  destructive: "oklch(0.53 0.22 25)",
  sidebar: "oklch(0.16 0.03 264)",
  sidebarForeground: "oklch(0.88 0.01 260)",
  sidebarAccent: "oklch(0.24 0.025 264)",
  sidebarBorder: "oklch(0.26 0.025 264)",
  sidebarPrimary: "oklch(0.58 0.20 264)",
  paper: "oklch(1 0 0)",
  paperInk: "oklch(0.15 0 0)",
  paperInkSoft: "oklch(0.45 0 0)",
  paperInkFaint: "oklch(0.62 0 0)",
  paperRule: "oklch(0.88 0 0)",
};

// Tints a token by mixing it with transparency, the same idea as Tailwind's
// `bg-warning/10`.
export const tint = (color: string, percent: number) =>
  `color-mix(in oklch, ${color} ${percent}%, transparent)`;

export const FPS = 30;
