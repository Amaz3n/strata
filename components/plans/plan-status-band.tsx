"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { AlertTriangle, Lock } from "@/components/icons"
import { releasePlanVersionAction } from "@/app/(app)/plans/actions"
import { centsToDollars, signedDollars } from "@/components/plans/plan-badges"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { unwrapAction } from "@/lib/action-result"
import { blockingGates } from "@/lib/plans/release-gates"
import type {
  HousePlanDto,
  HousePlanVersionDto,
  PlanBuildPerformanceDto,
  PlanVersionDriftDto,
} from "@/lib/services/house-plans"
import { cn } from "@/lib/utils"

/**
 * The loudest thing on the canvas, because it is the only thing on this page that
 * changes what happens to houses that do not exist yet. A draft shows the ramp it
 * is climbing with the release action at the end of it, so how far you are from
 * being allowed to press it is visible rather than discovered.
 */
export function PlanStatusBand({
  plan,
  version,
  releasedVersion,
  drift,
  performance,
  costCents,
  cycleMedianDays,
  canRelease,
}: {
  plan: HousePlanDto
  version: HousePlanVersionDto
  releasedVersion: HousePlanVersionDto | null
  drift: PlanVersionDriftDto | null
  performance: PlanBuildPerformanceDto | null
  costCents: number | null
  cycleMedianDays: number | null
  canRelease: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [confirming, setConfirming] = useState(false)

  function release() {
    startTransition(async () => {
      try {
        unwrapAction(await releasePlanVersionAction(plan.id, version.id))
        toast.success(`v${version.version_number} released`)
        setConfirming(false)
        router.refresh()
      } catch (error) {
        toast.error("Release failed", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  if (version.status === "released") {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-primary/5 px-4 py-2 text-[11px]">
        <span className="font-medium text-foreground">Current edition</span>
        <span className="text-muted-foreground">
          New starts use v{version.version_number}.
          {version.released_at ? ` Released ${new Date(version.released_at).toLocaleDateString()}.` : ""}{" "}
          {version.pinned_lot_count > 0
            ? `${version.pinned_lot_count} ${version.pinned_lot_count === 1 ? "house" : "houses"} pinned.`
            : "No houses pinned."}
          {cycleMedianDays != null ? ` ${cycleMedianDays} day median cycle.` : ""}
          {performance?.variance_pct != null
            ? ` Actuals ${performance.variance_pct > 0 ? "+" : "−"}${Math.abs(performance.variance_pct).toFixed(1)}% vs takeoff.`
            : ""}
        </span>
      </div>
    )
  }

  if (version.status === "superseded") {
    const behind = drift?.changes.length ?? 0
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-muted/40 px-4 py-2 text-[11px]">
        <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">Superseded · read-only</span>
        <span className="text-muted-foreground">
          {version.pinned_lot_count > 0
            ? `${version.pinned_lot_count} ${version.pinned_lot_count === 1 ? "house is" : "houses are"} still building to v${version.version_number}.`
            : "No houses still use this edition."}
          {behind > 0 && drift
            ? ` ${behind} changed ${behind === 1 ? "line" : "lines"} · ${signedDollars(drift.manual_price_delta_cents)}.`
            : ""}
        </span>
      </div>
    )
  }

  const blocking = blockingGates(version)
  const ready = blocking.length === 0

  return (
    <div className={cn("border-b px-4 py-2.5", ready ? "bg-success/5" : "bg-warning/5")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-xs font-medium">
            {ready ? `v${version.version_number} ready to release` : `v${version.version_number} draft`}
          </p>
          {!ready ? (
            <p className="text-[11px] text-destructive">
              Needs {blocking.map((gate) => gate.label.toLowerCase()).join(" and ")}
            </p>
          ) : null}
        </div>
        {canRelease ? (
          <Button
            size="sm"
            className="shrink-0 rounded-none"
            disabled={pending || !ready}
            onClick={() => setConfirming(true)}
            title={ready ? undefined : `Blocked by ${blocking.map((gate) => gate.label.toLowerCase()).join(" and ")}`}
          >
            Release v{version.version_number}
          </Button>
        ) : null}
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="rounded-none sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Release v{version.version_number}?</DialogTitle>
            <DialogDescription>This cannot be undone. Repricing later means a new edition.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-xs">
            <div className="border p-3">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">What gets frozen</p>
              <ul className="mt-1.5 space-y-1 text-muted-foreground">
                <li>
                  {version.takeoff_line_count} takeoff line{version.takeoff_line_count === 1 ? "" : "s"}
                  {costCents != null ? ` · ${centsToDollars(costCents)} direct cost` : ""}
                </li>
                <li>
                  Budget {version.budget_template_id ? "template" : "from takeoff"} · schedule template ·{" "}
                  {version.checklist_template_ids.length} checklist
                  {version.checklist_template_ids.length === 1 ? "" : "s"} ·{" "}
                  {version.selection_category_ids.length} selection categor
                  {version.selection_category_ids.length === 1 ? "y" : "ies"}
                </li>
                <li>{version.drawing_source_file_id ? "Plan-set PDF" : "No plan set — starts begin without drawings"}</li>
              </ul>
            </div>
            {releasedVersion ? (
              <div className="flex items-start gap-2 border border-warning/50 bg-warning/10 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <p>
                  v{releasedVersion.version_number} becomes superseded. Its{" "}
                  {releasedVersion.pinned_lot_count === 1
                    ? "1 pinned house keeps"
                    : `${releasedVersion.pinned_lot_count} pinned houses keep`}{" "}
                  building to it — only houses started after this release use v{version.version_number}.
                </p>
              </div>
            ) : (
              <p className="text-muted-foreground">
                This is the first release for {plan.code}. The plan can be set active once it lands.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" className="rounded-none" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button className="rounded-none" onClick={release} disabled={pending}>
              {pending ? "Releasing…" : `Release v${version.version_number}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
