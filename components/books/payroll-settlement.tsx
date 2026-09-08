"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { loadPayrollSettlementAccountsAction, recordPayrollSettlementAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { parseMoneyToCents } from "@/lib/financials/money-input"

export function PayrollSettlement() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [accounts, setAccounts] = useState<Array<{ id: string; code: string; name: string }>>([])
  const [code, setCode] = useState<"2200" | "2220" | "2230">("2200")
  return <><Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(async () => {
    const result = await loadPayrollSettlementAccountsAction()
    if (!result.success) { toast.error(result.error); return }
    setAccounts(result.data); setOpen(true)
  })}>Record payroll or reimbursement payment</Button><Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Record a completed payment</DialogTitle><DialogDescription>Use the payroll report or reimbursement confirmation. This records cash already paid and clears its payable balance.</DialogDescription></DialogHeader>
    <form className="space-y-3" onSubmit={event => {
      event.preventDefault(); const data = new FormData(event.currentTarget)
      startTransition(async () => {
        try {
          const grossCents = parseMoneyToCents(String(data.get("gross") ?? ""))
          const withheldCents = code === "2200" ? parseMoneyToCents(String(data.get("withheld") || "0")) : 0
          if (grossCents === null || withheldCents === null) throw new Error("Enter valid payment amounts")
          const result = await recordPayrollSettlementAction({ clearingCode: code, cashAccountId: String(data.get("cashAccountId") ?? ""), date: String(data.get("date") ?? ""), grossCents, withheldCents, reference: String(data.get("reference") ?? ""), evidenceUrl: String(data.get("evidenceUrl") ?? "") })
          if (!result.success) { toast.error(result.error); return }
          toast.success("Payment recorded in Books"); setOpen(false); router.refresh()
        } catch (error) { toast.error(error instanceof Error ? error.message : "Check the payment amounts") }
      })
    }}>
      <div className="space-y-1"><Label htmlFor="payroll-kind">Payable</Label><Select value={code} onValueChange={value => setCode(value as typeof code)}><SelectTrigger id="payroll-kind"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="2200">Payroll</SelectItem><SelectItem value="2220">Employee reimbursements</SelectItem><SelectItem value="2230">Payroll deductions remittance</SelectItem></SelectContent></Select></div>
      <div className="space-y-1"><Label htmlFor="payroll-bank">Paid from</Label><Select name="cashAccountId" required><SelectTrigger id="payroll-bank"><SelectValue placeholder="Actual bank account" /></SelectTrigger><SelectContent>{accounts.map(account => <SelectItem key={account.id} value={account.id}>{account.code} · {account.name}</SelectItem>)}</SelectContent></Select></div>
      {([['date', 'Payment date', 'date'], ['gross', code === '2200' ? 'Gross payroll settled' : 'Amount paid', 'text'], ['reference', 'Payment or payroll-run reference', 'text'], ['evidenceUrl', 'Payroll report or payment confirmation URL', 'url']] as const).map(([name, label, type]) => <div className="space-y-1" key={name}><Label htmlFor={`payroll-${name}`}>{label}</Label><Input id={`payroll-${name}`} name={name} type={type} required /></div>)}
      {code === "2200" && <div className="space-y-1"><Label htmlFor="payroll-withheld">Deductions withheld from gross pay</Label><Input id="payroll-withheld" name="withheld" defaultValue="0" inputMode="decimal" /><p className="text-xs text-muted-foreground">Cash paid equals gross less deductions. Withheld amounts remain payable until remitted.</p></div>}
      <Button type="submit" disabled={pending || accounts.length === 0}>{pending ? "Recording…" : "Record completed payment"}</Button>
    </form>
  </DialogContent></Dialog></>
}
