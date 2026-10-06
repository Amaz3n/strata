"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  createTakeoffConditionAction,
  listConditionTemplatesAction,
} from "@/app/(app)/drawings/takeoff-actions";
import { unwrapAction } from "@/lib/action-result";
import type { ConditionTemplate } from "@/lib/drawings/condition-templates";
import { conditionSourceUom, formatQuantity, MEASURE_UOM_LABELS, type ConditionUom } from "@/lib/drawings/measure";
import { nextConditionColor } from "@/lib/drawings/takeoff-palette";
import type { ConditionRollup, TakeoffCondition } from "@/lib/services/takeoff";

import { TOOL_LABELS, TOOL_SOURCE_UOM, type MeasuringTool } from "./workspace-tools";

export type TakeoffScope = { project_id: string } | { house_plan_version_id: string };

interface NewItemOption {
  uom: ConditionUom;
  heightFt: number | null;
  note: string;
}

const NEW_ITEM_OPTIONS: Record<MeasuringTool, NewItemOption[]> = {
  length: [
    { uom: "lf", heightFt: null, note: "Linear feet" },
    { uom: "sf", heightFt: 9, note: "Wall area · measured as a run × 9'-0\" high" },
  ],
  area: [
    { uom: "sf", heightFt: null, note: "Square feet" },
    { uom: "sy", heightFt: null, note: "Square yards — carpet, sod" },
  ],
  count: [{ uom: "ea", heightFt: null, note: "Each" }],
};

type Factors = { height_ft: number | null; depth_in: number | null; pitch_rise: number | null; tons_per_cy: number | null };

/** True when an item with this unit is measured by this tool. */
function measuresWith(tool: MeasuringTool | null, uom: ConditionUom, factors: Factors): boolean {
  return !tool || conditionSourceUom(uom, factors) === TOOL_SOURCE_UOM[tool];
}

const VERB: Record<MeasuringTool, string> = {
  length: "Measure a length for…",
  area: "Measure an area for…",
  count: "Count…",
};

/**
 * "What are you measuring?" — asked once, when a measuring tool is picked.
 *
 * The tool already says the unit; this names the bucket. Items on the job come
 * first, then the company library, then "create". Picking one arms the tool so
 * the very next click on the sheet measures into it.
 */
export function ItemPicker({
  open,
  onOpenChange,
  tool,
  rollups,
  scope,
  canWrite,
  excludeConditionId = null,
  title,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null: any unit (moving a measurement keeps its own). */
  tool: MeasuringTool | null;
  rollups: ConditionRollup[];
  scope: TakeoffScope | null;
  canWrite: boolean;
  excludeConditionId?: string | null;
  title?: string;
  onPick: (condition: TakeoffCondition) => void;
}) {
  const [query, setQuery] = useState("");
  const [templates, setTemplates] = useState<ConditionTemplate[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    if (templates || !canWrite) return;
    let cancelled = false;
    listConditionTemplatesAction()
      .then((result) => {
        if (!cancelled) setTemplates(result.success ? result.data : []);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, templates, canWrite]);

  const jobItems = useMemo(
    () => rollups.filter((row) => row.condition.id !== excludeConditionId && measuresWith(tool, row.condition.uom, row.condition)),
    [rollups, excludeConditionId, tool],
  );
  const libraryItems = useMemo(() => {
    const onJob = new Set(rollups.map((row) => row.condition.name.toLowerCase()));
    return (templates ?? []).filter((template) => !onJob.has(template.name.toLowerCase()) && measuresWith(tool, template.uom, template));
  }, [templates, rollups, tool]);

  const trimmed = query.trim();
  const exactMatch = [...rollups.map((row) => row.condition.name), ...(templates ?? []).map((template) => template.name)].some(
    (name) => name.toLowerCase() === trimmed.toLowerCase(),
  );

  const create = async (input: { name: string; uom: ConditionUom; heightFt: number | null; template?: ConditionTemplate }) => {
    if (!scope || creating) return;
    setCreating(true);
    try {
      const template = input.template;
      const condition = unwrapAction(
        await createTakeoffConditionAction({
          ...scope,
          name: input.name,
          uom: input.uom,
          height_ft: template ? template.height_ft : input.heightFt,
          depth_in: template?.depth_in ?? null,
          pitch_rise: template?.pitch_rise ?? null,
          tons_per_cy: template?.tons_per_cy ?? null,
          cost_code_id: template?.cost_code_id ?? null,
          waste_pct: template?.waste_pct ?? 0,
          unit_cost_cents: template?.unit_cost_cents ?? null,
          share_with_clients: template?.share_with_clients ?? false,
          notes: template?.notes ?? null,
          color: nextConditionColor(rollups.map((row) => row.condition.color)),
        }),
      );
      onPick(condition);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't create that item");
    } finally {
      setCreating(false);
    }
  };

  const heading = title ?? (tool ? VERB[tool] : "What are you measuring?");

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={heading}
      description="Pick a takeoff item, or type a name to create one"
      className="top-[30%] max-w-md"
      showCloseButton={false}
    >
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-semibold">{heading}</span>
        {tool && <span className="font-mono text-[11px] text-muted-foreground">{TOOL_LABELS[tool]}</span>}
      </div>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={canWrite ? "Type a name — Baseboard, Tile, Outlets…" : "Find an item"}
        aria-label="Takeoff item"
      />
      <CommandList className="max-h-[min(360px,50vh)]">
        <CommandEmpty>{canWrite ? "Type a name to create a new item." : "No item measures this way yet."}</CommandEmpty>
        {jobItems.length > 0 && (
          <CommandGroup heading="On this job">
            {jobItems.map((row) => (
              <CommandItem
                key={row.condition.id}
                value={`job ${row.condition.name}`}
                onSelect={() => {
                  onPick(row.condition);
                  onOpenChange(false);
                }}
                className="gap-3"
              >
                <span className="size-2.5 shrink-0" style={{ backgroundColor: row.condition.color }} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{row.condition.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {row.markup_count > 0
                      ? `${formatQuantity(row.effective_quantity)} ${MEASURE_UOM_LABELS[row.condition.uom]} so far`
                      : "Nothing measured yet"}
                  </span>
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{MEASURE_UOM_LABELS[row.condition.uom]}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {canWrite && libraryItems.length > 0 && (
          <CommandGroup heading="From your library">
            {libraryItems.map((template) => (
              <CommandItem
                key={template.id}
                value={`library ${template.name} ${template.group_name ?? ""}`}
                disabled={creating}
                onSelect={() => void create({ name: template.name, uom: template.uom, heightFt: template.height_ft, template })}
                className="gap-3"
              >
                <span className="size-2.5 shrink-0 border border-dashed border-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{template.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {[template.group_name, template.height_ft ? `${template.height_ft}' wall` : null].filter(Boolean).join(" · ") || "Library item"}
                  </span>
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{MEASURE_UOM_LABELS[template.uom]}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {canWrite && scope && trimmed && !exactMatch && (
          <CommandGroup heading="New">
            {(tool ? NEW_ITEM_OPTIONS[tool] : NEW_ITEM_OPTIONS.length.concat(NEW_ITEM_OPTIONS.area, NEW_ITEM_OPTIONS.count)).map((option) => (
              <CommandItem
                key={`${option.uom}-${option.heightFt ?? 0}`}
                value={`new ${trimmed} ${option.uom} ${option.heightFt ?? ""}`}
                disabled={creating}
                onSelect={() => void create({ name: trimmed, uom: option.uom, heightFt: option.heightFt })}
                className="gap-3"
              >
                {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">Create &ldquo;{trimmed}&rdquo;</span>
                  <span className="block text-xs text-muted-foreground">{option.note} · set the rate later</span>
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{MEASURE_UOM_LABELS[option.uom]}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
      <div className="flex gap-4 border-t px-3 py-2 text-[11px] text-muted-foreground">
        <span>
          <kbd className="font-mono">↑↓</kbd> choose
        </span>
        <span>
          <kbd className="font-mono">Enter</kbd> start measuring
        </span>
        <span>
          <kbd className="font-mono">Esc</kbd> close
        </span>
      </div>
    </CommandDialog>
  );
}
