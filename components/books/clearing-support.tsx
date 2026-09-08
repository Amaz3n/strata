"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { loadClearingSupportAction, saveClearingSupportAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"

type Workspace = Awaited<ReturnType<typeof import("@/lib/services/books/clearing-support").getClearingSupportWorkspace>>
const names: Record<string, string> = { "1010": "Undeposited receipts", "2200": "Payroll payable", "2220": "Employee reimbursements", "2230": "Payroll deductions payable" }
export function ClearingSupport({ periodId }: { periodId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [evidence, setEvidence] = useState<Record<string, { expectedSettlementDate: string; explanation: string; evidenceUrl: string }>>({})
  const [pending, startTransition] = useTransition()
  const load = () => startTransition(async () => {
    const result = await loadClearingSupportAction(periodId)
    if (!result.success) { toast.error(result.error); return }
    setWorkspace(result.data); setEvidence({}); setOpen(true)
  })
  return <><Button size="sm" variant="outline" disabled={pending} onClick={load}>Review clearing balances</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Support balances awaiting settlement</DialogTitle><DialogDescription>Attach a schedule explaining each balance and its expected settlement. New ledger activity requires another review.</DialogDescription></DialogHeader>
      {workspace?.balances.length === 0 && <p className="text-sm">All clearing accounts have zero balances.</p>}
      {workspace?.balances.map(balance => <fieldset key={balance.code} className="space-y-3 border p-3"><legend className="px-1 text-sm font-medium">{names[balance.code]} · {(balance.balanceCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}</legend>
        {([['expectedSettlementDate', 'Expected settlement', 'date'], ['evidenceUrl', 'Supporting schedule URL', 'url'], ['explanation', 'What remains outstanding', 'text']] as const).map(([key, label, type]) => <div className="space-y-1" key={key}><Label htmlFor={`${periodId}-${balance.code}-${key}`}>{label}</Label><Input id={`${periodId}-${balance.code}-${key}`} type={type} value={evidence[balance.code]?.[key] ?? ""} onChange={event => { const value = event.target.value; setEvidence(current => ({ ...current, [balance.code]: { ...(current[balance.code] ?? { expectedSettlementDate: "", explanation: "", evidenceUrl: "" }), [key]: value } })) }} /></div>)}
      </fieldset>)}
      {workspace && workspace.balances.length > 0 && <Button disabled={pending} onClick={() => startTransition(async () => {
        const result = await saveClearingSupportAction({ periodId, ledgerDigest: workspace.ledgerDigest, items: workspace.balances.map(balance => ({ code: balance.code as "1010" | "2200" | "2220" | "2230", amountCents: balance.balanceCents, ...evidence[balance.code] })) })
        if (!result.success) { toast.error(result.error); return }
        toast.success("Clearing support saved and checklist refreshed"); setOpen(false); router.refresh()
      })}>{pending ? "Saving…" : "Approve supporting schedules"}</Button>}
    </DialogContent></Dialog></>
}
