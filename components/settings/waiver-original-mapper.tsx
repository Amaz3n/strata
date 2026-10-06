"use client";
import { useRef, useState } from "react";
import { PdfDocumentPreview } from "@/components/invoices/waiver-pdf-preview";
import type { WaiverDocument } from "@/lib/templates/waiver-document";
import { templateFields } from "@/lib/templates/waiver-template";
export default function WaiverOriginalMapper({
  source,
  document: d,
  onChange,
  disabled,
}: {
  source: string;
  document: WaiverDocument;
  onChange: (d: WaiverDocument) => void;
  disabled?: boolean;
}) {
  const [selected, setSelected] = useState<string>();
  const drag = useRef<{
    id: string;
    x: number;
    y: number;
    startX: number;
    startY: number;
    width: number;
    height: number;
  } | null>(null);
  return (
    <PdfDocumentPreview
      url={`/api/settings/templates/${source}`}
      toolbar={
        <span>Drag fields · Arrow keys move · Shift + arrows resize</span>
      }
      renderOverlay={(page) =>
        d.placements
          .filter((p) => p.page === page)
          .map((p) => {
            const label =
              p.kind === "text"
                ? (d.fields.find((f) => f.key === p.key)?.label ??
                  templateFields[p.key as keyof typeof templateFields] ??
                  p.key)
                : `${p.signerRole ?? "claimant"} ${p.kind}`;
            const update = (x: number, y: number) =>
              onChange({
                ...d,
                placements: d.placements.map((v) =>
                  v.id === p.id
                    ? {
                        ...v,
                        x: Math.max(0, Math.min(1 - v.width, x)),
                        y: Math.max(0, Math.min(1 - v.height, y)),
                      }
                    : v,
                ),
              });
            return (
              <button
                type="button"
                key={p.id}
                disabled={disabled}
                aria-label={`${label}. Drag or use arrow keys to position.`}
                className={`absolute touch-none overflow-hidden border px-1 text-left text-[10px] text-primary ${selected === p.id ? "border-primary bg-primary/20 ring-1 ring-primary" : "border-primary/50 bg-primary/10"}`}
                style={{
                  left: `${p.x * 100}%`,
                  top: `${p.y * 100}%`,
                  width: `${p.width * 100}%`,
                  height: `${p.height * 100}%`,
                }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setSelected(p.id);
                  const bounds =
                    e.currentTarget.parentElement!.getBoundingClientRect();
                  drag.current = {
                    id: p.id,
                    x: p.x,
                    y: p.y,
                    startX: e.clientX,
                    startY: e.clientY,
                    width: bounds.width,
                    height: bounds.height,
                  };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const start = drag.current;
                  if (!start || start.id !== p.id) return;
                  const x = Math.max(
                      0,
                      Math.min(
                        1 - p.width,
                        start.x + (e.clientX - start.startX) / start.width,
                      ),
                    ),
                    y = Math.max(
                      0,
                      Math.min(
                        1 - p.height,
                        start.y + (e.clientY - start.startY) / start.height,
                      ),
                    );
                  e.currentTarget.style.left = `${x * 100}%`;
                  e.currentTarget.style.top = `${y * 100}%`;
                }}
                onPointerUp={(e) => {
                  const start = drag.current;
                  drag.current = null;
                  if (start?.id === p.id)
                    update(
                      start.x + (e.clientX - start.startX) / start.width,
                      start.y + (e.clientY - start.startY) / start.height,
                    );
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
                onKeyDown={(e) => {
                  const delta: Record<string, [number, number]> = {
                    ArrowLeft: [-0.005, 0],
                    ArrowRight: [0.005, 0],
                    ArrowUp: [0, -0.005],
                    ArrowDown: [0, 0.005],
                  };
                  const offset = delta[e.key];
                  if (!offset) return;
                  e.preventDefault();
                  if (e.shiftKey)
                    onChange({
                      ...d,
                      placements: d.placements.map((v) =>
                        v.id === p.id
                          ? {
                              ...v,
                              width: Math.max(
                                0.01,
                                Math.min(1 - v.x, v.width + offset[0]),
                              ),
                              height: Math.max(
                                0.01,
                                Math.min(1 - v.y, v.height + offset[1]),
                              ),
                            }
                          : v,
                      ),
                    });
                  else update(p.x + offset[0], p.y + offset[1]);
                }}
              >
                {label}
              </button>
            );
          })
      }
    />
  );
}
