"use client"

import { useState, useTransition } from "react"
import { getPoExceptionCandidatesAction, resolvePoExceptionAction } from "@/app/(app)/purchasing/actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import type { PriceAgreement } from "@/lib/services/price-book"
import { toast } from "sonner"

const money = (cents: number | null | undefined) => cents == null ? "Not priced" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)

export function AgreementChoiceDialog({ exceptionId, description }: { exceptionId: string; description: string }) {
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<{ items: PriceAgreement[]; page: number; pages: number } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function load(page: number) {
    setSelected(null)
    setError(null)
    startTransition(async () => {
      try {
        const response = await getPoExceptionCandidatesAction({ exceptionId, page })
        if (!response.success) { setError(response.error); setResult(null); return }
        setResult(response.data)
      } catch { setError("Unable to load agreements. Try again."); setResult(null) }
    })
  }

  function resolve() {
    if (!selected) return
    setError(null)
    startTransition(async () => {
      try {
        const response = await resolvePoExceptionAction(exceptionId, { kind: "agreement", agreement_id: selected })
        if (!response.success) { setError(response.error); return }
        toast.success("Exception resolved and affected purchase orders regenerated")
        setOpen(false)
      } catch { setError("Unable to confirm the resolution. Refresh the queue before retrying.") }
    })
  }

  return <Dialog open={open} onOpenChange={(next) => { if (pending) return; setOpen(next); if (next) { setResult(null); load(1) } }}>
    <DialogTrigger asChild><Button size="sm" variant="ghost">Review agreements</Button></DialogTrigger>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>Choose a price agreement</DialogTitle><DialogDescription>{description}. Compare vendors, price, scope, and effective dates before resolving.</DialogDescription></DialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {pending && !result && <div role="status" className="space-y-2" aria-label="Loading agreements">{[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse bg-muted" />)}</div>}
      <fieldset disabled={pending} className="space-y-2"><legend className="sr-only">Price agreements</legend>
        {result?.items.map((agreement) => <label key={agreement.id} className="flex cursor-pointer items-start gap-3 border p-3 text-sm hover:bg-muted">
          <input type="radio" name={`agreement-${exceptionId}`} checked={selected === agreement.id} onChange={() => setSelected(agreement.id)} disabled={agreement.status !== "active"} className="mt-1 accent-primary" />
          <span className="min-w-0 flex-1"><span className="block font-medium">{agreement.company_name} · {money(agreement.pricing_kind === "unit" ? agreement.unit_cost_cents : agreement.lump_sum_cents)}{agreement.pricing_kind === "unit" ? ` / ${agreement.uom}` : " lump sum"}</span>
            <span className="block text-xs text-muted-foreground">{[agreement.division_name, agreement.community_name, agreement.house_plan_name].filter(Boolean).join(" / ") || "Organization-wide"} · {agreement.status}</span>
            <span className="block text-xs text-muted-foreground">{agreement.effective_from} – {agreement.effective_to ?? "No end date"}</span>
            {agreement.scope_of_work && <span className="mt-1 block whitespace-pre-wrap">{agreement.scope_of_work}</span>}
          </span>
        </label>)}
      </fieldset>
      {result?.items.length === 0 && <p className="text-sm text-muted-foreground">No accessible agreements on this page. Refresh pricing or resolve with a manual price.</p>}
      {result && result.pages > 1 && <nav aria-label="Candidate pages" className="flex items-center justify-between text-sm"><Button variant="outline" disabled={pending || result.page <= 1} onClick={() => load(result.page - 1)}>Previous</Button><span>Page {result.page} of {result.pages}</span><Button variant="outline" disabled={pending || result.page >= result.pages} onClick={() => load(result.page + 1)}>Next</Button></nav>}
      <div className="flex justify-end gap-2"><Button variant="outline" disabled={pending} onClick={() => load(result?.page ?? 1)}>Refresh</Button><Button disabled={pending || !selected} onClick={resolve}>{pending ? "Working…" : "Use selected agreement"}</Button></div>
    </DialogContent>
  </Dialog>
}
