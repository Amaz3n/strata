"use client";

import type { ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  GitCompare,
  Keyboard,
  Layers,
  Loader2,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Search,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DrawingSheet, DrawingSheetVersion } from "@/app/(app)/drawings/types";
import { cn } from "@/lib/utils";

import { Segmented } from "./segmented";
import { VIEW_LABELS, type WorkspaceView } from "./workspace-tools";

export interface LayerToggle {
  key: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export interface WorkspaceHeaderProps {
  sheet: DrawingSheet;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  closeDisabled?: boolean;
  onToggleRail: () => void;
  railOpen: boolean;
  onTogglePanel?: () => void;
  panelOpen: boolean;
  view: WorkspaceView;
  onView: (view: WorkspaceView) => void;
  /** No 3D for this workspace — the switch hides. */
  modelAvailable: boolean;
  scale: ReactNode;
  versions: DrawingSheetVersion[];
  versionsLoading: boolean;
  versionsOpen: boolean;
  onVersionsOpenChange: (open: boolean) => void;
  onCompare: (olderId: string, newerId: string) => void;
  onFind: () => void;
  findActive: boolean;
  layers: LayerToggle[];
  menu: Array<{ label: string; onSelect?: () => void; href?: string }>;
  onShortcuts: () => void;
}

export function WorkspaceHeader({
  sheet,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
  closeDisabled,
  onToggleRail,
  railOpen,
  onTogglePanel,
  panelOpen,
  view,
  onView,
  modelAvailable,
  scale,
  versions,
  versionsLoading,
  versionsOpen,
  onVersionsOpenChange,
  onCompare,
  onFind,
  findActive,
  layers,
  menu,
  onShortcuts,
}: WorkspaceHeaderProps) {
  const revision = sheet.current_revision_label;
  return (
    <header className="flex h-12 shrink-0 items-center gap-1.5 border-b bg-background px-2">
      <Button variant="ghost" size="icon-sm" onClick={onToggleRail} aria-label={railOpen ? "Hide sheets" : "Show sheets"} aria-pressed={railOpen}>
        <PanelLeft className="size-4" />
      </Button>
      <div className="flex items-center">
        <Button variant="ghost" size="icon-sm" onClick={onPrev} disabled={!hasPrev} aria-label="Previous sheet">
          <ChevronLeft className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onNext} disabled={!hasNext} aria-label="Next sheet">
          <ChevronRight className="size-4" />
        </Button>
      </div>
      <div className="flex min-w-0 flex-1 items-baseline gap-2.5 overflow-hidden px-1">
        <h1 className="shrink-0 font-mono text-[15px] font-bold tracking-tight">{sheet.sheet_number}</h1>
        <span className="min-w-0 truncate text-sm text-muted-foreground max-sm:hidden">{sheet.sheet_title ?? ""}</span>
        <DropdownMenu open={versionsOpen} onOpenChange={onVersionsOpenChange}>
          <DropdownMenuTrigger asChild>
            <button type="button" className="inline-flex h-7 shrink-0 items-center gap-1.5 border px-2 text-xs font-medium transition-colors hover:border-line-strong max-sm:hidden" aria-label="Revisions">
              {revision ? `Rev ${revision}` : "Revisions"}
              {(sheet.version_count ?? 0) > 1 && <span className="font-mono text-[10px] text-muted-foreground">{sheet.version_count}</span>}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-80">
            <DropdownMenuLabel className="microlabel">Versions of {sheet.sheet_number}</DropdownMenuLabel>
            {versionsLoading && versions.length === 0 ? (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Loading versions…
              </div>
            ) : versions.length < 2 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">Only one version available.</p>
            ) : (
              versions.map((version, index) => (
                <DropdownMenuItem
                  key={version.id}
                  disabled={index === 0}
                  onSelect={() => onCompare(version.id, versions[0].id)}
                  className="flex items-start gap-3"
                >
                  <span className="w-8 shrink-0 font-mono text-xs font-semibold">v{versions.length - index}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {index === 0 ? "Current" : `Compare with current`}
                      {version.revision_label ? ` · ${version.revision_label}` : ""}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[version.creator_name, new Date(version.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })]
                        .filter(Boolean)
                        .join(" · ")}
                      {version.change_description ? ` — ${version.change_description}` : ""}
                    </span>
                  </span>
                  {index > 0 && <GitCompare className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {modelAvailable && (
        <Segmented
          label="View"
          value={view}
          onChange={onView}
          options={(["sheet", "split", "3d"] as const).map((option, index) => ({ value: option, label: VIEW_LABELS[option], title: `${VIEW_LABELS[option]}  ${index + 1}` }))}
          className="max-[560px]:hidden"
        />
      )}
      {scale}
      <Button variant={findActive ? "secondary" : "ghost"} size="icon-sm" onClick={onFind} aria-label="Find in sheet" aria-pressed={findActive}>
        <Search className="size-4" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Layers" className="max-sm:hidden">
            <Layers className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="microlabel">Show on sheet</DropdownMenuLabel>
          {layers.map((layer) => (
            <DropdownMenuCheckboxItem key={layer.key} checked={layer.checked} onCheckedChange={(value) => layer.onChange(value === true)} onSelect={(event) => event.preventDefault()}>
              {layer.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Drawing options">
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {menu.map((item) =>
            item.href ? (
              <DropdownMenuItem key={item.label} asChild>
                <a href={item.href} download target="_blank" rel="noreferrer">
                  {item.label}
                </a>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem key={item.label} onSelect={item.onSelect}>
                {item.label}
              </DropdownMenuItem>
            ),
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onShortcuts}>
            <Keyboard className="size-3.5" />
            Keyboard shortcuts
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">?</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {onTogglePanel && (
        <Button variant="ghost" size="icon-sm" onClick={onTogglePanel} aria-label={panelOpen ? "Hide panel" : "Show panel"} aria-pressed={panelOpen} className="max-md:hidden">
          <PanelRight className="size-4" />
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" onClick={onClose} disabled={closeDisabled} aria-label="Close drawing" className={cn("ml-0.5")}>
        <X className="size-4" />
      </Button>
    </header>
  );
}
