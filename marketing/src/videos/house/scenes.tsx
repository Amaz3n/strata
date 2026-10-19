import { Box, Check } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { ArcMark, Sidebar } from "../../kit/arc-ui";
import { fonts, tint, tokens } from "../../kit/brand";
import { Background, Camera, Headline } from "../../kit/canvas";
import { fade, pop } from "../../kit/motion";
import { AiChip, ClickRipple, Cursor } from "../../kit/pieces";
import { HouseScene, type CamKey, type HouseState } from "./house-3d";
import { HOUSE, type Wall } from "./plan";
import { PlanDrawing, PlanSheet } from "./sheet";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const BLUEPRINT = "rgb(40, 72, 205)";

// GENERATION_STAGES in components/drawings/workspace/use-workspace-model.ts.
const STAGES = ["Reading the sheets", "Finding walls, doors and windows", "Stacking the floors", "Checking the model"];

// ---------------------------------------------------------------- 1. hook

export function Hook() {
  const frame = useCurrentFrame();
  const a = pop(frame, 4);
  const b = fade(frame, 26, 14);
  return (
    <AbsoluteFill>
      <Background />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", gap: 28 }}>
        <Headline size={112} style={{ opacity: a, transform: `translateY(${(1 - a) * 30}px)` }}>
          Your plans are already a house.
        </Headline>
        <Headline size={46} style={{ fontWeight: 400, opacity: b * 0.85, transform: `translateY(${(1 - b) * 12}px)` }}>
          Arc builds the 3D model from your drawings.
        </Headline>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------- 2. workspace

const WIN = { x: 160, y: 100, w: 1700, h: 1040 };
const PANE = { x: WIN.x + 300 + 860, w: 540 };
const BUILD_BUTTON = { x: PANE.x + 40 + 110, y: 506 };

function Microlabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: tokens.mutedForeground, ...style }}>{children}</span>
  );
}

// The scan bay: the sheet inverted to a blueprint, swept by the beam, with the
// step under way written across it (ModelScanBays in scan-overlay.tsx).
function ScanBay({ width, height, frame, step, ppf, highlight }: { width: number; height: number; frame: number; step: string; ppf: number; highlight?: (wall: Wall) => number }) {
  const beam = (frame % 90) / 90;
  const planW = HOUSE.width * ppf;
  const planH = HOUSE.depth * ppf;
  const corner = Math.max(12, width * 0.025);
  const type = Math.max(10, width * 0.012);
  return (
    <div style={{ position: "relative", width, height, background: BLUEPRINT, overflow: "hidden", border: `1px solid ${tint(tokens.primary, 60)}` }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.18,
          backgroundImage: "linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)",
          backgroundSize: `${ppf * 2}px ${ppf * 2}px`,
          backgroundPosition: `${(width - planW) / 2}px ${(height - planH) / 2}px`,
        }}
      />
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        <g transform={`translate(${(width - planW) / 2} ${(height - planH) / 2})`} opacity={0.92}>
          <PlanDrawing ink="white" ppf={ppf} highlight={highlight} />
        </g>
      </svg>
      <div style={{ position: "absolute", left: 0, right: 0, top: beam * (height * 1.25) - height * 0.25, height: height * 0.25 }}>
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, transparent, rgba(255,255,255,0.35))" }} />
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, background: "white" }} />
      </div>
      {[
        { left: 8, top: 8, borderLeft: 2, borderTop: 2 },
        { right: 8, top: 8, borderRight: 2, borderTop: 2 },
        { left: 8, bottom: 8, borderLeft: 2, borderBottom: 2 },
        { right: 8, bottom: 8, borderRight: 2, borderBottom: 2 },
      ].map(({ borderLeft, borderTop, borderRight, borderBottom, ...pos }, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            width: corner,
            height: corner,
            borderColor: "white",
            borderStyle: "solid",
            borderWidth: `${(borderTop ?? 0) * (width > 1000 ? 2 : 1)}px ${(borderRight ?? 0) * (width > 1000 ? 2 : 1)}px ${(borderBottom ?? 0) * (width > 1000 ? 2 : 1)}px ${(borderLeft ?? 0) * (width > 1000 ? 2 : 1)}px`,
            ...pos,
          }}
        />
      ))}
      <div style={{ position: "absolute", left: corner + 14, right: corner + 14, top: corner * 0.6, display: "flex", justifyContent: "space-between", fontFamily: fonts.mono, fontSize: type, letterSpacing: "0.14em", color: "white" }}>
        <span>FIRST FLOOR</span>
        <span style={{ opacity: 0.75 }}>A-101</span>
      </div>
      <div style={{ position: "absolute", left: corner + 14, bottom: corner * 0.6, fontFamily: fonts.mono, fontSize: type, letterSpacing: "0.14em", color: "rgba(255,255,255,0.9)" }}>
        {step.toUpperCase()}
      </div>
    </div>
  );
}

function stageAt(frame: number, starts: number[]) {
  let i = 0;
  for (let k = 0; k < starts.length; k++) if (frame >= starts[k]) i = k;
  return i;
}

export function Workspace() {
  const frame = useCurrentFrame();
  const clickAt = 70;
  const building = frame >= clickAt + 4;
  const stage = stageAt(frame, [0, 104]);
  const t = frame - clickAt;
  return (
    <AbsoluteFill>
      <Background />
      <Camera
        keys={[
          { at: 0, x: 980, y: 560, scale: 1.0 },
          { at: 60, x: 1250, y: 520, scale: 1.22 },
          { at: 130, x: 1430, y: 520, scale: 1.55 },
        ]}
      >
        <div style={{ position: "absolute", left: WIN.x, top: WIN.y, width: WIN.w, height: WIN.h, display: "flex", background: tokens.background, boxShadow: "0 40px 120px oklch(0.15 0.05 264 / 0.45)", overflow: "hidden", fontFamily: fonts.sans }}>
          <Sidebar active="Projects" />
          <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "30px 28px 0", fontSize: 17, color: tokens.mutedForeground }}>Magnolia Residence</div>
            <div style={{ display: "flex", alignItems: "center", gap: 18, padding: "6px 28px 22px" }}>
              <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em", color: tokens.foreground }}>Drawings</div>
              <span style={{ border: `1px solid ${tokens.border}`, background: tokens.card, padding: "6px 12px", fontSize: 16, color: tokens.foreground, fontFamily: fonts.mono }}>A-101 · Floor plan</span>
            </div>
            <div style={{ flex: 1, display: "flex", borderTop: `1px solid ${tokens.border}` }}>
              <div style={{ width: 860, background: tint(tokens.muted, 100), position: "relative" }}>
                <div style={{ position: "absolute", left: 40, top: 44, transform: "scale(0.52)", transformOrigin: "0 0", boxShadow: "0 8px 30px oklch(0 0 0 / 0.12)" }}>
                  <PlanSheet />
                </div>
              </div>
              <div style={{ width: PANE.w, background: tint(tokens.muted, 40), borderLeft: `1px solid ${tokens.border}`, position: "relative" }}>
                <div style={{ padding: "16px 22px", borderBottom: `1px solid ${tokens.border}` }}>
                  <Microlabel>3D model</Microlabel>
                </div>
                {!building ? (
                  <div style={{ position: "absolute", left: 40, top: 92, width: 440, display: "flex", flexDirection: "column", gap: 12, fontSize: 18, color: tokens.mutedForeground }}>
                    <span style={{ width: 52, height: 52, display: "grid", placeItems: "center", border: `1px solid ${tokens.border}`, background: tokens.card, color: tokens.foreground }}>
                      <Box size={26} />
                    </span>
                    <span style={{ fontSize: 22, fontWeight: 600, color: tokens.foreground }}>No 3D model yet</span>
                    <span style={{ lineHeight: 1.45 }}>Arc builds it from your floor plans: walls, doors, windows and rooms, floor by floor, at the sheet&apos;s scale.</span>
                    <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
                      <span style={{ height: 44, padding: "0 18px", display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap", background: tokens.primary, color: tokens.primaryForeground, fontSize: 17, fontWeight: 500, transform: `scale(${frame >= clickAt && frame < clickAt + 4 ? 0.96 : 1})` }}>
                        <Box size={17} /> Build the 3D model
                      </span>
                      <span style={{ height: 44, padding: "0 14px", display: "flex", alignItems: "center", whiteSpace: "nowrap", fontSize: 15, color: tokens.foreground }}>Choose sheets and floors</span>
                    </div>
                    <span style={{ fontSize: 15 }}>Usually under a minute. You can keep measuring while it works.</span>
                  </div>
                ) : (
                  <div style={{ position: "absolute", left: 30, top: 80, width: 480, opacity: fade(t, 4, 8), display: "flex", flexDirection: "column", gap: 18 }}>
                    <ScanBay width={480} height={360} frame={frame} step={STAGES[stage]} ppf={7.2} />
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <div>
                        <div style={{ fontSize: 20, fontWeight: 600, color: tokens.foreground }}>Building the 3D model</div>
                        <div style={{ fontSize: 15, color: tokens.mutedForeground, marginTop: 4 }}>Keep working on the sheet — it appears here when it&apos;s done.</div>
                      </div>
                      <span style={{ fontFamily: fonts.mono, fontSize: 14, color: tokens.mutedForeground }}>0:{String(Math.floor(t / 30)).padStart(2, "0")}</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      {STAGES.map((label, i) => (
                        <span key={label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, color: i <= stage ? tokens.foreground : tokens.mutedForeground }}>
                          <span style={{ width: 16, height: 16, display: "grid", placeItems: "center", border: `1px solid ${i < stage ? tokens.success : i === stage ? tokens.primary : tokens.border}`, background: i < stage ? tokens.success : "transparent" }}>
                            {i < stage ? <Check size={11} color="white" strokeWidth={3} /> : null}
                          </span>
                          {label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        <Cursor
          keys={[
            { at: 0, x: 900, y: 900, press: 0 },
            { at: 58, x: BUILD_BUTTON.x, y: BUILD_BUTTON.y, press: 0 },
            { at: clickAt - 2, x: BUILD_BUTTON.x, y: BUILD_BUTTON.y, press: 0 },
            { at: clickAt, x: BUILD_BUTTON.x, y: BUILD_BUTTON.y, press: 1 },
            { at: clickAt + 5, x: BUILD_BUTTON.x, y: BUILD_BUTTON.y, press: 0 },
            { at: 140, x: BUILD_BUTTON.x + 330, y: BUILD_BUTTON.y + 470, press: 0 },
          ]}
        />
        <ClickRipple x={BUILD_BUTTON.x} y={BUILD_BUTTON.y} at={clickAt} />
      </Camera>
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------- 3. the scan, close up

export function ScanCloseUp() {
  const frame = useCurrentFrame();
  const stage = stageAt(frame, [0, 34, 88, 112]);
  const ppf = 21;
  const planTop = (1080 - HOUSE.depth * ppf) / 2;
  // The beam traces walls as it passes them: a wall lights when the beam
  // crosses its top, in the plan's own coordinates.
  const sweep = interpolate(frame, [20, 100], [-2, HOUSE.depth + 2], clamp);
  const highlight = (w: Wall) => interpolate(sweep - Math.min(w.y1, w.y2), [0, 3], [0, 0.9], clamp);
  const push = interpolate(frame, [0, 130], [1.06, 1.0], clamp);
  return (
    <AbsoluteFill style={{ background: BLUEPRINT }}>
      <AbsoluteFill style={{ transform: `scale(${push})` }}>
        <ScanBay width={1920} height={1080} frame={frame + 30} step={STAGES[stage]} ppf={ppf} highlight={highlight} />
      </AbsoluteFill>
      <AiChip label="Walls" x={230} y={planTop + 60} at={40} />
      <AiChip label="Doors" x={1500} y={planTop + 140} at={54} />
      <AiChip label="Windows" x={1480} y={planTop + 560} at={66} />
      <AiChip label="Rooms" x={250} y={planTop + 640} at={78} />
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------- 3D shots

function Stage3D({ camera, state, children }: { camera: CamKey[]; state: HouseState; children?: ReactNode }) {
  return (
    <AbsoluteFill>
      <Background />
      <HouseScene width={1920} height={1080} camera={camera} state={state} />
      {children}
    </AbsoluteFill>
  );
}

// Overlay chip, styled as Arc's tool popovers.
function ToolCard({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ position: "absolute", background: tokens.card, boxShadow: "0 16px 40px oklch(0.15 0.05 264 / 0.3)", fontFamily: fonts.sans, color: tokens.foreground, ...style }}>{children}</div>
  );
}

const TOP_DOWN: CamKey = { at: 0, az: 0, el: 88, dist: 84, tx: 0, ty: 0, tz: 0, fov: 35 };
const OVERVIEW = { az: 32, el: 44, dist: 96, tx: 0, ty: 0, tz: 1, fov: 35 };

// 4 — the walls rise out of the blueprint, the floors finish, the furniture lands.
export function Rise() {
  const frame = useCurrentFrame();
  const state: HouseState = {
    rise: interpolate(frame, [12, 120], [0, 1], clamp),
    finish: interpolate(frame, [104, 150], [0, 1], clamp),
    furnish: interpolate(frame, [136, 210], [0, 1], clamp),
    hour: 15,
  };
  return (
    <Stage3D
      camera={[TOP_DOWN, { ...TOP_DOWN, at: 30, el: 86, dist: 82 }, { at: 150, ...OVERVIEW, az: 18, el: 50, dist: 100 }, { at: 240, ...OVERVIEW }]}
      state={state}
    >
      <Caption text="Built from the sheet's own linework" at={150} until={232} />
    </Stage3D>
  );
}

function Caption({ text, at, until }: { text: string; at: number; until: number }) {
  const frame = useCurrentFrame();
  const o = fade(frame, at, 12) * (1 - fade(frame, until - 12, 12));
  if (o <= 0) return null;
  return (
    <Headline size={44} style={{ position: "absolute", top: 70, left: 0, right: 0, fontWeight: 500, opacity: o, transform: `translateY(${(1 - o) * 10}px)` }}>
      {text}
    </Headline>
  );
}

const formatHour = (h: number) => {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60 / 15) * 15;
  const suffix = hh >= 12 ? "PM" : "AM";
  const twelve = hh % 12 === 0 ? 12 : hh % 12;
  return `${twelve}:${String(mm % 60).padStart(2, "0")} ${suffix}`;
};

// 5 — drag the sun: shadows swing across the house.
export function SunSweep() {
  const frame = useCurrentFrame();
  const hour = interpolate(frame, [16, 140], [7.5, 18.5], clamp);
  const card = pop(frame, 4);
  const pct = (hour - 5) / 16;
  return (
    <Stage3D camera={[{ at: 0, ...OVERVIEW }, { at: 160, ...OVERVIEW, az: 70, el: 40, dist: 90 }]} state={{ rise: 1, finish: 1, furnish: 1, hour }}>
      <ToolCard style={{ left: 120, bottom: 110, width: 420, padding: "22px 24px", opacity: card, transform: `translateY(${(1 - card) * 20}px)` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: "0.14em", color: tokens.mutedForeground }}>SUN</span>
          <span style={{ fontFamily: fonts.mono, fontSize: 20 }}>{formatHour(hour)}</span>
        </div>
        <div style={{ position: "relative", height: 6, background: tokens.muted, margin: "20px 0 14px" }}>
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct * 100}%`, background: tokens.primary }} />
          <div style={{ position: "absolute", left: `calc(${pct * 100}% - 11px)`, top: -8, width: 22, height: 22, borderRadius: "50%", background: tokens.card, border: `2px solid ${tokens.primary}`, boxShadow: "0 2px 6px oklch(0 0 0 / 0.2)" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: fonts.mono, fontSize: 13, color: tokens.mutedForeground }}>
          <span>5 AM</span>
          <span>Noon</span>
          <span>9 PM</span>
        </div>
      </ToolCard>
      <Caption text="Today's sun, at this site" at={10} until={150} />
    </Stage3D>
  );
}

// Eye level in the living room, from beside the media console: the sofa's
// front, the lounge chair and the north glass with the sun coming through.
const EYE = { tx: 12, ty: 3.6, tz: -12, fov: 50 };

// 6 — swoop down and walk in.
export function Walkthrough() {
  const frame = useCurrentFrame();
  const rec = fade(frame, 50, 8);
  const seconds = Math.max(0, Math.floor((frame - 50) / 30));
  return (
    <Stage3D
      camera={[
        { at: 0, ...OVERVIEW, az: 70, el: 40, dist: 90 },
        { at: 60, az: 58, el: 24, dist: 38, tx: 9, ty: 3, tz: -9, fov: 44 },
        { at: 130, az: 47, el: 6, dist: 16.5, ...EYE },
      ]}
      state={{ rise: 1, finish: 1, furnish: 1, hour: 16.5 }}
    >
      <ToolCard style={{ left: "50%", bottom: 90, transform: `translateX(-50%) translateY(${(1 - rec) * 20}px)`, opacity: rec, padding: "16px 24px", display: "flex", alignItems: "center", gap: 14, fontSize: 24, fontWeight: 500 }}>
        <span style={{ width: 14, height: 14, borderRadius: "50%", background: tokens.destructive, opacity: frame % 30 < 20 ? 1 : 0.35 }} />
        Record walkthrough
        <span style={{ fontFamily: fonts.mono, fontSize: 20, color: tokens.mutedForeground }}>0:{String(seconds).padStart(2, "0")}</span>
      </ToolCard>
    </Stage3D>
  );
}

// 7 — the path-traced photo resolving, approximated with a grain that clears.
export function RenderPhoto() {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [10, 92], [0, 1], { ...clamp, easing: (t) => 1 - Math.pow(1 - t, 2.2) });
  const grain = (1 - progress) * 0.75;
  const label = progress < 1 ? `Rendering photo · ${Math.round(progress * 100)}%` : "Photo ready";
  return (
    <Stage3D camera={[{ at: 0, az: 47, el: 6, dist: 16.5, ...EYE }, { at: 130, az: 52, el: 6, dist: 15.8, ...EYE }]} state={{ rise: 1, finish: 1, furnish: 1, hour: 16.5 }}>
      {grain > 0.01 ? (
        <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, opacity: grain, mixBlendMode: "hard-light" }}>
          <filter id="grain">
            <feTurbulence type="fractalNoise" baseFrequency="0.95" numOctaves={2} seed={frame} />
            <feColorMatrix type="saturate" values="0.2" />
          </filter>
          <rect width="100%" height="100%" filter="url(#grain)" />
        </svg>
      ) : null}
      <ToolCard style={{ left: "50%", bottom: 90, transform: "translateX(-50%)", padding: "16px 26px", minWidth: 380, fontSize: 24, fontWeight: 500 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {progress >= 1 ? <Check size={24} color={tokens.success} strokeWidth={3} /> : null}
          {label}
        </div>
        <div style={{ height: 4, background: tokens.muted, marginTop: 12 }}>
          <div style={{ height: 4, width: `${progress * 100}%`, background: progress >= 1 ? tokens.success : tokens.primary }} />
        </div>
      </ToolCard>
    </Stage3D>
  );
}

// ---------------------------------------------------------------- 8. the buyer's phone

const PHONE = { w: 430, h: 880 };

export function BuyerPhone() {
  const frame = useCurrentFrame();
  const enter = pop(frame, 4, 110);
  const text = fade(frame, 22, 14);
  const screenW = PHONE.w - 28;
  const modelH = 520;
  return (
    <AbsoluteFill>
      <Background />
      <div style={{ position: "absolute", left: 170, top: 330, width: 760, opacity: text, transform: `translateY(${(1 - text) * 16}px)` }}>
        <Headline size={84} style={{ textAlign: "left" }}>
          Your buyer can walk it too.
        </Headline>
        <Headline size={34} style={{ textAlign: "left", fontWeight: 400, marginTop: 26, opacity: 0.85 }}>
          It lives in their client portal, one link away on their phone.
        </Headline>
      </div>
      <div
        style={{
          position: "absolute",
          left: 1180,
          top: (1080 - PHONE.h) / 2,
          width: PHONE.w,
          height: PHONE.h,
          borderRadius: 64,
          background: "oklch(0.18 0.01 260)",
          padding: 14,
          boxShadow: "0 50px 120px oklch(0.12 0.05 264 / 0.5), inset 0 0 0 2px oklch(0.35 0.01 260)",
          transform: `translateY(${(1 - enter) * 120}px) rotate(${(1 - enter) * 4}deg)`,
          opacity: enter,
        }}
      >
        <div style={{ width: screenW, height: PHONE.h - 28, borderRadius: 52, overflow: "hidden", background: tokens.background, fontFamily: fonts.sans, position: "relative" }}>
          <div style={{ height: 54 }} />
          <div style={{ padding: "6px 24px 14px", display: "flex", alignItems: "center", gap: 12 }}>
            <ArcMark size={30} />
            <div>
              <div style={{ fontSize: 19, fontWeight: 600, color: tokens.foreground }}>Magnolia Residence</div>
              <div style={{ fontSize: 14, color: tokens.mutedForeground }}>Gulfstone Homes</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 22, padding: "0 24px", borderBottom: `1px solid ${tokens.border}`, fontSize: 16 }}>
            {["Overview", "Selections", "Model"].map((tab) => (
              <span key={tab} style={{ padding: "12px 0", color: tab === "Model" ? tokens.foreground : tokens.mutedForeground, fontWeight: tab === "Model" ? 600 : 400, boxShadow: tab === "Model" ? `inset 0 -2px 0 ${tokens.primary}` : "none" }}>
                {tab}
              </span>
            ))}
          </div>
          <div style={{ position: "relative", height: modelH, background: tint(tokens.muted, 60) }}>
            <HouseScene
              width={screenW}
              height={modelH}
              camera={[
                { at: 0, az: -20, el: 52, dist: 118, tx: 0, ty: 0, tz: 0, fov: 40 },
                { at: 150, az: 50, el: 46, dist: 108, tx: 0, ty: 0, tz: 0, fov: 40 },
              ]}
              state={{ rise: 1, finish: 1, furnish: 1, hour: 15 }}
            />
          </div>
          <div style={{ padding: "18px 24px", fontSize: 16, lineHeight: 1.45, color: tokens.mutedForeground }}>A model of your floorplan, built from the construction drawings.</div>
        </div>
      </div>
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------- 9. end card

export function EndCard() {
  const frame = useCurrentFrame();
  const mark = pop(frame, 4, 120);
  const line = fade(frame, 20, 14);
  return (
    <AbsoluteFill>
      <Background />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", gap: 40 }}>
        <div style={{ transform: `scale(${0.6 + mark * 0.4})`, opacity: mark, background: "white", padding: 26, boxShadow: "0 20px 60px oklch(0.15 0.05 264 / 0.35)" }}>
          <ArcMark size={120} />
        </div>
        <Headline size={80} style={{ opacity: line, transform: `translateY(${(1 - line) * 14}px)` }}>
          Plans in. House out.
        </Headline>
        <Headline size={34} style={{ fontWeight: 400, opacity: fade(frame, 34, 14) * 0.85 }}>
          3D models in Arc
        </Headline>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

