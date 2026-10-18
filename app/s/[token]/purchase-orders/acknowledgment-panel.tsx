"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CheckCircle2, MessageSquareWarning } from "lucide-react"

import { acknowledgePurchaseOrderAction } from "./actions"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { PortalPurchaseOrder } from "@/lib/services/portal-purchase-orders"
import type { PoAcknowledgmentLineInput } from "@/lib/validation/po-acknowledgments"

type Kind = "quantity" | "date" | "scope"
type Draft = { checked: boolean; kind: Kind; value: string }

const fieldClass = "h-8 border bg-background px-2 text-sm"
const KIND_LABELS: Record<Kind, string> = { quantity: "Quantity", date: "Date", scope: "Scope" }

function tone(state: NonNullable<PortalPurchaseOrder["issue"]>["state"]) {
  if (state === "disputed") return "border-destructive/40 bg-destructive/5"
  if (state === "pending" || state === "revised") return "border-warning/40 bg-warning/5"
  if (state === "accepted") return "border-success/40 bg-success/5"
  return "bg-muted/20"
}

/**
 * The vendor's answer to the version of a purchase order it is held to: accept
 * (optionally promising a date per line) or dispute lines by quantity, date or
 * scope with a reason. The answer is bound to the version shown, so a revision
 * that lands while the form is open is refused and the page reloads.
 */
export function AcknowledgmentPanel({ token, order, canAcknowledge }: { token: string; order: PortalPurchaseOrder; canAcknowledge: boolean }) {
  const issue = order.issue
  const router = useRouter()
  const [mode, setMode] = useState<"accept" | "dispute" | null>(null)
  const [reason, setReason] = useState("")
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [pending, startTransition] = useTransition()
  if (!issue) return null

  const open = issue.state === "pending" || issue.state === "revised"
  const draftFor = (lineId: string): Draft => drafts[lineId] ?? { checked: false, kind: "quantity", value: "" }
  const setDraft = (lineId: string, patch: Partial<Draft>) => setDrafts((current) => ({ ...current, [lineId]: { ...draftFor(lineId), ...patch } }))
  const close = () => { setMode(null); setReason(""); setDrafts({}) }

  const submit = (response: "accepted" | "disputed") => {
    const lines = order.lines.flatMap((line): PoAcknowledgmentLineInput[] => {
      const draft = draftFor(line.id)
      if (response === "accepted") return draft.value ? [{ commitmentLineId: line.id, kind: "date" as const, promisedDate: draft.value }] : []
      if (!draft.checked) return []
      if (draft.kind === "quantity") return [{ commitmentLineId: line.id, kind: "quantity" as const, proposedQuantity: Number(draft.value) }]
      if (draft.kind === "date") return [{ commitmentLineId: line.id, kind: "date" as const, promisedDate: draft.value }]
      return [{ commitmentLineId: line.id, kind: "scope" as const, note: draft.value }]
    })
    startTransition(async () => {
      const result = await acknowledgePurchaseOrderAction(token, {
        commitmentId: order.id, issueVersionId: issue.versionId, termsHash: issue.termsHash, response,
        reason: response === "disputed" ? reason : undefined, lines,
      })
      if (result.success) {
        toast.success(response === "accepted" ? "Purchase order accepted" : "Dispute sent to the builder")
        close()
      } else toast.error(result.error)
      router.refresh()
    })
  }

  return <div className={`mt-3 border p-3 text-sm ${tone(issue.state)}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="font-medium">Revision {issue.revision} · {issue.sentence}</div>
        <div className="text-xs text-muted-foreground">Issued {new Date(issue.issuedAt).toLocaleDateString()}</div>
      </div>
      {canAcknowledge && mode === null && <div className="flex gap-2">
        <Button size="sm" variant={open ? "default" : "outline"} onClick={() => setMode("accept")}><CheckCircle2 /> {open ? "Accept" : "Change answer"}</Button>
        <Button size="sm" variant="outline" onClick={() => setMode("dispute")}><MessageSquareWarning /> Dispute</Button>
      </div>}
    </div>
    {issue.changes.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">{issue.changes.map((change) => <li key={change}>{change}</li>)}</ul>}
    {issue.answer && <div className="mt-2 border-t pt-2 text-xs">
      <div className="font-medium capitalize">Your answer: {issue.answer.response}{issue.answer.status === "resolved" ? ` · builder ${issue.answer.resolution === "upheld" ? "kept the terms" : "closed the dispute"}` : ""}</div>
      {issue.answer.reason && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{issue.answer.reason}</p>}
      {issue.answer.resolutionNote && <p className="mt-1 whitespace-pre-wrap">Builder: {issue.answer.resolutionNote}</p>}
    </div>}

    {mode === "accept" && <form className="mt-3 space-y-3 border-t pt-3" onSubmit={(event) => { event.preventDefault(); submit("accepted") }}>
      <p className="text-xs text-muted-foreground">Optionally promise a delivery or completion date for a line.</p>
      <div className="divide-y border-y">{order.lines.map((line) => <label key={line.id} className="flex items-center justify-between gap-3 py-1.5">
        <span>{line.description} <span className="text-muted-foreground">({line.quantity} {line.unit || "ea"})</span></span>
        <input aria-label={`Promised date for ${line.description}`} type="date" className={fieldClass} value={draftFor(line.id).value} onChange={(event) => setDraft(line.id, { value: event.target.value })} />
      </label>)}</div>
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={close}>Cancel</Button><Button disabled={pending}>Accept purchase order</Button></div>
    </form>}

    {mode === "dispute" && <form className="mt-3 space-y-3 border-t pt-3" onSubmit={(event) => { event.preventDefault(); submit("disputed") }}>
      <label className="grid gap-1"><span className="font-medium">What is wrong</span>
        <Textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Tell the builder why" required minLength={3} />
      </label>
      <fieldset><legend className="mb-1 font-medium">Lines you dispute</legend>
        <div className="divide-y border-y">{order.lines.map((line) => {
          const draft = draftFor(line.id)
          return <div key={line.id} className="flex flex-wrap items-center gap-2 py-1.5">
            <label className="flex min-w-48 flex-1 items-center gap-2"><input type="checkbox" checked={draft.checked} onChange={(event) => setDraft(line.id, { checked: event.target.checked })} />
              <span>{line.description} <span className="text-muted-foreground">({line.quantity} {line.unit || "ea"})</span></span></label>
            {draft.checked && <>
              <select aria-label="What you dispute" className={fieldClass} value={draft.kind} onChange={(event) => setDraft(line.id, { kind: event.target.value as Kind, value: "" })}>
                {(Object.keys(KIND_LABELS) as Kind[]).map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
              </select>
              {draft.kind === "quantity" && <input aria-label="Quantity you can supply" type="number" min="0" step="any" className={`${fieldClass} w-28`} placeholder="Quantity" value={draft.value} onChange={(event) => setDraft(line.id, { value: event.target.value })} required />}
              {draft.kind === "date" && <input aria-label="Date you can meet" type="date" className={fieldClass} value={draft.value} onChange={(event) => setDraft(line.id, { value: event.target.value })} required />}
              {draft.kind === "scope" && <input aria-label="Scope concern" className={`${fieldClass} min-w-48 flex-1`} placeholder="What is wrong with the scope" minLength={3} value={draft.value} onChange={(event) => setDraft(line.id, { value: event.target.value })} required />}
            </>}
          </div>
        })}</div>
      </fieldset>
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={close}>Cancel</Button><Button disabled={pending || !order.lines.some((line) => draftFor(line.id).checked)}>Send dispute</Button></div>
    </form>}
  </div>
}
