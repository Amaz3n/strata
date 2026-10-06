"use client";

/**
 * The hologram scan — what it looks like while Arc reads a drawing.
 *
 * Three moments, one look (a blueprint grid, HUD corner brackets, a beam
 * sweeping through, a mono caption): a sheet being read for rooms, symbols or
 * its scale (`SheetScan`, drawn in the sheet's own coordinates so it zooms with
 * it); a 3D model being traced from its sheets (`ModelScanBays`, one bay per
 * floor, like suits in a lab); and the model arriving (`ScanReveal`, once).
 *
 * It is live progress, so it moves only while real work runs, and stands
 * still for anyone who asked for reduced motion.
 */

import { useEffect, useId, useState } from "react";

import { cn } from "@/lib/utils";

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const change = () => setReduced(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return reduced;
}

/** Over the sheet, in image pixels: rendered inside the sheet's SVG overlay. */
export function SheetScan({ imageSize, caption }: { imageSize: { width: number; height: number }; caption: string }) {
  const id = useId().replace(/:/g, "");
  const reduced = useReducedMotion();
  const { width: w, height: h } = imageSize;
  const cell = Math.max(w, h) / 48;
  const bracket = Math.min(w, h) * 0.06;
  const inset = Math.min(w, h) * 0.012;
  const band = h * 0.16;
  const type = Math.max(w, h) * 0.014;
  const corners: Array<[number, number, number, number]> = [
    [inset, inset, 1, 1],
    [w - inset, inset, -1, 1],
    [inset, h - inset, 1, -1],
    [w - inset, h - inset, -1, -1],
  ];
  return (
    <g pointerEvents="none" aria-hidden>
      <defs>
        <pattern id={`${id}-grid`} width={cell} height={cell} patternUnits="userSpaceOnUse">
          <path d={`M ${cell} 0 L 0 0 0 ${cell}`} fill="none" stroke="var(--primary)" strokeOpacity={0.14} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </pattern>
        <linearGradient id={`${id}-beam`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity={0} />
          <stop offset="88%" stopColor="var(--primary)" stopOpacity={0.22} />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.5} />
        </linearGradient>
      </defs>
      <rect width={w} height={h} fill="var(--primary)" fillOpacity={0.07} />
      <rect width={w} height={h} fill={`url(#${id}-grid)`} />
      {!reduced && (
        <g>
          <rect x={0} y={-band} width={w} height={band} fill={`url(#${id}-beam)`} />
          <line x1={0} x2={w} y1={0} y2={0} stroke="var(--primary)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          <animateTransform attributeName="transform" type="translate" values={`0 0; 0 ${h + band}; 0 0`} keyTimes="0;0.5;1" dur="4.8s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1; 0.45 0 0.55 1" />
        </g>
      )}
      {corners.map(([x, y, dx, dy]) => (
        <path
          key={`${x}-${y}`}
          d={`M ${x} ${y + dy * bracket} L ${x} ${y} L ${x + dx * bracket} ${y}`}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={2.5}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <text x={inset + bracket * 0.35} y={inset + bracket * 0.55} fill="var(--primary)" fontSize={type} fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" letterSpacing={type * 0.12}>
        {caption.toUpperCase()}
      </text>
    </g>
  );
}

export interface ScanBay {
  key: string;
  /** "First floor", or the sheet number when no floor is named yet. */
  name: string;
  sheetNumber: string | null;
  thumbnailUrl: string | null;
}

/**
 * The model being traced: each source sheet in its own bay, inverted to a
 * blueprint and swept by the beam, with the step under way written across it.
 */
export function ModelScanBays({ bays, step, className }: { bays: ScanBay[]; step: string; className?: string }) {
  return (
    <div className={cn("grid gap-2", bays.length > 1 ? "grid-cols-2" : "grid-cols-1", className)}>
      {bays.slice(0, 4).map((bay, index) => (
        <div key={bay.key} className="relative aspect-[4/3] overflow-hidden border border-primary/60 bg-primary">
          {bay.thumbnailUrl ? (
            // Inverted and screened over the primary: white linework on blue, a blueprint in any theme.
            <img src={bay.thumbnailUrl} alt="" className="absolute inset-0 size-full object-contain p-3 opacity-80 mix-blend-screen invert" />
          ) : null}
          <div
            className="absolute inset-0 opacity-25"
            style={{
              backgroundImage:
                "linear-gradient(to right, var(--primary-foreground) 1px, transparent 1px), linear-gradient(to bottom, var(--primary-foreground) 1px, transparent 1px)",
              backgroundSize: "16px 16px",
            }}
            aria-hidden
          />
          <div className="arc-scan-beam absolute inset-0" style={{ animationDelay: `${index * -0.6}s` }} aria-hidden>
            <div className="absolute inset-x-0 bottom-0 h-1/4 bg-gradient-to-b from-transparent to-primary-foreground/35" />
            <div className="absolute inset-x-0 bottom-0 h-px bg-primary-foreground" />
          </div>
          <Brackets />
          <div className="absolute inset-x-0 top-0 flex items-baseline justify-between gap-2 px-5 pt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-primary-foreground">
            <span className="truncate">{bay.name}</span>
            {bay.sheetNumber && <span className="shrink-0 opacity-75">{bay.sheetNumber}</span>}
          </div>
          <div className="absolute inset-x-0 bottom-0 px-5 pb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-primary-foreground/85">{step}</div>
        </div>
      ))}
    </div>
  );
}

function Brackets() {
  const corner = "absolute size-3 border-primary-foreground";
  return (
    <div className="pointer-events-none absolute inset-1.5" aria-hidden>
      <span className={cn(corner, "left-0 top-0 border-l-2 border-t-2")} />
      <span className={cn(corner, "right-0 top-0 border-r-2 border-t-2")} />
      <span className={cn(corner, "bottom-0 left-0 border-b-2 border-l-2")} />
      <span className={cn(corner, "bottom-0 right-0 border-b-2 border-r-2")} />
    </div>
  );
}

/** Once, as a freshly built model appears: the beam passes up through it and is gone. */
export function ScanReveal({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, 1600);
    return () => window.clearTimeout(timer);
  }, [onDone]);
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden>
      <div className="arc-scan-reveal absolute inset-0">
        <div className="absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-primary/45 to-transparent" />
        <div className="absolute inset-x-0 top-0 h-0.5 bg-primary" />
      </div>
    </div>
  );
}
