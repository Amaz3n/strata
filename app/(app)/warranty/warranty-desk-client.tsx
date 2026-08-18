"use client"

import { useCallback, useMemo, useState, useTransition } from "react"
import { AlertTriangle, CalendarClock, PhoneCall, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type {
  WarrantyBackchargeDTO, WarrantyCostSummaryRow, WarrantyDefectAnalysisRow, WarrantyServiceVisitDTO,
} from "@/lib/services/warranty"
import type { RankedOriginatingCommitment, WarrantyCostBasisItem, WarrantySlaState } from "@/lib/services/warranty/domain"
import { warrantyFirstResponseState, warrantyResolutionState } from "@/lib/services/warranty/domain"
import type { WarrantyRequest } from "@/lib/types"
import {
  acknowledgeWarrantyRequestAction, createWarrantyBackchargeAction, disputeWarrantyBackchargeAction,
  findOriginatingCommitmentsAction, generateWarrantyCourtesyInspectionsAction, getWarrantyRequestCostBasisAction,
  issueWarrantyBackchargeAction, resolveWarrantyBackchargeAction, scheduleWarrantyVisitAction,
  verifyWarrantyVisitAction,
} from "./actions"

type DeskRequest = WarrantyRequest & { project_name?: string | null; community_name?: string | null }
type DispatchVisit = WarrantyServiceVisitDTO & { request?: Record<string, unknown> | null; project?: Record<string, unknown> | null }
type CostBasisDraft = { label: string; amount: string }

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const moneyExact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

const SLA_TONE: Record<WarrantySlaState, string> = {
  breached: "text-destructive font-medium",
  due_soon: "text-warning font-medium",
  met: "text-success",
  on_track: "text-muted-foreground",
  unset: "text-muted-foreground",
}

const SLA_LABEL: Record<WarrantySlaState, string> = {
  breached: "Overdue", due_soon: "Due soon", met: "Met", on_track: "On track", unset: "—",
}

const QUEUE_FILTERS = [
  { value: "all", label: "All open" },
  { value: "awaiting_first_response", label: "Awaiting first contact" },
  { value: "first_response_breached", label: "First response overdue" },
  { value: "breached", label: "Resolution overdue" },
] as const

const RESOLUTIONS = [
  { value: "recovered", label: "Recovered in full", destructive: false },
  { value: "written_off", label: "Write off", destructive: true },
  { value: "waived", label: "Waive", destructive: true },
] as const

function countdown(value?: string | null) {
  if (!value) return "—"
  const hours = Math.round((new Date(value).getTime() - Date.now()) / 3_600_000)
  return hours < 0 ? `${Math.abs(hours)}h over` : `${hours}h left`
}

function centsFromInput(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0
}

function draftTotalCents(rows: CostBasisDraft[]) {
  return rows.reduce((sum, row) => sum + centsFromInput(row.amount), 0)
}

export function WarrantyDeskClient({
  requests: initialRequests, total, visits, pendingVerification: initialPendingVerification,
  backcharges, defects, costs, technicians, companies,
}: {
  requests: DeskRequest[]
  total: number
  visits: DispatchVisit[]
  pendingVerification: DispatchVisit[]
  backcharges: WarrantyBackchargeDTO[]
  defects: WarrantyDefectAnalysisRow[]
  costs: WarrantyCostSummaryRow[]
  technicians: Array<{ id: string; name: string }>
  companies: Array<{ id: string; name: string }>
}) {
  const [requests, setRequests] = useState(initialRequests)
  const [scheduledVisits, setScheduledVisits] = useState(visits)
  const [awaitingVerification, setAwaitingVerification] = useState(initialPendingVerification)
  const [charges, setCharges] = useState(backcharges)
  const [selected, setSelected] = useState<DeskRequest | null>(null)
  const [pending, startTransition] = useTransition()

  const [filter, setFilter] = useState("")
  const [slaFilter, setSlaFilter] = useState<string>("all")

  const [acknowledgeChannel, setAcknowledgeChannel] = useState("phone")
  const [acknowledgeNote, setAcknowledgeNote] = useState("")

  const [assigneeKind, setAssigneeKind] = useState<"tech" | "trade">("tech")
  const [assigneeId, setAssigneeId] = useState("")
  const [windowStart, setWindowStart] = useState("")
  const [windowEnd, setWindowEnd] = useState("")

  const [commitments, setCommitments] = useState<RankedOriginatingCommitment[]>([])
  const [commitmentsLoaded, setCommitmentsLoaded] = useState(false)
  const [commitmentId, setCommitmentId] = useState("")
  const [backchargeCompanyId, setBackchargeCompanyId] = useState("")
  const [backchargeReason, setBackchargeReason] = useState("")
  const [costBasis, setCostBasis] = useState<CostBasisDraft[]>([{ label: "", amount: "" }])
  const [confirmNoApHistory, setConfirmNoApHistory] = useState(false)

  const [verifyNote, setVerifyNote] = useState<Record<string, string>>({})
  const [disputeNote, setDisputeNote] = useState<Record<string, string>>({})
  const [resolving, setResolving] = useState<{ charge: WarrantyBackchargeDTO; resolution: (typeof RESOLUTIONS)[number] } | null>(null)
  const [resolveNote, setResolveNote] = useState("")

  const now = useMemo(() => new Date(), [])

  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase()
    return requests.filter((request) => {
      if (term && !`${request.title} ${request.project_name ?? ""} ${request.community_name ?? ""}`.toLowerCase().includes(term)) return false
      if (slaFilter === "all") return true
      const firstResponse = warrantyFirstResponseState(request, now)
      if (slaFilter === "awaiting_first_response") return firstResponse !== "met"
      if (slaFilter === "first_response_breached") return firstResponse === "breached"
      return warrantyResolutionState(request, now) === "breached"
    })
  }, [requests, filter, slaFilter, now])

  const openSheet = useCallback((request: DeskRequest) => {
    setSelected(request)
    setAcknowledgeChannel("phone"); setAcknowledgeNote("")
    setAssigneeKind("tech"); setAssigneeId(""); setWindowStart(""); setWindowEnd("")
    setCommitments([]); setCommitmentsLoaded(false); setCommitmentId("")
    setBackchargeCompanyId(request.assigned_company_id ?? "")
    setBackchargeReason(""); setConfirmNoApHistory(false)
    setCostBasis([{ label: "", amount: "" }])
    startTransition(async () => {
      const [candidates, basis] = await Promise.all([
        findOriginatingCommitmentsAction({ projectId: request.project_id, costCodeId: request.cost_code_id, companyId: request.assigned_company_id }),
        getWarrantyRequestCostBasisAction(request.id),
      ])
      if (candidates.success) setCommitments(candidates.data)
      setCommitmentsLoaded(true)
      if (basis.success && basis.data.length) {
        setCostBasis(basis.data.map((item) => ({ label: item.label, amount: (item.amount_cents / 100).toFixed(2) })))
      }
    })
  }, [])

  const basisTotalCents = draftTotalCents(costBasis)
  const basisReady = costBasis.length > 0 && costBasis.every((row) => row.label.trim() && centsFromInput(row.amount) > 0)
  const chosenCommitment = commitments.find((candidate) => candidate.id === commitmentId) ?? null

  function submitBackcharge() {
    if (!selected) return
    const items: WarrantyCostBasisItem[] = costBasis.map((row) => ({ label: row.label.trim(), amount_cents: centsFromInput(row.amount) }))
    startTransition(async () => {
      const result = await createWarrantyBackchargeAction({
        project_id: selected.project_id, warranty_request_id: selected.id, company_id: backchargeCompanyId,
        commitment_id: commitmentId || null, cost_code_id: selected.cost_code_id,
        amount_cents: basisTotalCents, reason: backchargeReason.trim(), cost_basis: items,
        notes: chosenCommitment ? `Originating PO: ${chosenCommitment.contract_number ?? chosenCommitment.title} (${chosenCommitment.match_reason})` : null,
        confirm_no_ap_history: confirmNoApHistory,
      })
      if (!result.success) { toast.error(result.error); return }
      setCharges((rows) => [result.data, ...rows])
      setBackchargeReason(""); setConfirmNoApHistory(false); setCommitmentId("")
      setCostBasis([{ label: "", amount: "" }])
      toast.success("Backcharge draft created")
    })
  }

  return (
    <div className="desk-rise space-y-4">
      <Tabs defaultValue="queue" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="queue">Queue</TabsTrigger>
            <TabsTrigger value="dispatch">Dispatch</TabsTrigger>
            <TabsTrigger value="verify">Verify{awaitingVerification.length ? ` (${awaitingVerification.length})` : ""}</TabsTrigger>
            <TabsTrigger value="backcharges">Backcharges</TabsTrigger>
            <TabsTrigger value="analytics">Analytics</TabsTrigger>
          </TabsList>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => startTransition(async () => {
              const result = await generateWarrantyCourtesyInspectionsAction()
              if (!result.success) { toast.error(result.error); return }
              toast.success(result.data.created ? `${result.data.created} courtesy inspection${result.data.created === 1 ? "" : "s"} scheduled` : "No courtesy inspections are due")
            })}
          >
            Generate courtesy inspections
          </Button>
        </div>

        <TabsContent value="queue" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input className="w-72" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search home, community, or request" />
              <Select value={slaFilter} onValueChange={setSlaFilter}>
                <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                <SelectContent>{QUEUE_FILTERS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground tabular-nums">
              {visible.length} of {requests.length} shown{total > requests.length ? ` · ${total} open in total (first ${requests.length} loaded)` : ""}
            </p>
          </div>
          <div className="overflow-x-auto border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Home</th>
                  <th className="px-3 py-2 font-medium">Request</th>
                  <th className="px-3 py-2 font-medium">Severity</th>
                  <th className="px-3 py-2 font-medium">Coverage</th>
                  <th className="px-3 py-2 font-medium">Assignee</th>
                  <th className="px-3 py-2 font-medium">First response</th>
                  <th className="px-3 py-2 font-medium">Resolution</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.map((request) => {
                  const firstResponse = warrantyFirstResponseState(request, now)
                  const resolution = warrantyResolutionState(request, now)
                  const courtesy = typeof request.metadata?.courtesy_milestone === "string"
                  return (
                    <tr key={request.id} className="transition-colors hover:bg-muted/30">
                      <td className="px-3 py-2 tabular-nums">
                        <Button variant="link" className="h-auto p-0" onClick={() => openSheet(request)}>WR-{request.request_number}</Button>
                      </td>
                      <td className="px-3 py-2">
                        <p>{request.project_name ?? "Home"}</p>
                        <p className="text-xs text-muted-foreground">{request.community_name ?? "—"}</p>
                      </td>
                      <td className="px-3 py-2">
                        <p className="font-medium">{request.title}</p>
                        <p className="text-xs text-muted-foreground">{courtesy ? "Courtesy inspection" : request.category ?? "Uncategorized"}</p>
                      </td>
                      <td className="px-3 py-2"><Badge variant={request.severity === "emergency" ? "destructive" : "outline"}>{request.severity?.replaceAll("_", " ")}</Badge></td>
                      <td className="px-3 py-2"><Badge variant="outline">{request.coverage_status?.replaceAll("_", " ")}</Badge></td>
                      <td className="px-3 py-2">{request.assigned_user_name ?? request.assigned_company_name ?? "Unassigned"}</td>
                      <td className={cn("px-3 py-2 tabular-nums", SLA_TONE[firstResponse])}>
                        {firstResponse === "met" ? "Contacted" : `${SLA_LABEL[firstResponse]} · ${countdown(request.first_response_due_at)}`}
                      </td>
                      <td className={cn("px-3 py-2 tabular-nums", SLA_TONE[resolution])}>
                        {countdown(request.resolution_due_at)}
                        {request.cost_dump_flag ? <AlertTriangle className="ml-2 inline size-3 text-warning" aria-label="Possible cost dump" /> : null}
                      </td>
                      <td className="px-3 py-2">{request.status.replaceAll("_", " ")}</td>
                    </tr>
                  )
                })}
                {visible.length === 0 ? (
                  <tr><td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">No warranty requests match this queue.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="dispatch">
          <div className="grid gap-3 border border-border p-3 md:grid-cols-7">
            {Array.from({ length: 7 }, (_, day) => {
              const date = new Date()
              date.setDate(date.getDate() - date.getDay() + day)
              const dayVisits = scheduledVisits.filter((visit) => new Date(visit.window_start).toDateString() === date.toDateString())
              return (
                <div key={day} className="min-h-40 border border-border">
                  <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1 text-xs font-medium">
                    <span>{date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>
                    <span className="tabular-nums text-muted-foreground">{dayVisits.length || ""}</span>
                  </div>
                  <div className="space-y-1 p-1">
                    {dayVisits.map((visit) => (
                      <div key={visit.id} className="border border-border p-2 text-xs">
                        <p className="font-medium">{String(visit.request?.title ?? "Service visit")}</p>
                        <p className="text-muted-foreground">
                          {new Date(visit.window_start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · {visit.assigned_user_name ?? visit.assigned_company_name}
                        </p>
                      </div>
                    ))}
                    {dayVisits.length === 0 ? <p className="px-1 py-2 text-xs text-muted-foreground">No visits</p> : null}
                  </div>
                </div>
              )
            })}
          </div>
        </TabsContent>

        <TabsContent value="verify">
          <div className="overflow-x-auto border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Request</th>
                  <th className="px-3 py-2 font-medium">Home</th>
                  <th className="px-3 py-2 font-medium">Completed by</th>
                  <th className="px-3 py-2 font-medium">Reported outcome</th>
                  <th className="px-3 py-2 font-medium">Verification note</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {awaitingVerification.map((visit) => (
                  <tr key={visit.id} className="align-top transition-colors hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <p className="font-medium">{String(visit.request?.title ?? `Visit ${visit.visit_number}`)}</p>
                      <p className="text-xs text-muted-foreground">{visit.outcome_note ?? "No note provided"}</p>
                    </td>
                    <td className="px-3 py-2">{String(visit.project?.name ?? "Home")}</td>
                    <td className="px-3 py-2">{visit.assigned_company_name ?? visit.assigned_user_name ?? "—"}</td>
                    <td className="px-3 py-2">
                      <Badge variant={visit.outcome === "resolved" ? "outline" : "secondary"}>{visit.outcome?.replaceAll("_", " ") ?? "—"}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        value={verifyNote[visit.id] ?? ""}
                        onChange={(event) => setVerifyNote((state) => ({ ...state, [visit.id]: event.target.value }))}
                        placeholder="What the homeowner is told"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() => startTransition(async () => {
                          const result = await verifyWarrantyVisitAction(visit.id, verifyNote[visit.id]?.trim() || undefined)
                          if (!result.success) { toast.error(result.error); return }
                          setAwaitingVerification((rows) => rows.filter((row) => row.id !== visit.id))
                          setRequests((rows) => rows.filter((row) => row.id !== visit.request_id || visit.outcome !== "resolved"))
                          toast.success(visit.outcome === "resolved" ? "Verified and resolved" : "Verified — request stays open")
                        })}
                      >
                        Verify
                      </Button>
                    </td>
                  </tr>
                ))}
                {awaitingVerification.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">Nothing is waiting on verification.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="backcharges">
          <div className="overflow-x-auto border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Trade</th>
                  <th className="px-3 py-2 font-medium">Home</th>
                  <th className="px-3 py-2 font-medium">Originating PO</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 text-right font-medium">Recovered</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {charges.map((charge) => (
                  <tr key={charge.id} className="align-top transition-colors hover:bg-muted/30">
                    <td className="px-3 py-2 tabular-nums">WB-{charge.backcharge_number}</td>
                    <td className="px-3 py-2">{charge.company_name}</td>
                    <td className="px-3 py-2">{charge.project_name}</td>
                    <td className="px-3 py-2">
                      {charge.commitment_id ? <Badge variant="outline">Linked</Badge> : <span className="text-xs text-warning">Unlinked</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{money.format(charge.amount_cents / 100)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money.format(charge.recovered_cents / 100)}</td>
                    <td className="px-3 py-2"><Badge variant="outline">{charge.status.replaceAll("_", " ")}</Badge></td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {charge.status === "draft" ? (
                          <Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(async () => {
                            const result = await issueWarrantyBackchargeAction(charge.id)
                            if (!result.success) { toast.error(result.error); return }
                            setCharges((rows) => rows.map((row) => row.id === charge.id ? result.data : row))
                            toast.success("Backcharge issued as a vendor credit")
                          })}>Issue</Button>
                        ) : null}
                        {charge.status === "issued" ? (
                          <>
                            <Input
                              className="h-8 w-48"
                              value={disputeNote[charge.id] ?? ""}
                              onChange={(event) => setDisputeNote((state) => ({ ...state, [charge.id]: event.target.value }))}
                              placeholder="Dispute reason"
                            />
                            <Button size="sm" variant="outline" disabled={pending || !(disputeNote[charge.id] ?? "").trim()} onClick={() => startTransition(async () => {
                              const result = await disputeWarrantyBackchargeAction({ backcharge_id: charge.id, note: (disputeNote[charge.id] ?? "").trim() })
                              if (!result.success) { toast.error(result.error); return }
                              setCharges((rows) => rows.map((row) => row.id === charge.id ? result.data : row))
                              setDisputeNote((state) => ({ ...state, [charge.id]: "" }))
                              toast.success("Dispute recorded")
                            })}>Dispute</Button>
                          </>
                        ) : null}
                        {["issued", "disputed"].includes(charge.status) ? RESOLUTIONS.map((resolution) => (
                          <Button
                            key={resolution.value}
                            size="sm"
                            variant={resolution.destructive ? "outline" : "default"}
                            disabled={pending}
                            onClick={() => { setResolving({ charge, resolution }); setResolveNote("") }}
                          >
                            {resolution.label}
                          </Button>
                        )) : null}
                      </div>
                    </td>
                  </tr>
                ))}
                {charges.length === 0 ? (
                  <tr><td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">No warranty backcharges. Open a request to create one.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="analytics" className="space-y-5">
          <section>
            <h2 className="mb-2 text-sm font-semibold">Recurring defects by community</h2>
            <div className="overflow-x-auto border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Community</th>
                    <th className="px-3 py-2 text-right font-medium">Requests</th>
                    <th className="px-3 py-2 text-right font-medium">Affected homes</th>
                    <th className="px-3 py-2 text-right font-medium">Closed homes</th>
                    <th className="px-3 py-2 text-right font-medium">Affected %</th>
                    <th className="px-3 py-2 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {defects.map((row) => (
                    <tr key={row.group_id} className="transition-colors hover:bg-muted/30">
                      <td className="px-3 py-2">{row.group_name ?? "Unknown"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.request_count}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.affected_home_count}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.closed_home_count}</td>
                      <td className={cn("px-3 py-2 text-right tabular-nums", (row.affected_home_percent ?? 0) > 25 ? "text-destructive font-medium" : "")}>
                        {row.affected_home_percent == null ? "—" : `${row.affected_home_percent.toFixed(1)}%`}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{money.format(row.remediation_cost_cents / 100)}</td>
                    </tr>
                  ))}
                  {defects.length === 0 ? (
                    <tr><td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">No warranty history in this scope yet.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold">Warranty cost benchmark</h2>
            <p className="mb-2 text-xs text-muted-foreground">Includes self-performed technician labor and materials, not only trade recoveries. Industry benchmark is 0.7–1.0% of closed revenue.</p>
            <div className="overflow-x-auto border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Community</th>
                    <th className="px-3 py-2 text-right font-medium">Warranty cost</th>
                    <th className="px-3 py-2 text-right font-medium">Recovered</th>
                    <th className="px-3 py-2 text-right font-medium">Net cost</th>
                    <th className="px-3 py-2 text-right font-medium">Closed revenue</th>
                    <th className="px-3 py-2 text-right font-medium">Cost %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {costs.map((row) => (
                    <tr key={row.community_id} className="transition-colors hover:bg-muted/30">
                      <td className="px-3 py-2">{row.community_name ?? "Unknown"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money.format(row.warranty_cost_cents / 100)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money.format(row.recovered_cents / 100)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money.format(row.net_cost_cents / 100)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.closed_revenue_cents ? money.format(row.closed_revenue_cents / 100) : "—"}</td>
                      <td className={cn("px-3 py-2 text-right tabular-nums", (row.cost_percent ?? 0) > 1 ? "text-destructive font-medium" : "")}>
                        {row.cost_percent == null ? "—" : `${row.cost_percent.toFixed(2)}%`}
                      </td>
                    </tr>
                  ))}
                  {costs.length === 0 ? (
                    <tr><td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">No closed homes in this scope yet.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        </TabsContent>
      </Tabs>

      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{selected ? `WR-${selected.request_number} · ${selected.title}` : "Warranty request"}</SheetTitle>
          </SheetHeader>
          {selected ? (
            <div className="space-y-5 p-4">
              <div className="grid grid-cols-2 gap-3 border border-border p-3 text-sm">
                <div><p className="text-xs text-muted-foreground">Home</p><p>{selected.project_name}</p></div>
                <div><p className="text-xs text-muted-foreground">Coverage</p><p>{selected.coverage_status?.replaceAll("_", " ")}</p></div>
                <div><p className="text-xs text-muted-foreground">Severity</p><p>{selected.severity?.replaceAll("_", " ")}</p></div>
                <div>
                  <p className="text-xs text-muted-foreground">First response</p>
                  <p className={SLA_TONE[warrantyFirstResponseState(selected, now)]}>
                    {selected.first_responded_at ? new Date(selected.first_responded_at).toLocaleString() : `${SLA_LABEL[warrantyFirstResponseState(selected, now)]} · ${countdown(selected.first_response_due_at)}`}
                  </p>
                </div>
                <div className="col-span-2">
                  <p className="text-xs text-muted-foreground">Resolution</p>
                  <p className={SLA_TONE[warrantyResolutionState(selected, now)]}>{countdown(selected.resolution_due_at)}</p>
                </div>
              </div>

              {!selected.first_responded_at ? (
                <section>
                  <h3 className="mb-2 text-sm font-semibold">Log first contact</h3>
                  <div className="space-y-3 border border-border p-3">
                    <p className="text-xs text-muted-foreground">The first-response clock stops when the homeowner is actually contacted — not when a truck is dispatched.</p>
                    <Select value={acknowledgeChannel} onValueChange={setAcknowledgeChannel}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="phone">Phone call</SelectItem>
                        <SelectItem value="email">Email</SelectItem>
                        <SelectItem value="text">Text message</SelectItem>
                        <SelectItem value="in_person">In person</SelectItem>
                      </SelectContent>
                    </Select>
                    <Textarea value={acknowledgeNote} onChange={(event) => setAcknowledgeNote(event.target.value)} placeholder="What the homeowner was told" rows={2} />
                    <Button disabled={pending} onClick={() => startTransition(async () => {
                      const result = await acknowledgeWarrantyRequestAction({ request_id: selected.id, channel: acknowledgeChannel, note: acknowledgeNote.trim() || null })
                      if (!result.success) { toast.error(result.error); return }
                      setRequests((rows) => rows.map((row) => row.id === selected.id ? { ...row, first_responded_at: result.data.first_responded_at } : row))
                      setSelected((current) => current ? { ...current, first_responded_at: result.data.first_responded_at } : current)
                      toast.success("First response recorded")
                    })}>
                      <PhoneCall className="mr-2 size-4" />Record first contact
                    </Button>
                  </div>
                </section>
              ) : null}

              <section>
                <h3 className="mb-2 text-sm font-semibold">Schedule service visit</h3>
                <div className="space-y-3 border border-border p-3">
                  <div className="grid grid-cols-2 gap-2">
                    <Select value={assigneeKind} onValueChange={(value) => { setAssigneeKind(value === "trade" ? "trade" : "tech"); setAssigneeId("") }}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tech">In-house tech</SelectItem>
                        <SelectItem value="trade">Trade</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={assigneeId} onValueChange={setAssigneeId}>
                      <SelectTrigger><SelectValue placeholder="Choose assignee" /></SelectTrigger>
                      <SelectContent>{(assigneeKind === "tech" ? technicians : companies).map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="window-start">Window start</Label>
                      <Input id="window-start" type="datetime-local" value={windowStart} onChange={(event) => setWindowStart(event.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="window-end">Window end</Label>
                      <Input id="window-end" type="datetime-local" value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} />
                    </div>
                  </div>
                  <Button disabled={pending || !assigneeId || !windowStart || !windowEnd} onClick={() => startTransition(async () => {
                    const payload = {
                      request_id: selected.id, assignee_kind: assigneeKind,
                      assigned_user_id: assigneeKind === "tech" ? assigneeId : null,
                      assigned_company_id: assigneeKind === "trade" ? assigneeId : null,
                      window_start: new Date(windowStart).toISOString(), window_end: new Date(windowEnd).toISOString(),
                    }
                    let result = await scheduleWarrantyVisitAction(payload)
                    if (!result.success) {
                      if (!result.error.includes("already booked") || !window.confirm(`${result.error}\n\nBook anyway?`)) { toast.error(result.error); return }
                      result = await scheduleWarrantyVisitAction(payload, true)
                      if (!result.success) { toast.error(result.error); return }
                    }
                    const visit = result.data
                    setScheduledVisits((rows) => [...rows, visit])
                    setRequests((rows) => rows.map((row) => row.id === selected.id ? {
                      ...row, status: "in_progress",
                      assigned_user_id: visit.assigned_user_id ?? row.assigned_user_id,
                      assigned_user_name: visit.assigned_user_name ?? row.assigned_user_name,
                      assigned_company_id: visit.assigned_company_id ?? row.assigned_company_id,
                      assigned_company_name: visit.assigned_company_name ?? row.assigned_company_name,
                    } : row))
                    toast.success("Warranty visit scheduled")
                    setWindowStart(""); setWindowEnd("")
                  })}>
                    <CalendarClock className="mr-2 size-4" />Schedule visit
                  </Button>
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">Create trade backcharge</h3>
                <div className="space-y-3 border border-border p-3">
                  <div className="space-y-1.5">
                    <Label>Originating purchase order</Label>
                    {!commitmentsLoaded ? (
                      <p className="text-xs text-muted-foreground">Finding the PO that bought this work…</p>
                    ) : commitments.length === 0 ? (
                      <p className="text-xs text-warning">No commitments on this home. A backcharge without an originating PO is materially harder to recover.</p>
                    ) : (
                      <div className="max-h-56 divide-y divide-border overflow-y-auto border border-border">
                        {commitments.map((candidate) => (
                          <button
                            key={candidate.id}
                            type="button"
                            onClick={() => { setCommitmentId(candidate.id); if (candidate.company_id) setBackchargeCompanyId(candidate.company_id) }}
                            className={cn(
                              "flex w-full items-start justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40",
                              commitmentId === candidate.id ? "bg-muted" : "",
                            )}
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{candidate.contract_number ? `${candidate.contract_number} · ` : ""}{candidate.title}</span>
                              <span className="block truncate text-xs text-muted-foreground">{candidate.company_name ?? "No trade"} · {candidate.match_reason}</span>
                            </span>
                            <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{money.format(candidate.total_cents / 100)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label>Responsible trade</Label>
                    <Select value={backchargeCompanyId} onValueChange={setBackchargeCompanyId}>
                      <SelectTrigger><SelectValue placeholder="Responsible trade" /></SelectTrigger>
                      <SelectContent>{companies.map((company) => <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Cost basis</Label>
                    <p className="text-xs text-muted-foreground">Seeded from the internal cost recorded on this request&apos;s visits. Lines must add up to the backcharge total.</p>
                    {costBasis.map((row, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <Input
                          className="flex-1"
                          value={row.label}
                          onChange={(event) => setCostBasis((rows) => rows.map((item, position) => position === index ? { ...item, label: event.target.value } : item))}
                          placeholder="What this cost was"
                        />
                        <Input
                          className="w-32 text-right tabular-nums"
                          inputMode="decimal"
                          value={row.amount}
                          onChange={(event) => setCostBasis((rows) => rows.map((item, position) => position === index ? { ...item, amount: event.target.value } : item))}
                          placeholder="0.00"
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Remove cost line"
                          disabled={costBasis.length === 1}
                          onClick={() => setCostBasis((rows) => rows.filter((_, position) => position !== index))}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ))}
                    <div className="flex items-center justify-between">
                      <Button size="sm" variant="ghost" onClick={() => setCostBasis((rows) => [...rows, { label: "", amount: "" }])}>
                        <Plus className="mr-2 size-4" />Add line
                      </Button>
                      <p className="text-sm font-medium tabular-nums">{moneyExact.format(basisTotalCents / 100)}</p>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="backcharge-reason">Reason</Label>
                    <Textarea id="backcharge-reason" value={backchargeReason} onChange={(event) => setBackchargeReason(event.target.value)} placeholder="Why this trade is responsible" rows={2} />
                  </div>

                  <label className="flex items-start gap-2 text-xs text-muted-foreground">
                    <Checkbox checked={confirmNoApHistory} onCheckedChange={(checked) => setConfirmNoApHistory(checked === true)} />
                    <span>I confirm this trade can be backcharged even if Arc has no prior payable history for it.</span>
                  </label>

                  {!commitmentId && commitmentsLoaded && commitments.length > 0 ? (
                    <p className="text-xs text-warning">No originating PO selected — this backcharge will not be tied to the work that was bought.</p>
                  ) : null}

                  <Button variant="outline" disabled={pending || !backchargeCompanyId || !backchargeReason.trim() || !basisReady} onClick={submitBackcharge}>
                    Create draft
                  </Button>
                </div>
              </section>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <AlertDialog open={Boolean(resolving)} onOpenChange={(open) => { if (!open) setResolving(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {resolving ? `${resolving.resolution.label} WB-${resolving.charge.backcharge_number}?` : "Resolve backcharge"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {resolving?.resolution.value === "recovered"
                ? `Records ${moneyExact.format((resolving?.charge.amount_cents ?? 0) / 100)} as fully recovered. Backcharge resolutions are final.`
                : `Arc posts a reversing bill for ${moneyExact.format((resolving?.charge.amount_cents ?? 0) / 100)} against the original vendor credit. This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {resolving?.resolution.value !== "recovered" ? (
            <div className="space-y-1.5">
              <Label htmlFor="resolve-note">Resolution note</Label>
              <Textarea id="resolve-note" value={resolveNote} onChange={(event) => setResolveNote(event.target.value)} placeholder="Why this is not being recovered" rows={2} />
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending || (resolving?.resolution.value !== "recovered" && !resolveNote.trim())}
              onClick={() => {
                if (!resolving) return
                const { charge, resolution } = resolving
                startTransition(async () => {
                  const result = await resolveWarrantyBackchargeAction({
                    backcharge_id: charge.id, resolution: resolution.value,
                    recovered_cents: resolution.value === "recovered" ? charge.amount_cents : undefined,
                    note: resolution.value === "recovered" ? undefined : resolveNote.trim(),
                  })
                  if (!result.success) { toast.error(result.error); return }
                  setCharges((rows) => rows.map((row) => row.id === charge.id ? result.data : row))
                  setResolving(null); setResolveNote("")
                  toast.success(`Backcharge ${resolution.label.toLowerCase()}`)
                })
              }}
            >
              {resolving?.resolution.label ?? "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
