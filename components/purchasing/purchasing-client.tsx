"use client"

import Link from "next/link"
import { CreateProductionBidDialog } from "./create-bid-dialog"
import { useMemo, useState, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { AlertTriangle, Check, CircleDollarSign, FileSpreadsheet, PackageCheck, X } from "lucide-react"

import {
  approvePoCompletionAction,
  approveVarianceOrderAction,
  dismissPoExceptionAction,
  rejectPoCompletionAction,
  rejectVarianceOrderAction,
  verifyPoCompletionAction,
} from "@/app/(app)/purchasing/actions"
import { PoGenerationDialog } from "@/components/purchasing/po-generation-dialog"
import { AgreementChoiceDialog } from "@/components/purchasing/agreement-choice-dialog"
import { CompletionApprovalDialog } from "@/components/purchasing/completion-approval-dialog"
import { VpoEvidenceUpload } from "@/components/purchasing/vpo-evidence-upload"
import { attachVpoEvidenceAction } from "@/app/(app)/purchasing/vpo-actions"
import { ManualPriceDialog } from "@/components/purchasing/manual-price-dialog"
import { PriceBookPanel, type PriceBookFilters } from "@/components/purchasing/price-book-panel"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { PriceAgreement, RenewalRow } from "@/lib/services/price-book"
import type { VarianceAnalysisRow } from "@/lib/services/reports/variance-analysis"

type Lookup = { id: string; name: string; code?: string | null }
type BidRow = { id: string; title: string; jobName: string; status: string; dueAt: string | null; invites: number; responses: number }
type ExceptionRow = { id: string; projectName: string; projectId: string; description: string; reason: string; quantity: number; uom: string | null; costCode: string; candidates: string[]; createdAt: string }
type VpoRow = { id: string; title: string; projectId: string; evidenceCount: number; vendor: string; reason: string; origin: string; totalCents: number; photoCount: number; createdAt: string }
type CompletionRow = { id: string; project: string; po: string; status: string; amountCents: number | null; reportedAt: string }

interface PurchasingClientProps {
  initialTab?: string
  health: { active: number; expiring: number; ambiguousOverlaps: number; coverageGapCount: number; coverageGaps: Array<{ communityId: string; communityName: string; costCodeId: string; costCodeCode: string; costCodeName: string }>; leadDays: number } | null
  agreements: PriceAgreement[]
  agreementCount: number
  renewals: { rows: RenewalRow[]; count: number }
  priceBookFilters: PriceBookFilters
  bids: BidRow[]
  exceptions: ExceptionRow[]
  exceptionCount: number
  vpos: VpoRow[]
  vpoCount: number
  completions: CompletionRow[]
  varianceRange: { from: string; to: string }
  /** The reader may request or decide variance orders, so may attach cost evidence to them. */
  canAttachEvidence: boolean
  /** The org requires a passed inspection (or a waiver) before a completion is approved. */
  requiresInspection: boolean
  variance: { rows: VarianceAnalysisRow[]; summary: { totalAbsoluteCents: number; totalNetCents: number; incidence: number; directCostBudgetCents: number; varianceRate: number; benchmarkLow: number; benchmarkHigh: number } } | null
  costCodes: Lookup[]
  /** The Deliveries tab, built on the server: its own client component owns the dialogs. */
  deliveries?: React.ReactNode
  /** The Acknowledgments tab, built on the server: its own client component owns the resolve dialog. */
  acknowledgments?: React.ReactNode
}

const money = (cents: number | null | undefined) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format((cents ?? 0) / 100)
const shortDate = (value: string | null) => value ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)) : "—"

export function PurchasingClient(props: PurchasingClientProps) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()
  const params = useSearchParams()
  const tab = props.initialTab ?? "price-book"
  const selectTab = (next: string) => {
    const query = new URLSearchParams(params.toString())
    query.set("tab", next)
    query.delete("page")
    startTransition(() => router.push(`/purchasing?${query}`, { scroll: false }))
  }
  const [dimension, setDimension] = useState<VarianceAnalysisRow["dimension"]>("reason")
  const varianceRows = useMemo(() => props.variance?.rows.filter((row) => row.dimension === dimension) ?? [], [dimension, props.variance])
  const [approving, setApproving] = useState<string | null>(null)
  const exportVariance = async () => {
    const { from, to } = props.varianceRange
    try {
      const response = await fetch(`/api/purchasing/variance?from=${from}&to=${to}`)
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null)
        toast.error(body && typeof body === "object" && typeof Reflect.get(body, "error") === "string" ? String(Reflect.get(body, "error")) : "Unable to export variance analysis")
        return
      }
      const url = URL.createObjectURL(await response.blob())
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `variance-analysis-${from}-to-${to}.csv`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error("Unable to export variance analysis")
    }
  }

  const mutate = (operation: () => Promise<{ success: boolean; error?: string }>, success: string, onSuccess?: () => void) => startTransition(async () => {
    try {
      const result = await operation()
      if (result.success) { toast.success(success); onSuccess?.() }
      else toast.error(result.error ?? "Action failed")
    } catch {
      toast.error("Unable to confirm the result. Refresh the queue before retrying.")
    }
  })

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="grid border-b bg-muted/20 sm:grid-cols-3" aria-busy={pending}>
      {props.health && <>
        <Stat label="Active agreements" value={String(props.health.active)} />
        <Link href="/purchasing?tab=price-book&pbstatus=active&expiring=1" className="block transition-colors hover:bg-muted/40"><Stat label={`Expiring ≤${props.health.leadDays}d`} value={String(props.health.expiring)} warning={props.health.expiring > 0} /></Link>
        <Stat label="Uncovered cost codes" value={String(props.health.coverageGapCount)} warning={props.health.coverageGapCount > 0} />
      </>}
      {tab === "exceptions" && <Stat label="Open exceptions" value={String(props.exceptionCount)} />}
      {tab === "vpos" && <Stat label="VPOs pending" value={String(props.vpoCount)} />}
      {props.variance && <Stat label="Variance vs budget" value={`${(props.variance.summary.varianceRate * 100).toFixed(2)}%`} detail="Benchmark 1–2%" warning={props.variance.summary.varianceRate > 0.02} />}
    </div>

    <Tabs value={tab} onValueChange={selectTab} className="min-h-0 flex-1 gap-0">
      <div className="flex items-center justify-between gap-4 overflow-x-auto border-b px-4 py-2">
        <TabsList className="h-8 rounded-none bg-transparent p-0">
          {[["price-book","Price book"],["bids","Bid packages"],["exceptions","Exceptions"],["vpos","VPOs"],["variance","Variance analysis"],["completions","Completions"],["deliveries","Deliveries"],["acknowledgments","Acknowledgments"]].map(([value,label]) => <TabsTrigger key={value} value={value} disabled={pending} className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:shadow-none">{label}</TabsTrigger>)}
        </TabsList>
        <Link href="/settings/purchasing" className="shrink-0 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">Purchasing settings</Link>
      </div>

      {props.health && <TabsContent value="price-book" className="m-0">
        <PriceBookPanel health={props.health} agreements={props.agreements} agreementCount={props.agreementCount} renewals={props.renewals} costCodes={props.costCodes} filters={props.priceBookFilters} />
      </TabsContent>}

      <TabsContent value="bids" className="m-0"><div className="flex items-center justify-between gap-3 pr-4"><SectionHeader title="Community and plan bid packages" detail="Awards mint effective-dated price agreements" /><CreateProductionBidDialog /></div><Table><TableHeader><TableRow><TableHead>Package</TableHead><TableHead>Community / plan</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Invites</TableHead><TableHead className="text-right">Responses</TableHead><TableHead>Due</TableHead></TableRow></TableHeader><TableBody>{props.bids.map((row) => <TableRow key={row.id}><TableCell className="font-medium"><Link className="underline underline-offset-4" href={`/purchasing/bids/${row.id}`}>{row.title}</Link></TableCell><TableCell>{row.jobName}</TableCell><TableCell><StateBadge value={row.status} /></TableCell><TableCell className="text-right tabular-nums">{row.invites}</TableCell><TableCell className="text-right tabular-nums">{row.responses}</TableCell><TableCell>{shortDate(row.dueAt)}</TableCell></TableRow>)}{props.bids.length === 0 && <EmptyRow columns={6} icon={<CircleDollarSign />} text="No price-book bid packages. Create a package to request community or plan pricing." />}</TableBody></Table></TabsContent>

      <TabsContent value="exceptions" className="m-0"><SectionHeader title="PO generation exceptions" detail="Unpriceable lines are held here; they are never silently priced at zero" actions={<PoGenerationDialog />} /><Table><TableHeader><TableRow><TableHead>Project</TableHead><TableHead>Cost code</TableHead><TableHead>Description</TableHead><TableHead className="text-right">Quantity</TableHead><TableHead>Reason</TableHead><TableHead>Age</TableHead><TableHead /></TableRow></TableHeader><TableBody>{props.exceptions.map((row) => <TableRow key={row.id}><TableCell>{row.projectName}</TableCell><TableCell className="font-mono text-xs">{row.costCode}</TableCell><TableCell>{row.description}</TableCell><TableCell className="text-right tabular-nums">{row.quantity} {row.uom}</TableCell><TableCell><Badge variant="destructive" className="rounded-none">{row.reason.replaceAll("_", " ")}</Badge></TableCell><TableCell>{shortDate(row.createdAt)}</TableCell><TableCell className="text-right">{row.candidates.length > 0 && <AgreementChoiceDialog exceptionId={row.id} description={row.description} />}<ManualPriceDialog exceptionId={row.id} description={row.description} uom={row.uom} /><Button size="sm" variant="ghost" onClick={() => mutate(() => dismissPoExceptionAction(row.id, "Dismissed from purchasing desk"), "Exception dismissed")}>Dismiss</Button></TableCell></TableRow>)}{props.exceptions.length === 0 && <EmptyRow columns={7} icon={<Check />} text="No open PO exceptions." />}</TableBody></Table></TabsContent>

      <TabsContent value="vpos" className="m-0"><SectionHeader title="Variance purchase orders" detail="Pending approval, with reason and field provenance" /><Table><TableHeader><TableRow><TableHead>VPO</TableHead><TableHead>Vendor</TableHead><TableHead>Reason</TableHead><TableHead>Origin</TableHead><TableHead>Evidence</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Requested</TableHead><TableHead /></TableRow></TableHeader><TableBody>{props.vpos.map((row) => <TableRow key={row.id}><TableCell className="font-medium">{row.title}</TableCell><TableCell>{row.vendor}</TableCell><TableCell>{row.reason}</TableCell><TableCell><Badge variant="outline" className="rounded-none">{row.origin.replaceAll("_", " ")}</Badge></TableCell><TableCell className="whitespace-nowrap"><span className={`tabular-nums ${row.evidenceCount === 0 ? "text-muted-foreground" : ""}`}>{row.evidenceCount} {row.evidenceCount === 1 ? "file" : "files"}</span>{row.photoCount > 0 && <span className="ml-2 text-xs text-muted-foreground">{row.photoCount} photo{row.photoCount === 1 ? "" : "s"}</span>}{props.canAttachEvidence && <VpoEvidenceUpload projectId={row.projectId} label="Attach" disabled={pending} onUploaded={async (ids) => { const result = await attachVpoEvidenceAction(row.projectId, row.id, ids); if (result.success) { toast.success("Evidence attached"); router.refresh() } else toast.error(result.error) }} />}</TableCell><TableCell className="text-right font-medium tabular-nums">{money(row.totalCents)}</TableCell><TableCell>{shortDate(row.createdAt)}</TableCell><TableCell className="text-right"><Button size="sm" variant="ghost" onClick={() => mutate(() => approveVarianceOrderAction(row.id), "VPO approved")}><Check /> Approve</Button><Button size="sm" variant="ghost" onClick={() => { const reason = window.prompt("Rejection reason"); if (reason) mutate(() => rejectVarianceOrderAction(row.id, reason), "VPO rejected") }}><X /> Reject</Button></TableCell></TableRow>)}{props.vpos.length === 0 && <EmptyRow columns={8} icon={<Check />} text="No VPOs are awaiting approval." />}</TableBody></Table></TabsContent>

      {props.variance && <TabsContent value="variance" className="m-0"><SectionHeader title="Variance analysis" detail={`${props.varianceRange.from} to ${props.varianceRange.to} · ${money(props.variance.summary.totalAbsoluteCents)} absolute variance · ${props.variance.summary.incidence} incidents`} actions={<div className="flex items-center gap-2"><form action="/purchasing" className="flex items-center gap-2"><input type="hidden" name="tab" value="variance" /><label htmlFor="variance-from" className="sr-only">From</label><Input id="variance-from" name="from" type="date" defaultValue={props.varianceRange.from} className="h-8 w-36" /><label htmlFor="variance-to" className="sr-only">To</label><Input id="variance-to" name="to" type="date" defaultValue={props.varianceRange.to} className="h-8 w-36" /><Button size="sm" variant="outline" type="submit">Apply</Button></form><Button size="sm" variant="outline" onClick={exportVariance}><FileSpreadsheet /> Export CSV</Button><Select value={dimension} onValueChange={(value) => setDimension(value as typeof dimension)}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent>{["reason","community","plan","division","vendor","superintendent","month"].map((value) => <SelectItem key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</SelectItem>)}</SelectContent></Select></div>} /><div className="border-b px-4 py-3"><div className="h-2 bg-muted"><div className={`h-full ${props.variance.summary.varianceRate > .02 ? "bg-destructive" : "bg-primary"}`} style={{ width: `${Math.min(props.variance.summary.varianceRate / .04 * 100, 100)}%` }} /></div><div className="mt-1 flex justify-between text-xs text-muted-foreground"><span>0%</span><span>Benchmark 1–2%</span><span>4%+</span></div></div><Table><TableHeader><TableRow><TableHead>Group</TableHead><TableHead className="text-right">Net</TableHead><TableHead className="text-right">Absolute</TableHead><TableHead className="text-right">Incidence</TableHead><TableHead className="text-right">Direct-cost budget</TableHead><TableHead className="text-right">Rate</TableHead></TableRow></TableHeader><TableBody>{varianceRows.map((row) => <TableRow key={`${row.dimension}:${row.dimension_id}`}><TableCell className="font-medium">{row.dimension_label}</TableCell><TableCell className="text-right tabular-nums">{money(row.net_variance_cents)}</TableCell><TableCell className="text-right tabular-nums">{money(row.absolute_variance_cents)}</TableCell><TableCell className="text-right tabular-nums">{row.incidence}</TableCell><TableCell className="text-right tabular-nums">{money(row.direct_cost_budget_cents)}</TableCell><TableCell className={`text-right font-medium tabular-nums ${row.variance_rate > .02 ? "text-destructive" : ""}`}>{(row.variance_rate * 100).toFixed(2)}%</TableCell></TableRow>)}{varianceRows.length === 0 && <EmptyRow columns={6} icon={<FileSpreadsheet />} text="No approved VPO variance in this period." />}</TableBody></Table></TabsContent>}

      <TabsContent value="completions" className="m-0"><SectionHeader title="Pay-on-PO completions" detail="Verify field reports before creating an approved vendor bill" /><Table><TableHeader><TableRow><TableHead>Project</TableHead><TableHead>Purchase order</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Reported</TableHead><TableHead /></TableRow></TableHeader><TableBody>{props.completions.map((row) => <TableRow key={row.id}><TableCell>{row.project}</TableCell><TableCell className="font-medium">{row.po}</TableCell><TableCell><StateBadge value={row.status} /></TableCell><TableCell className="text-right tabular-nums">{money(row.amountCents)}</TableCell><TableCell>{shortDate(row.reportedAt)}</TableCell><TableCell className="text-right">{row.status === "reported" && <Button size="sm" variant="ghost" onClick={() => mutate(() => verifyPoCompletionAction(row.id), "Completion verified")}><PackageCheck /> Verify</Button>}{row.status === "verified" && <Button size="sm" variant="ghost" onClick={() => props.requiresInspection ? setApproving(row.id) : mutate(() => approvePoCompletionAction(row.id), "Completion approved and vendor bill created")}><CircleDollarSign /> Approve & bill</Button>}{["reported","verified"].includes(row.status) && <Button size="sm" variant="ghost" onClick={() => { const reason = window.prompt("Rejection reason"); if (reason) mutate(() => rejectPoCompletionAction(row.id, reason), "Completion rejected") }}><X /> Reject</Button>}</TableCell></TableRow>)}{props.completions.length === 0 && <EmptyRow columns={6} icon={<PackageCheck />} text="No completion reports are waiting." />}</TableBody></Table>{approving && <CompletionApprovalDialog completionId={approving} open pending={pending} onOpenChange={(open) => { if (!open) setApproving(null) }} onApprove={(evidence) => mutate(() => approvePoCompletionAction(approving, evidence), "Completion approved and vendor bill created", () => setApproving(null))} />}</TabsContent>
      <TabsContent value="deliveries" className="m-0">{props.deliveries}</TabsContent>

      <TabsContent value="acknowledgments" className="m-0">{props.acknowledgments}</TabsContent>
    </Tabs>
  </div>
}

function Stat({ label, value, detail, warning }: { label: string; value: string; detail?: string; warning?: boolean }) { return <div className="border-b px-4 py-3 sm:border-b-0 sm:border-r"><div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div><div className={`mt-1 text-xl font-semibold tabular-nums ${warning ? "text-destructive" : ""}`}>{value}</div>{detail && <div className="text-xs text-muted-foreground">{detail}</div>}</div> }
function SectionHeader({ title, detail, actions }: { title: string; detail: string; actions?: React.ReactNode }) { return <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b px-4 py-2"><div><h2 className="font-semibold">{title}</h2><p className="text-xs text-muted-foreground">{detail}</p></div>{actions}</div> }
function StateBadge({ value }: { value: string }) { const active = ["active","approved","verified","billed","awarded"].includes(value); return <Badge variant={active ? "secondary" : value === "rejected" || value === "void" ? "destructive" : "outline"} className="rounded-none capitalize">{value.replaceAll("_", " ")}</Badge> }
function EmptyRow({ columns, icon, text }: { columns: number; icon: React.ReactNode; text: string }) { return <TableRow><TableCell colSpan={columns} className="h-36 text-center"><div className="mx-auto flex max-w-md flex-col items-center gap-2 text-muted-foreground"><span className="[&_svg]:size-5">{icon}</span><span>{text}</span></div></TableCell></TableRow> }
