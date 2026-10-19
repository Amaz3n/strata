import { noise2D } from "@remotion/noise";
import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { fonts } from "./brand";
import { track, type Key } from "./motion";

// The brand canvas every shot sits on: a cool indigo-slate wash with a field of
// dots that drift slowly and twinkle. It is the "expressive zone" of the video;
// the product on top of it stays exactly as plain as the app.
export function Background() {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const dots: ReactNode[] = [];
  const step = 46;
  for (let gx = 0; gx < width / step + 1; gx++) {
    for (let gy = 0; gy < height / step + 1; gy++) {
      const n = noise2D("field", gx * 0.08, gy * 0.08);
      // Dots gather toward the lower corners, like a horizon of light.
      const band = Math.max(0, (gy * step) / height - 0.35);
      const twinkle = (noise2D("tw", gx * 0.3 + frame * 0.012, gy * 0.3) + 1) / 2;
      const opacity = Math.max(0, n * 0.6 + 0.2) * band * (0.35 + twinkle * 0.65);
      if (opacity < 0.04) continue;
      const dx = noise2D("dx", gx, gy + frame * 0.004) * 6;
      const dy = noise2D("dy", gx + frame * 0.004, gy) * 6;
      dots.push(
        <circle key={`${gx}-${gy}`} cx={gx * step + dx} cy={gy * step + dy} r={2.2} fill="white" opacity={opacity} />,
      );
    }
  }
  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(120% 90% at 30% 10%, oklch(0.70 0.035 250) 0%, oklch(0.56 0.045 258) 55%, oklch(0.40 0.05 264) 100%)",
      }}
    >
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        {dots}
      </svg>
    </AbsoluteFill>
  );
}

export type CameraKey = Key<{ x: number; y: number; scale: number }>;

// A virtual camera: `x`/`y` is the point of the 1920×1080 stage that sits at
// the centre of the frame, `scale` is the zoom. Every push-in in the video is
// a keyframe list handed to this.
export function Camera({ keys, children }: { keys: CameraKey[]; children: ReactNode }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const { x, y, scale } = track(frame, keys);
  return (
    <AbsoluteFill
      style={{
        transform: `translate(${width / 2}px, ${height / 2}px) scale(${scale}) translate(${-x}px, ${-y}px)`,
        transformOrigin: "0 0",
      }}
    >
      {children}
    </AbsoluteFill>
  );
}

// Every scene fades and de-blurs in, and blurs out, so cuts read as one
// continuous camera rather than a slideshow.
export function Scene({ duration, children, inFrames = 10, outFrames = 10 }: {
  duration: number;
  children: ReactNode;
  inFrames?: number;
  outFrames?: number;
}) {
  const frame = useCurrentFrame();
  // 0 while entering or leaving, 1 in between; a zero-length edge is a cut.
  const enter = inFrames > 0 ? interpolate(frame, [0, inFrames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  const leave = outFrames > 0 ? interpolate(frame, [duration - outFrames, duration], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  const opacity = Math.min(enter, leave);
  const blur = (1 - opacity) * 12;
  return <AbsoluteFill style={{ opacity, filter: `blur(${blur}px)` }}>{children}</AbsoluteFill>;
}

export function Headline({ children, size = 84, style }: { children: ReactNode; size?: number; style?: CSSProperties }) {
  return (
    <div
      style={{
        fontFamily: fonts.sans,
        fontSize: size,
        fontWeight: 600,
        letterSpacing: "-0.03em",
        lineHeight: 1.05,
        color: "white",
        textAlign: "center",
        textShadow: "0 2px 24px oklch(0.2 0.05 264 / 0.25)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
