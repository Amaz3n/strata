"use client";

import { Check, Crosshair, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { SheetCalibration } from "@/lib/services/drawings";
import { cn } from "@/lib/utils";

export type ScaleState = "none" | "scanning" | "set" | "verify" | "proposal" | "unset";

export function scaleState(calibration: SheetCalibration | null, scanning: boolean): ScaleState {
  if (!calibration) return "none";
  if (calibration.feet_per_image_px) return calibration.carried_from_version_id ? "verify" : "set";
  if (scanning) return "scanning";
  if (calibration.proposal) return "proposal";
  return "unset";
}

const METHOD_NOTE: Record<string, string> = {
  two_point: "Set from a known dimension",
  title_block: "Read from the title block",
  dimension_check: "Cross-checked against printed dimensions",
  space_area: "Cross-checked against printed room areas",
};

/**
 * The one place a sheet's scale is seen and set.
 *
 * Every quantity is a multiple of this number, so the chip reports where it
 * came from. A detected scale is a proposal until someone confirms it —
 * auto-applying a wrong one would silently multiply every measurement.
 */
export function ScaleChip({
  calibration,
  scanning,
  applying,
  canWrite,
  onApplyProposal,
  onCalibrate,
  open,
  onOpenChange,
}: {
  calibration: SheetCalibration | null;
  scanning: boolean;
  applying: boolean;
  canWrite: boolean;
  onApplyProposal: () => void;
  onCalibrate: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const state = scaleState(calibration, scanning);
  const proposal = calibration?.proposal ?? null;
  const label =
    state === "none"
      ? "No scale"
      : state === "scanning"
        ? "Reading scale…"
        : state === "unset"
          ? "Set scale"
          : state === "proposal"
            ? `Confirm ${proposal?.raw ?? "scale"}`
            : (calibration?.source_label ?? "Scale set");

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Drawing scale: ${label}`}
          className={cn(
            "inline-flex h-8 max-w-56 shrink-0 items-center gap-2 border bg-card px-2.5 text-xs font-medium transition-colors hover:border-line-strong max-sm:max-w-28",
            (state === "proposal" || state === "verify") && "border-warning/60 bg-warning/10",
            state === "unset" && "border-destructive/50",
          )}
        >
          {state === "scanning" ? (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          ) : (
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full bg-muted-foreground",
                state === "set" && "bg-success",
                (state === "proposal" || state === "verify") && "bg-warning",
                state === "unset" && "bg-destructive",
              )}
            />
          )}
          <span className="truncate font-mono tabular-nums">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3">
        <div className="microlabel">Drawing scale</div>
        {state === "none" && (
          <p className="text-sm text-muted-foreground">This sheet has no published version yet, so it can't be scaled.</p>
        )}
        {state === "scanning" && <p className="text-sm text-muted-foreground">Reading the scale off this sheet…</p>}
        {(state === "set" || state === "verify") && calibration && (
          <div className="space-y-1">
            <div className="font-mono text-sm font-semibold tabular-nums">{calibration.source_label ?? "Calibrated by hand"}</div>
            <p className="text-xs text-muted-foreground">
              {state === "verify"
                ? "Carried forward from the previous revision. Check it against a dimension you know."
                : ((calibration.method && METHOD_NOTE[calibration.method]) ?? "Set on this sheet")}
            </p>
          </div>
        )}
        {state === "proposal" && proposal && (
          <div className="space-y-1">
            <p className="text-sm">
              Arc read <span className="font-mono font-semibold">{proposal.raw ?? "a scale"}</span> from this sheet.
            </p>
            <p className="text-xs text-muted-foreground">
              {proposal.method === "dimension_check"
                ? `Cross-checked against ${proposal.sample_count ?? 0} printed dimensions.`
                : proposal.method === "space_area"
                  ? `Cross-checked against ${proposal.sample_count ?? 0} printed room areas.`
                  : "Read from the title block."}{" "}
              Confirm it before measuring.
            </p>
          </div>
        )}
        {state === "unset" && (
          <p className="text-sm text-muted-foreground">
            Arc couldn&apos;t read a scale here. Click both ends of a dimension you know and type its length.
          </p>
        )}
        {canWrite && state !== "none" && state !== "scanning" && (
          <div className="flex flex-wrap gap-2 border-t pt-3">
            {state === "proposal" && (
              <Button size="sm" className="h-8 gap-1.5" disabled={applying} onClick={onApplyProposal}>
                {applying ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                Confirm scale
              </Button>
            )}
            <Button
              size="sm"
              variant={state === "unset" ? "default" : "outline"}
              className="h-8 gap-1.5"
              onClick={onCalibrate}
            >
              <Crosshair className="size-3.5" />
              {state === "unset" ? "Set from a dimension" : state === "proposal" ? "Check against a dimension" : "Recalibrate"}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
