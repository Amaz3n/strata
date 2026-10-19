import type { ReactNode } from "react";
import { fonts } from "../../kit/brand";
import { HOUSE, ROOMS, WALLS, along, wallPieces, roomArea, EXTERIOR_T, INTERIOR_T, type Wall } from "./plan";

// The construction sheet: the same plan the 3D house is built from, drawn the
// way an architect issues it. `ink` lets the scan bay redraw it white on blue.

export const SHEET = { width: 1500, height: 1000 };
// Where the plan sits on the sheet, and its scale in px per foot.
export const PLAN = { x: 120, y: 150, ppf: 17 };

const serifStack = "Georgia, 'Times New Roman', serif";

function wallRects(w: Wall, ppf: number) {
  const t = w.exterior ? EXTERIOR_T : INTERIOR_T;
  const horizontal = w.y1 === w.y2;
  const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
  return wallPieces(w)
    .filter((p) => p.z0 === 0 && !p.glass)
    .map((p, i) => {
      const a = p.a === 0 && w.exterior ? -t / 2 : p.a;
      const b = p.b === len && w.exterior ? len + t / 2 : p.b;
      const s = along(w, Math.max(0, a));
      const start = horizontal ? Math.min(w.x1, w.x2) + a : Math.min(w.y1, w.y2) + a;
      return horizontal
        ? { key: `${w.id}-${i}`, x: start * ppf, y: (s.y - t / 2) * ppf, w: (b - a) * ppf, h: t * ppf }
        : { key: `${w.id}-${i}`, x: (s.x - t / 2) * ppf, y: start * ppf, w: t * ppf, h: (b - a) * ppf };
    });
}

// The plan alone, in its own coordinates (origin at the house's corner).
export function PlanDrawing({ ink, ppf = PLAN.ppf, wallFill, labels = true, highlight }: {
  ink: string;
  ppf?: number;
  wallFill?: string;
  labels?: boolean;
  /** Per-wall 0→1, drawn over the wall as a traced overlay. */
  highlight?: (wall: Wall) => number;
}) {
  const fill = wallFill ?? ink;
  const lines: ReactNode[] = [];
  for (const w of WALLS) {
    const t = w.exterior ? EXTERIOR_T : INTERIOR_T;
    const horizontal = w.y1 === w.y2;
    for (const o of w.openings) {
      const a = along(w, o.from);
      const b = along(w, o.to);
      if (o.kind === "door") {
        // Leaf swung open 90° and its arc.
        const width = (o.to - o.from) * ppf;
        const hx = a.x * ppf;
        const hy = a.y * ppf;
        const leaf = horizontal ? { x2: hx, y2: hy + width } : { x2: hx + width, y2: hy };
        const end = horizontal ? { x: b.x * ppf, y: b.y * ppf } : { x: b.x * ppf, y: b.y * ppf };
        lines.push(<line key={`${w.id}-${o.from}-leaf`} x1={hx} y1={hy} x2={leaf.x2} y2={leaf.y2} stroke={ink} strokeWidth={1.6} />);
        lines.push(
          <path
            key={`${w.id}-${o.from}-arc`}
            d={`M ${leaf.x2} ${leaf.y2} A ${width} ${width} 0 0 ${horizontal ? 0 : 1} ${end.x} ${end.y}`}
            fill="none"
            stroke={ink}
            strokeWidth={0.9}
            strokeDasharray="3 3"
          />,
        );
      } else {
        // Window: jambs plus three lines through the wall's thickness.
        for (const k of [-0.5, 0, 0.5]) {
          const off = k * t * ppf;
          lines.push(
            horizontal ? (
              <line key={`${w.id}-${o.from}-${k}`} x1={a.x * ppf} x2={b.x * ppf} y1={a.y * ppf + off} y2={a.y * ppf + off} stroke={ink} strokeWidth={k === 0 ? 1.4 : 0.9} />
            ) : (
              <line key={`${w.id}-${o.from}-${k}`} y1={a.y * ppf} y2={b.y * ppf} x1={a.x * ppf + off} x2={a.x * ppf + off} stroke={ink} strokeWidth={k === 0 ? 1.4 : 0.9} />
            ),
          );
        }
      }
    }
  }
  return (
    <g>
      {WALLS.flatMap((w) => wallRects(w, ppf).map((r) => <rect key={r.key} x={r.x} y={r.y} width={r.w} height={r.h} fill={fill} />))}
      {lines}
      {highlight
        ? WALLS.flatMap((w) => {
            const k = highlight(w);
            if (k <= 0) return [];
            return wallRects(w, ppf).map((r) => (
              <rect key={`hl-${r.key}`} x={r.x - 2} y={r.y - 2} width={r.w + 4} height={r.h + 4} fill="oklch(0.86 0.09 250)" opacity={k} />
            ));
          })
        : null}
      {labels
        ? ROOMS.map((r) => (
            <g key={r.name} fontFamily={fonts.mono} fill={ink} textAnchor="middle">
              <text x={(r.x + r.w / 2) * ppf} y={(r.y + r.h / 2) * ppf} fontSize={ppf * 0.78} letterSpacing={1}>
                {r.name.toUpperCase()}
              </text>
              <text x={(r.x + r.w / 2) * ppf} y={(r.y + r.h / 2) * ppf + ppf * 1.05} fontSize={ppf * 0.62} opacity={0.75}>
                {`${r.w}'-0" × ${r.h}'-0"`}
              </text>
            </g>
          ))
        : null}
    </g>
  );
}

function Dimension({ x1, y1, x2, y2, label, ink, vertical }: { x1: number; y1: number; x2: number; y2: number; label: string; ink: string; vertical?: boolean }) {
  const tick = 6;
  return (
    <g stroke={ink} strokeWidth={0.9} fill={ink} fontFamily={fonts.mono} fontSize={13}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} />
      {[
        [x1, y1],
        [x2, y2],
      ].map(([x, y]) => (
        <line key={`${x}-${y}`} x1={x - tick} y1={y + tick} x2={x + tick} y2={y - tick} strokeWidth={1.4} />
      ))}
      <text
        x={(x1 + x2) / 2}
        y={(y1 + y2) / 2 - 8}
        stroke="none"
        textAnchor="middle"
        transform={vertical ? `rotate(-90 ${(x1 + x2) / 2} ${(y1 + y2) / 2})` : undefined}
      >
        {label}
      </text>
    </g>
  );
}

// The whole issued sheet: border, plan, dimensions, title block.
export function PlanSheet({ highlight }: { highlight?: (wall: Wall) => number }) {
  const ink = "oklch(0.18 0 0)";
  const soft = "oklch(0.45 0 0)";
  const { ppf } = PLAN;
  const W = HOUSE.width * ppf;
  const D = HOUSE.depth * ppf;
  const tbX = SHEET.width - 300;
  return (
    <svg width={SHEET.width} height={SHEET.height} viewBox={`0 0 ${SHEET.width} ${SHEET.height}`} style={{ display: "block" }}>
      <rect width={SHEET.width} height={SHEET.height} fill="white" />
      <rect x={24} y={24} width={SHEET.width - 48} height={SHEET.height - 48} fill="none" stroke={ink} strokeWidth={2} />
      <line x1={tbX} y1={24} x2={tbX} y2={SHEET.height - 24} stroke={ink} strokeWidth={1.4} />
      <g transform={`translate(${PLAN.x} ${PLAN.y})`}>
        <PlanDrawing ink={ink} highlight={highlight} />
        <Dimension x1={0} y1={-46} x2={W} y2={-46} label={`${HOUSE.width}'-0"`} ink={soft} />
        <Dimension x1={22 * ppf} y1={-20} x2={W} y2={-20} label={`34'-0"`} ink={soft} />
        <Dimension x1={0} y1={-20} x2={22 * ppf} y2={-20} label={`22'-0"`} ink={soft} />
        <Dimension x1={-40} y1={0} x2={-40} y2={D} label={`${HOUSE.depth}'-0"`} ink={soft} vertical />
      </g>
      <g fontFamily={serifStack} fill={ink}>
        <text x={PLAN.x} y={PLAN.y + D + 70} fontSize={22} fontWeight={700} letterSpacing={2}>
          FLOOR PLAN
        </text>
        <text x={PLAN.x} y={PLAN.y + D + 96} fontSize={15} fill={soft}>
          {`SCALE: 1/4" = 1'-0"   ·   ${ROOMS.reduce((s, r) => s + roomArea(r), 0).toLocaleString()} SF CONDITIONED`}
        </text>
      </g>
      <g fontFamily={serifStack} fill={ink}>
        <text x={tbX + 28} y={86} fontSize={15} fill={soft} letterSpacing={2}>
          PROJECT
        </text>
        <text x={tbX + 28} y={118} fontSize={21} fontWeight={700}>
          Magnolia Residence
        </text>
        <text x={tbX + 28} y={144} fontSize={16} fill={soft}>
          Lot 14 · Fairhope, AL
        </text>
        <line x1={tbX} y1={180} x2={SHEET.width - 24} y2={180} stroke={ink} strokeWidth={1} />
        <text x={tbX + 28} y={220} fontSize={15} fill={soft} letterSpacing={2}>
          BUILDER
        </text>
        <text x={tbX + 28} y={250} fontSize={20} fontWeight={700}>
          Gulfstone Homes
        </text>
        <line x1={tbX} y1={SHEET.height - 250} x2={SHEET.width - 24} y2={SHEET.height - 250} stroke={ink} strokeWidth={1} />
        <text x={tbX + 28} y={SHEET.height - 210} fontSize={15} fill={soft} letterSpacing={2}>
          SHEET TITLE
        </text>
        <text x={tbX + 28} y={SHEET.height - 180} fontSize={22} fontWeight={700}>
          Floor Plan
        </text>
        <line x1={tbX} y1={SHEET.height - 150} x2={SHEET.width - 24} y2={SHEET.height - 150} stroke={ink} strokeWidth={1} />
        <text x={tbX + 28} y={SHEET.height - 110} fontSize={15} fill={soft} letterSpacing={2}>
          SHEET
        </text>
        <text x={tbX + 28} y={SHEET.height - 52} fontSize={60} fontWeight={700}>
          A-101
        </text>
      </g>
    </svg>
  );
}
