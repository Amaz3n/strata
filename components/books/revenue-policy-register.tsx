"use client"

import { useId, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { proposeRevenuePolicyAction, reviewRevenuePolicyAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { BILLING_METHOD_LABELS, DEFAULT_REVENUE_METHOD, REVENUE_METHOD_LABELS, type RevenueBillingMethod } from "@/lib/financials/revenue-policy"
import type { RevenueRecognitionBasis } from "@/lib/financials/billing-model"
import { cn } from "@/lib/utils"

type Register = Awaited<ReturnType<typeof import("@/lib/services/books/revenue-policies").getRevenuePolicyRegister>>
type Row = Register["rows"][number]
const BILLING_METHODS: RevenueBillingMethod[] = ["fixed_price", "cost_plus_percent", "cost_plus_fixed_fee", "cost_plus_gmp", "time_and_materials", "purchase_agreement"]
const date = (value: string) => value <= "1900-01-01" ? "from the start" : new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })

/**
 * How each job earns revenue, and on whose say-so. An inferred policy is the
 * one Arc recorded from the billing settings when the job first posted; it
 * decides until someone proposes and someone else approves a policy.
 */
export function RevenuePolicyRegister({ register }: { register: Register }) {
  const [proposing, setProposing] = useState<Row | null>(null)
  const unreviewed = register.rows.filter(row => row.inForce?.source === "inferred").length
  return <div className="space-y-4">
    <div className="max-w-3xl space-y-1">
      <p className="text-sm text-muted-foreground">How each job earns revenue. A policy takes effect on its date and never changes what came before it. Inferred policies were recorded by Arc from the billing settings and have not been reviewed; confirming or changing one takes a proposal and a second person&apos;s approval.</p>
      {unreviewed > 0 && <p className="text-sm text-warning">{unreviewed} {unreviewed === 1 ? "job is" : "jobs are"} on an inferred policy.</p>}
    </div>
    <div className="overflow-x-auto border">
      <table className="w-full min-w-[880px] text-sm">
        <thead><tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground">
          <th className="px-3 py-2 font-medium">Job</th><th className="px-3 py-2 font-medium">Revenue earned</th><th className="px-3 py-2 font-medium">Billed as</th>
          <th className="px-3 py-2 font-medium">Policy</th><th className="px-3 py-2 font-medium">Waiting for review</th><th className="px-3 py-2" />
        </tr></thead>
        <tbody>
          {register.rows.map(row => <PolicyRow key={`${row.projectId}:${row.contractId ?? ""}`} row={row} canPropose={register.canPropose} canReview={register.canReview} userId={register.userId} onPropose={() => setProposing(row)} />)}
          {register.rows.length === 0 && <tr><td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">No jobs yet.</td></tr>}
        </tbody>
      </table>
    </div>
    {register.truncated && <p className="text-xs text-muted-foreground">Showing the first {register.rows.length} of {register.total} jobs.</p>}
    {proposing && <ProposePolicy row={proposing} onClose={() => setProposing(null)} />}
  </div>
}

function PolicyRow({ row, canPropose, canReview, userId, onPropose }: { row: Row; canPropose: boolean; canReview: boolean; userId: string; onPropose: () => void }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const review = (policyId: string, approve: boolean) => startTransition(async () => {
    const note = approve ? "" : window.prompt("Why is this policy rejected?") ?? ""
    if (!approve && note.trim().length < 10) { toast.error("Say why the policy is rejected"); return }
    const result = await reviewRevenuePolicyAction({ policyId, approve, note: note || undefined })
    if (!result.success) { toast.error(result.error); return }
    toast.success(approve ? "Revenue policy approved" : "Revenue policy rejected"); router.refresh()
  })
  const policy = row.inForce
  return <tr className="border-b align-top last:border-0">
    <td className="px-3 py-2.5"><Link href={`/projects/${row.projectId}/financials`} className="font-medium hover:underline">{row.projectName}</Link>{row.contractTitle && <p className="text-xs text-muted-foreground">{row.contractTitle}</p>}</td>
    <td className="px-3 py-2.5">{policy ? REVENUE_METHOD_LABELS[policy.method] : <span className="text-muted-foreground">{REVENUE_METHOD_LABELS[row.settingsSay.method]} (not posted yet)</span>}
      {row.drift && <p className="text-xs text-warning">Billing settings now say {REVENUE_METHOD_LABELS[row.settingsSay.method].toLowerCase()}</p>}</td>
    <td className="px-3 py-2.5">{BILLING_METHOD_LABELS[policy?.billingMethod ?? row.settingsSay.billingMethod]}</td>
    <td className="px-3 py-2.5">{policy ? <><span className={cn("text-xs font-medium", policy.source === "approved" ? "text-success" : "text-warning")}>{policy.source === "approved" ? "Approved" : "Inferred, not reviewed"}</span><p className="text-xs text-muted-foreground">{date(policy.effectiveFrom)}</p></> : <span className="text-xs text-muted-foreground">Recorded when the job first posts</span>}</td>
    <td className="px-3 py-2.5">{row.pending ? <div className="space-y-1">
      <p>{REVENUE_METHOD_LABELS[row.pending.method]} {date(row.pending.effectiveFrom)}</p>
      <p className="max-w-64 text-xs text-muted-foreground">{row.pending.rationale} · {row.pending.preparedByName}</p>
      {canReview && row.pending.preparedBy !== userId && <div className="flex gap-2"><Button size="sm" disabled={pending} onClick={() => review(row.pending.id, true)}>Approve</Button><Button size="sm" variant="ghost" disabled={pending} onClick={() => review(row.pending.id, false)}>Reject</Button></div>}
      {row.pending.preparedBy === userId && <p className="text-xs text-muted-foreground">Another member approves it.</p>}
    </div> : <span className="text-xs text-muted-foreground">—</span>}</td>
    <td className="px-3 py-2.5 text-right">{canPropose && !row.pending && <Button size="sm" variant="outline" onClick={onPropose}>{policy?.source === "inferred" ? "Confirm or change" : "Propose change"}</Button>}</td>
  </tr>
}

function ProposePolicy({ row, onClose }: { row: Row; onClose: () => void }) {
  const prefix = useId()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [billingMethod, setBillingMethod] = useState<RevenueBillingMethod>(row.inForce?.billingMethod ?? row.settingsSay.billingMethod)
  const [method, setMethod] = useState<RevenueRecognitionBasis>(row.inForce?.method ?? row.settingsSay.method)
  const [effectiveFrom, setEffectiveFrom] = useState(row.inForce?.source === "inferred" ? "1900-01-01" : new Date().toISOString().slice(0, 10))
  const [rationale, setRationale] = useState("")
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader><DialogTitle>Revenue policy · {row.projectName}{row.contractTitle ? ` · ${row.contractTitle}` : ""}</DialogTitle>
        <DialogDescription>Another member approves it before it applies. Documents dated before the effective date keep the policy they were posted under.</DialogDescription></DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1"><Label htmlFor={`${prefix}-billing`}>Billed as</Label>
          <select id={`${prefix}-billing`} className="w-full border bg-background p-2 text-sm" value={billingMethod} onChange={event => { const next = BILLING_METHODS.find(value => value === event.target.value); if (!next) return; setBillingMethod(next); setMethod(DEFAULT_REVENUE_METHOD[next]) }}>
            {BILLING_METHODS.map(value => <option key={value} value={value}>{BILLING_METHOD_LABELS[value]}</option>)}
          </select></div>
        <div className="space-y-1"><Label htmlFor={`${prefix}-method`}>Revenue earned</Label>
          <select id={`${prefix}-method`} className="w-full border bg-background p-2 text-sm" value={method} onChange={event => setMethod(event.target.value === "closing" ? "closing" : "percentage_of_completion")}>
            {Object.entries(REVENUE_METHOD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></div>
        <div className="space-y-1"><Label htmlFor={`${prefix}-from`}>Effective from</Label>
          <Input id={`${prefix}-from`} type="date" min="1900-01-01" value={effectiveFrom} onChange={event => setEffectiveFrom(event.target.value)} />
          <p className="text-xs text-muted-foreground">{effectiveFrom <= "1900-01-01" ? "From the start of the job: confirms how it has always earned." : "From this date forward."}</p></div>
        <div className="space-y-1"><Label htmlFor={`${prefix}-why`}>Why</Label>
          <Textarea id={`${prefix}-why`} rows={3} maxLength={4000} value={rationale} onChange={event => setRationale(event.target.value)} placeholder="Cite the contract and the accounting judgment behind this method." /></div>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={pending || rationale.trim().length < 10 || !effectiveFrom} onClick={() => startTransition(async () => {
            const result = await proposeRevenuePolicyAction({ projectId: row.projectId, contractId: row.contractId, method, billingMethod, effectiveFrom, rationale })
            if (!result.success) { toast.error(result.error); return }
            toast.success("Policy proposed. Another member approves it."); onClose(); router.refresh()
          })}>{pending ? "Proposing…" : "Propose policy"}</Button></div>
      </div>
    </DialogContent>
  </Dialog>
}
