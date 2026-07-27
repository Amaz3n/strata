"use client"

import Link from "next/link"
import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import { AlertTriangle, ArrowRight, Check, Loader2 } from "@/components/icons"
import { formatDay } from "@/components/starts/start-card"
import { StartStatusBadge } from "@/components/starts/start-badges"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import type { StartGateDTO, StartPackageDetailDTO } from "@/lib/services/starts"
import { mondayOfIsoWeek } from "@/lib/starts/even-flow-math"
import { cn } from "@/lib/utils"
import {
  attestGateAction, cancelReleaseAction, cancelStartPackageAction, getStartPackageAction,
  refreshGatesAction, releaseStartAction, reopenGateAction, retryReleaseAction,
  setProjectSuperintendentAction, setStartTargetWeekAction, waiveGateAction,
} from "@/app/(app)/starts/actions"

const STEP_LABELS: Record<string, string> = {
  project: "Project", budget: "Budget", schedule: "Schedule", checklists: "Checklists",
  drawings: "Drawings", pos: "Purchase orders", notify_trades: "Notify trades", finalize: "Finalize",
}

/** What an unmet automatic check is actually waiting for, and where to go fix it. */
const AUTO_GATE_HINTS: Record<string, { hint: string; tab?: string; cta?: string }> = {
  plot_plan: { hint: "No plot plan on file for this house", tab: "documents", cta: "Upload" },
  selections_locked: { hint: "Selection groups are still open", tab: "selections", cta: "Open selections" },
  plan_pinned: { hint: "The lot needs a released plan version and elevation pinned" },
  price_book: { hint: "Open purchase-order exceptions on this house", tab: "commitments", cta: "Review" },
  budget: { hint: "Generated when the house is released" },
  po_set: { hint: "Generated when the house is released" },
}

function gateEvidence(gate: StartGateDTO) {
  if (gate.status === "waived") return `Waived by ${gate.attestedByName ?? "coordinator"}${gate.waivedReason ? ` — ${gate.waivedReason}` : ""}`
  if (gate.passedVia === "attested") return `Attested by ${gate.attestedByName ?? "coordinator"}${gate.attestedAt ? ` · ${gate.attestedAt.slice(0, 10)}` : ""}`
  if (gate.passedVia === "auto") return "Cleared by system check"
  return null
}

interface Props {
  packageId: string | null
  weeks: string[]
  currentWeek: string
  canWrite: boolean
  canRelease: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}

export function StartPackageSheet({ packageId, weeks, currentWeek, canWrite, canRelease, onOpenChange, onChanged }: Props) {
  const [pkg, setPkg] = useState<StartPackageDetailDTO | null>(null)
  const [superintendents, setSuperintendents] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(false)
  const [pending, startTransition] = useTransition()

  const [releaseOpen, setReleaseOpen] = useState(false)
  const [releaseDate, setReleaseDate] = useState("")
  const [overSlot, setOverSlot] = useState<{ targetWeek: string; target: number; alreadyTargeted: number } | null>(null)
  const [attestTarget, setAttestTarget] = useState<StartGateDTO | null>(null)
  const [attestNote, setAttestNote] = useState("")
  const [waiveTarget, setWaiveTarget] = useState<StartGateDTO | null>(null)
  const [waiveReason, setWaiveReason] = useState("")
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState("")

  async function load(id: string) {
    setLoading(true)
    try {
      const data = unwrapAction(await getStartPackageAction(id))
      setPkg(data.pkg)
      setSuperintendents(data.superintendents)
    } catch (error) {
      toast.error("Unable to load this start package", { description: error instanceof Error ? error.message : undefined })
      onOpenChange(false)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!packageId) {
      setPkg(null)
      return
    }
    void load(packageId)
    // `load` is stable for a given id; re-running on identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packageId])

  function runAction(operation: () => Promise<unknown>, success: string, failure: string, after?: () => void) {
    startTransition(async () => {
      try {
        await operation()
        toast.success(success)
        after?.()
        if (packageId) await load(packageId)
        onChanged()
      } catch (error) {
        toast.error(failure, { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function openReleaseDialog(target: StartPackageDetailDTO) {
    const today = new Date().toISOString().slice(0, 10)
    setReleaseDate(target.scheduledStartDate ?? (target.targetWeek && target.targetWeek > today ? target.targetWeek : today))
    setOverSlot(null)
    setReleaseOpen(true)
  }

  function release(confirmOverSlot: boolean) {
    if (!pkg) return
    startTransition(async () => {
      try {
        const result = unwrapAction(await releaseStartAction(pkg.id, { scheduledStartDate: releaseDate, confirmOverSlot }))
        if ("requiresConfirm" in result) {
          setOverSlot(result.slot)
          return
        }
        toast.success("Start released — orchestration is running")
        setReleaseOpen(false)
        setOverSlot(null)
        await load(pkg.id)
        onChanged()
      } catch (error) {
        toast.error("Unable to release start", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  const editable = pkg ? ["open", "ready"].includes(pkg.status) : false
  const gatesLocked = pkg ? ["releasing", "released", "cancelled"].includes(pkg.status) : true
  const failedStep = pkg?.steps.find((step) => step.status === "failed") ?? null

  return (
    <>
      <Sheet open={Boolean(packageId)} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-[30rem]">
          {loading && !pkg ? (
            <div className="space-y-3 p-5">
              <Skeleton className="h-5 w-48 rounded-none" />
              <Skeleton className="h-16 w-full rounded-none" />
              <Skeleton className="h-40 w-full rounded-none" />
            </div>
          ) : !pkg ? null : (
            <>
              <SheetHeader className="gap-1.5 border-b p-5">
                <SheetTitle className="text-base">{pkg.communityName} · {pkg.lotLabel}</SheetTitle>
                <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <StartStatusBadge status={pkg.status} />
                  <span>{[pkg.planCode ?? pkg.planName, pkg.elevationCode].filter(Boolean).join(" / ") || "Plan not pinned"}</span>
                  <span aria-hidden>·</span>
                  <span>{pkg.sale.isSold ? `SOLD${pkg.sale.buyerName ? ` · ${pkg.sale.buyerName}` : ""}` : "SPEC"}</span>
                </SheetDescription>
                {pkg.mustStartBy && pkg.daysToMustStart !== null ? (
                  <p className={cn(
                    "text-xs tabular-nums",
                    pkg.risk === "late" || pkg.risk === "at_risk" ? "font-medium text-destructive" : "text-muted-foreground",
                  )}>
                    {pkg.daysToMustStart < 0
                      ? `${Math.abs(pkg.daysToMustStart)} days past the must-start date of ${formatDay(pkg.mustStartBy)}`
                      : `Must start by ${formatDay(pkg.mustStartBy)} to hold a ${formatDay(pkg.sale.closingDate)} close · ${pkg.daysToMustStart} days left`}
                  </p>
                ) : null}
              </SheetHeader>

              {/* The blocker is the loudest thing in the sheet, because it is the
                  only thing anyone opens this sheet to find out. */}
              <div className="border-b p-5">
                {failedStep ? (
                  <div className="border border-destructive/50 bg-destructive/5 p-3">
                    <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                      <AlertTriangle className="h-4 w-4" />
                      Release failed at {STEP_LABELS[failedStep.stepKey] ?? failedStep.stepKey}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{failedStep.error}</p>
                    {canRelease ? (
                      <div className="mt-3 flex gap-2">
                        <Button size="sm" className="rounded-none" disabled={pending} onClick={() => runAction(async () => { unwrapAction(await retryReleaseAction(pkg.id)) }, "Release retry queued", "Unable to retry release")}>
                          Retry release
                        </Button>
                        <Button size="sm" variant="outline" className="rounded-none" disabled={pending} onClick={() => runAction(async () => { unwrapAction(await cancelReleaseAction(pkg.id)) }, "Release cancelled — package returned to ready", "Unable to cancel release")}>
                          Cancel release
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : pkg.gatesTotal === 0 ? (
                  <div className="border border-warning/50 bg-warning/5 p-3">
                    <p className="flex items-center gap-1.5 text-sm font-medium text-warning">
                      <AlertTriangle className="h-4 w-4" />
                      No readiness gates on this package
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Nothing is checked before this house can release. Re-run the system checks to attach the org&rsquo;s
                      current gate definitions, or review them in settings.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button asChild size="sm" variant="outline" className="rounded-none">
                        <Link href="/settings/starts">Start gate settings</Link>
                      </Button>
                      {canRelease && pkg.status === "ready" ? (
                        <Button size="sm" className="rounded-none" disabled={pending} onClick={() => { openReleaseDialog(pkg) }}>
                          Release anyway
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : pkg.blocker ? (
                  <>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Waiting on</p>
                    <p className="mt-1 text-lg font-semibold leading-tight">{pkg.blocker.label}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Nothing has cleared on this house in {pkg.stalledDays} {pkg.stalledDays === 1 ? "day" : "days"}.
                      {" "}Typically takes about {pkg.blocker.leadDays} {pkg.blocker.leadDays === 1 ? "day" : "days"}.
                    </p>
                  </>
                ) : pkg.status === "released" ? (
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <Check className="h-4 w-4" />
                    Released{pkg.releasedAt ? ` on ${pkg.releasedAt.slice(0, 10)}` : ""}
                  </p>
                ) : (
                  <>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Ready</p>
                    <p className="mt-1 text-lg font-semibold leading-tight">Every gate is clear</p>
                    {canRelease && pkg.status === "ready" ? (
                      <Button size="sm" className="mt-3 rounded-none" disabled={pending} onClick={() => openReleaseDialog(pkg)}>
                        Release start
                      </Button>
                    ) : null}
                  </>
                )}
              </div>

              {/* Keyboard-and-mouse equivalent of dragging a card between weeks. */}
              <div className="grid gap-3 border-b p-5 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="sheet-week" className="text-[11px] uppercase tracking-wide text-muted-foreground">Target week</Label>
                  <Select
                    value={pkg.targetWeek ?? "none"}
                    disabled={!canWrite || !editable || pending}
                    onValueChange={(value) =>
                      runAction(
                        async () => { unwrapAction(await setStartTargetWeekAction(pkg.id, value === "none" ? null : value)) },
                        "Target week updated",
                        "Unable to retarget this house",
                      )
                    }
                  >
                    <SelectTrigger id="sheet-week" className="h-8 rounded-none text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No target — hold in the yard</SelectItem>
                      {weeks.filter((week) => week >= currentWeek || week === pkg.targetWeek).map((week) => (
                        <SelectItem key={week} value={week}>Week of {formatDay(week)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="sheet-super" className="text-[11px] uppercase tracking-wide text-muted-foreground">Superintendent</Label>
                  <Select
                    value={pkg.superintendentId ?? "unassigned"}
                    disabled={!canWrite || !pkg.projectId || pending}
                    onValueChange={(value) => {
                      const projectId = pkg.projectId
                      if (!projectId) return
                      runAction(
                        async () => { unwrapAction(await setProjectSuperintendentAction(projectId, value === "unassigned" ? null : value)) },
                        "Superintendent updated",
                        "Unable to assign superintendent",
                      )
                    }}
                  >
                    <SelectTrigger id="sheet-super" className="h-8 rounded-none text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unassigned">Unassigned</SelectItem>
                      {superintendents.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>{candidate.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* ===== Gates ===== */}
              <section className="border-b p-5">
                <div className="mb-3 flex items-baseline justify-between">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide">Readiness gates</h3>
                  <span className="text-xs tabular-nums text-muted-foreground">{pkg.gatesPassed}/{pkg.gatesTotal} cleared</span>
                </div>
                <ul className="divide-y border">
                  {pkg.gates.length === 0 ? (
                    <li className="p-6 text-center text-xs text-muted-foreground">
                      This package has no gates. Re-running the system checks attaches the org&rsquo;s active gate definitions.
                    </li>
                  ) : null}
                  {pkg.gates.map((gate) => {
                    const satisfied = ["passed", "waived"].includes(gate.status)
                    const hint = AUTO_GATE_HINTS[gate.key]
                    const evidence = gateEvidence(gate)
                    return (
                      <li className={cn("p-3", gate.status === "waived" && "bg-warning/5")} key={gate.id}>
                        <div className="flex items-start gap-2.5">
                          <span
                            aria-hidden
                            className={cn(
                              "mt-0.5 flex size-4 flex-none items-center justify-center border",
                              satisfied ? "border-success bg-success text-success-foreground" : "border-line-strong",
                              gate.status === "not_applicable" && "border-dashed opacity-50",
                            )}
                          >
                            {satisfied ? <Check className="h-3 w-3" /> : null}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className={cn("text-[13px] font-medium leading-tight", gate.status === "not_applicable" && "text-muted-foreground line-through")}>
                              {gate.label}
                              {gate.releaseProduced ? <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">generated at release</span> : null}
                            </p>
                            <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                              {evidence ?? (gate.status === "not_applicable"
                                ? "Does not apply to this house"
                                : hint?.hint ?? (gate.checkKind === "manual" ? "Needs someone to attest it" : "Waiting on a system check"))}
                            </p>
                            {!satisfied && gate.status !== "not_applicable" && hint?.tab && hint.cta && pkg.projectId ? (
                              <Link
                                href={`/projects/${pkg.projectId}/${hint.tab}`}
                                className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium hover:underline"
                              >
                                {hint.cta}
                                <ArrowRight className="h-3 w-3" />
                              </Link>
                            ) : null}
                          </div>
                          {canWrite && !gatesLocked ? (
                            <div className="flex flex-none gap-1">
                              {gate.checkKind === "manual" && gate.status === "pending" ? (
                                <Button size="sm" variant="outline" className="h-7 rounded-none px-2 text-[11px]" disabled={pending} onClick={() => { setAttestNote(""); setAttestTarget(gate) }}>
                                  Attest
                                </Button>
                              ) : null}
                              {gate.status === "pending" && canRelease ? (
                                <Button size="sm" variant="ghost" className="h-7 rounded-none px-2 text-[11px]" disabled={pending} onClick={() => { setWaiveReason(""); setWaiveTarget(gate) }}>
                                  Waive
                                </Button>
                              ) : null}
                              {satisfied ? (
                                <Button size="sm" variant="ghost" className="h-7 rounded-none px-2 text-[11px]" disabled={pending} onClick={() => runAction(async () => { unwrapAction(await reopenGateAction(pkg.id, gate.id)) }, "Gate reopened", "Unable to reopen gate")}>
                                  Reopen
                                </Button>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </li>
                    )
                  })}
                </ul>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" className="rounded-none" disabled={pending} onClick={() => runAction(async () => { unwrapAction(await refreshGatesAction(pkg.id)) }, "Checks refreshed", "Unable to refresh checks")}>
                    Re-run system checks
                  </Button>
                  {pkg.projectId ? (
                    <Button asChild size="sm" variant="ghost" className="rounded-none">
                      <Link href={`/projects/${pkg.projectId}`}>Open the house</Link>
                    </Button>
                  ) : null}
                  <Button asChild size="sm" variant="ghost" className="rounded-none">
                    <Link href="/settings/starts">Gate settings</Link>
                  </Button>
                </div>
              </section>

              {/* ===== Release ledger ===== */}
              {pkg.steps.length ? (
                <section className="border-b p-5">
                  <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wide">Release ledger</h3>
                  <ol className="space-y-1.5">
                    {pkg.steps.map((step) => (
                      <li className="flex items-baseline gap-2 text-xs" key={step.stepKey}>
                        <span
                          aria-hidden
                          className={cn(
                            "size-1.5 flex-none translate-y-1",
                            step.status === "completed" && "bg-success",
                            step.status === "failed" && "bg-destructive",
                            step.status === "running" && "bg-primary",
                            step.status === "skipped" && "bg-muted-foreground/40",
                            step.status === "pending" && "bg-muted-foreground/30",
                          )}
                        />
                        <span className="w-28 flex-none font-medium">{STEP_LABELS[step.stepKey] ?? step.stepKey.replaceAll("_", " ")}</span>
                        <span className={cn("min-w-0 flex-1 truncate", step.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                          {step.error ?? step.status}
                          {step.attempt > 1 ? ` · attempt ${step.attempt}` : ""}
                        </span>
                        {step.status === "running" ? <Loader2 className="h-3 w-3 flex-none animate-spin" /> : null}
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}

              {pkg.notes ? <p className="border-b p-5 text-xs text-muted-foreground">{pkg.notes}</p> : null}

              {canWrite && editable ? (
                <div className="p-5">
                  <Button size="sm" variant="ghost" className="rounded-none text-destructive hover:text-destructive" disabled={pending} onClick={() => { setCancelReason(""); setCancelOpen(true) }}>
                    Cancel start package
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* ===== Single release ===== */}
      <Dialog open={releaseOpen} onOpenChange={(open) => { if (!open) { setReleaseOpen(false); setOverSlot(null) } }}>
        <DialogContent className="rounded-none sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Release start</DialogTitle>
            <DialogDescription>
              Generates the budget, schedule, checklists, drawings and PO set from the pinned plan version, then notifies trades.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="sheet-release-date">Scheduled start date</Label>
            <Input
              id="sheet-release-date"
              type="date"
              className="rounded-none"
              min={new Date().toISOString().slice(0, 10)}
              value={releaseDate}
              onChange={(event) => { setReleaseDate(event.target.value); setOverSlot(null) }}
            />
            {releaseDate ? <p className="text-xs text-muted-foreground">Counts against the week of Monday {formatDay(mondayOfIsoWeek(releaseDate))}.</p> : null}
          </div>
          {overSlot ? (
            <div className="border border-destructive/50 bg-destructive/5 p-3 text-sm">
              <p className="flex items-center gap-1.5 font-medium text-destructive">
                <AlertTriangle className="h-4 w-4" />
                Over even-flow target
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                The week of {formatDay(overSlot.targetWeek)} targets {overSlot.target} {overSlot.target === 1 ? "start" : "starts"} and already has {overSlot.alreadyTargeted}. This would be #{overSlot.alreadyTargeted + 1}.
              </p>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setReleaseOpen(false); setOverSlot(null) }}>Cancel</Button>
            {overSlot ? (
              <Button variant="destructive" disabled={pending || !releaseDate} onClick={() => release(true)}>
                {pending ? "Releasing…" : "Release over target"}
              </Button>
            ) : (
              <Button disabled={pending || !releaseDate} onClick={() => release(false)}>
                {pending ? "Releasing…" : "Release"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== Attest ===== */}
      <Dialog open={Boolean(attestTarget)} onOpenChange={(open) => { if (!open) setAttestTarget(null) }}>
        <DialogContent className="rounded-none sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Attest — {attestTarget?.label}</DialogTitle>
            <DialogDescription>Confirms this requirement is satisfied. Your name and the timestamp are recorded on the gate.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="attest-note">Note <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Textarea id="attest-note" className="rounded-none" rows={2} maxLength={2000} placeholder="Permit #, appraisal reference…" value={attestNote} onChange={(event) => setAttestNote(event.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAttestTarget(null)}>Cancel</Button>
            <Button
              disabled={pending}
              onClick={() => {
                const gate = attestTarget
                if (!gate || !pkg) return
                runAction(
                  async () => { unwrapAction(await attestGateAction(pkg.id, gate.id, attestNote.trim() ? { notes: attestNote.trim() } : {})) },
                  "Gate attested",
                  "Unable to attest gate",
                  () => setAttestTarget(null),
                )
              }}
            >
              {pending ? "Attesting…" : "Attest gate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== Waive ===== */}
      <Dialog open={Boolean(waiveTarget)} onOpenChange={(open) => { if (!open) setWaiveTarget(null) }}>
        <DialogContent className="rounded-none sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Waive — {waiveTarget?.label}</DialogTitle>
            <DialogDescription>Waivers notify every release approver and stay on the record. Use only when the requirement is genuinely covered another way.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="waive-reason">Reason</Label>
            <Textarea id="waive-reason" className="rounded-none" rows={3} maxLength={2000} value={waiveReason} onChange={(event) => setWaiveReason(event.target.value)} />
            <p className={cn("text-xs", waiveReason.trim().length < 10 ? "text-muted-foreground" : "text-transparent")}>Minimum 10 characters.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWaiveTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={pending || waiveReason.trim().length < 10}
              onClick={() => {
                const gate = waiveTarget
                if (!gate || !pkg) return
                runAction(
                  async () => { unwrapAction(await waiveGateAction(pkg.id, gate.id, waiveReason.trim())) },
                  "Gate waived",
                  "Unable to waive gate",
                  () => setWaiveTarget(null),
                )
              }}
            >
              {pending ? "Waiving…" : "Waive gate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== Cancel package ===== */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="rounded-none sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Cancel start package</DialogTitle>
            <DialogDescription>Removes {pkg?.lotLabel} from the start pipeline. The lot and its preconstruction project are kept.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="cancel-reason">Reason</Label>
            <Textarea id="cancel-reason" className="rounded-none" rows={3} maxLength={2000} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} />
            <p className={cn("text-xs", cancelReason.trim().length < 10 ? "text-muted-foreground" : "text-transparent")}>Minimum 10 characters.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)}>Keep package</Button>
            <Button
              variant="destructive"
              disabled={pending || cancelReason.trim().length < 10}
              onClick={() => {
                if (!pkg) return
                runAction(
                  async () => { unwrapAction(await cancelStartPackageAction(pkg.id, cancelReason.trim())) },
                  "Start package cancelled",
                  "Unable to cancel start package",
                  () => { setCancelOpen(false); onOpenChange(false) },
                )
              }}
            >
              {pending ? "Cancelling…" : "Cancel package"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
