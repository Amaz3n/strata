"use client"

import { useId, useState, useTransition } from "react"
import { toast } from "sonner"
import { allocateWipRevenueAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { parseMoneyToCents } from "@/lib/financials/money-input"

type Workspace = Awaited<ReturnType<typeof import("@/lib/services/books/wip-review").getWipReviewWorkspace>>
type Detail = Workspace["details"][number]
type AllocationRow = { key: string; accountId: string; contractId: string; costCodeId: string; amount: string }
const moneyInput = (cents: number) => `${BigInt(cents) / BigInt(100)}.${(BigInt(cents) % BigInt(100)).toString().padStart(2, "0")}`

export function WipRevenueAllocation({ periodId, detail, workspace, onSaved }: {
  periodId: string; detail: Detail; workspace: Workspace; onSaved: () => Promise<void>
}) {
  const prefix = useId()
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState("")
  const [rows, setRows] = useState<AllocationRow[]>(() => detail.revenueAllocations.length
    ? detail.revenueAllocations.map((row, index) => ({ key: String(index), accountId: row.account_id, contractId: row.contract_id ?? "", costCodeId: row.cost_code_id ?? "", amount: moneyInput(row.contract_cents) }))
    : [{ key: "default", accountId: workspace.incomeAccounts.find(row => row.code === "4000")?.id ?? "", contractId: "", costCodeId: "", amount: moneyInput(detail.revised_contract_cents) }])
  const parsed = rows.map(row => ({ account_id: row.accountId, contract_cents: parseMoneyToCents(row.amount), contract_id: row.contractId || null, cost_code_id: row.costCodeId || null }))
  const valid = parsed.every(row => row.account_id && row.contract_cents != null && row.contract_cents > 0) &&
    parsed.reduce((sum, row) => sum + BigInt(row.contract_cents ?? 0), BigInt(0)) === BigInt(detail.revised_contract_cents)
  function update(key: string, patch: Partial<AllocationRow>) { setRows(current => current.map(row => row.key === key ? { ...row, ...patch } : row)) }
  const contracts = workspace.contracts.filter(row => row.project_id === detail.project_id)
  return <div className="space-y-2 border-t pt-3">
    <p className="text-sm font-medium">Earned revenue allocation</p>
    {detail.revenueAllocationRequired && <p role="alert" className="text-sm text-destructive">Contract value changed. Allocate the revised value before this snapshot can be approved or posted.</p>}
    <ul className="space-y-1 text-sm text-muted-foreground">
      {detail.revenueAllocations.length ? detail.revenueAllocations.map((row, index) => <li key={index}>
        {row.account_code} · {workspace.incomeAccounts.find(account => account.id === row.account_id)?.name ?? "Income account"}: {(row.contract_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} of contract
        {row.contract_id && ` · ${contracts.find(contract => contract.id === row.contract_id)?.title ?? row.contract_id}`}
        {row.cost_code_id && ` · Cost code ${workspace.costCodes.find(code => code.id === row.cost_code_id)?.code ?? row.cost_code_id}`}
      </li>) : <li>{detail.revenueAllocationRequired ? "Revenue allocation is required." : "All earned revenue uses 4000 · Construction revenue."}</li>}
    </ul>
    {detail.revenueAllocationNote && <p className="whitespace-pre-wrap text-sm">Allocation basis: {detail.revenueAllocationNote}</p>}
    <details>
      <summary className="cursor-pointer text-sm underline">Revise income accounts and dimensions</summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm text-muted-foreground">Allocate the full revised contract value. Earned revenue follows these proportions; saving creates a new snapshot requiring approval. Changes can reclassify earlier earned revenue.</p>
        {rows.map((row, index) => <fieldset key={row.key} disabled={pending} className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
          <legend className="px-1 text-sm">Allocation {index + 1}</legend>
          <div><Label htmlFor={`${prefix}-${row.key}-account`}>Income account</Label><select id={`${prefix}-${row.key}-account`} className="w-full rounded-md border bg-background p-2 text-sm" value={row.accountId} onChange={event => update(row.key, { accountId: event.target.value })}><option value="">Choose an account</option>{workspace.incomeAccounts.map(account => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select></div>
          <div><Label htmlFor={`${prefix}-${row.key}-amount`}>Contract amount ($)</Label><Input id={`${prefix}-${row.key}-amount`} value={row.amount} inputMode="decimal" onChange={event => update(row.key, { amount: event.target.value })} /></div>
          <div><Label htmlFor={`${prefix}-${row.key}-contract`}>Contract dimension</Label><select id={`${prefix}-${row.key}-contract`} className="w-full rounded-md border bg-background p-2 text-sm" value={row.contractId} onChange={event => update(row.key, { contractId: event.target.value })}><option value="">Project only</option>{contracts.map(contract => <option key={contract.id} value={contract.id}>{contract.title}</option>)}</select></div>
          <div><Label htmlFor={`${prefix}-${row.key}-code`}>Cost code dimension</Label><select id={`${prefix}-${row.key}-code`} className="w-full rounded-md border bg-background p-2 text-sm" value={row.costCodeId} onChange={event => update(row.key, { costCodeId: event.target.value })}><option value="">No cost code</option>{workspace.costCodes.map(code => <option key={code.id} value={code.id}>{code.code} · {code.name}</option>)}</select></div>
          {rows.length > 1 && <Button size="sm" variant="ghost" onClick={() => setRows(current => current.filter(item => item.key !== row.key))}>Remove allocation {index + 1}</Button>}
        </fieldset>)}
        <Button size="sm" variant="outline" disabled={pending || rows.length >= 100} onClick={() => setRows(current => [...current, { key: crypto.randomUUID(), accountId: "", contractId: "", costCodeId: "", amount: "" }])}>Add allocation</Button>
        {!valid && <p className="text-sm text-muted-foreground">Choose income accounts and positive amounts totaling the revised contract value.</p>}
        <div><Label htmlFor={`${prefix}-note`}>Allocation explanation</Label><Textarea id={`${prefix}-note`} maxLength={4000} value={note} onChange={event => setNote(event.target.value)} /></div>
        <Button size="sm" disabled={pending || !valid || note.trim().length < 10} onClick={() => startTransition(async () => {
          if (!valid) return
          const result = await allocateWipRevenueAction({ periodId, snapshotId: detail.id, allocations: parsed.map(row => ({ ...row, contract_cents: row.contract_cents! })), note })
          if (!result.success) { toast.error(result.error); return }
          toast.success("Revenue allocation saved. Review the new WIP snapshot before approving.")
          await onSaved()
        })}>{pending ? "Saving…" : "Save allocation revision"}</Button>
      </div>
    </details>
  </div>
}
