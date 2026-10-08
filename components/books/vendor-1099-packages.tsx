"use client"

import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import {
  approve1099PackageAction, loadVendor1099PackagesAction, prepare1099PackageAction, record1099OutcomeAction,
  record1099SubmissionAction, setPayerTaxIdentityAction, withdraw1099PackageAction,
} from "@/app/(app)/books/actions"

type Workspace = Awaited<ReturnType<typeof import("@/lib/services/books/vendor-1099-packages").getVendor1099Packages>>
type Package = Workspace["packages"][number]
const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
const STATUS_TONE: Record<string, string> = { prepared: "text-warning", approved: "text-foreground", submitted: "text-foreground", accepted: "text-success", rejected: "text-destructive", withdrawn: "text-muted-foreground", superseded: "text-muted-foreground" }
const LIVE = ["approved", "submitted", "accepted", "rejected"]

/**
 * 1099-NEC filing by paying company: prepared from the year's payments, approved
 * by a second member, handed to a filing partner as an import file, and its
 * outcome kept. Payees show the last four of their taxpayer ID only.
 */
export function Vendor1099Packages({ defaultYear }: { defaultYear: number }) {
  const [year, setYear] = useState(defaultYear)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [pending, startTransition] = useTransition()
  const load = (taxYear: number) => startTransition(async () => {
    const result = await loadVendor1099PackagesAction(taxYear)
    if (!result.success) { setError(result.error); setWorkspace(null); return }
    setError(null); setWorkspace(result.data)
  })
  useEffect(() => {
    let current = true
    loadVendor1099PackagesAction(defaultYear).then((result) => {
      if (!current) return
      if (!result.success) { setError(result.error); setWorkspace(null); return }
      setError(null); setWorkspace(result.data)
    })
    return () => { current = false }
  }, [defaultYear])
  const act = (work: () => Promise<{ success: boolean; error?: string }>, done: string) => startTransition(async () => {
    const result = await work()
    if (!result.success) {
      const message = result.error ?? "Something went wrong"
      if (message.startsWith("This package cannot be prepared yet: ")) { setProblems(message.slice(37).split("; ")); return }
      toast.error(message); return
    }
    setProblems([]); toast.success(done); load(year)
  })

  return <section aria-label="1099 filing" className="space-y-4 border p-4">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h3 className="font-semibold">1099-NEC filing</h3>
        <p className="max-w-3xl text-sm text-muted-foreground">Each paying company files its own 1099s. A package freezes who is paid and how much, a second member approves it, and the approved file goes to your filing partner. Arc records the handoff; it does not transmit to the IRS.</p>
      </div>
      <div className="flex items-end gap-2">
        <div><Label htmlFor="vendor-1099-year">Tax year</Label><Input id="vendor-1099-year" type="number" className="w-28" value={year} onChange={(event) => setYear(Number(event.target.value))} /></div>
        <Button variant="outline" disabled={pending || !Number.isInteger(year)} onClick={() => load(year)}>Load</Button>
      </div>
    </div>
    {error && <p role="alert" className="border px-3 py-2 text-sm text-destructive">{error}</p>}
    {problems.length > 0 && <div role="alert" className="space-y-1 border px-3 py-2 text-sm">
      <p className="font-medium">Fix these before the package can be prepared:</p>
      <ul className="list-disc pl-5 text-muted-foreground">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
    </div>}
    {!workspace && !error && <div className="space-y-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-24 w-full" /></div>}
    {workspace && workspace.companies.map((company) => {
      const packages = workspace.packages.filter((row) => row.legal_entity_id === company.id)
      const live = packages.find((row) => LIVE.includes(row.status))
      const draft = packages.find((row) => row.status === "prepared")
      return <div key={company.id} className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">{company.name}{company.payerTinLast4 ? <span className="ml-2 text-xs text-muted-foreground">TIN ••• {company.payerTinLast4}</span> : null}</p>
          {!draft && <Button size="sm" variant="outline" disabled={pending || !company.payerTinLast4} onClick={() => act(() => prepare1099PackageAction({ taxYear: workspace.taxYear, legalEntityId: company.id, idempotencyKey: `1099-${crypto.randomUUID()}`, supersedesId: live?.id ?? null }), live ? "Correction prepared" : "Package prepared")}>
            {live ? "Prepare correction" : "Prepare package"}</Button>}
        </div>
        {(!company.payerTinLast4 || !company.hasAddress) && <PayerIdentity companyId={company.id} pending={pending} onSave={(input) => act(() => setPayerTaxIdentityAction(input), "Company taxpayer ID secured")} />}
        {packages.length === 0 ? <p className="border px-3 py-6 text-center text-sm text-muted-foreground">No {workspace.taxYear} package for this company yet.</p> : <div className="overflow-x-auto border">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 text-right font-medium">Payees</th><th className="px-3 py-2 text-right font-medium">Total</th><th className="px-3 py-2 font-medium">Record</th><th className="px-3 py-2 font-medium" />
            </tr></thead>
            <tbody>{packages.map((row) => <PackageRow key={row.id} row={row} userId={workspace.userId} pending={pending} act={act} />)}</tbody>
          </table>
        </div>}
      </div>
    })}
  </section>
}

function PackageRow({ row, userId, pending, act }: { row: Package; userId: string; pending: boolean; act: (work: () => Promise<{ success: boolean; error?: string }>, done: string) => void }) {
  const [form, setForm] = useState<null | "approve" | "withdraw" | "submit" | "outcome">(null)
  const [text, setText] = useState(""), [reference, setReference] = useState(""), [outcome, setOutcome] = useState<"accepted" | "rejected">("accepted")
  const close = () => { setForm(null); setText(""); setReference("") }
  return <>
    <tr className="border-b last:border-0 align-top">
      <td className="px-3 py-2"><Badge variant="outline" className={cn("capitalize", STATUS_TONE[row.status])}>{row.status}</Badge></td>
      <td className="px-3 py-2 text-right tabular-nums">{row.payee_count}</td>
      <td className="px-3 py-2 text-right tabular-nums">{money(Number(row.total_cents))}</td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        <p>Prepared {row.prepared_at.slice(0, 10)}{row.reviewed_at ? ` · approved ${row.reviewed_at.slice(0, 10)}` : ""}</p>
        {row.partner && <p>{row.partner}{row.partner_reference ? ` · ${row.partner_reference}` : ""}</p>}
        {row.outcome_notes && <p>{row.outcome_notes}</p>}
        {row.close_reason && <p>{row.close_reason}</p>}
      </td>
      <td className="px-3 py-2"><div className="flex flex-wrap justify-end gap-1">
        {row.status === "prepared" && row.prepared_by !== userId && <Button size="sm" variant="outline" disabled={pending} onClick={() => setForm("approve")}>Approve</Button>}
        {["prepared", "approved"].includes(row.status) && <Button size="sm" variant="ghost" disabled={pending} onClick={() => setForm("withdraw")}>Withdraw</Button>}
        {LIVE.includes(row.status) && <Button size="sm" variant="outline" asChild><a href={`/api/books/1099-packages/${row.id}/filing`}>Filing file</a></Button>}
        {["approved", "rejected"].includes(row.status) && <Button size="sm" variant="outline" disabled={pending} onClick={() => setForm("submit")}>Record submission</Button>}
        {row.status === "submitted" && <Button size="sm" variant="outline" disabled={pending} onClick={() => setForm("outcome")}>Record outcome</Button>}
      </div></td>
    </tr>
    {form && <tr className="border-b bg-muted/20"><td colSpan={5} className="px-3 py-3">
      <div className="flex flex-wrap items-end gap-2">
        {form === "submit" && <>
          <div><Label htmlFor={`partner-${row.id}`}>Filing partner</Label><Input id={`partner-${row.id}`} value={text} onChange={(event) => setText(event.target.value)} /></div>
          <div><Label htmlFor={`reference-${row.id}`}>Partner reference</Label><Input id={`reference-${row.id}`} value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Optional" /></div>
        </>}
        {form === "outcome" && <div><Label htmlFor={`outcome-${row.id}`}>Outcome</Label>
          <select id={`outcome-${row.id}`} className="block border bg-background p-2 text-sm" value={outcome} onChange={(event) => setOutcome(event.target.value === "rejected" ? "rejected" : "accepted")}><option value="accepted">Accepted</option><option value="rejected">Rejected</option></select></div>}
        {form !== "submit" && <div className="min-w-64 flex-1"><Label htmlFor={`notes-${row.id}`}>{form === "approve" ? "Review notes" : form === "withdraw" ? "Why withdraw" : "What the partner said"}</Label><Input id={`notes-${row.id}`} value={text} onChange={(event) => setText(event.target.value)} /></div>}
        <Button size="sm" disabled={pending || text.trim().length < (form === "approve" || form === "withdraw" ? 10 : form === "submit" ? 2 : 3)} onClick={() => {
          const work = form === "approve" ? () => approve1099PackageAction({ id: row.id, notes: text })
            : form === "withdraw" ? () => withdraw1099PackageAction({ id: row.id, reason: text })
            : form === "submit" ? () => record1099SubmissionAction({ id: row.id, partner: text, reference: reference || null })
            : () => record1099OutcomeAction({ id: row.id, outcome, notes: text })
          act(work, form === "approve" ? "Package approved" : form === "withdraw" ? "Package withdrawn" : form === "submit" ? "Submission recorded" : "Outcome recorded"); close()
        }}>Save</Button>
        <Button size="sm" variant="ghost" onClick={close}>Cancel</Button>
      </div>
    </td></tr>}
  </>
}

function PayerIdentity({ companyId, pending, onSave }: { companyId: string; pending: boolean; onSave: (input: { legalEntityId: string; tin: string; address: { street1: string; city: string; state: string; postal_code: string } }) => void }) {
  const [tin, setTin] = useState(""), [street1, setStreet] = useState(""), [city, setCity] = useState(""), [state, setState] = useState(""), [zip, setZip] = useState("")
  return <div className="flex flex-wrap items-end gap-2 border p-3">
    <p className="w-full text-xs text-muted-foreground">The company's own taxpayer ID and address print on every 1099 it files. The ID is kept in the vault; only its last four show here.</p>
    <div><Label htmlFor={`payer-tin-${companyId}`}>Company EIN</Label><Input id={`payer-tin-${companyId}`} value={tin} autoComplete="off" onChange={(event) => setTin(event.target.value)} placeholder="12-3456789" /></div>
    <div><Label htmlFor={`payer-street-${companyId}`}>Street</Label><Input id={`payer-street-${companyId}`} value={street1} onChange={(event) => setStreet(event.target.value)} /></div>
    <div><Label htmlFor={`payer-city-${companyId}`}>City</Label><Input id={`payer-city-${companyId}`} value={city} onChange={(event) => setCity(event.target.value)} /></div>
    <div><Label htmlFor={`payer-state-${companyId}`}>State</Label><Input id={`payer-state-${companyId}`} className="w-20" value={state} onChange={(event) => setState(event.target.value)} /></div>
    <div><Label htmlFor={`payer-zip-${companyId}`}>ZIP</Label><Input id={`payer-zip-${companyId}`} className="w-28" value={zip} onChange={(event) => setZip(event.target.value)} /></div>
    <Button size="sm" variant="outline" disabled={pending || tin.replace(/\D/g, "").length !== 9 || !street1 || !city || state.length !== 2 || zip.length < 5}
      onClick={() => onSave({ legalEntityId: companyId, tin, address: { street1, city, state, postal_code: zip } })}>Save</Button>
  </div>
}
