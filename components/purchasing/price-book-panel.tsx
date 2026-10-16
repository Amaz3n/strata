"use client"

import Link from "next/link"
import { useState, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { FileSpreadsheet, Plus } from "lucide-react"

import { createPriceAgreementAction } from "@/app/(app)/purchasing/actions"
import { AgreementChangeDialog, type AgreementChange } from "@/components/purchasing/agreement-change-dialog"
import { CreateProductionBidDialog } from "@/components/purchasing/create-bid-dialog"
import { PurchasingEntityPicker, type PurchasingEntity } from "@/components/purchasing/entity-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { parseMoneyToCents } from "@/lib/financials/money-input"
import type { PriceAgreement, RenewalRow } from "@/lib/services/price-book"

type Lookup = { id: string; name: string; code?: string | null }

export type PriceBookFilters = { company: PurchasingEntity | null; costCodeId: string; state: string; expiring: boolean }

interface PriceBookPanelProps {
  health: { active: number; expiring: number; ambiguousOverlaps: number; coverageGapCount: number; coverageGaps: Array<{ communityId: string; communityName: string; costCodeId: string; costCodeCode: string; costCodeName: string }>; leadDays: number }
  agreements: PriceAgreement[]
  agreementCount: number
  renewals: { rows: RenewalRow[]; count: number }
  costCodes: Lookup[]
  filters: PriceBookFilters
}

const STATES = ["active", "draft", "expired", "superseded", "void"]
const money = (cents: number | null | undefined) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format((cents ?? 0) / 100)
const priceOf = (row: PriceAgreement) => row.pricing_kind === "unit" ? row.unit_cost_cents : row.lump_sum_cents
const pct = (value: number | null) => value === null ? "—" : `${value > 0 ? "+" : ""}${value}%`

export function PriceBookPanel({ health, agreements, agreementCount, renewals, costCodes, filters }: PriceBookPanelProps) {
  const router = useRouter()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()
  const [showForm, setShowForm] = useState(false)
  const [vendor, setVendor] = useState<PurchasingEntity | null>(null)
  const [community, setCommunity] = useState<PurchasingEntity | null>(null)
  const [plan, setPlan] = useState<PurchasingEntity | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [change, setChange] = useState<AgreementChange | null>(null)
  const closeForm = () => { setShowForm(false); setVendor(null); setCommunity(null); setPlan(null); setFormError(null) }

  const setFilters = (updates: Record<string, string | null>) => {
    const query = new URLSearchParams(params.toString())
    for (const [key, value] of Object.entries(updates)) {
      if (value) query.set(key, value)
      else query.delete(key)
    }
    query.delete("page")
    startTransition(() => router.push(`/purchasing?${query}`, { scroll: false }))
  }
  const filtered = Boolean(filters.company || filters.costCodeId || filters.state || filters.expiring)

  const createAgreement = (form: HTMLFormElement) => {
    setFormError(null)
    if (!vendor) { setFormError("Choose a vendor"); return }
    const data = new FormData(form)
    const kind = String(data.get("pricing_kind"))
    const cents = parseMoneyToCents(String(data.get("price")))
    if (cents === null) { setFormError("Enter the price as a dollar amount"); return }
    startTransition(async () => {
      try {
        const result = await createPriceAgreementAction({
          company_id: vendor.id, cost_code_id: data.get("cost_code_id"),
          community_id: community?.id ?? null, house_plan_id: plan?.id ?? null,
          pricing_kind: kind, uom: kind === "unit" ? data.get("uom") : null,
          unit_cost_cents: kind === "unit" ? cents : null, lump_sum_cents: kind === "lump_sum" ? cents : null,
          scope_of_work: data.get("scope_of_work") || null, effective_from: data.get("effective_from"), status: "active", source: "manual",
        })
        if (!result.success) { setFormError(result.error); return }
        toast.success("Price agreement created")
        closeForm()
      } catch {
        setFormError("Unable to confirm the result. Refresh the price book before retrying.")
      }
    })
  }

  return <>
    <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
      <div>
        <h2 className="font-semibold">Vendor price agreements</h2>
        <p className="text-xs text-muted-foreground">{agreementCount} agreements{filtered ? " match" : ""} · {health.ambiguousOverlaps} ambiguous overlaps · {health.coverageGapCount} uncovered cost codes</p>
      </div>
      <Button size="sm" onClick={() => showForm ? closeForm() : setShowForm(true)}><Plus /> New agreement</Button>
    </div>

    {renewals.rows.length > 0 && <div className="border-b bg-warning/5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3">
        <p className="text-sm font-medium">Renewals · {renewals.count} agreement{renewals.count === 1 ? "" : "s"} end within {health.leadDays} days</p>
        <p className="text-xs text-muted-foreground">Awarding a replacement bid ends the standing price the day before the new one starts.{renewals.count > renewals.rows.length ? ` Showing ${renewals.rows.length} of ${renewals.count}; filter to narrow.` : ""}</p>
      </div>
      <Table><TableHeader><TableRow><TableHead>Agreement</TableHead><TableHead className="text-right">Price</TableHead><TableHead>Ends</TableHead><TableHead>Replacement bids</TableHead><TableHead className="text-right">Lowest</TableHead><TableHead className="text-right">Change</TableHead><TableHead /></TableRow></TableHeader><TableBody>
        {renewals.rows.map((row) => {
          const best = row.bids.find((bid) => bid.submissionId === row.bestBidSubmissionId) ?? null
          const scope = [row.agreement.community_name, row.agreement.house_plan_name].filter(Boolean).join(" / ") || "Org-wide"
          return <TableRow key={row.agreement.id}>
            <TableCell><div className="font-medium">{row.agreement.company_name}</div><div className="text-xs text-muted-foreground"><span className="font-mono">{row.agreement.cost_code_code}</span> {row.agreement.cost_code_name} · {scope}</div></TableCell>
            <TableCell className="text-right tabular-nums">{money(row.price.cents)}</TableCell>
            <TableCell className="text-xs tabular-nums">{row.agreement.effective_to}</TableCell>
            <TableCell className="text-sm">{row.bids.length === 0
              ? <span className="text-muted-foreground">{row.openPackage ? "Awaiting bids" : "None yet"}</span>
              : <>{`${row.bids.length} bid${row.bids.length === 1 ? "" : "s"}`}{!best && <span className="block text-xs text-muted-foreground">Priced by a different unit or kind; not comparable</span>}</>}</TableCell>
            <TableCell className="text-right tabular-nums">{best ? <><span>{money(best.price.cents)}</span><span className="block text-xs text-muted-foreground">{best.companyName}</span></> : "—"}</TableCell>
            <TableCell className={`text-right tabular-nums ${best && best.deltaCents !== null && best.deltaCents > 0 ? "text-destructive" : best && best.deltaCents !== null && best.deltaCents < 0 ? "text-success" : ""}`}>{best ? pct(best.deltaPct) : "—"}</TableCell>
            <TableCell className="text-right">{best
              ? <Button size="sm" variant="outline" asChild><Link href={`/purchasing/bids/${best.packageId}`}>Compare</Link></Button>
              : row.openPackage
              ? <Button size="sm" variant="outline" asChild><Link href={`/purchasing/bids/${row.openPackage.id}`}>Open package</Link></Button>
              : (row.agreement.community_id || row.agreement.house_plan_id) && <CreateProductionBidDialog variant="outline" label="Request bids" prefill={{
                  title: `${row.agreement.cost_code_name} renewal`,
                  community: row.agreement.community_id ? { id: row.agreement.community_id, name: row.agreement.community_name ?? "Community", detail: "" } : null,
                  plan: row.agreement.house_plan_id ? { id: row.agreement.house_plan_id, name: row.agreement.house_plan_name ?? "Plan", detail: "" } : null,
                  costCodeId: row.agreement.cost_code_id,
                }} />}</TableCell>
          </TableRow>
        })}
      </TableBody></Table>
    </div>}

    {health.coverageGaps.length > 0 && <div className="border-b bg-warning/5 p-4">
      <p className="text-sm font-medium">Cost codes with no active price in a selling community</p>
      <p className="mt-1 text-xs text-muted-foreground">A start released against these produces a price-book exception instead of a purchase order. {health.coverageGapCount > health.coverageGaps.length ? `Showing ${health.coverageGaps.length} of ${health.coverageGapCount}.` : null}</p>
      <ul className="mt-3 grid gap-1 sm:grid-cols-2">
        {health.coverageGaps.map((gap) => <li key={`${gap.communityId}:${gap.costCodeId}`} className="flex items-baseline justify-between gap-3 border-b py-1 text-xs last:border-b-0">
          <span className="font-medium tabular-nums">{gap.costCodeCode}</span>
          <span className="flex-1 truncate text-muted-foreground">{gap.costCodeName}</span>
          <span className="text-muted-foreground">{gap.communityName}</span>
        </li>)}
      </ul>
    </div>}

    <div className="flex flex-wrap items-end gap-3 border-b px-4 py-3" aria-busy={pending}>
      <div className="w-56"><PurchasingEntityPicker kind="vendor" value={filters.company} onChange={(value) => setFilters({ vendor: value?.id ?? null })} disabled={pending} /></div>
      <div className="grid gap-1.5"><Label htmlFor="price-book-cost-code" className="text-xs">Cost code</Label>
        <select id="price-book-cost-code" value={filters.costCodeId} disabled={pending} onChange={(event) => setFilters({ code: event.target.value || null })} className="h-9 w-48 border bg-background px-2 text-sm">
          <option value="">All cost codes</option>
          {costCodes.map((option) => <option key={option.id} value={option.id}>{option.code ? `${option.code} — ` : ""}{option.name}</option>)}
        </select></div>
      <div className="grid gap-1.5"><Label htmlFor="price-book-state" className="text-xs">Status</Label>
        <select id="price-book-state" value={filters.state} disabled={pending} onChange={(event) => setFilters({ pbstatus: event.target.value || null })} className="h-9 w-36 border bg-background px-2 text-sm">
          <option value="">Any status</option>
          {STATES.map((state) => <option key={state} value={state}>{state[0].toUpperCase() + state.slice(1)}</option>)}
        </select></div>
      <label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" checked={filters.expiring} disabled={pending} onChange={(event) => setFilters(event.target.checked ? { expiring: "1", pbstatus: "active" } : { expiring: null })} />Expiring within {health.leadDays} days</label>
      {filtered && <Button size="sm" variant="ghost" disabled={pending} onClick={() => startTransition(() => router.push("/purchasing?tab=price-book", { scroll: false }))}>Clear filters</Button>}
    </div>

    {showForm && <form className="grid gap-3 border-b bg-muted/20 p-4 lg:grid-cols-4" onSubmit={(event) => { event.preventDefault(); createAgreement(event.currentTarget) }}>
      <PurchasingEntityPicker kind="vendor" value={vendor} onChange={setVendor} disabled={pending} />
      <Label className="grid gap-1.5 text-xs">Cost code<select name="cost_code_id" required className="h-9 min-w-0 border bg-background px-2 text-sm">{costCodes.map((option) => <option key={option.id} value={option.id}>{option.code ? `${option.code} — ` : ""}{option.name}</option>)}</select></Label>
      <div><PurchasingEntityPicker kind="community" value={community} onChange={setCommunity} disabled={pending} /><p className="mt-1 text-xs text-muted-foreground">{community ? "" : "None chosen: org-wide."}</p></div>
      <div><PurchasingEntityPicker kind="plan" value={plan} onChange={setPlan} disabled={pending} /><p className="mt-1 text-xs text-muted-foreground">{plan ? "" : "None chosen: any plan."}</p></div>
      <Label className="grid gap-1.5 text-xs">Price kind<select name="pricing_kind" className="h-9 border bg-background px-2 text-sm"><option value="unit">Unit</option><option value="lump_sum">Plan lump sum</option></select></Label>
      <Label className="grid gap-1.5 text-xs">UOM<Input name="uom" defaultValue="ea" /></Label>
      <Label className="grid gap-1.5 text-xs">Price (dollars)<Input name="price" inputMode="decimal" required /></Label>
      <Label className="grid gap-1.5 text-xs">Effective from<Input name="effective_from" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></Label>
      <div className="lg:col-span-3"><Label className="grid gap-1.5 text-xs">Scope of work<Textarea name="scope_of_work" rows={2} /></Label></div>
      <div className="flex flex-col items-end justify-end gap-2">{formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}<div className="flex gap-2"><Button type="button" variant="ghost" onClick={closeForm}>Cancel</Button><Button disabled={pending}>Create</Button></div></div>
    </form>}

    <Table><TableHeader><TableRow><TableHead>Vendor</TableHead><TableHead>Cost code</TableHead><TableHead>Scope</TableHead><TableHead>Kind</TableHead><TableHead className="text-right">Price</TableHead><TableHead>Effective</TableHead><TableHead>Source</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader><TableBody>
      {agreements.map((row) => <TableRow key={row.id}>
        <TableCell className="font-medium">{row.company_name}</TableCell>
        <TableCell><span className="font-mono text-xs">{row.cost_code_code}</span> {row.cost_code_name}</TableCell>
        <TableCell className="max-w-72 whitespace-normal"><div>{[row.division_name, row.community_name, row.house_plan_name].filter(Boolean).join(" / ") || "Org-wide"}</div><div className="line-clamp-1 text-xs text-muted-foreground">{row.scope_of_work || "No scope note"}</div></TableCell>
        <TableCell>{row.pricing_kind === "unit" ? `Unit / ${row.uom}` : "Lump sum"}</TableCell>
        <TableCell className="text-right tabular-nums">{money(priceOf(row))}</TableCell>
        <TableCell className="text-xs tabular-nums">{row.effective_from} → {row.effective_to || "open"}</TableCell>
        <TableCell><Badge variant="outline" className="rounded-none">{row.source.replace("_", " ")}</Badge></TableCell>
        <TableCell><Badge variant={row.status === "active" ? "secondary" : row.status === "void" ? "destructive" : "outline"} className="rounded-none capitalize">{row.status}</Badge></TableCell>
        <TableCell className="text-right">{row.status === "active" && <>
          <Button size="sm" variant="ghost" onClick={() => setChange({ kind: "reprice", agreement: row })}>Reprice</Button>
          <Button size="sm" variant="ghost" onClick={() => setChange({ kind: "end", agreement: row })}>End</Button>
        </>}{(row.status === "active" || row.status === "draft") && <Button size="sm" variant="ghost" onClick={() => setChange({ kind: "void", agreement: row })}>Void</Button>}</TableCell>
      </TableRow>)}
      {agreements.length === 0 && <TableRow><TableCell colSpan={9} className="h-36 text-center"><div className="mx-auto flex max-w-md flex-col items-center gap-2 text-muted-foreground"><span className="[&_svg]:size-5"><FileSpreadsheet /></span><span>{filtered ? "No agreements match these filters." : "No price agreements yet. Import agreements or award a community bid package."}</span></div></TableCell></TableRow>}
    </TableBody></Table>
    <AgreementChangeDialog change={change} onClose={() => setChange(null)} />
  </>
}
