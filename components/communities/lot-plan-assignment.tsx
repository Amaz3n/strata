"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import { assignPlanToLotAction, listPlanAssignmentOptionsAction } from "@/app/(app)/communities/actions"
import { recordPlanOfferingOverrideAction } from "@/app/(app)/projects/[id]/plan-instantiation-actions"
import { LotReasonDialog } from "@/components/communities/lot-reason-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { unwrapAction } from "@/lib/action-result"
import { MIN_OFFERING_OVERRIDE_REASON_LENGTH, PLAN_OFFERING_REFUSAL } from "@/lib/sales/plan-offering"
import type { InventoryLotDTO } from "@/lib/services/community-inventory"
import type { PlanAssignmentOption } from "@/lib/services/lots"

const KEEP_SWING = "keep"

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; plans: PlanAssignmentOption[]; truncated: boolean }

/**
 * Pin a released plan version and elevation to a lot that has no home and no
 * buyer. Plans the community does not offer are listed on purpose: picking one
 * shows the real refusal, and a person with plan-release authority can record
 * the override right there rather than being sent off to find where.
 */
export function LotPlanAssignmentDialog({
  lot,
  communityId,
  open,
  onOpenChange,
  canOverrideOffering,
}: {
  lot: InventoryLotDTO
  communityId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  canOverrideOffering: boolean
}) {
  const router = useRouter()
  const [load, setLoad] = useState<Load>({ state: "loading" })
  const [planId, setPlanId] = useState("")
  const [planSearch, setPlanSearch] = useState("")
  const [query, setQuery] = useState("")
  const [versionId, setVersionId] = useState("")
  const [elevationId, setElevationId] = useState("")
  const [swing, setSwing] = useState(KEEP_SWING)
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [overriddenPlanId, setOverriddenPlanId] = useState<string | null>(lot.offeringOverridePlanId)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    const timer = setTimeout(() => setQuery(planSearch.trim()), 250)
    return () => clearTimeout(timer)
  }, [planSearch])

  useEffect(() => {
    if (!open) {
      setPlanSearch("")
      setQuery("")
      return
    }
    let active = true
    setLoad({ state: "loading" })
    setPlanId("")
    setVersionId("")
    setElevationId("")
    setSwing(KEEP_SWING)
    setError(null)
    setOverriddenPlanId(lot.offeringOverridePlanId)
    listPlanAssignmentOptionsAction(communityId, query || undefined).then((response) => {
      if (!active) return
      try {
        const { plans, truncated } = unwrapAction(response)
        setLoad({ state: "ready", plans, truncated })
      } catch (failure) {
        setLoad({ state: "error", message: failure instanceof Error ? failure.message : "Unable to load plans" })
      }
    })
    return () => {
      active = false
    }
  }, [open, communityId, lot.offeringOverridePlanId, query])

  const plans = load.state === "ready" ? load.plans : []
  const plan = plans.find((entry) => entry.planId === planId) ?? null
  const elevation = plan?.elevations.find((entry) => entry.id === elevationId) ?? null
  const offered = elevation != null && (elevation.offered || overriddenPlanId === planId)
  const refused = elevation != null && !offered
  const canSubmit = plan != null && versionId !== "" && elevation != null && offered

  function choosePlan(next: string) {
    const entry = plans.find((item) => item.planId === next)
    setPlanId(next)
    setVersionId(entry?.versions[0]?.id ?? "")
    setElevationId(entry?.elevations.length === 1 ? entry.elevations[0].id : "")
    setError(null)
  }

  function submit() {
    if (!canSubmit || !elevation) return
    startTransition(async () => {
      try {
        unwrapAction(
          await assignPlanToLotAction(lot.id, communityId, {
            versionId,
            elevationId: elevation.id,
            ...(swing !== KEEP_SWING ? { swing } : {}),
          }),
        )
        toast.success(`Plan assigned to lot ${lot.lotNumber}`)
        onOpenChange(false)
        router.refresh()
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "Unable to assign the plan")
      }
    })
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (isPending ? undefined : onOpenChange(next))}>
        <DialogContent className="rounded-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Assign plan · Lot {lot.lotNumber}</DialogTitle>
            <DialogDescription>
              Pins a released plan version and elevation to this lot so Starts and Sales read the product from it.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="assign-plan-search">Find a plan</Label>
            <Input
              id="assign-plan-search"
              value={planSearch}
              disabled={isPending}
              maxLength={60}
              placeholder="Search plans by code or name"
              className="rounded-none"
              onChange={(event) => setPlanSearch(event.target.value)}
            />
          </div>

          {load.state === "loading" ? (
            <div aria-busy="true" className="space-y-3">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className="h-9 w-full" />
              ))}
            </div>
          ) : load.state === "error" ? (
            <p role="alert" className="border px-3 py-4 text-sm text-destructive">
              {load.message}
            </p>
          ) : plans.length === 0 ? (
            <p className="border px-3 py-4 text-sm text-muted-foreground">
              {query
                ? "No plan with a released version and an active elevation matches that search."
                : "No plan has a released version and an active elevation yet. Release one from the plan library first."}
            </p>
          ) : (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="assign-plan">Plan</Label>
                <Select value={planId} onValueChange={choosePlan} disabled={isPending}>
                  <SelectTrigger id="assign-plan" className="rounded-none">
                    <SelectValue placeholder="Choose a plan" />
                  </SelectTrigger>
                  <SelectContent>
                    {plans.map((entry) => (
                      <SelectItem key={entry.planId} value={entry.planId}>
                        {entry.code} · {entry.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {load.truncated ? (
                  <p className="text-xs text-muted-foreground">
                    Showing the first {plans.length} plans. Search by code or name to find the rest.
                  </p>
                ) : null}
              </div>

              {plan ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="assign-version">Version</Label>
                    <Select value={versionId} onValueChange={setVersionId} disabled={isPending}>
                      <SelectTrigger id="assign-version" className="rounded-none">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {plan.versions.map((version) => (
                          <SelectItem key={version.id} value={version.id}>
                            v{version.versionNumber}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="assign-elevation">Elevation</Label>
                    <Select
                      value={elevationId}
                      onValueChange={(value) => {
                        setElevationId(value)
                        setError(null)
                      }}
                      disabled={isPending}
                    >
                      <SelectTrigger id="assign-elevation" className="rounded-none">
                        <SelectValue placeholder="Choose" />
                      </SelectTrigger>
                      <SelectContent>
                        {plan.elevations.map((entry) => (
                          <SelectItem key={entry.id} value={entry.id}>
                            {entry.code}
                            {entry.name ? ` · ${entry.name}` : ""}
                            {entry.offered || overriddenPlanId === planId ? "" : " (not offered)"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ) : null}

              {elevation?.swingApplicable ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="assign-swing">Garage swing</Label>
                  <Select value={swing} onValueChange={setSwing} disabled={isPending}>
                    <SelectTrigger id="assign-swing" className="rounded-none">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={KEEP_SWING}>Keep the lot&apos;s swing</SelectItem>
                      <SelectItem value="left">Left</SelectItem>
                      <SelectItem value="right">Right</SelectItem>
                      <SelectItem value="either">Either</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              {refused ? (
                <div role="alert" className="space-y-2 border border-warning/40 bg-warning/10 px-3 py-2.5">
                  <p className="text-xs text-warning">{PLAN_OFFERING_REFUSAL}</p>
                  {canOverrideOffering ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 rounded-none text-xs"
                      disabled={isPending}
                      onClick={() => setOverrideOpen(true)}
                    >
                      Record offering override
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Recording an override needs the plan.release permission.
                    </p>
                  )}
                </div>
              ) : null}

              {error ? (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" className="rounded-none" disabled={isPending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button className="rounded-none" disabled={!canSubmit || isPending} onClick={submit}>
              {isPending ? "Assigning…" : "Assign plan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LotReasonDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        title="Record offering override"
        description={`Lets lot ${lot.lotNumber} carry ${plan ? `${plan.code} · ${plan.name}` : "this plan"} although its community does not offer it. The override covers this plan on this lot only and is audited.`}
        minLength={MIN_OFFERING_OVERRIDE_REASON_LENGTH}
        submitLabel="Record override"
        success="Offering override recorded"
        onSubmit={async (reason) => {
          unwrapAction(await recordPlanOfferingOverrideAction({ communityId }, { lotId: lot.id, housePlanId: planId, reason }))
          setOverriddenPlanId(planId)
          setError(null)
        }}
      />
    </>
  )
}
