"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { AlertTriangle, CheckCircle2, Circle, Lock } from "@/components/icons"
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
import { blockingGates, releaseGates } from "@/lib/plans/release-gates"
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
      <div className="border-b bg-primary/5 px-4 py-3">
        <p className="text-sm font-medium">v{version.version_number} is the current edition</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Every house started from now builds to it.
          {version.released_at ? ` Released ${new Date(version.released_at).toLocaleDateString()}.` : ""}{" "}
          {version.pinned_lot_count > 0
            ? `${version.pinned_lot_count} ${version.pinned_lot_count === 1 ? "house is" : "houses are"} pinned to it.`
            : "No houses pinned to it yet."}
          {cycleMedianDays != null ? ` ${cycleMedianDays} day median cycle.` : ""}
          {performance?.variance_pct != null
            ? ` Actuals running ${performance.variance_pct > 0 ? "" : "−"}${Math.abs(performance.variance_pct).toFixed(1)}% against the takeoff.`
            : ""}
        </p>
      </div>
    )
  }

  if (version.status === "superseded") {
    const behind = drift?.changes.length ?? 0
    return (
      <div className="border-b bg-muted/40 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-sm font-medium">v{version.version_number} is superseded and read-only</p>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {version.pinned_lot_count > 0
            ? `${version.pinned_lot_count} ${version.pinned_lot_count === 1 ? "house is" : "houses are"} still building to it — they keep the bill of process they started on.`
            : "No houses are still building to it."}
          {behind > 0 && drift
            ? ` ${behind} ${behind === 1 ? "line has" : "lines have"} changed since, worth ${signedDollars(drift.manual_price_delta_cents)}.`
            : ""}
        </p>
      </div>
    )
  }

  const gates = releaseGates(version)
  const blocking = blockingGates(version)
  const ready = blocking.length === 0

  return (
    <div className={cn("border-b px-4 py-3", ready ? "bg-success/5" : "bg-warning/5")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {ready
              ? `v${version.version_number} is ready to release`
              : `v${version.version_number} is a draft — ${blocking.length} required ${blocking.length === 1 ? "gate is" : "gates are"} still open`}
          </p>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
            Releasing freezes this bill of process for every house started on it.
            {releasedVersion
              ? ` v${releasedVersion.version_number} becomes superseded; its ${releasedVersion.pinned_lot_count} pinned ${releasedVersion.pinned_lot_count === 1 ? "house keeps" : "houses keep"} building to v${releasedVersion.version_number}.`
              : ` This is the first release for ${plan.code}.`}
          </p>
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

      <ol className="mt-3 grid divide-y border sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-5 lg:divide-x">
        {gates.map((gate) => (
          <li key={gate.key} className="relative flex items-start gap-2 bg-background p-2.5">
            <span
              aria-hidden
              className={cn(
                "absolute inset-y-0 left-0 w-0.5",
                gate.ok ? "bg-success" : gate.required ? "bg-destructive" : "bg-border",
              )}
            />
            {gate.ok ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
            ) : (
              <Circle
                className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", gate.required ? "text-destructive" : "text-muted-foreground")}
              />
            )}
            <div className="min-w-0">
              <p className={cn("text-[11px] font-medium", !gate.ok && gate.required && "text-destructive")}>
                {gate.label}
                {!gate.required ? <span className="font-normal text-muted-foreground"> · optional</span> : null}
              </p>
              <p className="text-[10px] text-muted-foreground">{gate.detail}</p>
            </div>
          </li>
        ))}
      </ol>

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
