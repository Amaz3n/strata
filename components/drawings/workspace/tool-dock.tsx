"use client";

import {
  Hash,
  MapPin,
  MousePointer2,
  Move,
  Pencil,
  Pentagon,
  Ruler,
  Spline,
  X,
  type LucideIcon,
} from "lucide-react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { MEASURE_UOM_LABELS } from "@/lib/drawings/measure";
import type { TakeoffCondition } from "@/lib/services/takeoff";
import { cn } from "@/lib/utils";

import { TOOL_KEYS, TOOL_LABELS, type WorkspaceTool } from "./workspace-tools";

const GROUPS: Array<Array<{ tool: WorkspaceTool; icon: LucideIcon }>> = [
  [
    { tool: "select", icon: MousePointer2 },
    { tool: "pan", icon: Move },
  ],
  [
    { tool: "length", icon: Spline },
    { tool: "area", icon: Pentagon },
    { tool: "count", icon: Hash },
  ],
  [
    { tool: "ruler", icon: Ruler },
    { tool: "redline", icon: Pencil },
    { tool: "issue", icon: MapPin },
  ],
];

export interface ToolDockProps {
  tool: WorkspaceTool;
  onTool: (tool: WorkspaceTool) => void;
  /** The item the next measurement lands in. */
  armed: TakeoffCondition | null;
  onChangeArmed: () => void;
  onDisarm: () => void;
  /** The armed item's running quantity: on this sheet, and in all. */
  armedTotal?: string | null;
  /** Tools this person may not use here (no takeoff scope, read-only). */
  disabled?: Partial<Record<WorkspaceTool, string>>;
  className?: string;
}

/**
 * The one row of tools. There are no modes: every tool is always here, and a
 * measuring tool shows the item it is measuring into right beside it.
 */
export function ToolDock({ tool, onTool, armed, onChangeArmed, onDisarm, armedTotal, disabled = {}, className }: ToolDockProps) {
  const measuring = tool === "length" || tool === "area" || tool === "count";
  return (
    <TooltipProvider delayDuration={250}>
      <div
        role="toolbar"
        aria-label="Drawing tools"
        className={cn(
          "pointer-events-auto flex max-w-[calc(100%-1.5rem)] flex-wrap items-stretch justify-center border bg-popover shadow-lg",
          className,
        )}
      >
        {armed && measuring && (
          <div className="flex min-w-0 basis-full items-center border-b sm:basis-auto sm:border-b-0 sm:border-r">
            <button
              type="button"
              onClick={onChangeArmed}
              className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-3 pr-2 text-left transition-colors hover:bg-muted sm:max-w-64"
              title="Change what you're measuring"
            >
              <span className="size-2.5 shrink-0" style={{ backgroundColor: armed.color }} aria-hidden />
              <span className="grid min-w-0 leading-tight">
                <span className="truncate text-sm font-medium">{armed.name}</span>
                {armedTotal && <span className="truncate font-mono text-[10px] tabular-nums text-muted-foreground">{armedTotal} {MEASURE_UOM_LABELS[armed.uom]}</span>}
              </span>
              {!armedTotal && <span className="font-mono text-[11px] text-muted-foreground">{MEASURE_UOM_LABELS[armed.uom]}</span>}
            </button>
            <button
              type="button"
              onClick={onDisarm}
              className="grid size-9 shrink-0 place-items-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Stop measuring"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
        {GROUPS.map((group, index) => (
          <div key={index} className={cn("flex items-center gap-0.5 p-1", index > 0 && "border-l")}>
            {group.map(({ tool: option, icon: Icon }) => {
              const reason = disabled[option];
              const active = tool === option;
              return (
                <Tooltip key={option}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={TOOL_LABELS[option]}
                      aria-pressed={active}
                      disabled={!!reason}
                      onClick={() => onTool(option)}
                      className={cn(
                        "relative grid size-9 place-items-center text-muted-foreground transition-colors",
                        "hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35",
                        active && "bg-foreground text-background hover:bg-foreground hover:text-background",
                      )}
                    >
                      <Icon className="size-[17px]" />
                      <span className="absolute bottom-0.5 right-1 font-mono text-[8px] font-semibold opacity-50 max-sm:hidden">
                        {TOOL_KEYS[option]}
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {reason ?? (
                      <span>
                        {TOOL_LABELS[option]} <kbd className="ml-1 font-mono text-[10px] opacity-70">{TOOL_KEYS[option]}</kbd>
                      </span>
                    )}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
}
