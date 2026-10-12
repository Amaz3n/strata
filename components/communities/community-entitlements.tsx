"use client"

import { useRouter } from "next/navigation"
import { useEffect, useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import {
  createConditionAction,
  createEntitlementAction,
  deleteConditionAction,
  deleteEntitlementAction,
  meetConditionAction,
  reopenConditionAction,
  updateEntitlementAction,
  waiveConditionAction,
} from "@/app/(app)/communities/[id]/land/entitlement-actions"
import { useWorkspaceParam } from "@/components/financials/workspace/use-workspace-param"
import { Plus } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import {
  ENTITLEMENT_KIND_LABELS,
  ENTITLEMENT_KINDS,
  ENTITLEMENT_MILESTONE_LABELS,
  ENTITLEMENT_MILESTONES,
  ENTITLEMENT_STATUS_LABELS,
  ENTITLEMENT_STATUSES,
  type EntitlementKind,
  type EntitlementMilestone,
  type EntitlementStatus,
} from "@/lib/land/entitlement-readiness"
import type { CommunityEntitlementsTab, EntitlementConditionDTO, EntitlementDTO } from "@/lib/services/land-entitlements"
import { cn } from "@/lib/utils"

const NONE = "none"
const WHOLE = "whole"

const STATUS_TONE: Record<EntitlementStatus, string> = {
  not_started: "border-border bg-muted text-muted-foreground",
  submitted: "border-primary/30 bg-primary/10 text-primary",
  approved: "border-success/40 bg-success/10 text-success",
  denied: "border-destructive/40 bg-destructive/10 text-destructive",
  expired: "border-destructive/40 bg-destructive/10 text-destructive",
  withdrawn: "border-border bg-muted text-muted-foreground",
}

function shortDate(date: string | null) {
  if (!date) return "—"
  return new Date(`${date.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
}

function pick<T extends string>(values: readonly T[], value: string, fallback: T): T {
  return values.find((entry) => entry === value) ?? fallback
}

function pickOptional<T extends string>(values: readonly T[], value: string): T | null {
  return values.find((entry) => entry === value) ?? null
}

interface EntitlementDraft {
  kind: string
  name: string
  phaseId: string
  jurisdiction: string
  referenceNumber: string
  status: string
  requiredBefore: string
  submittedOn: string
  targetOn: string
  approvedOn: string
  expiresOn: string
  ownerUserId: string
  notes: string
}

function draftFrom(entitlement: EntitlementDTO | null): EntitlementDraft {
  return {
    kind: entitlement?.kind ?? "final_plat",
    name: entitlement?.name ?? "",
    phaseId: entitlement?.phaseId ?? WHOLE,
    jurisdiction: entitlement?.jurisdiction ?? "",
    referenceNumber: entitlement?.referenceNumber ?? "",
    status: entitlement?.status ?? "not_started",
    requiredBefore: entitlement ? entitlement.requiredBefore ?? NONE : "lot_delivery",
    submittedOn: entitlement?.submittedOn ?? "",
    targetOn: entitlement?.targetOn ?? "",
    approvedOn: entitlement?.approvedOn ?? "",
    expiresOn: entitlement?.expiresOn ?? "",
    ownerUserId: entitlement?.ownerUserId ?? NONE,
    notes: entitlement?.notes ?? "",
  }
}

function payloadFrom(draft: EntitlementDraft) {
  return {
    kind: pick<EntitlementKind>(ENTITLEMENT_KINDS, draft.kind, "other"),
    name: draft.name,
    communityPhaseId: draft.phaseId === WHOLE ? null : draft.phaseId,
    jurisdiction: draft.jurisdiction || null,
    referenceNumber: draft.referenceNumber || null,
    status: pick<EntitlementStatus>(ENTITLEMENT_STATUSES, draft.status, "not_started"),
    requiredBefore: pickOptional<EntitlementMilestone>(ENTITLEMENT_MILESTONES, draft.requiredBefore),
    submittedOn: draft.submittedOn || null,
    targetOn: draft.targetOn || null,
    approvedOn: draft.approvedOn || null,
    expiresOn: draft.expiresOn || null,
    ownerUserId: draft.ownerUserId === NONE ? null : draft.ownerUserId,
    notes: draft.notes || null,
  }
}

function EntitlementFields({
  draft,
  set,
  phases,
  people,
  disabled,
}: {
  draft: EntitlementDraft
  set: (patch: Partial<EntitlementDraft>) => void
  phases: Array<{ id: string; name: string }>
  people: Array<{ id: string; name: string }>
  disabled: boolean
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="entitlement-name">Approval</Label>
        <Input id="entitlement-name" disabled={disabled} value={draft.name} onChange={(event) => set({ name: event.target.value })} placeholder="Final plat — Phase 2" />
      </div>
      <div className="space-y-1.5">
        <Label>Kind</Label>
        <Select disabled={disabled} value={draft.kind} onValueChange={(kind) => set({ kind })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>{ENTITLEMENT_KINDS.map((kind) => <SelectItem key={kind} value={kind}>{ENTITLEMENT_KIND_LABELS[kind]}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>Applies to</Label>
        <Select disabled={disabled} value={draft.phaseId} onValueChange={(phaseId) => set({ phaseId })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={WHOLE}>Whole community</SelectItem>
            {phases.map((phase) => <SelectItem key={phase.id} value={phase.id}>{phase.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="entitlement-jurisdiction">Jurisdiction</Label>
        <Input id="entitlement-jurisdiction" disabled={disabled} value={draft.jurisdiction} onChange={(event) => set({ jurisdiction: event.target.value })} placeholder="City planning department" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="entitlement-reference">Case or permit no.</Label>
        <Input id="entitlement-reference" disabled={disabled} value={draft.referenceNumber} onChange={(event) => set({ referenceNumber: event.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label>Status</Label>
        <Select disabled={disabled} value={draft.status} onValueChange={(status) => set({ status })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>{ENTITLEMENT_STATUSES.map((status) => <SelectItem key={status} value={status}>{ENTITLEMENT_STATUS_LABELS[status]}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>Required before</Label>
        <Select disabled={disabled} value={draft.requiredBefore} onValueChange={(requiredBefore) => set({ requiredBefore })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Tracked only (never blocks)</SelectItem>
            {ENTITLEMENT_MILESTONES.map((milestone) => <SelectItem key={milestone} value={milestone}>{ENTITLEMENT_MILESTONE_LABELS[milestone]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="entitlement-submitted">Submitted</Label>
        <Input id="entitlement-submitted" type="date" disabled={disabled} value={draft.submittedOn} onChange={(event) => set({ submittedOn: event.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="entitlement-target">Expected by</Label>
        <Input id="entitlement-target" type="date" disabled={disabled} value={draft.targetOn} onChange={(event) => set({ targetOn: event.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="entitlement-approved">Approved</Label>
        <Input id="entitlement-approved" type="date" disabled={disabled} value={draft.approvedOn} onChange={(event) => set({ approvedOn: event.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="entitlement-expires">Expires</Label>
        <Input id="entitlement-expires" type="date" disabled={disabled} value={draft.expiresOn} onChange={(event) => set({ expiresOn: event.target.value })} />
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label>Owner</Label>
        <Select disabled={disabled} value={draft.ownerUserId} onValueChange={(ownerUserId) => set({ ownerUserId })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Unassigned</SelectItem>
            {people.map((person) => <SelectItem key={person.id} value={person.id}>{person.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="entitlement-notes">Notes</Label>
        <Textarea id="entitlement-notes" rows={2} disabled={disabled} value={draft.notes} onChange={(event) => set({ notes: event.target.value })} />
      </div>
    </div>
  )
}

function conditionOverdue(condition: EntitlementConditionDTO, today: string) {
  return condition.status === "open" && condition.dueOn !== null && condition.dueOn < today
}

/**
 * Community → Land: the approvals this community needs and the conditions
 * attached to them. An unmet entitlement or condition required before lot
 * delivery or a start holds starts in its phase (the Starts entitlements gate)
 * and shows on the community header; this is the one place they are recorded.
 */
export function CommunityEntitlements({ tab }: { tab: CommunityEntitlementsTab }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [selectedId, setSelectedId] = useWorkspaceParam("entitlement")
  const [createOpen, setCreateOpen] = useState(false)
  const [createDraft, setCreateDraft] = useState<EntitlementDraft>(draftFrom(null))
  const [editDraft, setEditDraft] = useState<EntitlementDraft>(draftFrom(null))
  const [conditionDraft, setConditionDraft] = useState({ title: "", requiredBefore: "inherit", dueOn: "", ownerUserId: NONE })
  const [waiving, setWaiving] = useState<{ id: string; reason: string } | null>(null)

  const phaseName = useMemo(() => new Map(tab.phases.map((phase) => [phase.id, phase.name])), [tab.phases])
  const selected = tab.entitlements.find((entitlement) => entitlement.id === selectedId) ?? null
  useEffect(() => {
    if (selected) setEditDraft(draftFrom(selected))
  }, [selected])

  const groups = useMemo(() => {
    const order: Array<string | null> = [null, ...tab.phases.map((phase) => phase.id)]
    return order
      .map((phaseId) => ({ phaseId, rows: tab.entitlements.filter((entitlement) => entitlement.phaseId === phaseId) }))
      .filter((group) => group.rows.length > 0)
  }, [tab.entitlements, tab.phases])

  function act(label: string, operation: () => Promise<unknown>, after?: () => void) {
    startTransition(async () => {
      try {
        await operation()
        toast.success(label)
        after?.()
        router.refresh()
      } catch (error) {
        toast.error("That did not save", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  const readinessChips = tab.readiness.filter((row) => row.phaseId !== null || tab.phases.length === 0)

  return (
    <section id="entitlements" className="scroll-mt-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="microlabel">Entitlements</h2>
          <p className="text-xs text-muted-foreground">Approvals and conditions. Anything unmet that is required before delivery or a start holds starts in its phase.</p>
        </div>
        {tab.canWrite ? (
          <Button variant="outline" size="sm" onClick={() => { setCreateDraft(draftFrom(null)); setCreateOpen(true) }}>
            <Plus className="mr-1.5 h-4 w-4" />Entitlement
          </Button>
        ) : null}
      </div>

      {tab.entitlements.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {readinessChips.map((row) => {
            const label = row.phaseId ? phaseName.get(row.phaseId) ?? "Phase" : "Community"
            const blocked = row.start.length
            return (
              <span
                key={row.phaseId ?? WHOLE}
                className={cn(
                  "border px-1.5 py-0.5 text-[11px] font-medium",
                  blocked === 0 && "border-success/40 text-success",
                  blocked > 0 && row.overdue === 0 && "border-warning/50 text-warning",
                  row.overdue > 0 && "border-destructive/50 text-destructive",
                )}
              >
                {label}: {blocked === 0 ? "ready to start" : `${blocked} blocker${blocked === 1 ? "" : "s"}${row.overdue > 0 ? `, ${row.overdue} overdue` : ""}`}
              </span>
            )
          })}
        </div>
      ) : null}

      {tab.truncated ? (
        <p className="mb-2 text-xs text-warning">This community has more entitlements than the tab reads at once; the newest are not shown.</p>
      ) : null}

      <div className="overflow-x-auto border">
        <Table>
          <TableHeader>
            <TableRow className="microlabel">
              <TableHead>Approval</TableHead>
              <TableHead>Jurisdiction</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Approved / expires</TableHead>
              <TableHead>Required before</TableHead>
              <TableHead className="text-right">Conditions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-xs text-muted-foreground">
                  No entitlements recorded. Add zoning, plats and agreements so overdue conditions hold starts.
                </TableCell>
              </TableRow>
            ) : (
              groups.flatMap((group) => [
                <TableRow key={`group-${group.phaseId ?? WHOLE}`} className="bg-muted/40 hover:bg-muted/40">
                  <TableCell colSpan={6} className="py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {group.phaseId ? phaseName.get(group.phaseId) ?? "Phase" : "Whole community"}
                  </TableCell>
                </TableRow>,
                ...group.rows.map((entitlement) => {
                  const resolved = entitlement.conditions.filter((condition) => condition.status !== "open").length
                  const overdue = entitlement.conditions.filter((condition) => conditionOverdue(condition, tab.today)).length
                  const expired = entitlement.status === "approved" && entitlement.expiresOn !== null && entitlement.expiresOn < tab.today
                  const late = entitlement.status !== "approved" && entitlement.targetOn !== null && entitlement.targetOn < tab.today
                  return (
                    <TableRow
                      key={entitlement.id}
                      className={cn("cursor-pointer text-xs", selectedId === entitlement.id && "bg-accent")}
                      onClick={() => setSelectedId(entitlement.id)}
                    >
                      <TableCell className="font-medium">
                        {entitlement.name}
                        <span className="block font-normal text-muted-foreground">{ENTITLEMENT_KIND_LABELS[entitlement.kind]}{entitlement.referenceNumber ? ` · ${entitlement.referenceNumber}` : ""}</span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{entitlement.jurisdiction ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn("text-[10px] font-medium uppercase tracking-wide", STATUS_TONE[entitlement.status])}>
                          {ENTITLEMENT_STATUS_LABELS[entitlement.status]}
                        </Badge>
                        {late ? <span className="ml-1.5 text-[11px] font-medium text-destructive">late</span> : null}
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {shortDate(entitlement.approvedOn)}
                        {entitlement.expiresOn ? (
                          <span className={cn("block", expired && "font-medium text-destructive")}>exp. {shortDate(entitlement.expiresOn)}</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {entitlement.requiredBefore ? ENTITLEMENT_MILESTONE_LABELS[entitlement.requiredBefore] : "Tracked"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {entitlement.conditions.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <>
                            {resolved}/{entitlement.conditions.length}
                            {overdue > 0 ? <span className="ml-1.5 font-medium text-destructive">{overdue} overdue</span> : null}
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                }),
              ])
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Record an entitlement</DialogTitle>
            <DialogDescription>An approval this community or one of its phases needs, and the milestone it must be in hand before.</DialogDescription>
          </DialogHeader>
          <EntitlementFields
            draft={createDraft}
            set={(patch) => setCreateDraft((current) => ({ ...current, ...patch }))}
            phases={tab.phases}
            people={tab.people}
            disabled={pending}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={pending}>Cancel</Button>
            <Button
              disabled={pending || !createDraft.name.trim()}
              onClick={() =>
                act("Entitlement recorded", async () => unwrapAction(await createEntitlementAction(tab.communityId, payloadFrom(createDraft))), () => setCreateOpen(false))
              }
            >
              Record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet open={selected !== null} onOpenChange={(next) => (next ? undefined : setSelectedId(null))}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          {selected ? (
            <>
              <SheetHeader className="border-b pb-3">
                <span className="microlabel">{ENTITLEMENT_KIND_LABELS[selected.kind]} · {selected.phaseId ? phaseName.get(selected.phaseId) ?? "Phase" : "Whole community"}</span>
                <SheetTitle className="text-base">{selected.name}</SheetTitle>
                <SheetDescription>{selected.jurisdiction ?? "No jurisdiction recorded"}</SheetDescription>
              </SheetHeader>
              <div className="space-y-6 px-4 pb-6">
                <section className="space-y-3">
                  <h3 className="microlabel">Approval</h3>
                  <EntitlementFields
                    draft={editDraft}
                    set={(patch) => setEditDraft((current) => ({ ...current, ...patch }))}
                    phases={tab.phases}
                    people={tab.people}
                    disabled={!tab.canWrite || pending}
                  />
                  {tab.canWrite ? (
                    <div className="flex justify-between">
                      {selected.status === "not_started" && selected.conditions.length === 0 ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          disabled={pending}
                          onClick={() => act("Entitlement removed", async () => unwrapAction(await deleteEntitlementAction(tab.communityId, selected.id)), () => setSelectedId(null))}
                        >
                          Remove
                        </Button>
                      ) : <span />}
                      <Button
                        size="sm"
                        disabled={pending || !editDraft.name.trim()}
                        onClick={() => act("Entitlement saved", async () => unwrapAction(await updateEntitlementAction(tab.communityId, selected.id, payloadFrom(editDraft))))}
                      >
                        Save
                      </Button>
                    </div>
                  ) : null}
                </section>

                <section className="space-y-3">
                  <h3 className="microlabel">Conditions of approval</h3>
                  <div className="border">
                    <Table>
                      <TableHeader>
                        <TableRow className="microlabel">
                          <TableHead>Condition</TableHead>
                          <TableHead>Required before</TableHead>
                          <TableHead>Due</TableHead>
                          <TableHead>Status</TableHead>
                          {tab.canWrite ? <TableHead className="text-right" /> : null}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selected.conditions.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={tab.canWrite ? 5 : 4} className="py-6 text-center text-xs text-muted-foreground">No conditions recorded.</TableCell>
                          </TableRow>
                        ) : (
                          selected.conditions.map((condition) => (
                            <TableRow key={condition.id} className="text-xs">
                              <TableCell className="font-medium">
                                {condition.title}
                                <span className="block font-normal text-muted-foreground">
                                  {[condition.phaseId ? phaseName.get(condition.phaseId) : null, condition.ownerName].filter(Boolean).join(" · ") || null}
                                </span>
                                {condition.waivedReason ? <span className="block font-normal text-muted-foreground">Waived: {condition.waivedReason}</span> : null}
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {condition.requiredBefore ? ENTITLEMENT_MILESTONE_LABELS[condition.requiredBefore] : "Tracked"}
                              </TableCell>
                              <TableCell className={cn("tabular-nums", conditionOverdue(condition, tab.today) ? "font-medium text-destructive" : "text-muted-foreground")}>
                                {shortDate(condition.dueOn)}
                              </TableCell>
                              <TableCell>
                                <span
                                  className={cn(
                                    "uppercase tracking-wide",
                                    condition.status === "met" && "text-success",
                                    condition.status === "waived" && "text-warning",
                                    condition.status === "open" && "text-muted-foreground",
                                  )}
                                >
                                  {condition.status === "met" ? `Met ${shortDate(condition.metOn)}` : condition.status}
                                </span>
                              </TableCell>
                              {tab.canWrite ? (
                                <TableCell className="space-x-1 whitespace-nowrap text-right">
                                  {condition.status === "open" ? (
                                    <>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7"
                                        disabled={pending}
                                        onClick={() => act("Condition met", async () => unwrapAction(await meetConditionAction(tab.communityId, condition.id, tab.today)))}
                                      >
                                        Met
                                      </Button>
                                      <Button size="sm" variant="ghost" className="h-7" disabled={pending} onClick={() => setWaiving({ id: condition.id, reason: "" })}>Waive</Button>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 text-destructive hover:text-destructive"
                                        disabled={pending}
                                        onClick={() => act("Condition removed", async () => unwrapAction(await deleteConditionAction(tab.communityId, condition.id)))}
                                      >
                                        Remove
                                      </Button>
                                    </>
                                  ) : (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7"
                                      disabled={pending}
                                      onClick={() => act("Condition reopened", async () => unwrapAction(await reopenConditionAction(tab.communityId, condition.id)))}
                                    >
                                      Reopen
                                    </Button>
                                  )}
                                </TableCell>
                              ) : null}
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>

                  {waiving ? (
                    <div className="flex items-end gap-2 border p-3">
                      <div className="flex-1 space-y-1.5">
                        <Label htmlFor="condition-waiver">Why it is waived</Label>
                        <Input id="condition-waiver" value={waiving.reason} onChange={(event) => setWaiving({ ...waiving, reason: event.target.value })} />
                      </div>
                      <Button size="sm" variant="outline" onClick={() => setWaiving(null)} disabled={pending}>Cancel</Button>
                      <Button
                        size="sm"
                        disabled={pending || waiving.reason.trim().length < 10}
                        onClick={() => act("Condition waived", async () => unwrapAction(await waiveConditionAction(tab.communityId, waiving.id, waiving.reason)), () => setWaiving(null))}
                      >
                        Waive
                      </Button>
                    </div>
                  ) : null}

                  {tab.canWrite ? (
                    <div className="grid gap-2 border p-3 sm:grid-cols-[1fr_9rem_9rem_auto] sm:items-end">
                      <div className="space-y-1.5">
                        <Label htmlFor="condition-title">New condition</Label>
                        <Input id="condition-title" value={conditionDraft.title} onChange={(event) => setConditionDraft({ ...conditionDraft, title: event.target.value })} placeholder="Install signal before the 50th CO" />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Required before</Label>
                        <Select value={conditionDraft.requiredBefore} onValueChange={(requiredBefore) => setConditionDraft({ ...conditionDraft, requiredBefore })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="inherit">As the approval</SelectItem>
                            {ENTITLEMENT_MILESTONES.map((milestone) => <SelectItem key={milestone} value={milestone}>{ENTITLEMENT_MILESTONE_LABELS[milestone]}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="condition-due">Due</Label>
                        <Input id="condition-due" type="date" value={conditionDraft.dueOn} onChange={(event) => setConditionDraft({ ...conditionDraft, dueOn: event.target.value })} />
                      </div>
                      <Button
                        size="sm"
                        disabled={pending || !conditionDraft.title.trim()}
                        onClick={() =>
                          act(
                            "Condition recorded",
                            async () =>
                              unwrapAction(
                                await createConditionAction(tab.communityId, selected.id, {
                                  title: conditionDraft.title,
                                  requiredBefore: pickOptional<EntitlementMilestone>(ENTITLEMENT_MILESTONES, conditionDraft.requiredBefore),
                                  dueOn: conditionDraft.dueOn || null,
                                  ownerUserId: conditionDraft.ownerUserId === NONE ? null : conditionDraft.ownerUserId,
                                }),
                              ),
                            () => setConditionDraft({ title: "", requiredBefore: "inherit", dueOn: "", ownerUserId: NONE }),
                          )
                        }
                      >
                        Add
                      </Button>
                    </div>
                  ) : null}
                </section>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </section>
  )
}

/** Holds the Entitlements section's place while the Land tab loads. */
export function CommunityEntitlementsSkeleton() {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-80" />
        </div>
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="border">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="grid grid-cols-[2fr_repeat(5,1fr)] gap-4 border-b px-3 py-2.5 last:border-b-0">
            {Array.from({ length: 6 }).map((__, cell) => <Skeleton key={cell} className="h-3.5 w-full" />)}
          </div>
        ))}
      </div>
    </section>
  )
}
