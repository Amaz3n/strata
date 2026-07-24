"use client"

import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"
import { AlertTriangle, Check, CircleDollarSign, FileSpreadsheet, PackageCheck, Plus, RefreshCw, X } from "lucide-react"

import {
  approvePoCompletionAction,
  approveVarianceOrderAction,
  createPriceAgreementAction,
  dismissPoExceptionAction,
  generatePurchaseOrdersAction,
  rejectPoCompletionAction,
  rejectVarianceOrderAction,
  repriceAgreementAction,
  resolvePoExceptionAction,
  verifyPoCompletionAction,
  voidPriceAgreementAction,
} from "@/app/(app)/purchasing/actions"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import type { PriceAgreement } from "@/lib/services/price-book"
import type { VarianceAnalysisRow } from "@/lib/services/reports/variance-analysis"

type Lookup = { id: string; name: string; code?: string | null }
type BidRow = { id: string; title: string; jobName: string; status: string; dueAt: string | null; invites: number; responses: number }
type ExceptionRow = { id: string; projectName: string; projectId: string; description: string; reason: string; quantity: number; uom: string | null; costCode: string; candidates: string[]; createdAt: string }
type VpoRow = { id: string; title: string; projectId: string; vendor: string; reason: string; origin: string; totalCents: number; photoCount: number; createdAt: string }
type CompletionRow = { id: string; project: string; po: string; status: string; amountCents: number | null; reportedAt: string }

interface PurchasingClientProps {
  initialTab?: string
  health: { active: number; expiring: number; ambiguousOverlaps: number; leadDays: number }
  agreements: PriceAgreement[]
  agreementCount: number
  bids: BidRow[]
  exceptions: ExceptionRow[]
  exceptionCount: number
  vpos: VpoRow[]
  vpoCount: number
  completions: CompletionRow[]
  variance: { rows: VarianceAnalysisRow[]; summary: { totalAbsoluteCents: number; totalNetCents: number; incidence: number; directCostBudgetCents: number; varianceRate: number; benchmarkLow: number; benchmarkHigh: number } }
  companies: Lookup[]
  costCodes: Lookup[]
  communities: Lookup[]
  plans: Lookup[]
}

const money = (cents: number | null | undefined) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format((cents ?? 0) / 100)
const shortDate = (value: string | null) => value ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)) : "—"

export function PurchasingClient(props: PurchasingClientProps) {
  const [pending, startTransition] = useTransition()
  const [showAgreementForm, setShowAgreementForm] = useState(false)
  const [dimension, setDimension] = useState<VarianceAnalysisRow["dimension"]>("reason")
  const varianceRows = useMemo(() => props.variance.rows.filter((row) => row.dimension === dimension), [dimension, props.variance.rows])
  const exportVariance = () => {
    const header = ["Dimension", "Group", "Net variance", "Absolute variance", "Incidence", "Direct-cost budget", "Variance rate"]
    const lines = props.variance.rows.map((row) => [row.dimension, row.dimension_label, (row.net_variance_cents / 100).toFixed(2), (row.absolute_variance_cents / 100).toFixed(2), row.incidence, (row.direct_cost_budget_cents / 100).toFixed(2), (row.variance_rate * 100).toFixed(2) + "%"])
    const csv = [header, ...lines].map((line) => line.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n")
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
    const anchor = document.createElement("a")
    anchor.href = url; anchor.download = `variance-analysis-${new Date().toISOString().slice(0, 10)}.csv`; anchor.click(); URL.revokeObjectURL(url)
  }

  const mutate = (operation: () => Promise<{ success: boolean; error?: string }>, success: string) => startTransition(async () => {
    const result = await operation()
    if (result.success) toast.success(success)
    else toast.error(result.error ?? "Action failed")
  })

  const createAgreement = (form: HTMLFormElement) => {
    const data = new FormData(form)
    const kind = String(data.get("pricing_kind"))
    const amount = Math.round(Number(data.get("price")) * 100)
    mutate(() => createPriceAgreementAction({
      company_id: data.get("company_id"), cost_code_id: data.get("cost_code_id"),
      community_id: data.get("community_id") || null, house_plan_id: data.get("house_plan_id") || null,
      pricing_kind: kind, uom: kind === "unit" ? data.get("uom") : null,
      unit_cost_cents: kind === "unit" ? amount : null, lump_sum_cents: kind === "lump_sum" ? amount : null,
      scope_of_work: data.get("scope_of_work") || null, effective_from: data.get("effective_from"), status: "active", source: "manual",
    }), "Price agreement created")
    setShowAgreementForm(false)
  }

  const reprice = (agreement: PriceAgreement) => {
    const price = window.prompt("New price in dollars")
    const effective = window.prompt("Effective from (YYYY-MM-DD)", new Date().toISOString().slice(0, 10))
    if (!price || !effective) return
    const cents = Math.round(Number(price) * 100)
    mutate(() => repriceAgreementAction(agreement.id, {
      effective_from: effective,
      unit_cost_cents: agreement.pricing_kind === "unit" ? cents : null,
      lump_sum_cents: agreement.pricing_kind === "lump_sum" ? cents : null,
    }), "Agreement repriced with a new history row")
  }

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="grid border-b bg-muted/20 sm:grid-cols-5">
      <Stat label="Active agreements" value={String(props.health.active)} />
      <Stat label={`Expiring ≤${props.health.leadDays}d`} value={String(props.health.expiring)} />
      <Stat label="Open exceptions" value={String(props.exceptionCount)} />
      <Stat label="VPOs pending" value={String(props.vpoCount)} />
      <Stat label="Variance vs budget" value={`${(props.variance.summary.varianceRate * 100).toFixed(2)}%`} detail="Benchmark 1–2%" warning={props.variance.summary.varianceRate > 0.02} />
    </div>

    <Tabs defaultValue={props.initialTab ?? "price-book"} className="min-h-0 flex-1 gap-0">
      <div className="overflow-x-auto border-b px-4 py-2">
        <TabsList className="h-8 rounded-none bg-transparent p-0">
          {[["price-book","Price book"],["bids","Bid packages"],["exceptions","Exceptions"],["vpos","VPOs"],["variance","Variance analysis"],["completions","Completions"]].map(([value,label]) => <TabsTrigger key={value} value={value} className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:shadow-none">{label}</TabsTrigger>)}
        </TabsList>
      </div>

      <TabsContent value="price-book" className="m-0">
        <SectionHeader title="Vendor price agreements" detail={`${props.agreementCount} agreements · ${props.health.ambiguousOverlaps} ambiguous overlaps`} actions={<Button size="sm" onClick={() => setShowAgreementForm((value) => !value)}><Plus /> New agreement</Button>} />
        {showAgreementForm && <form className="grid gap-3 border-b bg-muted/20 p-4 lg:grid-cols-4" onSubmit={(event) => { event.preventDefault(); createAgreement(event.currentTarget) }}>
          <Field label="Vendor"><NativeSelect name="company_id" required options={props.companies} /></Field>
          <Field label="Cost code"><NativeSelect name="cost_code_id" required options={props.costCodes} code /></Field>
          <Field label="Community"><NativeSelect name="community_id" options={props.communities} empty="Org-wide" /></Field>
          <Field label="Plan"><NativeSelect name="house_plan_id" options={props.plans} empty="Any plan" /></Field>
          <Field label="Price kind"><select name="pricing_kind" className="h-9 border bg-background px-2 text-sm"><option value="unit">Unit</option><option value="lump_sum">Plan lump sum</option></select></Field>
          <Field label="UOM"><Input name="uom" defaultValue="ea" /></Field>
          <Field label="Price (dollars)"><Input name="price" type="number" min="0" step="0.01" required /></Field>
          <Field label="Effective from"><Input name="effective_from" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></Field>
          <div className="lg:col-span-3"><Field label="Scope of work"><Textarea name="scope_of_work" rows={2} /></Field></div>
          <div className="flex items-end justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setShowAgreementForm(false)}>Cancel</Button><Button disabled={pending}>Create</Button></div>
        </form>}
        <Table><TableHeader><TableRow><TableHead>Vendor</TableHead><TableHead>Cost code</TableHead><TableHead>Scope</TableHead><TableHead>Kind</TableHead><TableHead className="text-right">Price</TableHead><TableHead>Effective</TableHead><TableHead>Source</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader><TableBody>
          {props.agreements.map((row) => <TableRow key={row.id}><TableCell className="font-medium">{row.company_name}</TableCell><TableCell><span className="font-mono text-xs">{row.cost_code_code}</span> {row.cost_code_name}</TableCell><TableCell className="max-w-72 whitespace-normal"><div>{[row.division_name,row.community_name,row.house_plan_name].filter(Boolean).join(" / ") || "Org-wide"}</div><div className="line-clamp-1 text-xs text-muted-foreground">{row.scope_of_work || "No scope note"}</div></TableCell><TableCell>{row.pricing_kind === "unit" ? `Unit / ${row.uom}` : "Lump sum"}</TableCell><TableCell className="text-right tabular-nums">{money(row.pricing_kind === "unit" ? row.unit_cost_cents : row.lump_sum_cents)}</TableCell><TableCell className="text-xs tabular-nums">{row.effective_from} → {row.effective_to || "open"}</TableCell><TableCell><Badge variant="outline" className="rounded-none">{row.source.replace("_", " ")}</Badge></TableCell><TableCell><StateBadge value={row.status} /></TableCell><TableCell className="text-right"><Button size="sm" variant="ghost" onClick={() => reprice(row)} disabled={pending}>Reprice</Button><Button size="sm" variant="ghost" onClick={() => mutate(() => voidPriceAgreementAction(row.id), "Agreement voided")} disabled={pending}>Void</Button></TableCell></TableRow>)}
          {props.agreements.length === 0 && <EmptyRow columns={9} icon={<FileSpreadsheet />} text="No price agreements yet. Import agreements or award a community bid package." />}
        </TableBody></Table>
      </TabsContent>

      <TabsContent value="bids" className="m-0"><SectionHeader title="Community and plan bid packages" detail="Awards mint effective-dated price agreements" /><Table><TableHeader><TableRow><TableHead>Package</TableHead><TableHead>Community / plan</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Invites</TableHead><TableHead className="text-right">Responses</TableHead><TableHead>Due</TableHead></TableRow></TableHeader><TableBody>{props.bids.map((row) => <TableRow key={row.id}><TableCell className="font-medium">{row.title}</TableCell><TableCell>{row.jobName}</TableCell><TableCell><StateBadge value={row.status} /></TableCell><TableCell className="text-right tabular-nums">{row.invites}</TableCell><TableCell className="text-right tabular-nums">{row.responses}</TableCell><TableCell>{shortDate(row.dueAt)}</TableCell></TableRow>)}{props.bids.length === 0 && <EmptyRow columns={6} icon={<CircleDollarSign />} text="No price-book bid packages. Create one from a community or plan." />}</TableBody></Table></TabsContent>

      <TabsContent value="exceptions" className="m-0"><SectionHeader title="PO generation exceptions" detail="Unpriceable lines are held here; they are never silently priced at zero" actions={<GenerationControls pending={pending} run={(projectId, mode) => mutate(() => generatePurchaseOrdersAction({ projectId, mode }), mode === "dry_run" ? "Dry run completed" : "Purchase orders generated")} />} /><Table><TableHeader><TableRow><TableHead>Project</TableHead><TableHead>Cost code</TableHead><TableHead>Description</TableHead><TableHead className="text-right">Quantity</TableHead><TableHead>Reason</TableHead><TableHead>Age</TableHead><TableHead /></TableRow></TableHeader><TableBody>{props.exceptions.map((row) => <TableRow key={row.id}><TableCell>{row.projectName}</TableCell><TableCell className="font-mono text-xs">{row.costCode}</TableCell><TableCell>{row.description}</TableCell><TableCell className="text-right tabular-nums">{row.quantity} {row.uom}</TableCell><TableCell><Badge variant="destructive" className="rounded-none">{row.reason.replaceAll("_", " ")}</Badge></TableCell><TableCell>{shortDate(row.createdAt)}</TableCell><TableCell className="text-right">{row.candidates[0] && <Button size="sm" variant="ghost" onClick={() => mutate(() => resolvePoExceptionAction(row.id, { kind: "agreement", agreement_id: row.candidates[0] }), "Exception resolved and affected POs regenerated")}>Use candidate</Button>}<Button size="sm" variant="ghost" onClick={() => { const vendor = window.prompt("Vendor company UUID"); const price = window.prompt(`Manual unit price for ${row.uom || "unit"} (dollars)`); if (vendor && price) mutate(() => resolvePoExceptionAction(row.id, { kind: "manual", company_id: vendor, unit_cost_cents: Math.round(Number(price) * 100), note: "Manual purchasing-desk resolution" }), "Exception resolved and affected POs regenerated") }}>Manual price</Button><Button size="sm" variant="ghost" onClick={() => mutate(() => dismissPoExceptionAction(row.id, "Dismissed from purchasing desk"), "Exception dismissed")}>Dismiss</Button></TableCell></TableRow>)}{props.exceptions.length === 0 && <EmptyRow columns={7} icon={<Check />} text="No open PO exceptions." />}</TableBody></Table></TabsContent>

      <TabsContent value="vpos" className="m-0"><SectionHeader title="Variance purchase orders" detail="Pending approval, with reason and field provenance" /><Table><TableHeader><TableRow><TableHead>VPO</TableHead><TableHead>Vendor</TableHead><TableHead>Reason</TableHead><TableHead>Origin</TableHead><TableHead>Photos</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Requested</TableHead><TableHead /></TableRow></TableHeader><TableBody>{props.vpos.map((row) => <TableRow key={row.id}><TableCell className="font-medium">{row.title}</TableCell><TableCell>{row.vendor}</TableCell><TableCell>{row.reason}</TableCell><TableCell><Badge variant="outline" className="rounded-none">{row.origin.replaceAll("_", " ")}</Badge></TableCell><TableCell className="tabular-nums">{row.photoCount}</TableCell><TableCell className="text-right font-medium tabular-nums">{money(row.totalCents)}</TableCell><TableCell>{shortDate(row.createdAt)}</TableCell><TableCell className="text-right"><Button size="sm" variant="ghost" onClick={() => mutate(() => approveVarianceOrderAction(row.id), "VPO approved")}><Check /> Approve</Button><Button size="sm" variant="ghost" onClick={() => { const reason = window.prompt("Rejection reason"); if (reason) mutate(() => rejectVarianceOrderAction(row.id, reason), "VPO rejected") }}><X /> Reject</Button></TableCell></TableRow>)}{props.vpos.length === 0 && <EmptyRow columns={8} icon={<Check />} text="No VPOs are awaiting approval." />}</TableBody></Table></TabsContent>

      <TabsContent value="variance" className="m-0"><SectionHeader title="Variance analysis" detail={`${money(props.variance.summary.totalAbsoluteCents)} absolute variance · ${props.variance.summary.incidence} incidents`} actions={<div className="flex items-center gap-2"><Button size="sm" variant="outline" onClick={exportVariance}><FileSpreadsheet /> Export CSV</Button><Select value={dimension} onValueChange={(value) => setDimension(value as typeof dimension)}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent>{["reason","community","plan","division","vendor","superintendent","month"].map((value) => <SelectItem key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</SelectItem>)}</SelectContent></Select></div>} /><div className="border-b px-4 py-3"><div className="h-2 bg-muted"><div className={`h-full ${props.variance.summary.varianceRate > .02 ? "bg-destructive" : "bg-primary"}`} style={{ width: `${Math.min(props.variance.summary.varianceRate / .04 * 100, 100)}%` }} /></div><div className="mt-1 flex justify-between text-xs text-muted-foreground"><span>0%</span><span>Benchmark 1–2%</span><span>4%+</span></div></div><Table><TableHeader><TableRow><TableHead>Group</TableHead><TableHead className="text-right">Net</TableHead><TableHead className="text-right">Absolute</TableHead><TableHead className="text-right">Incidence</TableHead><TableHead className="text-right">Direct-cost budget</TableHead><TableHead className="text-right">Rate</TableHead></TableRow></TableHeader><TableBody>{varianceRows.map((row) => <TableRow key={`${row.dimension}:${row.dimension_id}`}><TableCell className="font-medium">{row.dimension_label}</TableCell><TableCell className="text-right tabular-nums">{money(row.net_variance_cents)}</TableCell><TableCell className="text-right tabular-nums">{money(row.absolute_variance_cents)}</TableCell><TableCell className="text-right tabular-nums">{row.incidence}</TableCell><TableCell className="text-right tabular-nums">{money(row.direct_cost_budget_cents)}</TableCell><TableCell className={`text-right font-medium tabular-nums ${row.variance_rate > .02 ? "text-destructive" : ""}`}>{(row.variance_rate * 100).toFixed(2)}%</TableCell></TableRow>)}{varianceRows.length === 0 && <EmptyRow columns={6} icon={<FileSpreadsheet />} text="No approved VPO variance in this period." />}</TableBody></Table></TabsContent>

      <TabsContent value="completions" className="m-0"><SectionHeader title="Pay-on-PO completions" detail="Verify field reports before creating an approved vendor bill" /><Table><TableHeader><TableRow><TableHead>Project</TableHead><TableHead>Purchase order</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Reported</TableHead><TableHead /></TableRow></TableHeader><TableBody>{props.completions.map((row) => <TableRow key={row.id}><TableCell>{row.project}</TableCell><TableCell className="font-medium">{row.po}</TableCell><TableCell><StateBadge value={row.status} /></TableCell><TableCell className="text-right tabular-nums">{money(row.amountCents)}</TableCell><TableCell>{shortDate(row.reportedAt)}</TableCell><TableCell className="text-right">{row.status === "reported" && <Button size="sm" variant="ghost" onClick={() => mutate(() => verifyPoCompletionAction(row.id), "Completion verified")}><PackageCheck /> Verify</Button>}{row.status === "verified" && <Button size="sm" variant="ghost" onClick={() => mutate(() => approvePoCompletionAction(row.id), "Completion approved and vendor bill created")}><CircleDollarSign /> Approve & bill</Button>}{["reported","verified"].includes(row.status) && <Button size="sm" variant="ghost" onClick={() => { const reason = window.prompt("Rejection reason"); if (reason) mutate(() => rejectPoCompletionAction(row.id, reason), "Completion rejected") }}><X /> Reject</Button>}</TableCell></TableRow>)}{props.completions.length === 0 && <EmptyRow columns={6} icon={<PackageCheck />} text="No completion reports are waiting." />}</TableBody></Table></TabsContent>
    </Tabs>
  </div>
}

function Stat({ label, value, detail, warning }: { label: string; value: string; detail?: string; warning?: boolean }) { return <div className="border-b px-4 py-3 sm:border-b-0 sm:border-r"><div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div><div className={`mt-1 text-xl font-semibold tabular-nums ${warning ? "text-destructive" : ""}`}>{value}</div>{detail && <div className="text-xs text-muted-foreground">{detail}</div>}</div> }
function SectionHeader({ title, detail, actions }: { title: string; detail: string; actions?: React.ReactNode }) { return <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b px-4 py-2"><div><h2 className="font-semibold">{title}</h2><p className="text-xs text-muted-foreground">{detail}</p></div>{actions}</div> }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <Label className="grid gap-1.5 text-xs">{label}{children}</Label> }
function NativeSelect({ name, options, required, empty, code }: { name: string; options: Lookup[]; required?: boolean; empty?: string; code?: boolean }) { return <select name={name} required={required} className="h-9 min-w-0 border bg-background px-2 text-sm">{empty !== undefined && <option value="">{empty}</option>}{options.map((option) => <option key={option.id} value={option.id}>{code && option.code ? `${option.code} — ` : ""}{option.name}</option>)}</select> }
function StateBadge({ value }: { value: string }) { const active = ["active","approved","verified","billed","awarded"].includes(value); return <Badge variant={active ? "secondary" : value === "rejected" || value === "void" ? "destructive" : "outline"} className="rounded-none capitalize">{value.replaceAll("_", " ")}</Badge> }
function EmptyRow({ columns, icon, text }: { columns: number; icon: React.ReactNode; text: string }) { return <TableRow><TableCell colSpan={columns} className="h-36 text-center"><div className="mx-auto flex max-w-md flex-col items-center gap-2 text-muted-foreground"><span className="[&_svg]:size-5">{icon}</span><span>{text}</span></div></TableCell></TableRow> }
function GenerationControls({ pending, run }: { pending: boolean; run: (projectId: string, mode: "dry_run" | "commit") => void }) { const [projectId, setProjectId] = useState(""); return <div className="flex items-center gap-2"><Input className="w-64" placeholder="Project UUID" value={projectId} onChange={(event) => setProjectId(event.target.value)} /><Button size="sm" variant="outline" disabled={pending || !projectId} onClick={() => run(projectId, "dry_run")}><RefreshCw /> Dry run</Button><Button size="sm" disabled={pending || !projectId} onClick={() => run(projectId, "commit")}><PackageCheck /> Generate</Button></div> }
