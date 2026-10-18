import type { ModelSceneTheme } from "./model-scene";

/**
 * Arc's tokens are oklch, which Three cannot parse. Painting one pixel with the
 * token and reading it back makes the browser do the conversion, so the scene
 * matches the surrounding UI in either theme without a hard-coded palette.
 */
function tokenColor(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return fallback;
  context.fillStyle = "magenta";
  context.fillStyle = raw;
  if (context.fillStyle === "magenta") return fallback;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return (r << 16) | (g << 8) | b;
}

function tokenString(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function mix(a: number, b: number, k: number): number {
  const channel = (shift: number) => Math.round(((a >> shift) & 255) * (1 - k) + ((b >> shift) & 255) * k);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

/** The environment follows the theme; physical surfaces never do. */
export function readModelTheme(): ModelSceneTheme {
  const muted = tokenColor("--muted", 0xe6e7ea);
  return {
    ink: tokenString("--paper-ink", "black"),
    // The panes sit on muted/40 over the page; post-processing needs it opaque.
    background: mix(tokenColor("--background", 0xffffff), muted, 0.4),
    ground: muted,
    accent: tokenColor("--primary", 0x3355ff),
    added: tokenColor("--success", 0x2f9e5b),
    changed: tokenColor("--warning", 0xd99a1e),
    removed: tokenColor("--destructive", 0xcc272e),
  };
}
