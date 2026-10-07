"use client"

import { useId, useState, useTransition } from "react"
import { toast } from "sonner"

import { assignInvoiceContractAction, recordWipCostAllocationAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

type Workspace = Awaited<ReturnType<typeof import("@/lib/services/books/wip-review").getWipReviewWorkspace>>
type Blocker = Workspace["ownershipBlockers"][number]
const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })

/**
 * On a job with more than one contract, every cost and billing must belong to a
 * contract before that contract's WIP can be prepared. Each fix here is the cure
 * the preparation refusal names: share a cost code's costs, or say which
 * contract an invoice bills.
 */
export function WipOwnership({ workspace, periodId, onSaved }: { workspace: Workspace; periodId: string; onSaved: () => Promise<void> }) {
  // One fix per project and cost code, however many contracts it blocks.
  const costFixes = new Map<string, { projectId: string; costCodeId: string | null; cents: number; contractIds: string[] }>()
  for (const blocker of workspace.ownershipBlockers) for (const code of blocker.costCodes) {
    costFixes.set(`${blocker.projectId}:${code.costCodeId ?? ""}`, { projectId: blocker.projectId, costCodeId: code.costCodeId, cents: code.cents, contractIds: code.contractIds })
  }
  const projects = [...new Set(workspace.ownershipBlockers.map(row => row.projectId))]
  return <section aria-label="Contract ownership" className="space-y-3 border border-warning/40 bg-warning/5 p-3">
    <div className="space-y-1">
      <h3 className="text-sm font-medium">Costs and billings need a contract</h3>
      <p className="text-xs text-muted-foreground">These jobs have more than one contract. Each contract&apos;s WIP is built only from its own costs and billings, so these must be placed before those contracts can be prepared. Other jobs are not affected.</p>
    </div>
    {projects.map(projectId => <div key={projectId} className="space-y-2">
      <p className="text-sm font-medium">{workspace.projectNames[projectId] ?? projectId}</p>
      {[...new Set(workspace.ownershipBlockers.filter((row: Blocker) => row.projectId === projectId).map(row => row.message))].map(message => <p key={message} className="text-xs text-muted-foreground">{message}</p>)}
      {[...costFixes.values()].filter(fix => fix.projectId === projectId).map(fix => <CostShare key={`${fix.projectId}:${fix.costCodeId ?? ""}`} periodId={periodId} workspace={workspace} fix={fix} onSaved={onSaved} />)}
      {workspace.unassignedInvoices.filter(invoice => invoice.project_id === projectId).map(invoice => <InvoiceContract key={invoice.id} workspace={workspace} invoice={invoice} onSaved={onSaved} />)}
    </div>)}
  </section>
}

function CostShare({ periodId, workspace, fix, onSaved }: { periodId: string; workspace: Workspace; fix: { projectId: string; costCodeId: string | null; cents: number; contractIds: string[] }; onSaved: () => Promise<void> }) {
  const prefix = useId()
  const contracts = workspace.contracts.filter(contract => contract.project_id === fix.projectId && (fix.contractIds.length < 2 || fix.contractIds.includes(contract.id)))
  const [percents, setPercents] = useState<Record<string, string>>({})
  const [note, setNote] = useState("")
  const [pending, startTransition] = useTransition()
  const code = fix.costCodeId ? workspace.costCodes.find(row => row.id === fix.costCodeId) : null
  // Basis points from a percentage typed with up to two decimals.
  const shares = contracts.map(contract => ({ contractId: contract.id, basisPoints: Math.round(Number(percents[contract.id] || 0) * 100) })).filter(share => share.basisPoints > 0)
  const total = shares.reduce((sum, share) => sum + share.basisPoints, 0)
  const valid = shares.length > 0 && total === 10000 && shares.every(share => Number.isInteger(share.basisPoints))
  return <fieldset disabled={pending} className="space-y-2 border bg-background p-3">
    <legend className="px-1 text-sm">{code ? `${code.code} · ${code.name}` : "Costs with no cost code"} · {money(fix.cents)}</legend>
    <p className="text-xs text-muted-foreground">{fix.contractIds.length > 1 ? "This code is on more than one contract's schedule of values. Say how its costs are shared." : "This code is on no contract's schedule of values. Say which contract its costs belong to."}</p>
    <div className="grid gap-2 sm:grid-cols-2">{contracts.map(contract => <div key={contract.id} className="space-y-1">
      <Label htmlFor={`${prefix}-${contract.id}`}>{contract.title} (%)</Label>
      <Input id={`${prefix}-${contract.id}`} inputMode="decimal" value={percents[contract.id] ?? ""} onChange={event => setPercents(current => ({ ...current, [contract.id]: event.target.value }))} />
    </div>)}</div>
    {!valid && <p className="text-xs text-muted-foreground">Shares must add up to 100%.</p>}
    <Label htmlFor={`${prefix}-note`}>Basis for this split</Label>
    <Textarea id={`${prefix}-note`} rows={2} maxLength={4000} value={note} onChange={event => setNote(event.target.value)} placeholder="Cite the estimate, schedule or agreement that supports these shares." />
    <div className="flex justify-end"><Button size="sm" disabled={!valid || note.trim().length < 10} onClick={() => startTransition(async () => {
      const result = await recordWipCostAllocationAction({ periodId, projectId: fix.projectId, costCodeId: fix.costCodeId, shares, note })
      if (!result.success) { toast.error(result.error); return }
      toast.success("Cost split recorded. Prepare the affected contracts again.")
      await onSaved()
    })}>{pending ? "Saving…" : "Record split"}</Button></div>
  </fieldset>
}

function InvoiceContract({ workspace, invoice, onSaved }: { workspace: Workspace; invoice: Workspace["unassignedInvoices"][number]; onSaved: () => Promise<void> }) {
  const prefix = useId()
  const contracts = workspace.contracts.filter(contract => contract.project_id === invoice.project_id)
  const [contractId, setContractId] = useState("")
  const [pending, startTransition] = useTransition()
  return <div className="flex flex-wrap items-end gap-2 border bg-background p-3">
    <div className="min-w-48 flex-1 space-y-1">
      <Label htmlFor={`${prefix}-contract`}>Invoice {invoice.invoice_number ?? "without a number"} · {money(Number(invoice.total_cents ?? 0))} bills</Label>
      <select id={`${prefix}-contract`} className="w-full border bg-background p-2 text-sm" value={contractId} onChange={event => setContractId(event.target.value)}>
        <option value="">Choose its contract</option>
        {contracts.map(contract => <option key={contract.id} value={contract.id}>{contract.title}</option>)}
      </select>
    </div>
    <Button size="sm" disabled={pending || !contractId} onClick={() => startTransition(async () => {
      const result = await assignInvoiceContractAction({ invoiceId: invoice.id, contractId })
      if (!result.success) { toast.error(result.error); return }
      toast.success("Invoice assigned to its contract.")
      await onSaved()
    })}>{pending ? "Saving…" : "Assign"}</Button>
  </div>
}
