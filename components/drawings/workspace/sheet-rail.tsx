"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, ChevronDown, Search, Spline, X } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { SheetThumbnail } from "@/components/drawings/sheet-thumbnail";
import type { DrawingSheet } from "@/app/(app)/drawings/types";
import { groupSheetsByDiscipline } from "@/lib/utils/drawing-utils";
import { DISCIPLINE_LABELS, type DrawingDiscipline } from "@/lib/validation/drawings";
import { cn } from "@/lib/utils";

export interface SheetRailProps {
  sheets: DrawingSheet[];
  activeSheetId: string;
  onNavigate: (sheet: DrawingSheet) => void;
  /** sheet id → measurements on it; absent when this workspace has no takeoff. */
  measurements?: Map<string, number>;
  /** sheet id → the model level traced from it. */
  modelSources?: Map<string, string>;
  setLabel?: string | null;
  onClose?: () => void;
  className?: string;
}

/**
 * The set, always in view, read the way a set is read: by discipline, by
 * number, with each sheet's own picture. A sheet only says something when it
 * has something to say — takeoff measured on it, open issues, a 3D floor traced
 * from it. Most sheets in a set (specs, details, schedules) never carry a
 * takeoff, so "not measured" is not news and is not shown.
 */
export function SheetRail({ sheets, activeSheetId, onNavigate, measurements, modelSources, setLabel, onClose, className }: SheetRailProps) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const activeRef = useRef<HTMLButtonElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sheets;
    return sheets.filter((sheet) => [sheet.sheet_number, sheet.sheet_title ?? "", sheet.discipline ?? ""].some((value) => value.toLowerCase().includes(q)));
  }, [sheets, query]);
  const groups = useMemo(() => [...groupSheetsByDiscipline(filtered).entries()].filter(([, list]) => list.length > 0), [filtered]);
  const searching = query.trim().length > 0;

  // The sheet on screen stays in view as you page through the set.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeSheetId]);

  const toggle = (discipline: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(discipline)) next.delete(discipline);
      else next.add(discipline);
      return next;
    });

  return (
    <aside aria-label="Sheets" className={cn("flex min-h-0 flex-col border-r bg-card", className)}>
      <div className="space-y-2.5 border-b px-3 pb-3 pt-3">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{setLabel ?? "Sheets"}</span>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{sheets.length}</span>
          {onClose && (
            <button type="button" onClick={onClose} className="grid size-7 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close sheets">
              <X className="size-4" />
            </button>
          )}
        </div>
        <label className="flex h-8 items-center gap-2 border bg-background px-2 text-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setQuery("")}
            placeholder="Find a sheet"
            aria-label="Find a sheet"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
          {searching && (
            <button type="button" onClick={() => setQuery("")} className="text-muted-foreground hover:text-foreground" aria-label="Clear">
              <X className="size-3.5" />
            </button>
          )}
        </label>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="pb-3">
          {groups.length === 0 && <p className="px-3 py-6 text-sm text-muted-foreground">No sheet matches &ldquo;{query}&rdquo;.</p>}
          {groups.map(([discipline, list]) => {
            const label = DISCIPLINE_LABELS[discipline as DrawingDiscipline] ?? "Other";
            const closed = !searching && collapsed.has(discipline) && !list.some((sheet) => sheet.id === activeSheetId);
            return (
              <section key={discipline} aria-label={label}>
                <button
                  type="button"
                  onClick={() => toggle(discipline)}
                  aria-expanded={!closed}
                  className="sticky top-0 z-10 flex w-full items-center gap-1.5 border-b bg-card/95 px-3 py-1.5 text-left backdrop-blur-sm hover:text-foreground"
                >
                  <ChevronDown className={cn("size-3 text-muted-foreground transition-transform duration-150", closed && "-rotate-90")} />
                  <span className="microlabel flex-1">{label}</span>
                  <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{list.length}</span>
                </button>
                {!closed &&
                  list.map((sheet) => (
                    <SheetRow
                      key={sheet.id}
                      sheet={sheet}
                      active={sheet.id === activeSheetId}
                      buttonRef={sheet.id === activeSheetId ? activeRef : undefined}
                      measured={measurements?.get(sheet.id) ?? 0}
                      level={modelSources?.get(sheet.id)}
                      onNavigate={onNavigate}
                    />
                  ))}
              </section>
            );
          })}
        </div>
      </ScrollArea>
    </aside>
  );
}

function SheetRow({
  sheet,
  active,
  buttonRef,
  measured,
  level,
  onNavigate,
}: {
  sheet: DrawingSheet;
  active: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
  measured: number;
  level?: string;
  onNavigate: (sheet: DrawingSheet) => void;
}) {
  const issues = sheet.open_pins_count ?? 0;
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => onNavigate(sheet)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex w-full items-center gap-2.5 py-1.5 pl-3 pr-2.5 text-left transition-colors duration-150",
        active ? "bg-accent shadow-[inset_2px_0_0_var(--primary)]" : "hover:bg-muted",
      )}
    >
      <SheetThumbnail sheet={sheet} className={cn("h-7 w-10 shrink-0", active ? "border-primary/60" : "opacity-90 group-hover:opacity-100")} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={cn("truncate font-mono text-xs font-semibold", active && "text-primary")}>{sheet.sheet_number}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
            {measured > 0 && (
              <span className="inline-flex items-center gap-0.5" title={`${measured} takeoff ${measured === 1 ? "measurement" : "measurements"}`}>
                <Spline className="size-2.5" />
                {measured}
              </span>
            )}
            {issues > 0 && (
              <span className="inline-flex items-center gap-1 text-warning" title={`${issues} open ${issues === 1 ? "issue" : "issues"}`}>
                <span className="size-1.5 rounded-full bg-warning" aria-hidden />
                {issues}
              </span>
            )}
            {level && (
              <span className="inline-flex items-center gap-0.5" title={`The 3D model's ${level} is traced from this sheet`}>
                <Box className="size-2.5" />
                <span className="max-w-14 truncate">{level}</span>
              </span>
            )}
          </span>
        </span>
        <span className={cn("block truncate text-[13px] leading-snug", active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground")}>
          {sheet.sheet_title || "Untitled sheet"}
        </span>
      </span>
    </button>
  );
}
