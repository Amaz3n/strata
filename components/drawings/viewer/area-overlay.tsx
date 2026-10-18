"use client";

/**
 * Detected rooms, drawn on the sheet: faint outlines everywhere, the hovered
 * room lit, edit handles on the one being adjusted, unresolved room labels
 * numbered so the estimator can find what detection missed.
 */

import type { AreaTakeoffController } from "./use-area-takeoff";
import type { AreaPoint } from "@/lib/drawings/area-evidence";

export function AreaTakeoffOverlay({
  controller: c,
  imageSize,
  snap,
}: {
  controller: AreaTakeoffController;
  imageSize: { width: number; height: number };
  snap?: (point: AreaPoint) => AreaPoint;
}) {
  const path = (points: AreaPoint[]) =>
    points
      .map(
        (p, i) =>
          `${i ? "L" : "M"}${p[0] * imageSize.width} ${p[1] * imageSize.height}`,
      )
      .join(" ") + " Z";
  return (
    <g style={{ pointerEvents: "none" }}>
      {c.region && (
        <rect
          x={c.region.x0 * imageSize.width}
          y={c.region.y0 * imageSize.height}
          width={(c.region.x1 - c.region.x0) * imageSize.width}
          height={(c.region.y1 - c.region.y0) * imageSize.height}
          fill="none"
          stroke="var(--primary)"
          strokeDasharray="6 4"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {c.proposals.map((p) => (
        <g key={p.id}>
          <path
            d={[path(p.points), ...p.holes.map(path)].join(" ")}
            fillRule="evenodd"
            fill={
              c.selected.has(p.id) || c.hoveredId === p.id
                ? "var(--primary)"
                : "var(--muted-foreground)"
            }
            fillOpacity={
              c.selected.has(p.id) ? 0.14 : c.hoveredId === p.id ? 0.07 : 0.015
            }
            stroke={
              c.selected.has(p.id) || c.hoveredId === p.id
                ? "var(--primary)"
                : "var(--muted-foreground)"
            }
            strokeWidth={c.selected.has(p.id) ? 2 : 1}
            vectorEffect="non-scaling-stroke"
          >
            <title>
              {p.label} · {p.areaSqft.toFixed(1)} SF · Review required
            </title>
          </path>
          {c.selected.has(p.id) &&
            (c.tool === "corner" || c.tool === "edge") &&
            p.points.map((point, i) => {
              const next = p.points[(i + 1) % p.points.length];
              const target: AreaPoint =
                c.tool === "edge"
                  ? [(point[0] + next[0]) / 2, (point[1] + next[1]) / 2]
                  : point;
              return (
                <AreaBoundaryHandle
                  key={`${c.tool}-${i}`}
                  point={target}
                  imageSize={imageSize}
                  label={`Move ${c.tool} ${i + 1} of ${p.label}`}
                  onMove={(point, bypassSnap) =>
                    c.moveHandle(
                      p.id,
                      i,
                      !bypassSnap && snap ? snap(point) : point,
                      c.tool === "edge",
                    )
                  }
                />
              );
            })}
        </g>
      ))}
      {c.boundaries.map((b, i) => (
        <line
          key={i}
          x1={b.a[0] * imageSize.width}
          y1={b.a[1] * imageSize.height}
          x2={b.b[0] * imageSize.width}
          y2={b.b[1] * imageSize.height}
          stroke="var(--warning)"
          strokeWidth={2}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {c.coverage?.labels
        .filter((l) => l.status === "unresolved")
        .map((l, i) => (
          <g
            key={`${l.label}-${i}`}
            transform={`translate(${l.point[0] * imageSize.width} ${l.point[1] * imageSize.height})`}
          >
            <circle
              r={9}
              fill="var(--background)"
              stroke="var(--warning)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
            <text
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={11}
              fill="var(--foreground)"
            >
              {i + 1}
            </text>
            <title>{l.label}: unresolved area</title>
          </g>
        ))}
      {c.pending && (
        <circle
          cx={c.pending[0] * imageSize.width}
          cy={c.pending[1] * imageSize.height}
          r={5}
          fill="var(--primary)"
        />
      )}
    </g>
  );
}

function AreaBoundaryHandle({
  point,
  imageSize,
  label,
  onMove,
}: {
  point: AreaPoint;
  imageSize: { width: number; height: number };
  label: string;
  onMove: (point: AreaPoint, bypassSnap: boolean) => void;
}) {
  const position = (
    event: React.PointerEvent<SVGCircleElement>,
  ): AreaPoint | null => {
    const matrix =
      event.currentTarget.parentElement &&
      (
        event.currentTarget.parentElement as unknown as SVGGraphicsElement
      ).getScreenCTM();
    if (!matrix) return null;
    const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(
      matrix.inverse(),
    );
    return [local.x / imageSize.width, local.y / imageSize.height];
  };
  return (
    <circle
      data-area-handle
      aria-label={label}
      cx={point[0] * imageSize.width}
      cy={point[1] * imageSize.height}
      r={6}
      fill="var(--background)"
      stroke="var(--primary)"
      strokeWidth={2}
      vectorEffect="non-scaling-stroke"
      style={{ pointerEvents: "all", cursor: "move" }}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        e.stopPropagation();
        const p = position(e);
        if (p) {
          e.currentTarget.setAttribute("cx", String(p[0] * imageSize.width));
          e.currentTarget.setAttribute("cy", String(p[1] * imageSize.height));
        }
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const p = position(e);
        e.currentTarget.releasePointerCapture(e.pointerId);
        e.currentTarget.setAttribute("cx", String(point[0] * imageSize.width));
        e.currentTarget.setAttribute("cy", String(point[1] * imageSize.height));
        if (p) onMove(p, e.altKey);
      }}
      onPointerCancel={(e) => {
        e.currentTarget.setAttribute("cx", String(point[0] * imageSize.width));
        e.currentTarget.setAttribute("cy", String(point[1] * imageSize.height));
      }}
    />
  );
}
