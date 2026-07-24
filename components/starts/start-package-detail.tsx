"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { AlertTriangle } from "@/components/icons"
import { GateStatusBadge, ReleaseStepBadge, StartStatusBadge } from "@/components/starts/start-badges"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import type { StartGateDTO, StartPackageDetailDTO } from "@/lib/services/starts"
import { mondayOfIsoWeek } from "@/lib/starts/even-flow-math"
import { cn } from "@/lib/utils"
import {
  attestGateAction, cancelReleaseAction, cancelStartPackageAction, refreshGatesAction,
  releaseStartAction, reopenGateAction, retryReleaseAction, setProjectSuperintendentAction,
  updateStartPackageAction, waiveGateAction,
} from "@/app/(app)/starts/actions"

const STEP_LABELS: Record<string, string> = {
  project: "Project",
  budget: "Budget",
  schedule: "Schedule",
  checklists: "Checklists",
  drawings: "Drawings",
  pos: "Purchase orders",
  notify_trades: "Notify trades",
  finalize: "Finalize",
}

function formatDetail(detail: Record<string, unknown>) {
  const entries = Object.entries(detail)
  if (!entries.length) return "—"
  return entries
    .map(([key, value]) => `${key.replaceAll("_", " ")}: ${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`)
    .join(" · ")
}

function gateEvidence(gate: StartGateDTO) {
  if (gate.status === "waived") return `Waived by ${gate.attestedByName ?? "coordinator"}${gate.waivedReason ? ` — ${gate.waivedReason}` : ""}`
  if (gate.passedVia === "attested") return `Attested by ${gate.attestedByName ?? "coordinator"}${gate.attestedAt ? ` · ${gate.attestedAt.slice(0, 10)}` : ""}`
  if (gate.passedVia === "auto") return "System check"
  return "—"
}

export function StartPackageDetail({ pkg, superintendents, canWrite, canRelease }: {
  pkg: StartPackageDetailDTO
  superintendents: Array<{ id: string; name: string }>
  canWrite: boolean
  canRelease: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [releaseOpen, setReleaseOpen] = useState(false)
  const [releaseDate, setReleaseDate] = useState(pkg.scheduledStartDate ?? new Date().toISOString().slice(0, 10))
  const [overSlot, setOverSlot] = useState<{ targetWeek: string; target: number; alreadyTargeted: number } | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editTargetDate, setEditTargetDate] = useState(pkg.targetWeek ?? "")
  const [editScheduled, setEditScheduled] = useState(pkg.scheduledStartDate ?? "")
  const [editFinanced, setEditFinanced] = useState(pkg.isFinanced)
  const [editNotes, setEditNotes] = useState(pkg.notes ?? "")
  const [waiveGateTarget, setWaiveGateTarget] = useState<StartGateDTO | null>(null)
  const [waiveReason, setWaiveReason] = useState("")
  const [attestGateTarget, setAttestGateTarget] = useState<StartGateDTO | null>(null)
  const [attestNote, setAttestNote] = useState("")
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState("")

  const projectId = pkg.projectId
  const editable = ["open", "ready"].includes(pkg.status)
  const gatesLocked = ["releasing", "released", "cancelled"].includes(pkg.status)
  const readinessRatio = pkg.gatesTotal > 0 ? pkg.gatesPassed / pkg.gatesTotal : 0

  const runAction = (operation: () => Promise<unknown>, success: string, failure: string, after?: () => void) => {
    startTransition(async () => {
      try {
        await operation()
        toast.success(success)
        after?.()
        router.refresh()
      } catch (error) {
        toast.error(failure, { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  const release = (confirmOverSlot: boolean) => {
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
        router.refresh()
      } catch (error) {
        toast.error("Unable to release start", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 border-b pb-4 sm:grid-cols-3 lg:grid-cols-6">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Status</p>
          <div className="mt-1"><StartStatusBadge status={pkg.status} /></div>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Plan / Elevation</p>
          <p className="text-sm">{[pkg.planCode ?? pkg.planName, pkg.elevationCode].filter(Boolean).join(" / ") || "Unpinned"}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Target week</p>
          <p className="text-sm tabular-nums">{pkg.targetWeek ?? "—"}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Scheduled start</p>
          <p className="text-sm tabular-nums">{pkg.scheduledStartDate ?? "—"}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Financing</p>
          <p className="text-sm">{pkg.isFinanced ? "Financed" : "Cash"}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Precon age</p>
          <p className={cn("text-sm tabular-nums", pkg.status !== "released" && pkg.preconAgeDays > 45 && "text-warning")}>{pkg.preconAgeDays}d</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="rounded-none" disabled={pending} onClick={() => runAction(async () => { unwrapAction(await refreshGatesAction(pkg.id)) }, "Checks refreshed", "Unable to refresh checks")}>
            Refresh checks
          </Button>
          {canWrite && editable ? (
            <Button size="sm" variant="outline" className="rounded-none" disabled={pending} onClick={() => setEditOpen(true)}>Edit package</Button>
          ) : null}
          {canRelease && pkg.status === "ready" ? (
            <Button size="sm" className="rounded-none" disabled={pending} onClick={() => { setOverSlot(null); setReleaseOpen(true) }}>Release start</Button>
          ) : null}
          {canRelease && pkg.status === "attention" ? (
            <Button size="sm" className="rounded-none" disabled={pending} onClick={() => runAction(async () => { unwrapAction(await retryReleaseAction(pkg.id)) }, "Release retry queued", "Unable to retry release")}>
              Retry release
            </Button>
          ) : null}
          {canRelease && ["attention", "releasing"].includes(pkg.status) ? (
            <Button size="sm" variant="outline" className="rounded-none" disabled={pending} onClick={() => runAction(async () => { unwrapAction(await cancelReleaseAction(pkg.id)) }, "Release cancelled — package returned to ready", "Unable to cancel release")}>
              Cancel release
            </Button>
          ) : null}
          {canWrite && editable ? (
            <Button size="sm" variant="ghost" className="rounded-none text-destructive hover:text-destructive" disabled={pending} onClick={() => setCancelOpen(true)}>
              Cancel package
            </Button>
          ) : null}
        </div>
        {projectId ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Superintendent</span>
            <Select
              value={pkg.superintendentId ?? "unassigned"}
              disabled={!canWrite || pending}
              onValueChange={(value) =>
                runAction(
                  async () => { unwrapAction(await setProjectSuperintendentAction(projectId, value === "unassigned" ? null : value)) },
                  "Superintendent updated",
                  "Unable to assign superintendent",
                )
              }
            >
              <SelectTrigger className="h-8 w-48 rounded-none text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="unassigned">Unassigned</SelectItem>
                {superintendents.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>

      {pkg.notes ? <p className="border bg-muted/30 p-3 text-sm text-muted-foreground">{pkg.notes}</p> : null}

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide">Readiness gates</h2>
          <span className="text-xs tabular-nums text-muted-foreground">{pkg.gatesPassed}/{pkg.gatesTotal} cleared</span>
        </div>
        <div className="mb-2 h-1 w-full bg-muted">
          <div className="h-1 bg-primary" style={{ width: `${Math.round(readinessRatio * 100)}%` }} />
        </div>
        <div className="overflow-x-auto border">
          <Table>
            <TableHeader>
              <TableRow className="text-[11px] uppercase tracking-wide">
                <TableHead>Gate</TableHead>
                <TableHead>Check</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Evidence</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pkg.gates.map((gate) => (
                <TableRow key={gate.id} className={cn("text-xs", gate.status === "waived" && "bg-warning/5")}>
                  <TableCell className="font-medium">
                    {gate.label}
                    {gate.releaseProduced ? <span className="ml-2 text-[10px] font-normal text-muted-foreground">generated at release</span> : null}
                  </TableCell>
                  <TableCell className="capitalize text-muted-foreground">{gate.checkKind}</TableCell>
                  <TableCell><GateStatusBadge status={gate.status} /></TableCell>
                  <TableCell className="max-w-72 text-xs text-muted-foreground">{gateEvidence(gate)}</TableCell>
                  <TableCell className="text-right">
                    {canWrite && !gatesLocked ? (
                      <div className="flex justify-end gap-1">
                        {gate.checkKind === "manual" && gate.status === "pending" ? (
                          <Button size="sm" variant="outline" className="rounded-none" disabled={pending} onClick={() => { setAttestNote(""); setAttestGateTarget(gate) }}>
                            Attest
                          </Button>
                        ) : null}
                        {gate.status === "pending" && canRelease ? (
                          <Button size="sm" variant="ghost" className="rounded-none" disabled={pending} onClick={() => { setWaiveReason(""); setWaiveGateTarget(gate) }}>
                            Waive
                          </Button>
                        ) : null}
                        {["passed", "waived"].includes(gate.status) ? (
                          <Button size="sm" variant="ghost" className="rounded-none" disabled={pending} onClick={() => runAction(async () => { unwrapAction(await reopenGateAction(pkg.id, gate.id)) }, "Gate reopened", "Unable to reopen gate")}>
                            Reopen
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      {pkg.steps.length ? (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide">Release ledger</h2>
          <div className="overflow-x-auto border">
            <Table>
              <TableHeader>
                <TableRow className="text-[11px] uppercase tracking-wide">
                  <TableHead>Step</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Attempt</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead>Detail / error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pkg.steps.map((step) => (
                  <TableRow key={step.stepKey} className="text-xs">
                    <TableCell className="font-medium">{STEP_LABELS[step.stepKey] ?? step.stepKey.replaceAll("_", " ")}</TableCell>
                    <TableCell><ReleaseStepBadge status={step.status} /></TableCell>
                    <TableCell className="text-right tabular-nums">{step.attempt}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{step.completedAt ? step.completedAt.slice(0, 16).replace("T", " ") : "—"}</TableCell>
                    <TableCell className={cn("max-w-96", step.error ? "text-destructive" : "text-muted-foreground")}>
                      {step.error ?? formatDetail(step.detail)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}

      <Dialog open={releaseOpen} onOpenChange={(open) => { if (!open) { setReleaseOpen(false); setOverSlot(null) } }}>
        <DialogContent className="rounded-none sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Release start</DialogTitle>
            <DialogDescription>
              Releasing generates the budget, schedule, checklists, drawings, and PO set from the pinned plan version, then notifies trades.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="release-date">Scheduled start date</Label>
            <Input
              id="release-date"
              type="date"
              className="rounded-none"
              min={new Date().toISOString().slice(0, 10)}
              value={releaseDate}
              onChange={(event) => { setReleaseDate(event.target.value); setOverSlot(null) }}
            />
            {releaseDate ? <p className="text-xs text-muted-foreground">Counts against the week of Monday {mondayOfIsoWeek(releaseDate)}.</p> : null}
          </div>
          {overSlot ? (
            <div className="border border-destructive/50 bg-destructive/5 p-3 text-sm">
              <p className="flex items-center gap-1.5 font-medium text-destructive">
                <AlertTriangle className="h-4 w-4" />
                Over even-flow target
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                The week of {overSlot.targetWeek} targets {overSlot.target} {overSlot.target === 1 ? "start" : "starts"} and already has {overSlot.alreadyTargeted} releasing or released. This would be #{overSlot.alreadyTargeted + 1}.
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

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="rounded-none sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit start package</DialogTitle>
            <DialogDescription>{pkg.communityName} · {pkg.lotLabel}</DialogDescription>
          </DialogHeader>
          <form
            id="edit-package"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (pending) return
              runAction(
                async () => {
                  unwrapAction(await updateStartPackageAction(pkg.id, {
                    targetWeek: editTargetDate ? mondayOfIsoWeek(editTargetDate) : null,
                    scheduledStartDate: editScheduled || null,
                    isFinanced: editFinanced,
                    notes: editNotes.trim() || null,
                  }))
                },
                "Start package updated",
                "Unable to update start package",
                () => setEditOpen(false),
              )
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="edit-target">Target start week</Label>
              <Input id="edit-target" type="date" className="rounded-none" value={editTargetDate} onChange={(event) => setEditTargetDate(event.target.value)} />
              {editTargetDate ? <p className="text-xs text-muted-foreground">Week of Monday {mondayOfIsoWeek(editTargetDate)}</p> : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-scheduled">Scheduled start date</Label>
              <Input id="edit-scheduled" type="date" className="rounded-none" value={editScheduled} onChange={(event) => setEditScheduled(event.target.value)} />
            </div>
            <div className="flex items-center justify-between border p-3">
              <div>
                <p className="text-sm font-medium">Financed buyer</p>
                <p className="text-xs text-muted-foreground">Adds the financing/appraisal gate.</p>
              </div>
              <Switch checked={editFinanced} onCheckedChange={setEditFinanced} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-notes">Notes</Label>
              <Textarea id="edit-notes" className="rounded-none" rows={3} maxLength={5000} value={editNotes} onChange={(event) => setEditNotes(event.target.value)} />
            </div>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button form="edit-package" type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(attestGateTarget)} onOpenChange={(open) => { if (!open) setAttestGateTarget(null) }}>
        <DialogContent className="rounded-none sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Attest — {attestGateTarget?.label}</DialogTitle>
            <DialogDescription>Confirms this requirement is satisfied. Your name and the timestamp are recorded on the gate.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="attest-note">Note <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Textarea id="attest-note" className="rounded-none" rows={2} maxLength={2000} placeholder="Permit #, appraisal reference…" value={attestNote} onChange={(event) => setAttestNote(event.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAttestGateTarget(null)}>Cancel</Button>
            <Button
              disabled={pending}
              onClick={() => {
                const gate = attestGateTarget
                if (!gate) return
                runAction(
                  async () => { unwrapAction(await attestGateAction(pkg.id, gate.id, attestNote.trim() ? { notes: attestNote.trim() } : {})) },
                  "Gate attested",
                  "Unable to attest gate",
                  () => setAttestGateTarget(null),
                )
              }}
            >
              {pending ? "Attesting…" : "Attest gate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(waiveGateTarget)} onOpenChange={(open) => { if (!open) setWaiveGateTarget(null) }}>
        <DialogContent className="rounded-none sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Waive — {waiveGateTarget?.label}</DialogTitle>
            <DialogDescription>Waivers notify every release approver and stay on the record. Use only when the requirement is genuinely covered another way.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="waive-reason">Reason</Label>
            <Textarea id="waive-reason" className="rounded-none" rows={3} maxLength={2000} value={waiveReason} onChange={(event) => setWaiveReason(event.target.value)} />
            <p className={cn("text-xs", waiveReason.trim().length < 10 ? "text-muted-foreground" : "text-transparent")}>Minimum 10 characters.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWaiveGateTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={pending || waiveReason.trim().length < 10}
              onClick={() => {
                const gate = waiveGateTarget
                if (!gate) return
                runAction(
                  async () => { unwrapAction(await waiveGateAction(pkg.id, gate.id, waiveReason.trim())) },
                  "Gate waived",
                  "Unable to waive gate",
                  () => setWaiveGateTarget(null),
                )
              }}
            >
              {pending ? "Waiving…" : "Waive gate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="rounded-none sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Cancel start package</DialogTitle>
            <DialogDescription>Removes {pkg.lotLabel} from the start pipeline. The lot and its preconstruction project are kept.</DialogDescription>
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
              onClick={() =>
                runAction(
                  async () => { unwrapAction(await cancelStartPackageAction(pkg.id, cancelReason.trim())) },
                  "Start package cancelled",
                  "Unable to cancel start package",
                  () => setCancelOpen(false),
                )
              }
            >
              {pending ? "Cancelling…" : "Cancel package"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
