"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { parseMoneyToCents } from "@/lib/financials/money-input"
import { taxWorkpaperEvidenceSchema, totalTaxAdjustments } from "@/lib/services/books/tax-adjustment-lines"
import { loadTaxWorkpaperWorkspaceAction, prepareTaxWorkpaperAction, reviewTaxWorkpaperAction, withdrawTaxWorkpaperAction } from "@/app/(app)/books/actions"

type Workspace = Awaited<ReturnType<typeof import("@/lib/services/books/tax-adjustments").getTaxWorkpaperWorkspace>>
type DraftLine = { id: string; kind: "permanent" | "timing"; amount: string; description: string; evidence_reference: string; evidence_file_id: string | null; project_id: string | null }
const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })

export function TaxWorkpapers({ canAdjust, asOf }: { canAdjust: boolean; asOf: string }) {
  const priorYear = Number(asOf.slice(0,4)) - 1
  const [start, setStart] = useState(`${priorYear}-01-01`), [end, setEnd] = useState(`${priorYear}-12-31`)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [lines, setLines] = useState<DraftLine[]>([])
  const [replacement, setReplacement] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState<string | null>(null)
  const [preparationNotes, setPreparationNotes] = useState("")
  const [withdrawId, setWithdrawId] = useState<string | null>(null), [withdrawReason, setWithdrawReason] = useState("")
  const [reviewId, setReviewId] = useState<string | null>(null), [notes, setNotes] = useState("")
  const [pending, transition] = useTransition()
  const parsed = taxWorkpaperEvidenceSchema.safeParse({ lines: lines.map(({ amount, ...line }) => ({ ...line, amount_cents: parseMoneyToCents(amount) })), preparation_notes: preparationNotes })
  let total: number | null = null
  try { if (parsed.success) total = totalTaxAdjustments(parsed.data.lines).totalCents } catch { /* Overflow disables preparation. */ }
  function changeDates(value: string, setter: (date: string) => void) {
    setter(value); setWorkspace(null); setLines([]); setReplacement(null); setRetryKey(null); setReviewId(null); setNotes(""); setWithdrawId(null); setWithdrawReason(""); setPreparationNotes("")
  }
  async function reload() {
    const result = await loadTaxWorkpaperWorkspaceAction(start, end)
    if (!result.success) { setWorkspace(null); toast.error(result.error); return }
    setWorkspace(result.data)
  }
  function updateLine(id: string, patch: Partial<DraftLine>) {
    setLines(previous => previous.map(line => line.id === id ? { ...line, ...patch } : line)); setRetryKey(null)
  }
  return <section className="space-y-4 rounded-lg border p-4">
    <div><h3 className="font-semibold">Tax adjustment workpapers</h3><p className="text-sm text-muted-foreground">Bridge cash book income to reviewed tax adjustments. Positive amounts increase income; negative amounts reduce it. These workpapers do not post to the ledger or determine tax elections.</p></div>
    <div className="flex flex-wrap items-end gap-3">
      <div><Label htmlFor="tax-workpaper-start">Period start</Label><Input id="tax-workpaper-start" type="date" value={start} disabled={pending} onChange={event => changeDates(event.target.value,setStart)} /></div>
      <div><Label htmlFor="tax-workpaper-end">Period end</Label><Input id="tax-workpaper-end" type="date" value={end} disabled={pending} onChange={event => changeDates(event.target.value,setEnd)} /></div>
      <Button variant="outline" disabled={pending || !start || !end || start > end} onClick={() => transition(reload)}>{pending ? "Loading…" : "Load period"}</Button>
    </div>
    {workspace && <>
      <p className="text-sm">Cash book income: <strong>{money(workspace.bookIncomeCents)}</strong></p>
      {workspace.workpapers.length === 0 && <p className="text-sm text-muted-foreground">No workpapers for these exact dates.</p>}
      {workspace.workpapers.map(batch => <article key={batch.id} className="space-y-2 rounded-md border p-3">
        <p className="text-sm font-medium">{batch.status} · Adjustments {money(batch.totalCents)} · Prepared by {batch.prepared_by}</p>
        {!batch.current && <p role="alert" className="text-sm text-destructive">Books changed since preparation. Prepare a replacement before publishing this period.</p>}
        <details><summary className="cursor-pointer text-sm">Adjustment evidence</summary><div className="space-y-2 pt-2">{batch.lines.map(line => <div key={line.id} className="text-sm"><p>{line.kind}: {money(line.amount_cents)} · {line.description}</p><p className="whitespace-pre-wrap text-muted-foreground">{line.evidence_reference}</p>{line.evidence_snapshot && <a className="mr-3 underline" href={`/api/books/tax-workpapers/${batch.id}/attachments/${line.id}`}>Download original attachment: {line.evidence_snapshot.file_name}</a>}{line.evidence_file_id && !line.evidence_snapshot && <p className="text-destructive">Original attachment identity is unavailable. Prepare a replacement to retain its evidence.</p>}{line.project_id && <Link className="underline" href={`/projects/${line.project_id}/financials/budget`}>Project workflow</Link>}</div>)}{batch.preparation_notes && <p className="whitespace-pre-wrap text-sm">Preparation: {batch.preparation_notes}</p>}{batch.close_reason && <p className="whitespace-pre-wrap text-sm">Closure: {batch.close_reason}</p>}{batch.review_notes && <p className="whitespace-pre-wrap text-sm">Review: {batch.review_notes}</p>}</div></details>
        {batch.status === "approved" && batch.current && <Button asChild variant="outline" size="sm"><Link href={`/reports/books-tax-workpaper?period=custom&_from=${start}&_to=${end}`}>Open reviewed report</Link></Button>}
        {canAdjust && batch.status === "approved" && <Button variant="outline" size="sm" disabled={pending} onClick={() => { setReplacement(batch.id); setPreparationNotes(batch.preparation_notes); setRetryKey(null); setLines(batch.lines.map(line => ({ ...line, id: crypto.randomUUID(), amount: String(line.amount_cents / 100) }))) }}>Prepare replacement</Button>}
        {canAdjust && batch.status === "draft" && batch.current && batch.prepared_by !== workspace.userId && <Button variant="outline" size="sm" disabled={pending} onClick={() => { setReviewId(batch.id); setNotes("") }}>Review this draft</Button>}
        {canAdjust && batch.status === "draft" && <Button variant="outline" size="sm" disabled={pending} onClick={() => { setWithdrawId(batch.id); setWithdrawReason("") }}>Withdraw draft</Button>}
        {batch.status === "draft" && batch.prepared_by === workspace.userId && <p className="text-sm text-muted-foreground">Another authorized accountant must review your draft.</p>}
      </article>)}
      {withdrawId && <div className="space-y-2 rounded-md border p-3"><Label htmlFor="tax-withdraw-reason">Draft withdrawal reason</Label><Textarea id="tax-withdraw-reason" value={withdrawReason} maxLength={2000} disabled={pending} onChange={event => setWithdrawReason(event.target.value)} placeholder="Explain why this unfinished draft should be withdrawn. Its evidence remains in history." /><Button disabled={pending || withdrawReason.trim().length < 10} onClick={() => transition(async () => {
        const result = await withdrawTaxWorkpaperAction({ id: withdrawId, reason: withdrawReason })
        if (!result.success) { toast.error(result.error); return }
        setWithdrawId(null); setWithdrawReason(""); toast.success("Draft withdrawn; history retained"); await reload()
      })}>Withdraw with reason</Button><Button variant="ghost" disabled={pending} onClick={() => setWithdrawId(null)}>Cancel</Button></div>}
      {reviewId && <div className="space-y-2 rounded-md border p-3"><Label htmlFor="tax-review-notes">Review explanation</Label><Textarea id="tax-review-notes" value={notes} maxLength={2000} disabled={pending} onChange={event => setNotes(event.target.value)} placeholder="Explain how you checked the source basis, adjustments and supporting evidence." /><Button disabled={pending || notes.trim().length < 10} onClick={() => transition(async () => {
        const result = await reviewTaxWorkpaperAction({ id: reviewId, notes })
        if (!result.success) { toast.error(result.error); return }
        setReviewId(null); setNotes(""); toast.success("Tax workpaper approved"); await reload()
      })}>Approve reviewed workpaper</Button></div>}
      {canAdjust && <div className="space-y-3 border-t pt-4">
        <p className="text-sm font-medium">{replacement ? "Prepare replacement (original approval remains until review)" : "Prepare adjustments"}</p>
        <div className="space-y-2"><Label htmlFor="tax-preparation-notes">Preparation evidence {lines.length === 0 ? "(required for no adjustments)" : "(optional)"}</Label><Textarea id="tax-preparation-notes" disabled={pending} value={preparationNotes} maxLength={2000} onChange={event => { setPreparationNotes(event.target.value); setRetryKey(null) }} placeholder="Explain the tax differences reviewed and cite the calculation supporting no adjustments, if none are needed." /></div>
        {lines.map((line,index) => <fieldset key={line.id} disabled={pending} className="space-y-2 rounded-md border p-3"><legend className="px-1 text-sm">Adjustment {index + 1}</legend>
          <div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor={`tax-kind-${line.id}`}>Difference type</Label><select id={`tax-kind-${line.id}`} className="w-full rounded-md border bg-background p-2" value={line.kind} onChange={event => updateLine(line.id,{ kind: event.target.value as DraftLine["kind"] })}><option value="permanent">Permanent</option><option value="timing">Timing</option></select></div><div><Label htmlFor={`tax-amount-${line.id}`}>Signed adjustment ($)</Label><Input id={`tax-amount-${line.id}`} inputMode="decimal" value={line.amount} onChange={event => updateLine(line.id,{ amount:event.target.value })} /></div></div>
          <Label htmlFor={`tax-description-${line.id}`}>Reason for adjustment</Label><Textarea id={`tax-description-${line.id}`} maxLength={2000} value={line.description} onChange={event => updateLine(line.id,{ description:event.target.value })} />
          <Label htmlFor={`tax-evidence-${line.id}`}>Supporting evidence reference</Label><Textarea id={`tax-evidence-${line.id}`} maxLength={2000} value={line.evidence_reference} onChange={event => updateLine(line.id,{ evidence_reference:event.target.value })} placeholder="Cite the source document, calculation or accountant workpaper." />
          <Label htmlFor={`tax-file-${line.id}`}>Supporting document (optional)</Label><select id={`tax-file-${line.id}`} className="w-full rounded-md border bg-background p-2" value={line.evidence_file_id ?? ""} onChange={event => updateLine(line.id,{ evidence_file_id: event.target.value || null })}><option value="">Reference only</option>{workspace.attachmentOptions.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}</select>
          <p className="text-xs text-muted-foreground">Preparation captures the selected document’s current version and verifies its bytes. Later document changes do not replace the reviewed evidence.</p>
          <Button size="sm" variant="outline" onClick={() => { setLines(previous => previous.filter(item => item.id !== line.id)); setRetryKey(null) }}>Remove adjustment</Button>
        </fieldset>)}
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={pending || lines.length >= 500} onClick={() => { setLines(previous => [...previous,{ id:crypto.randomUUID(),kind:"permanent",amount:"",description:"",evidence_reference:"",evidence_file_id:null,project_id:null }]); setRetryKey(null) }}>Add adjustment</Button>
          {replacement && <Button variant="ghost" disabled={pending} onClick={() => { setReplacement(null); setLines([]); setPreparationNotes(""); setRetryKey(null) }}>Cancel replacement</Button>}
          <Button disabled={pending || !parsed.success || total === null} onClick={() => transition(async () => {
            if (!parsed.success) return
            const key = retryKey ?? crypto.randomUUID(); setRetryKey(key)
            const result = await prepareTaxWorkpaperAction({ startDate:start,endDate:end,lines:parsed.data.lines,preparationNotes:parsed.data.preparation_notes,idempotencyKey:key,supersedesId:replacement })
            if (!result.success) { toast.error(result.error); return }
            setLines([]); setPreparationNotes(""); setReplacement(null); setRetryKey(null); toast.success("Draft prepared for independent review"); await reload()
          })}>{lines.length === 0 ? "Prepare no-adjustments confirmation" : "Prepare immutable draft"}</Button></div>
        {total !== null && <p className="text-sm">Total adjustments: {money(total)}</p>}
      </div>}
    </>}
  </section>
}
