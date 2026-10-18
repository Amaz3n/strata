"use client"

import { useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { Invoice, InvoiceLienWaiver } from "@/lib/types"
import { isIssuedInvoiceStatus } from "@/lib/financials/invoice-lifecycle"
import { readWaiverWorkflow } from "@/lib/lien-waivers/invoice-waiver"
import { unwrapAction } from "@/lib/action-result"
import { uploadExecutedWaiverAction } from "@/app/(app)/invoices/physical-waiver-actions"

export function PhysicalWaiverReturn({ invoice, waiver, onSaved, onChanged }: {
  invoice: Invoice; waiver: InvoiceLienWaiver;
  onSaved: (waiver: InvoiceLienWaiver) => void;
  onChanged: () => void | Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [submitted, setSubmitted] = useState(false)
  const guard = useRef(false)
  const flow = readWaiverWorkflow(waiver)
  const executed = flow?.lifecycle === "signed"
  const plan = invoice.metadata?.waiver_packet
  const pending = plan?.enabled && plan.delivery_mode === "after_physical_execution" && plan.waiver_id === waiver.id
  const otherSelected = Boolean(plan?.enabled && plan.waiver_id && plan.waiver_id !== waiver.id)
  const inactive = invoice.status === "void" || waiver.status === "void"
  const issued = isIssuedInvoiceStatus(invoice.status)
  const href = `/api/invoices/${invoice.id}/waivers/${waiver.id}`
  const editHref = invoice.project_id ? `/projects/${invoice.project_id}/financials/billing?compose=${invoice.id}` : `/billing?compose=${invoice.id}`

  async function upload() {
    if (guard.current || (!executed && (!file || !confirmed))) return
    guard.current = true
    setBusy(true)
    setError("")
    try {
      const form = new FormData()
      form.set("invoiceId", invoice.id)
      form.set("waiverId", waiver.id)
      form.set("confirmed", "true")
      // A retry reuses the already stored artifact; the server ignores this placeholder.
      form.set("file", file ?? new File([], "retry.pdf"))
      const result = unwrapAction(await uploadExecutedWaiverAction(form))
      onSaved(result)
      setSubmitted(true)
      setFile(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not upload the executed waiver")
    } finally {
      // The scan can be safely saved even when subsequent delivery fails. Reload it
      // so the next attempt retries delivery instead of requesting another upload.
      try { await onChanged() } catch { setError("Refresh the invoice to see its latest delivery status.") }
      guard.current = false
      setBusy(false)
    }
  }

  return <div className="space-y-3 pt-1">
    <p className="text-xs font-medium">{inactive ? "Waiver inactive" : executed ? "Executed waiver uploaded" : otherSelected ? "Not included in the current packet" : "Awaiting signed and notarized waiver"}</p>
    <a href={`${href}${executed ? "" : "?download=1"}`} target={executed ? "_blank" : undefined} rel="noreferrer" className="text-[11px] font-medium underline underline-offset-4">{executed ? "View executed waiver" : "Download printable waiver"}</a>
    {submitted || (executed && issued) ? <p role="status" className="text-xs text-muted-foreground">{submitted ? "Invoice and executed waiver submitted for delivery." : "Executed copy retained with this invoice."}</p> : !inactive && !issued && pending ? <>
      {!executed && <>
        <p className="text-xs leading-relaxed text-muted-foreground">Upload the complete scanned PDF after the authorized person and notary have finished signing.</p>
        <div className="space-y-1.5"><Label htmlFor={`executed-scan-${waiver.id}`} className="text-xs">Signed and notarized PDF</Label>
          <Input id={`executed-scan-${waiver.id}`} type="file" accept="application/pdf,.pdf" disabled={busy} className="text-xs" onChange={event => {setFile(event.target.files?.[0] ?? null);setConfirmed(false);setError("")}} />
        </div>
        <label className="flex items-start gap-2 text-xs leading-relaxed"><Checkbox checked={confirmed} disabled={busy} onCheckedChange={value => setConfirmed(value === true)} />I confirm the scan includes all required signatures and completed notarization, including the notary’s seal where required.</label>
      </>}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{executed ? "Retry sending the saved scan" : "Confirming sends the invoice and this scan"} to {Array.isArray(plan.recipients) ? plan.recipients.join(", ") : "the saved customer recipients"}.</p>
      <Button size="sm" className="w-full text-xs" disabled={busy || (!executed && (!file || !confirmed))} onClick={() => void upload()}>{busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}{busy ? "Submitting…" : executed ? "Retry invoice delivery" : "Mark executed and send invoice"}</Button>
    </> : !inactive && !issued && !otherSelected ? <p className="text-xs text-muted-foreground"><a href={editHref} className="underline underline-offset-4">Review invoice recipients</a> and save it as awaiting the signed waiver before uploading here.</p> : null}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>
}
