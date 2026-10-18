"use client";

import type { ReactNode } from "react";
import { ArrowUpRight, Camera, Link2, MapPin, Pencil } from "lucide-react";

import type { DrawingMarkup, DrawingPin } from "@/app/(app)/drawings/types";
import { PIN_ENTITY_TYPE_LABELS } from "@/lib/validation/drawings";
import { cn } from "@/lib/utils";

export interface SheetLink {
  x: number;
  y: number;
  w: number;
  h: number;
  targetSheetId: string;
  targetSheetNumber: string;
}

const REDLINE_TYPES = new Set(["cloud", "arrow", "text", "callout", "freehand", "highlight", "rectangle", "circle"]);

const OPEN_STATUSES = new Set(["open", "in_progress", "pending"]);

/**
 * Everything pinned to this sheet that isn't takeoff: issues and photos,
 * redlines, and the callouts that jump to other sheets. Clicking a row frames
 * it on the sheet.
 */
export function OnSheetPanel({
  pins,
  markups,
  links,
  linksLoaded,
  onFocusPin,
  onOpenPin,
  onFocusMarkup,
  onOpenLink,
  onLoadLinks,
}: {
  pins: DrawingPin[];
  markups: DrawingMarkup[];
  links: SheetLink[];
  linksLoaded: boolean;
  onFocusPin: (pin: DrawingPin) => void;
  onOpenPin: (pin: DrawingPin) => void;
  onFocusMarkup: (markup: DrawingMarkup) => void;
  onOpenLink: (sheetId: string) => void;
  onLoadLinks: () => void;
}) {
  const redlines = markups.filter((markup) => !markup.condition_id && REDLINE_TYPES.has(markup.data.type));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-4">
      <Section label="Issues & photos" count={pins.length}>
        {pins.length === 0 ? (
          <Empty>Nothing pinned here. Use Issue or photo (I) to drop one on the sheet.</Empty>
        ) : (
          pins.map((pin) => {
            const open = pin.status ? OPEN_STATUSES.has(pin.status) : false;
            return (
              <div key={pin.id} className="group flex items-center hover:bg-muted/60">
                <button type="button" onClick={() => onFocusPin(pin)} className="flex min-w-0 flex-1 items-center gap-2.5 px-4 py-2 text-left">
                  {pin.entity_type === "photo" ? (
                    <Camera className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <MapPin className={cn("size-3.5 shrink-0", open ? "text-warning" : "text-muted-foreground")} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{pin.entity_title ?? pin.label ?? "Untitled"}</span>
                    <span className="block text-xs text-muted-foreground">
                      {PIN_ENTITY_TYPE_LABELS[pin.entity_type] ?? pin.entity_type}
                      {pin.status ? ` · ${pin.status.replace(/_/g, " ")}` : ""}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onOpenPin(pin)}
                  className="mr-2 grid size-7 shrink-0 place-items-center text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  aria-label={`Open ${pin.entity_title ?? "item"}`}
                >
                  <ArrowUpRight className="size-3.5" />
                </button>
              </div>
            );
          })
        )}
      </Section>
      <Section label="Redlines" count={redlines.length}>
        {redlines.length === 0 ? (
          <Empty>No redlines. Use Redline (M) to cloud, arrow or note something.</Empty>
        ) : (
          redlines.map((markup) => (
            <button key={markup.id} type="button" onClick={() => onFocusMarkup(markup)} className="flex w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-muted/60">
              <Pencil className="size-3.5 shrink-0 text-destructive" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{markup.data.text || markup.label || `${markup.data.type[0].toUpperCase()}${markup.data.type.slice(1)}`}</span>
                <span className="block text-xs text-muted-foreground">
                  {[markup.creator_name, new Date(markup.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })].filter(Boolean).join(" · ")}
                </span>
              </span>
            </button>
          ))
        )}
      </Section>
      <Section label="Links to other sheets" count={linksLoaded ? links.length : undefined}>
        {!linksLoaded ? (
          <div className="px-4 py-1">
            <button type="button" onClick={onLoadLinks} className="text-sm font-medium text-primary hover:underline">
              Find callouts on this sheet
            </button>
          </div>
        ) : links.length === 0 ? (
          <Empty>No callouts to other sheets were found here.</Empty>
        ) : (
          links.map((link, index) => (
            <button key={`${link.targetSheetId}-${index}`} type="button" onClick={() => onOpenLink(link.targetSheetId)} className="flex w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-muted/60">
              <Link2 className="size-3.5 shrink-0 text-primary" />
              <span className="font-mono text-sm font-semibold">{link.targetSheetNumber}</span>
              <span className="ml-auto text-xs text-primary">Open</span>
            </button>
          ))
        )}
      </Section>
    </div>
  );
}

function Section({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  return (
    <section className="pt-4">
      <div className="flex items-baseline justify-between px-4 pb-1">
        <span className="microlabel">{label}</span>
        {count !== undefined && <span className="font-mono text-[11px] text-muted-foreground">{count}</span>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-1.5 text-xs text-muted-foreground">{children}</p>;
}
