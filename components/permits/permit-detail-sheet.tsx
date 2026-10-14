"use client"

import Link from "next/link"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import {
  assessPermitFeeAction,
  assignPermitApplicationAction,
  linkPermitFeePaymentAction,
  payPermitFeeAction,
  recordCorrectionRoundAction,
  recordPermitDecisionAction,
  recordPermitSubmissionAction,
  setPermitDocumentAction,
  updateCorrectionRoundAction,
  voidPermitFeeAction,
} from "@/app/(app)/projects/[id]/permits/actions"
import { CostCodeSelectItems } from "@/components/cost-codes/cost-code-select-items"
import { AlertTriangle } from "@/components/icons"
import { AGING_CLASS, STAGE_CLASS, addDaysIso, dueLabel, formatDay, parseDollars } from "@/components/permits/permit-format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction, type ActionResult } from "@/lib/action-result"
import { PERMIT_FEE_DUE, PERMIT_FEE_DUE_LABELS, PERMIT_FEE_KINDS, PERMIT_FEE_KIND_LABELS, type PermitFeeDue, type PermitFeeKind } from "@/lib/permits/fees"
import type { PermitApplicationDTO, ProjectPermitsDTO } from "@/lib/services/permits"
import { cn, formatMoneyCentsExact } from "@/lib/utils"

const NONE = "__none"

type Act = <T>(operation: () => Promise<ActionResult<T>>, message: string, done?: () => void) => void

function useAct(): [boolean, Act] {
  const [pending, startTransition] = useTransition()
  const act: Act = (operation, message, done) => startTransition(async () => {
    try {
      unwrapAction(await operation())
      toast.success(message)
      done?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed")
    }
  })
  return [pending, act]
}

function FilePicker({ id, files, value, onChange, placeholder = "Choose a file on this home" }: {
  id: string
  files: ProjectPermitsDTO["files"]
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  return (
    <Select value={value || NONE} onValueChange={(next) => onChange(next === NONE ? "" : next)}>
      <SelectTrigger id={id} className="h-8 rounded-none text-xs"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{placeholder}</SelectItem>
        {files.map((file) => <SelectItem key={file.id} value={file.id}>{file.name}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

function Band({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b px-5 py-4">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="microlabel">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

/**
 * One application: its checklist, what was submitted, what the authority sent
 * back and who owns the response, its decision, and its fees against what
 * their payables paid.
 */
export function PermitDetailSheet({ data, application, onClose, onRevise }: {
  data: ProjectPermitsDTO
  application: PermitApplicationDTO
  onClose: () => void
  onRevise: () => void
}) {
  const [pending, act] = useAct()
  const editable = data.canWrite && !application.supersededAt && application.decision === null
  const home = data.projectId

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="flex flex-wrap items-center gap-2 text-base">
            {application.permitTypeLabel} permit
            <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-normal", STAGE_CLASS[application.stage])}>{application.stageLabel}</span>
          </SheetTitle>
          <SheetDescription className="text-xs">
            {application.jurisdiction.name}
            {application.permitNumber ? ` · ${application.permitNumber}` : ""}
            {application.expectedDecisionOn && application.decision === null ? ` · Decision expected ${formatDay(application.expectedDecisionOn)}` : ""}
          </SheetDescription>
          <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
            <span className="text-muted-foreground">Coordinator</span>
            {data.canWrite && !application.supersededAt ? (
              <Select value={application.ownerUserId ?? NONE} disabled={pending}
                onValueChange={(value) => act(() => assignPermitApplicationAction(home, { applicationId: application.id, ownerUserId: value === NONE ? null : value }), "Coordinator changed")}>
                <SelectTrigger className="h-7 w-48 rounded-none text-xs" aria-label="Coordinator"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Unassigned</SelectItem>
                  {data.members.map((member) => <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : <span>{application.ownerName ?? "Unassigned"}</span>}
          </div>
        </SheetHeader>

        <DocumentsBand data={data} application={application} editable={editable} pending={pending} act={act} />
        <SubmissionsBand data={data} application={application} editable={editable} pending={pending} act={act} />
        <RoundsBand data={data} application={application} editable={editable} pending={pending} act={act} />
        <DecisionBand data={data} application={application} editable={editable} pending={pending} act={act} onRevise={onRevise} />
        <FeesBand data={data} application={application} pending={pending} act={act} />
      </SheetContent>
    </Sheet>
  )
}

type BandProps = { data: ProjectPermitsDTO; application: PermitApplicationDTO; editable: boolean; pending: boolean; act: Act }

function DocumentsBand({ data, application, editable, pending, act }: BandProps) {
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState("")
  const [requiredFor, setRequiredFor] = useState<"submission" | "decision">("decision")
  const missing = application.documents.filter((document) => !document.fileId).length
  const attach = (kind: string, fileId: string | null) =>
    act(() => setPermitDocumentAction(data.projectId, { applicationId: application.id, documentKind: kind, fileId }), fileId ? "Document attached" : "Document cleared")
  const kindFor = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "doc_$1").slice(0, 40)

  return (
    <Band title="Required documents" aside={missing ? <span className="text-xs text-warning">{missing} missing</span> : application.documents.length ? <span className="text-xs text-success">All on file</span> : null}>
      {application.documents.length === 0 ? <p className="text-xs text-muted-foreground">The authority lists no documents for this permit.</p> : (
        <ul className="divide-y border">
          {application.documents.map((document) => (
            <li key={document.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{document.label}</p>
                <p className="text-xs text-muted-foreground">Before {document.requiredFor}{document.source === "jurisdiction" ? " · authority checklist" : document.source === "added" ? " · added" : ""}</p>
              </div>
              {document.fileId
                ? <span className="max-w-48 truncate text-xs text-success">{document.fileName}</span>
                : <span className="inline-flex items-center gap-1 text-xs text-warning"><AlertTriangle className="h-3 w-3" />Missing</span>}
              {editable ? (
                <div className="w-52">
                  <FilePicker id={`document-${document.id}`} files={data.files} value={document.fileId ?? ""} onChange={(fileId) => attach(document.kind, fileId || null)} placeholder={document.fileId ? "Clear the file" : "Attach a file"} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editable ? (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
          <Link href={`/projects/${data.projectId}/documents`} className="text-muted-foreground hover:underline">Upload on the home&apos;s documents</Link>
          {data.filesTruncated ? <span className="text-muted-foreground">Showing the 200 newest files.</span> : null}
          <Button size="sm" variant="ghost" className="ml-auto h-7 rounded-none px-2 text-xs" onClick={() => setAdding((value) => !value)}>{adding ? "Cancel" : "Add a requirement"}</Button>
        </div>
      ) : null}
      {adding ? (
        <div className="mt-2 grid gap-2 border bg-muted/30 p-3 sm:grid-cols-[1fr_10rem_auto]">
          <Input className="h-8 rounded-none text-xs" placeholder="What the authority asked for" value={label} onChange={(event) => setLabel(event.target.value)} aria-label="Document" />
          <Select value={requiredFor} onValueChange={(value) => setRequiredFor(value === "submission" ? "submission" : "decision")}>
            <SelectTrigger className="h-8 rounded-none text-xs" aria-label="Needed before"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="submission">Before submission</SelectItem>
              <SelectItem value="decision">Before decision</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" className="h-8 rounded-none" disabled={pending || kindFor(label).length < 2}
            onClick={() => act(() => setPermitDocumentAction(data.projectId, { applicationId: application.id, documentKind: kindFor(label), label, requiredFor, fileId: null }), "Requirement added", () => { setAdding(false); setLabel("") })}>
            Add
          </Button>
        </div>
      ) : null}
    </Band>
  )
}

function SubmissionsBand({ data, application, editable, pending, act }: BandProps) {
  const [open, setOpen] = useState(false)
  const [submittedOn, setSubmittedOn] = useState(data.today)
  const [reference, setReference] = useState("")
  const [note, setNote] = useState("")
  const [respondsTo, setRespondsTo] = useState<string>(NONE)
  const openRounds = application.rounds.filter((round) => round.status === "open")
  const blocked = application.missingSubmissionDocuments

  return (
    <Band title="Submissions" aside={editable ? (
      <Button size="sm" variant="outline" className="h-7 rounded-none px-2 text-xs" disabled={blocked.length > 0} onClick={() => setOpen((value) => !value)}>
        {open ? "Cancel" : application.submissions.length ? "Record resubmission" : "Record submission"}
      </Button>
    ) : null}>
      {editable && blocked.length ? <p className="mb-2 text-xs text-warning">Attach before submitting: {blocked.join(", ")}</p> : null}
      {open ? (
        <div className="mb-3 grid gap-2 border bg-muted/30 p-3 sm:grid-cols-2">
          <div className="grid gap-1"><Label className="text-xs" htmlFor="submitted-on">Submitted</Label><Input id="submitted-on" type="date" className="h-8 rounded-none text-xs" max={data.today} value={submittedOn} onChange={(event) => setSubmittedOn(event.target.value)} /></div>
          <div className="grid gap-1"><Label className="text-xs" htmlFor="submission-reference">Portal reference</Label><Input id="submission-reference" className="h-8 rounded-none text-xs" value={reference} onChange={(event) => setReference(event.target.value)} /></div>
          {openRounds.length ? (
            <div className="grid gap-1 sm:col-span-2">
              <Label className="text-xs" htmlFor="responds-to">Answers</Label>
              <Select value={respondsTo} onValueChange={setRespondsTo}>
                <SelectTrigger id="responds-to" className="h-8 rounded-none text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No correction round (a revision)</SelectItem>
                  {openRounds.map((round) => <SelectItem key={round.id} value={round.id}>Round {round.number} corrections</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <Textarea className="rounded-none text-xs sm:col-span-2" rows={2} placeholder="Note" value={note} onChange={(event) => setNote(event.target.value)} />
          <Button size="sm" className="rounded-none sm:col-span-2 sm:justify-self-end" disabled={pending || !submittedOn}
            onClick={() => act(() => recordPermitSubmissionAction(data.projectId, {
              applicationId: application.id, submittedOn, reference: reference || null, note: note || null, respondsToRoundId: respondsTo === NONE ? null : respondsTo,
            }), "Submission recorded", () => { setOpen(false); setNote(""); setReference(""); setRespondsTo(NONE) })}>
            Record
          </Button>
        </div>
      ) : null}
      {application.submissions.length === 0 ? <p className="text-xs text-muted-foreground">Not submitted to the authority yet.</p> : (
        <table className="w-full text-xs">
          <thead><tr className="border-b text-muted-foreground"><th className="py-1.5 text-left font-medium">#</th><th className="py-1.5 text-left font-medium">Kind</th><th className="py-1.5 text-left font-medium">Submitted</th><th className="py-1.5 text-left font-medium">Reference</th><th className="py-1.5 text-right font-medium">Decision expected</th></tr></thead>
          <tbody>
            {application.submissions.map((submission) => (
              <tr key={submission.id} className="border-b last:border-b-0">
                <td className="py-1.5 tabular-nums">{submission.number}</td>
                <td className="py-1.5 capitalize">{submission.kind}</td>
                <td className="py-1.5 tabular-nums">{formatDay(submission.submittedOn)} <span className="text-muted-foreground">· {submission.submittedBy}</span></td>
                <td className="py-1.5 text-muted-foreground">{submission.reference ?? "—"}</td>
                <td className="py-1.5 text-right tabular-nums">{formatDay(submission.expectedDecisionOn)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Band>
  )
}

function RoundsBand({ data, application, editable, pending, act }: BandProps) {
  const [open, setOpen] = useState(false)
  const [receivedOn, setReceivedOn] = useState(data.today)
  const [comments, setComments] = useState("")
  const [owner, setOwner] = useState<string>(application.ownerUserId ?? NONE)
  const [dueOn, setDueOn] = useState(addDaysIso(data.today, 14))
  const [letter, setLetter] = useState("")
  const [historyFor, setHistoryFor] = useState<string | null>(null)
  const [noteFor, setNoteFor] = useState<{ roundId: string; status: "withdrawn" | "open" } | null>(null)
  const [note, setNote] = useState("")
  const update = (roundId: string, patch: Record<string, unknown>, message: string, done?: () => void) =>
    act(() => updateCorrectionRoundAction(data.projectId, { roundId, ...patch }), message, done)

  return (
    <Band title="Correction rounds" aside={editable && application.submissions.length ? (
      <Button size="sm" variant="outline" className="h-7 rounded-none px-2 text-xs" onClick={() => setOpen((value) => !value)}>{open ? "Cancel" : "Record corrections"}</Button>
    ) : null}>
      {open ? (
        <div className="mb-3 grid gap-2 border bg-muted/30 p-3 sm:grid-cols-2">
          <div className="grid gap-1"><Label className="text-xs" htmlFor="round-received">Received</Label><Input id="round-received" type="date" className="h-8 rounded-none text-xs" max={data.today} value={receivedOn} onChange={(event) => setReceivedOn(event.target.value)} /></div>
          <div className="grid gap-1"><Label className="text-xs" htmlFor="round-due">Response due</Label><Input id="round-due" type="date" required className="h-8 rounded-none text-xs" min={receivedOn} value={dueOn} onChange={(event) => setDueOn(event.target.value)} /></div>
          <div className="grid gap-1">
            <Label className="text-xs" htmlFor="round-owner">Owner</Label>
            <Select value={owner} onValueChange={setOwner}>
              <SelectTrigger id="round-owner" className="h-8 rounded-none text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>The application&apos;s coordinator</SelectItem>
                {data.members.map((member) => <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1"><Label className="text-xs" htmlFor="round-letter">Comment letter</Label><FilePicker id="round-letter" files={data.files} value={letter} onChange={setLetter} placeholder="No letter on file" /></div>
          <Textarea className="rounded-none text-xs sm:col-span-2" rows={3} placeholder="What the reviewer asked for" value={comments} onChange={(event) => setComments(event.target.value)} />
          <Button size="sm" className="rounded-none sm:col-span-2 sm:justify-self-end" disabled={pending || !comments.trim() || !dueOn}
            onClick={() => act(() => recordCorrectionRoundAction(data.projectId, {
              applicationId: application.id, receivedOn, comments, commentFileId: letter || null, ownerUserId: owner === NONE ? null : owner, dueOn,
            }), "Corrections recorded", () => { setOpen(false); setComments(""); setLetter("") })}>
            Record
          </Button>
        </div>
      ) : null}
      {application.rounds.length === 0 ? <p className="text-xs text-muted-foreground">The authority has not returned corrections.</p> : (
        <ul className="space-y-2">
          {application.rounds.map((round) => {
            const late = round.overdueDays > 0
            const active = round.status === "open" || round.status === "responded"
            return (
              <li key={round.id} className={cn("border p-3 text-sm", round.status === "open" && late && "border-destructive/40")}>
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">Round {round.number} <span className="font-normal text-muted-foreground">· received {formatDay(round.receivedOn)}</span></p>
                    <p className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">{round.comments}</p>
                  </div>
                  <Badge variant="outline" className={cn("text-[10px] capitalize", round.status === "open" ? "text-warning" : round.status === "resolved" ? "text-success" : "")}>{round.status}</Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  {editable && active ? (
                    <>
                      <Select value={round.ownerUserId ?? NONE} disabled={pending} onValueChange={(value) => update(round.id, { ownerUserId: value === NONE ? null : value }, "Owner changed")}>
                        <SelectTrigger className="h-7 w-44 rounded-none text-xs" aria-label={`Round ${round.number} owner`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>Unassigned</SelectItem>
                          {data.members.map((member) => <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Input type="date" className="h-7 w-36 rounded-none text-xs" aria-label={`Round ${round.number} due`} defaultValue={round.dueOn ?? ""} min={round.receivedOn}
                        onBlur={(event) => { if (event.target.value && event.target.value !== round.dueOn) update(round.id, { dueOn: event.target.value }, "Due date moved") }} />
                    </>
                  ) : <span className="text-muted-foreground">{round.ownerName ?? "Unassigned"} · due {formatDay(round.dueOn)}</span>}
                  {round.status === "open" && round.dueOn ? <span className={late ? AGING_CLASS.overdue : "text-muted-foreground"}>{late ? `${round.overdueDays}d late` : dueLabel(Math.round((Date.parse(round.dueOn) - Date.parse(data.today)) / 86_400_000))}</span> : null}
                  {round.status === "responded" ? <span className="text-muted-foreground">Responded {formatDay(round.respondedOn)}</span> : null}
                  {round.status === "resolved" ? <span className="text-success">Resolved {formatDay(round.resolvedOn)}</span> : null}
                  <span className="ml-auto flex gap-1">
                    {editable && round.status === "responded" ? (
                      <>
                        <Button size="sm" variant="outline" className="h-7 rounded-none px-2 text-xs" disabled={pending} onClick={() => update(round.id, { status: "resolved", note: "Accepted by the reviewer" }, "Round resolved")}>Resolve</Button>
                        <Button size="sm" variant="ghost" className="h-7 rounded-none px-2 text-xs" disabled={pending} onClick={() => { setNote(""); setNoteFor({ roundId: round.id, status: "open" }) }}>Sent back</Button>
                      </>
                    ) : null}
                    {editable && round.status === "open" ? (
                      <Button size="sm" variant="ghost" className="h-7 rounded-none px-2 text-xs" disabled={pending} onClick={() => { setNote(""); setNoteFor({ roundId: round.id, status: "withdrawn" }) }}>Withdraw</Button>
                    ) : null}
                    <Button size="sm" variant="ghost" className="h-7 rounded-none px-2 text-xs" aria-expanded={historyFor === round.id} onClick={() => setHistoryFor(historyFor === round.id ? null : round.id)}>History</Button>
                  </span>
                </div>
                {noteFor?.roundId === round.id ? (
                  <div className="mt-2 flex gap-2">
                    <Input className="h-8 rounded-none text-xs" placeholder={noteFor.status === "withdrawn" ? "Why the authority withdrew it" : "What the reviewer still wants"} value={note} onChange={(event) => setNote(event.target.value)} />
                    <Button size="sm" className="h-8 rounded-none" disabled={pending || note.trim().length < 5} onClick={() => update(round.id, { status: noteFor.status, note }, noteFor.status === "withdrawn" ? "Round withdrawn" : "Round reopened", () => setNoteFor(null))}>Save</Button>
                  </div>
                ) : null}
                {historyFor === round.id ? (
                  <ol className="mt-2 space-y-1 border-t pt-2 text-xs text-muted-foreground">
                    {round.history.map((entry) => (
                      <li key={entry.id} className="tabular-nums">
                        <span className="text-foreground">{new Date(entry.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                        {" · "}{entry.actor}{" · "}
                        {entry.fromStatus && entry.fromStatus !== entry.toStatus ? `${entry.fromStatus} → ${entry.toStatus}` : entry.toStatus}
                        {entry.fromOwner !== entry.toOwner ? ` · owner ${entry.fromOwner ?? "—"} → ${entry.toOwner ?? "—"}` : ""}
                        {entry.fromDueOn !== entry.toDueOn ? ` · due ${formatDay(entry.fromDueOn)} → ${formatDay(entry.toDueOn)}` : ""}
                        {entry.note ? ` · ${entry.note}` : ""}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </Band>
  )
}

function DecisionBand({ data, application, editable, pending, act, onRevise }: BandProps & { onRevise: () => void }) {
  const [decision, setDecision] = useState<"approved" | "not_required" | "denied" | "withdrawn">("approved")
  const [decidedOn, setDecidedOn] = useState(data.today)
  const [permitNumber, setPermitNumber] = useState("")
  const [expiresOn, setExpiresOn] = useState("")
  const [permitFile, setPermitFile] = useState("")
  const [plansFile, setPlansFile] = useState("")
  const [note, setNote] = useState("")
  const fileName = (id: string | null) => (id ? data.files.find((file) => file.id === id)?.name ?? "File on this home" : "—")

  if (application.decision) {
    const canRevise = data.canWrite && !application.supersededAt && (application.decision === "approved" || application.decision === "not_required")
    return (
      <Band title="Decision" aside={canRevise ? <Button size="sm" variant="outline" className="h-7 rounded-none px-2 text-xs" onClick={onRevise}>Open a revision</Button> : null}>
        <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Decision</dt><dd className="capitalize">{application.decision.replace("_", " ")} · {formatDay(application.decidedOn)}</dd>
          {application.permitNumber ? <><dt className="text-muted-foreground">Permit number</dt><dd className="tabular-nums">{application.permitNumber}</dd></> : null}
          {application.expiresOn ? <><dt className="text-muted-foreground">Expires</dt><dd className={application.stage === "expired" ? "text-destructive" : ""}>{formatDay(application.expiresOn)}</dd></> : null}
          {application.issuedPermitFileId ? <><dt className="text-muted-foreground">{application.decision === "not_required" ? "Authority letter" : "Issued permit"}</dt><dd>{fileName(application.issuedPermitFileId)}</dd></> : null}
          {application.approvedPlansFileId ? <><dt className="text-muted-foreground">Approved plans</dt><dd>{fileName(application.approvedPlansFileId)}</dd></> : null}
          {application.decisionNote ? <><dt className="text-muted-foreground">Note</dt><dd>{application.decisionNote}</dd></> : null}
        </dl>
        {application.supersededAt ? <p className="mt-2 text-xs text-muted-foreground">Superseded by a revision on {formatDay(application.supersededAt)}.</p> : null}
      </Band>
    )
  }
  if (!editable) return <Band title="Decision"><p className="text-xs text-muted-foreground">Waiting on the authority.</p></Band>

  const approving = decision === "approved"
  const blocked = approving && application.approvalBlockers.length > 0
  return (
    <Band title="Decision">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-1">
          <Label className="text-xs" htmlFor="decision">The authority</Label>
          <Select value={decision} onValueChange={(value) => setDecision(value === "not_required" || value === "denied" || value === "withdrawn" ? value : "approved")}>
            <SelectTrigger id="decision" className="h-8 rounded-none text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="approved">Approved and issued the permit</SelectItem>
              <SelectItem value="not_required">Said no permit is required</SelectItem>
              <SelectItem value="denied">Denied the application</SelectItem>
              <SelectItem value="withdrawn">Application withdrawn</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1"><Label className="text-xs" htmlFor="decided-on">On</Label><Input id="decided-on" type="date" className="h-8 rounded-none text-xs" max={data.today} value={decidedOn} onChange={(event) => setDecidedOn(event.target.value)} /></div>
        {approving ? (
          <>
            <div className="grid gap-1"><Label className="text-xs" htmlFor="permit-number">Permit number</Label><Input id="permit-number" className="h-8 rounded-none text-xs" value={permitNumber} onChange={(event) => setPermitNumber(event.target.value)} /></div>
            <div className="grid gap-1"><Label className="text-xs" htmlFor="permit-expires">Expires</Label><Input id="permit-expires" type="date" className="h-8 rounded-none text-xs" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} /></div>
            <div className="grid gap-1"><Label className="text-xs" htmlFor="permit-file">Issued permit</Label><FilePicker id="permit-file" files={data.files} value={permitFile} onChange={setPermitFile} /></div>
            <div className="grid gap-1"><Label className="text-xs" htmlFor="plans-file">Approved plan set</Label><FilePicker id="plans-file" files={data.files} value={plansFile} onChange={setPlansFile} /></div>
          </>
        ) : decision === "not_required" ? (
          <div className="grid gap-1 sm:col-span-2"><Label className="text-xs" htmlFor="letter-file">The authority&apos;s letter</Label><FilePicker id="letter-file" files={data.files} value={permitFile} onChange={setPermitFile} /></div>
        ) : null}
        <Textarea className="rounded-none text-xs sm:col-span-2" rows={2} placeholder={approving ? "Note" : decision === "not_required" ? "Why no permit is required (10+ characters)" : "Why"} value={note} onChange={(event) => setNote(event.target.value)} />
      </div>
      {blocked ? (
        <ul className="mt-2 space-y-0.5 text-xs text-warning">
          {application.approvalBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
        </ul>
      ) : null}
      <div className="mt-2 flex justify-end">
        <Button size="sm" className="rounded-none" variant={approving || decision === "not_required" ? "default" : "destructive"}
          disabled={pending || blocked || (approving && (!permitNumber.trim() || !permitFile || !plansFile)) || (decision === "not_required" && (!permitFile || note.trim().length < 10))}
          onClick={() => act(() => recordPermitDecisionAction(data.projectId, {
            applicationId: application.id, decision, decidedOn, permitNumber: permitNumber || null, expiresOn: expiresOn || null,
            issuedPermitFileId: permitFile || null, approvedPlansFileId: plansFile || null, note: note || null,
          }), "Decision recorded")}>
          Record decision
        </Button>
      </div>
    </Band>
  )
}

function FeesBand({ data, application, pending, act }: Omit<BandProps, "editable">) {
  const canAssess = data.canWrite && !application.supersededAt
  const [assessing, setAssessing] = useState(false)
  const [kind, setKind] = useState<PermitFeeKind>("permit")
  const [amount, setAmount] = useState("")
  const [dueBefore, setDueBefore] = useState<PermitFeeDue | typeof NONE>("issuance")
  const [assessedOn, setAssessedOn] = useState(data.today)
  const [description, setDescription] = useState("")
  const [costCodeId, setCostCodeId] = useState("")
  const [paying, setPaying] = useState<{ feeId: string; via: "bill" | "expense" | "link" } | null>(null)
  const [voiding, setVoiding] = useState<string | null>(null)
  const totals = application.feeTotals
  const cents = parseDollars(amount)

  return (
    <Band title="Fees" aside={canAssess ? <Button size="sm" variant="outline" className="h-7 rounded-none px-2 text-xs" onClick={() => setAssessing((value) => !value)}>{assessing ? "Cancel" : "Assess a fee"}</Button> : null}>
      {assessing ? (
        <div className="mb-3 grid gap-2 border bg-muted/30 p-3 sm:grid-cols-2">
          <Select value={kind} onValueChange={(value) => setKind(PERMIT_FEE_KINDS.find((option) => option === value) ?? "other")}>
            <SelectTrigger className="h-8 rounded-none text-xs" aria-label="Fee"><SelectValue /></SelectTrigger>
            <SelectContent>{PERMIT_FEE_KINDS.map((option) => <SelectItem key={option} value={option}>{PERMIT_FEE_KIND_LABELS[option]}</SelectItem>)}</SelectContent>
          </Select>
          <Input className="h-8 rounded-none text-right text-xs tabular-nums" inputMode="decimal" placeholder="$0.00" aria-label="Amount" value={amount} onChange={(event) => setAmount(event.target.value)} />
          <Select value={dueBefore} onValueChange={(value) => setDueBefore(PERMIT_FEE_DUE.find((option) => option === value) ?? NONE)}>
            <SelectTrigger className="h-8 rounded-none text-xs" aria-label="Due"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No deadline</SelectItem>
              {PERMIT_FEE_DUE.map((option) => <SelectItem key={option} value={option}>{PERMIT_FEE_DUE_LABELS[option]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input type="date" className="h-8 rounded-none text-xs" aria-label="Assessed on" max={data.today} value={assessedOn} onChange={(event) => setAssessedOn(event.target.value)} />
          <Select value={costCodeId || NONE} onValueChange={(value) => setCostCodeId(value === NONE ? "" : value)}>
            <SelectTrigger className="h-8 rounded-none text-xs" aria-label="Cost code"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No cost code</SelectItem>
              <CostCodeSelectItems costCodes={data.costCodes} />
            </SelectContent>
          </Select>
          <Input className="h-8 rounded-none text-xs" placeholder="Description" value={description} onChange={(event) => setDescription(event.target.value)} />
          <Button size="sm" className="rounded-none sm:col-span-2 sm:justify-self-end" disabled={pending || !cents}
            onClick={() => act(() => assessPermitFeeAction(data.projectId, {
              applicationId: application.id, kind, amountCents: cents, assessedOn, dueBefore: dueBefore === NONE ? null : dueBefore, description: description || null,
              costCodeId: costCodeId || null,
            }), "Fee assessed", () => { setAssessing(false); setAmount(""); setDescription(""); setCostCodeId("") })}>
            Assess
          </Button>
        </div>
      ) : null}
      {application.fees.length === 0 ? <p className="text-xs text-muted-foreground">No fees assessed.</p> : (
        <>
          <table className="w-full text-xs">
            <thead><tr className="border-b text-muted-foreground"><th className="py-1.5 text-left font-medium">Fee</th><th className="py-1.5 text-left font-medium">Due</th><th className="py-1.5 text-right font-medium">Obligated</th><th className="py-1.5 text-right font-medium">Paid</th><th className="py-1.5 text-right font-medium">Owed</th><th className="py-1.5" aria-label="Actions" /></tr></thead>
            <tbody>
              {application.fees.map((fee) => (
                <tr key={fee.id} className={cn("border-b align-top last:border-b-0", fee.status === "void" && "text-muted-foreground line-through")}>
                  <td className="py-1.5">
                    <p className="font-medium">{fee.kindLabel}</p>
                    {fee.description ? <p className="text-muted-foreground">{fee.description}</p> : null}
                    {fee.costCodeLabel ? <p className="text-muted-foreground">{fee.costCodeLabel}</p> : null}
                    {fee.payments.map((payment) => <p key={payment.id} className="text-muted-foreground no-underline">{payment.label} · {payment.status} · {formatMoneyCentsExact(payment.totalCents)}</p>)}
                    {fee.status === "void" ? <p className="no-underline">Void: {fee.voidReason}</p> : null}
                  </td>
                  <td className="py-1.5 text-muted-foreground">{fee.dueBefore ? PERMIT_FEE_DUE_LABELS[fee.dueBefore] : "—"}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatMoneyCentsExact(fee.amountCents)}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatMoneyCentsExact(fee.paidCents)}</td>
                  <td className={cn("py-1.5 text-right tabular-nums", fee.status === "open" && (fee.reconciled ? "text-success" : fee.varianceCents < 0 ? "text-destructive" : "text-warning"))}>
                    {fee.status === "void" ? "—" : fee.reconciled ? "Paid" : formatMoneyCentsExact(fee.varianceCents)}
                  </td>
                  <td className="py-1.5 text-right">
                    {fee.status === "open" && fee.remainingToLinkCents > 0 ? (
                      <Select value="" onValueChange={(value) => setPaying({ feeId: fee.id, via: value === "bill" ? "bill" : value === "expense" ? "expense" : "link" })}>
                        <SelectTrigger className="ml-auto h-7 w-24 rounded-none text-xs" aria-label={`Pay ${fee.kindLabel}`}><SelectValue placeholder="Pay" /></SelectTrigger>
                        <SelectContent>
                          {data.canPayByBill ? <SelectItem value="bill">Pay by bill</SelectItem> : null}
                          {data.canPayByBill ? <SelectItem value="expense">Record counter payment</SelectItem> : null}
                          {data.canWrite || data.canPayByBill ? <SelectItem value="link">Link an existing payable</SelectItem> : null}
                        </SelectContent>
                      </Select>
                    ) : null}
                    {canAssess && fee.status === "open" && fee.linkedCents === 0 ? (
                      <Button size="sm" variant="ghost" className="mt-1 h-7 rounded-none px-2 text-xs" onClick={() => setVoiding(voiding === fee.id ? null : fee.id)}>Void</Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t font-medium">
                <td className="py-1.5" colSpan={2}>
                  {totals.reconciled ? <span className="text-success">Reconciled</span> : <span className="text-muted-foreground">Not reconciled</span>}
                </td>
                <td className="py-1.5 text-right tabular-nums">{formatMoneyCentsExact(totals.obligatedCents)}</td>
                <td className="py-1.5 text-right tabular-nums">{formatMoneyCentsExact(totals.paidCents)}</td>
                <td className={cn("py-1.5 text-right tabular-nums", totals.varianceCents > 0 ? "text-warning" : totals.varianceCents < 0 ? "text-destructive" : "text-success")}>{formatMoneyCentsExact(totals.varianceCents)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
          {voiding ? <VoidFeeForm projectId={data.projectId} feeId={voiding} pending={pending} act={act} onDone={() => setVoiding(null)} /> : null}
          {paying ? <PayFeeForm data={data} application={application} paying={paying} pending={pending} act={act} onDone={() => setPaying(null)} /> : null}
        </>
      )}
    </Band>
  )
}

function VoidFeeForm({ projectId, feeId, pending, act, onDone }: { projectId: string; feeId: string; pending: boolean; act: Act; onDone: () => void }) {
  const [reason, setReason] = useState("")
  return (
    <div className="mt-2 flex gap-2 border bg-muted/30 p-3">
      <Input className="h-8 rounded-none text-xs" placeholder="Why this fee is void (it stays on the record)" value={reason} onChange={(event) => setReason(event.target.value)} />
      <Button size="sm" variant="destructive" className="h-8 rounded-none" disabled={pending || reason.trim().length < 10}
        onClick={() => act(() => voidPermitFeeAction(projectId, { feeId, reason }), "Fee voided", onDone)}>Void fee</Button>
    </div>
  )
}

function PayFeeForm({ data, application, paying, pending, act, onDone }: {
  data: ProjectPermitsDTO
  application: PermitApplicationDTO
  paying: { feeId: string; via: "bill" | "expense" | "link" }
  pending: boolean
  act: Act
  onDone: () => void
}) {
  const [billNumber, setBillNumber] = useState("")
  const [date, setDate] = useState(data.today)
  const [method, setMethod] = useState("check")
  const [receipt, setReceipt] = useState("")
  const [payable, setPayable] = useState("")
  const fee = application.fees.find((row) => row.id === paying.feeId)
  if (!fee) return null
  const candidates = data.linkablePayables.filter((row) => row.companyId === application.jurisdiction.id && row.totalCents <= fee.remainingToLinkCents)
  return (
    <div className="mt-2 grid gap-2 border bg-muted/30 p-3 sm:grid-cols-2">
      <p className="text-xs sm:col-span-2">
        {paying.via === "bill" ? "A bill from the authority enters payables for approval and payment" : paying.via === "expense" ? "A payment already made at the counter, with its receipt" : "A payable already entered for this authority on this home"}
        {" — "}<span className="tabular-nums">{formatMoneyCentsExact(fee.remainingToLinkCents)}</span> remains on the {fee.kindLabel.toLowerCase()} fee.
      </p>
      {paying.via === "bill" ? (
        <>
          <Input className="h-8 rounded-none text-xs" placeholder="Authority's invoice number" aria-label="Invoice number" value={billNumber} onChange={(event) => setBillNumber(event.target.value)} />
          <Input type="date" className="h-8 rounded-none text-xs" aria-label="Invoice date" value={date} onChange={(event) => setDate(event.target.value)} />
        </>
      ) : paying.via === "expense" ? (
        <>
          <Input type="date" className="h-8 rounded-none text-xs" aria-label="Paid on" max={data.today} value={date} onChange={(event) => setDate(event.target.value)} />
          <Select value={method} onValueChange={setMethod}>
            <SelectTrigger className="h-8 rounded-none text-xs" aria-label="Paid by"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="check">Check</SelectItem>
              <SelectItem value="credit_card">Credit card</SelectItem>
              <SelectItem value="company_card">Company card</SelectItem>
              <SelectItem value="ach">ACH</SelectItem>
              <SelectItem value="cash">Cash</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
          <div className="sm:col-span-2"><FilePicker id="fee-receipt" files={data.files} value={receipt} onChange={setReceipt} placeholder="Receipt on this home" /></div>
        </>
      ) : candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground sm:col-span-2">No unlinked bill or expense to {application.jurisdiction.name} on this home fits what remains.</p>
      ) : (
        <div className="sm:col-span-2">
          <Select value={payable || NONE} onValueChange={(value) => setPayable(value === NONE ? "" : value)}>
            <SelectTrigger className="h-8 rounded-none text-xs" aria-label="Payable"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Choose a payable</SelectItem>
              {candidates.map((row) => <SelectItem key={row.id} value={row.id}>{row.label} · {row.status} · {formatMoneyCentsExact(row.totalCents)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button size="sm" variant="outline" className="rounded-none" onClick={onDone}>Cancel</Button>
        <Button size="sm" className="rounded-none"
          disabled={pending || (paying.via === "bill" && !billNumber.trim()) || (paying.via === "expense" && !receipt) || (paying.via === "link" && !payable)}
          onClick={() => {
            if (paying.via === "link") {
              const chosen = candidates.find((row) => row.id === payable)
              act(() => linkPermitFeePaymentAction(data.projectId, { feeId: fee.id, vendorBillId: chosen?.kind === "bill" ? chosen.id : null, projectExpenseId: chosen?.kind === "expense" ? chosen.id : null }), "Payable linked", onDone)
            } else if (paying.via === "bill") {
              act(() => payPermitFeeAction(data.projectId, { via: "bill", feeId: fee.id, billNumber, billDate: date }), "Bill entered and linked", onDone)
            } else {
              act(() => payPermitFeeAction(data.projectId, { via: "expense", feeId: fee.id, paidOn: date, paymentMethod: method, receiptFileId: receipt }), "Counter payment recorded", onDone)
            }
          }}>
          {paying.via === "link" ? "Link" : paying.via === "bill" ? "Enter bill" : "Record payment"}
        </Button>
      </div>
    </div>
  )
}
