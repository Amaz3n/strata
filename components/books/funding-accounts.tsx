"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { loadBooksFundingAction, saveBooksFundingAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

type Workspace = Awaited<ReturnType<typeof import("@/lib/services/books/funding").getBooksFundingWorkspace>>
export function FundingAccounts() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const load = () => startTransition(async () => {
    setError(null)
    const result = await loadBooksFundingAction()
    if (!result.success) { setError(result.error); return }
    setWorkspace(result.data)
  })
  return <section className="space-y-3 border p-4">
    <div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">Payment funding accounts</h3><p className="text-xs text-muted-foreground">Choose the cash account used by each Arc Pay funding source.</p></div><Button variant="outline" size="sm" onClick={load} disabled={pending}>{pending ? "Loading…" : "Review mappings"}</Button></div>
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    {workspace?.sources.length === 0 ? <p className="text-xs text-muted-foreground">No payment funding sources are configured.</p> : null}
    {workspace?.sources.map(source => <div key={source.id} className="grid grid-cols-2 items-center gap-4 border-t py-3"><span className="text-xs">{source.bank_name || "Bank account"} · {source.last4} · {source.status}</span>
      <Select disabled={pending} value={source.books_gl_account_id ?? ""} onValueChange={accountId => startTransition(async () => {
        const result = await saveBooksFundingAction({ fundingSourceId: source.id, accountId })
        if (!result.success) { toast.error(result.error); return }
        setWorkspace(current => current ? { ...current, sources: current.sources.map(row => row.id === source.id ? { ...row, books_gl_account_id: accountId } : row) } : current)
        toast.success("Funding account mapped")
      })}><SelectTrigger><SelectValue placeholder="Select cash account" /></SelectTrigger><SelectContent>{workspace.accounts.map(account => <SelectItem key={account.id} value={account.id}>{account.code} · {account.name}</SelectItem>)}</SelectContent></Select>
    </div>)}
  </section>
}
