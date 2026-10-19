import { Sparkles } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { fonts, tint, tokens } from "./brand";
import { pop, track, type Key } from "./motion";

export type CursorKey = Key<{ x: number; y: number; press: number }>;

// A macOS-style arrow. Playwright and screen recordings never show one, and a
// demo without a hand in it feels like a ghost is using the app.
export function Cursor({ keys, children }: { keys: CursorKey[]; children?: ReactNode }) {
  const frame = useCurrentFrame();
  const { x, y, press } = track(frame, keys);
  return (
    <div style={{ position: "absolute", left: x, top: y, zIndex: 50, pointerEvents: "none" }}>
      {children}
      <svg
        width={38}
        height={38}
        viewBox="0 0 24 24"
        style={{
          position: "absolute",
          left: -4,
          top: -3,
          transform: `scale(${1 - press * 0.14})`,
          transformOrigin: "4px 3px",
          filter: "drop-shadow(0 3px 6px oklch(0 0 0 / 0.35))",
        }}
      >
        <path d="M4 2.5 L4 19 L8.4 15 L11.4 21.6 L14.2 20.4 L11.2 13.9 L17.2 13.9 Z" fill="black" stroke="white" strokeWidth={1.4} strokeLinejoin="round" />
      </svg>
    </div>
  );
}

// A ripple at the point of a click.
export function ClickRipple({ x, y, at }: { x: number; y: number; at: number }) {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [at, at + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  if (frame < at || t >= 1) return null;
  const size = 20 + t * 50;
  return (
    <div
      style={{
        position: "absolute",
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        borderRadius: "50%",
        border: `3px solid ${tint(tokens.primary, 70)}`,
        opacity: 1 - t,
        zIndex: 49,
      }}
    />
  );
}

// The "AI found this" label: a white chip with a turning sparkle that springs
// out of the document at `at`.
export function AiChip({ label, x, y, at, style }: { label: string; x: number; y: number; at: number; style?: CSSProperties }) {
  const frame = useCurrentFrame();
  const p = pop(frame, at, 180);
  if (frame < at) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: `translateY(${(1 - p) * 18}px) scale(${0.85 + p * 0.15})`,
        opacity: p,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "14px 22px 14px 18px",
        background: tokens.card,
        boxShadow: "0 10px 30px oklch(0.2 0.05 264 / 0.22), 0 1px 0 oklch(0.2 0.05 264 / 0.06)",
        fontFamily: fonts.sans,
        fontSize: 30,
        fontWeight: 500,
        color: tokens.foreground,
        whiteSpace: "nowrap",
        zIndex: 20,
        ...style,
      }}
    >
      <Sparkles size={26} color={tokens.primary} style={{ transform: `rotate(${(frame - at) * 3}deg)` }} />
      {label}
    </div>
  );
}

// The line over a shot that says what Arc is doing ("Reading PDF"). Each
// label crossfades into the next on its own schedule.
export function WorkingLabel({ steps, y = 90 }: { steps: { at: number; text: string }[]; y?: number }) {
  const frame = useCurrentFrame();
  const current = [...steps].reverse().find((s) => frame >= s.at);
  if (!current) return null;
  const local = frame - current.at;
  const opacity = interpolate(local, [0, 8], [0, 1], { extrapolateRight: "clamp" });
  return (
    <div
      style={{
        position: "absolute",
        top: y,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: 18,
        fontFamily: fonts.sans,
        fontSize: 44,
        fontWeight: 500,
        color: "white",
        letterSpacing: "-0.01em",
        textShadow: "0 2px 18px oklch(0.2 0.05 264 / 0.3)",
        zIndex: 30,
      }}
    >
      <Sparkles size={40} color="white" style={{ transform: `rotate(${frame * 2}deg)` }} />
      <span style={{ opacity, transform: `translateY(${(1 - opacity) * 8}px)` }}>{current.text}</span>
    </div>
  );
}

// A file being dragged: a sheet of paper with a red PDF tag.
export function PdfFile({ name, rotate = 0, style }: { name?: string; rotate?: number; style?: CSSProperties }) {
  return (
    <div
      style={{
        width: 128,
        height: 160,
        background: tokens.paper,
        boxShadow: "0 14px 30px oklch(0 0 0 / 0.28)",
        transform: `rotate(${rotate}deg)`,
        position: "relative",
        ...style,
      }}
    >
      {[22, 36, 50].map((top) => (
        <div key={top} style={{ position: "absolute", left: 18, right: 18, top, height: 6, background: tokens.paperRule }} />
      ))}
      <div
        style={{
          position: "absolute",
          left: 14,
          right: 14,
          bottom: 18,
          height: 54,
          background: tokens.destructive,
          color: "white",
          fontFamily: fonts.sans,
          fontWeight: 700,
          fontSize: 28,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        PDF
      </div>
      {name ? (
        <div style={{ position: "absolute", top: 172, left: -40, right: -40, textAlign: "center", fontFamily: fonts.sans, fontSize: 18, color: "white" }}>
          {name}
        </div>
      ) : null}
    </div>
  );
}
