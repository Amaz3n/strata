"use client"

import { Fragment, useState, useTransition } from "react"
import { toast } from "sonner"

import {
  addAgreementMilestoneAction,
  resolveAgreementMilestoneAction,
  updateAgreementMilestoneAction,
} from "@/app/(app)/projects/[id]/closing/actions"
import { unwrapAction, type ActionResult } from "@/lib/action-result"
import { DELIVERY_REASON_LABELS, MILESTONE_KINDS, MILESTONE_KIND_LABELS, type MilestoneKind } from "@/lib/sales/agreement-milestones"
import type { getHomeAgreementMilestones } from "@/lib/services/agreement-milestones"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

export type HomeMilestones = Awaited<ReturnType<typeof getHomeAgreementMilestones>>
export type HomeMilestonesState = { ok: true; data: HomeMilestones } | { ok: false; error: string }
type Milestone = HomeMilestones["milestones"][number]

const NONE = "__none"

function formatDate(value?: string | null) {
  if (!value) return "—"
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function deliveryKindLabel(value: unknown) {
  const kind = MILESTONE_KINDS.find((option) => option === value)
  return kind ? MILESTONE_KIND_LABELS[kind] : "Update"
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

const STATUS_CLASS: Record<Milestone["status"], string> = {
  open: "border-border text-foreground",
  satisfied: "border-success/40 text-success",
  waived: "border-border text-muted-foreground",
  failed: "border-destructive/40 text-destructive",
}

function AgingCell({ milestone }: { milestone: Milestone }) {
  const { aging } = milestone
  if (milestone.status !== "open") return <span className="text-muted-foreground">—</span>
  if (aging.overdueDays !== null) return <span className="font-medium text-destructive">{aging.overdueDays}d late</span>
  if (aging.dueInDays !== null) return <span className={aging.tone === "soon" ? "text-warning" : "text-muted-foreground"}>{aging.dueInDays === 0 ? "Due today" : `${aging.dueInDays}d left`}</span>
  return <span className="text-muted-foreground">Open {aging.openDays}d</span>
}

/**
 * What the sale still owes before closing: the buyer's signed contingencies and
 * the lender and title milestones, with owners, due dates, prerequisites,
 * evidence and the external reports that reached this home.
 */
export function AgreementMilestonesPanel({ projectId, state, editable }: { projectId: string; state: HomeMilestonesState; editable: boolean }) {
  if (!state.ok) {
    return (
      <section id="milestones" className="border bg-background p-4" role="alert">
        <h2 className="font-semibold">Contingencies and lender milestones</h2>
        <p className="mt-1 text-sm text-destructive">{state.error}</p>
      </section>
    )
  }
  return <MilestonesTable projectId={projectId} data={state.data} editable={editable && state.data.canManage} />
}

function MilestonesTable({ projectId, data, editable }: { projectId: string; data: HomeMilestones; editable: boolean }) {
  const [pending, startTransition] = useTransition()
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const act = <T,>(operation: () => Promise<ActionResult<T>>, message: string, done?: () => void) =>
    startTransition(async () => {
      try {
        unwrapAction(await operation())
        toast.success(message)
        done?.()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Action failed")
      }
    })
  const memberName = new Map(data.members.map((member) => [member.id, member.name]))
  const titleById = new Map(data.milestones.map((row) => [row.id, row.title]))
  const holding = data.milestones.filter((row) => row.requiredBefore === "closing" && (row.status === "open" || row.status === "failed")).length
  const refused = data.deliveries.filter((delivery) => delivery.outcome === "refused")

  return (
    <section id="milestones" className="border bg-background">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
        <div>
          <h2 className="font-semibold">Contingencies and lender milestones</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {data.agreement ? `Agreement ${data.agreement.number ?? ""} · ` : ""}
            {holding > 0 ? <span className="text-warning">{holding} holding closing</span> : data.milestones.length ? <span className="text-success">Nothing holds closing</span> : null}
            {refused.length > 0 ? <span className="text-destructive"> · {refused.length} refused {refused.length === 1 ? "update" : "updates"}</span> : null}
          </p>
        </div>
        {editable && data.agreement ? <Button size="sm" variant="outline" onClick={() => setAdding((value) => !value)}>{adding ? "Cancel" : "Add milestone"}</Button> : null}
      </div>

      {adding ? <AddMilestoneForm projectId={projectId} milestones={data.milestones} members={data.members} pending={pending}
        onSubmit={(input) => act(() => addAgreementMilestoneAction(projectId, input), "Milestone added", () => setAdding(false))} /> : null}

      {!data.agreement ? (
        <p className="p-4 text-sm text-muted-foreground">No executed purchase agreement on this home. Contingencies and lender milestones appear once the buyer signs.</p>
      ) : data.milestones.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">This agreement carries no contingencies or lender milestones.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="px-4 py-2 text-left font-medium">Milestone</th>
                <th className="px-3 py-2 text-left font-medium">Owner</th>
                <th className="px-3 py-2 text-left font-medium">Due</th>
                <th className="px-3 py-2 text-left font-medium">Aging</th>
                <th className="px-3 py-2 text-left font-medium">Depends on</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data.milestones.map((milestone) => (
                <Fragment key={milestone.id}>
                  <tr className="border-b align-top hover:bg-muted/40">
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{milestone.title}</span>
                        {milestone.isContingency ? <Badge variant="outline" className="text-[10px]">Contract term</Badge> : null}
                        {milestone.requiredBefore ? <Badge variant="outline" className="text-[10px]">Before {milestone.requiredBefore}</Badge> : null}
                      </div>
                      {milestone.reportedLabel ? <p className="mt-0.5 text-xs text-primary">{milestone.reportedLabel}{milestone.reportedReference ? ` · ${milestone.reportedReference}` : ""}</p> : null}
                      {milestone.evidenceRequired && milestone.status === "open" ? <p className="mt-0.5 text-xs text-muted-foreground">Evidence required</p> : null}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {milestone.ownerUserId ? memberName.get(milestone.ownerUserId) ?? "Team member" : milestone.ownerCompanyId ? data.companyNames[milestone.ownerCompanyId] ?? "Company" : <span className="text-warning">Unassigned</span>}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">{formatDate(milestone.dueOn)}</td>
                    <td className="px-3 py-2.5 tabular-nums"><AgingCell milestone={milestone} /></td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">
                      {milestone.dependsOn.length ? milestone.dependsOn.map((id) => titleById.get(id) ?? "—").join(", ") : "—"}
                      {milestone.blockedBy.length && milestone.status === "open" ? <p className="text-warning">Waiting on {milestone.blockedBy.length}</p> : null}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${STATUS_CLASS[milestone.status]}`}>{milestone.status}</span>
                      {milestone.resolvedOn ? <p className="mt-0.5 text-xs text-muted-foreground">{formatDate(milestone.resolvedOn)}</p> : null}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Button size="sm" variant="ghost" aria-expanded={openRow === milestone.id} onClick={() => setOpenRow(openRow === milestone.id ? null : milestone.id)}>
                        {openRow === milestone.id ? "Close" : editable ? "Manage" : "History"}
                      </Button>
                    </td>
                  </tr>
                  {openRow === milestone.id ? (
                    <tr className="border-b bg-muted/30">
                      <td colSpan={7} className="px-4 py-3">
                        <MilestoneDetail milestone={milestone} data={data} editable={editable} pending={pending}
                          act={(operation, message) => act(operation, message, () => setOpenRow(null))} projectId={projectId} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
          {data.truncated ? <p className="border-t px-4 py-2 text-xs text-muted-foreground">Showing the first 100 milestones on this agreement.</p> : null}
        </div>
      )}

      {data.deliveries.length > 0 ? (
        <div className="border-t">
          <p className="microlabel px-4 pt-3">External updates</p>
          <ul className="divide-y text-sm">
            {data.deliveries.map((delivery) => (
              <li key={delivery.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                <span className="min-w-0 truncate">
                  {deliveryKindLabel(delivery.payload.milestone)}
                  <span className="ml-2 text-xs text-muted-foreground">{new Date(delivery.received_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                </span>
                <span className={`text-xs ${delivery.outcome === "refused" ? "text-destructive" : delivery.outcome === "applied" ? "text-success" : "text-muted-foreground"}`}>
                  {delivery.outcome === "refused" ? `Refused: ${DELIVERY_REASON_LABELS[delivery.reason_code ?? ""] ?? delivery.reason_code}` : delivery.outcome === "applied" ? "Applied" : "Recorded as reported"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

function MilestoneDetail({ milestone, data, editable, pending, act, projectId }: {
  milestone: Milestone
  data: HomeMilestones
  editable: boolean
  pending: boolean
  act: <T,>(operation: () => Promise<ActionResult<T>>, message: string) => void
  projectId: string
}) {
  const [resolvedOn, setResolvedOn] = useState(today())
  const [fileId, setFileId] = useState<string>(milestone.evidenceFileId ?? NONE)
  const [note, setNote] = useState("")
  const [dueOn, setDueOn] = useState(milestone.dueOn ?? "")
  const [reason, setReason] = useState("")
  const [owner, setOwner] = useState(milestone.ownerUserId ?? NONE)
  const history = data.history.filter((row) => row.milestone_id === milestone.id)
  const memberName = new Map(data.members.map((member) => [member.id, member.name]))
  const base = { milestoneId: milestone.id, version: milestone.version }
  const noteValid = note.trim().length >= 10
  const signedDueChange = milestone.source === "agreement" && dueOn !== (milestone.dueOn ?? "")

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        {editable && milestone.status === "open" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
              <div className="space-y-1">
                <Label htmlFor={`resolved-${milestone.id}`} className="text-xs">Date</Label>
                <Input id={`resolved-${milestone.id}`} type="date" max={today()} value={resolvedOn} onChange={(event) => setResolvedOn(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`evidence-${milestone.id}`} className="text-xs">Evidence {milestone.evidenceRequired ? "(required)" : "(optional)"}</Label>
                <Select value={fileId} onValueChange={setFileId}>
                  <SelectTrigger id={`evidence-${milestone.id}`}><SelectValue placeholder="Choose a file on this home" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No file</SelectItem>
                    {data.evidenceFiles.map((file) => <SelectItem key={file.id} value={file.id}>{file.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Button size="sm" disabled={pending || milestone.blockedBy.length > 0 || (milestone.evidenceRequired && fileId === NONE)}
                onClick={() => act(() => resolveAgreementMilestoneAction(projectId, { ...base, resolution: "satisfied", resolvedOn, evidenceFileId: fileId === NONE ? null : fileId }), "Milestone satisfied")}>
                Mark satisfied
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {milestone.blockedBy.length ? `Waiting on ${milestone.blockedBy.join(", ")}. ` : ""}
              Evidence is a file already on this home{data.evidenceFilesTruncated ? " (the 100 most recent are listed)" : ""}; upload it to the home's files first.
            </p>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
              <div className="space-y-1">
                <Label htmlFor={`note-${milestone.id}`} className="text-xs">Reason</Label>
                <Textarea id={`note-${milestone.id}`} rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why it is waived or failed (10 characters or more)" />
              </div>
              <Button size="sm" variant="outline" disabled={pending || !noteValid}
                onClick={() => act(() => resolveAgreementMilestoneAction(projectId, { ...base, resolution: "waived", resolvedOn, note }), "Milestone waived")}>Waive</Button>
              <Button size="sm" variant="outline" className="text-destructive" disabled={pending || !noteValid}
                onClick={() => act(() => resolveAgreementMilestoneAction(projectId, { ...base, resolution: "failed", resolvedOn, note }), "Milestone marked failed")}>Failed</Button>
            </div>
            <div className="grid gap-3 border-t pt-3 sm:grid-cols-[12rem_10rem_1fr_auto] sm:items-end">
              <div className="space-y-1">
                <Label htmlFor={`owner-${milestone.id}`} className="text-xs">Owner</Label>
                <Select value={owner} onValueChange={setOwner}>
                  <SelectTrigger id={`owner-${milestone.id}`}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Unassigned</SelectItem>
                    {data.members.map((member) => <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`due-${milestone.id}`} className="text-xs">Due</Label>
                <Input id={`due-${milestone.id}`} type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`reason-${milestone.id}`} className="text-xs">{signedDueChange ? "Extension reason (required)" : "Note"}</Label>
                <Input id={`reason-${milestone.id}`} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={signedDueChange ? "Why the signed date moves" : "Optional"} />
              </div>
              <Button size="sm" variant="outline" disabled={pending || (signedDueChange && reason.trim().length < 10)}
                onClick={() => act(() => updateAgreementMilestoneAction(projectId, { ...base, ownerUserId: owner === NONE ? null : owner, dueOn: dueOn || null, reason }), "Milestone updated")}>Save</Button>
            </div>
          </>
        ) : null}
        {editable && milestone.status !== "open" ? (
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            <div className="space-y-1">
              <Label htmlFor={`reopen-${milestone.id}`} className="text-xs">Reason</Label>
              <Input id={`reopen-${milestone.id}`} value={note} onChange={(event) => setNote(event.target.value)} placeholder="10 characters or more" />
            </div>
            {milestone.status === "failed" ? <Button size="sm" variant="outline" disabled={pending || !noteValid}
              onClick={() => act(() => resolveAgreementMilestoneAction(projectId, { ...base, resolution: "waived", resolvedOn: today(), note }), "Failure waived")}>Waive failure</Button> : null}
            <Button size="sm" variant="outline" disabled={pending || !noteValid}
              onClick={() => act(() => resolveAgreementMilestoneAction(projectId, { ...base, resolution: "open", note }), "Milestone reopened")}>Reopen</Button>
          </div>
        ) : null}
        {milestone.resolutionNote ? <p className="text-xs text-muted-foreground">Resolution: {milestone.resolutionNote}</p> : null}
      </div>
      <div>
        <p className="microlabel">History</p>
        {history.length === 0 ? <p className="mt-1 text-xs text-muted-foreground">No changes recorded.</p> : (
          <ol className="mt-1 space-y-1.5 text-xs">
            {history.map((row) => (
              <li key={row.id}>
                <span className="tabular-nums text-muted-foreground">{new Date(row.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>{" "}
                {row.source === "materialized" ? "Seeded from the agreement" : row.source === "external" ? `Reported ${row.reported_status?.replace("_", " ") ?? ""} by the lender/title feed` : (
                  row.from_status !== row.to_status ? `${row.from_status ?? "new"} → ${row.to_status}` : row.from_due_on !== row.to_due_on ? `Due ${formatDate(row.from_due_on)} → ${formatDate(row.to_due_on)}` : "Updated"
                )}
                {row.actor_id ? ` · ${memberName.get(row.actor_id) ?? "Team member"}` : ""}
                {row.note ? <span className="block text-muted-foreground">{row.note}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

function AddMilestoneForm({ milestones, members, pending, onSubmit, projectId }: {
  projectId: string
  milestones: Milestone[]
  members: HomeMilestones["members"]
  pending: boolean
  onSubmit: (input: Record<string, unknown>) => void
}) {
  const [kind, setKind] = useState<MilestoneKind>("financing")
  const [title, setTitle] = useState("")
  const [requiredBefore, setRequiredBefore] = useState<string>("closing")
  const [dueOn, setDueOn] = useState("")
  const [owner, setOwner] = useState(NONE)
  const [contingency, setContingency] = useState(true)
  const [evidence, setEvidence] = useState(true)
  const [dependsOn, setDependsOn] = useState<string[]>([])
  return (
    <div className="space-y-3 border-b bg-muted/30 p-4">
      <div className="grid gap-3 sm:grid-cols-[11rem_1fr_9rem_10rem_12rem]">
        <div className="space-y-1">
          <Label htmlFor="milestone-kind" className="text-xs">Kind</Label>
          <Select value={kind} onValueChange={(value) => setKind(MILESTONE_KINDS.find((option) => option === value) ?? "other")}>
            <SelectTrigger id="milestone-kind"><SelectValue /></SelectTrigger>
            <SelectContent>{MILESTONE_KINDS.map((option) => <SelectItem key={option} value={option}>{MILESTONE_KIND_LABELS[option]}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="milestone-title" className="text-xs">Title</Label>
          <Input id="milestone-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={`${MILESTONE_KIND_LABELS[kind]} contingency`} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="milestone-gate" className="text-xs">Holds</Label>
          <Select value={requiredBefore} onValueChange={setRequiredBefore}>
            <SelectTrigger id="milestone-gate"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="closing">Closing</SelectItem>
              <SelectItem value="start">Start</SelectItem>
              <SelectItem value={NONE}>Nothing (track)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="milestone-due" className="text-xs">Due</Label>
          <Input id="milestone-due" type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="milestone-owner" className="text-xs">Owner</Label>
          <Select value={owner} onValueChange={setOwner}>
            <SelectTrigger id="milestone-owner"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Unassigned</SelectItem>
              {members.map((member) => <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2"><Checkbox checked={contingency} onCheckedChange={(value) => setContingency(value === true)} />Buyer contingency</label>
        <label className="flex items-center gap-2"><Checkbox checked={evidence} onCheckedChange={(value) => setEvidence(value === true)} />Needs evidence</label>
        {milestones.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Depends on</span>
            {milestones.filter((row) => row.status === "open").map((row) => (
              <label key={row.id} className="flex items-center gap-1 text-xs">
                <Checkbox checked={dependsOn.includes(row.id)} onCheckedChange={(value) => setDependsOn((current) => value === true ? [...current, row.id] : current.filter((id) => id !== row.id))} />
                {row.title}
              </label>
            ))}
          </div>
        ) : null}
        <Button size="sm" className="ml-auto" disabled={pending}
          onClick={() => onSubmit({
            projectId, kind, title: title.trim() || `${MILESTONE_KIND_LABELS[kind]} contingency`, isContingency: contingency,
            requiredBefore: requiredBefore === NONE ? null : requiredBefore, dueOn: dueOn || null,
            ownerUserId: owner === NONE ? null : owner, evidenceRequired: evidence, dependsOn,
          })}>
          Add
        </Button>
      </div>
    </div>
  )
}
