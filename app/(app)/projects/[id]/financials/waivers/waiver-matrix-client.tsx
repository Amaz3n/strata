"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { format } from "date-fns"
import { toast } from "sonner"

import type { CommitmentSummary } from "@/lib/services/commitments"
import type { WaiverMatrixRow } from "@/lib/services/lien-waivers"
import { cn, formatLocalDate, parseLocalDate } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar as CalendarPicker } from "@/components/ui/calendar"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Building2,
  Calendar,
  CheckCircle2,
  ChevronDown,
  Clock,
  Plus,
  Search,
  ShieldCheck,
} from "@/components/icons"
import { createSubtierRequirementAction } from "./actions"
import { WaiverClaimantSheet, type ClaimantFormValues } from "./waiver-claimant-sheet"

type StatusFilter = "all" | "received" | "missing"

const filterOrder: StatusFilter[] = ["all", "missing", "received"]

const filterLabel: Record<StatusFilter, string> = {
  all: "All",
  missing: "Missing",
  received: "Received",
}

const waiverTypeLabel: Record<string, string> = {
  conditional: "Conditional",
  unconditional: "Unconditional",
  final: "Final",
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

interface RequirementView {
  id: string
  claimant_company_name: string
  waiver_type: string
  amount_cents: number
  received: boolean
}

interface WaiverMatrixClientProps {
  projectId: string
  periodEnd: string
  commitments: CommitmentSummary[]
  matrix: WaiverMatrixRow[]
  requireSubtierWaivers: boolean
}

export function WaiverMatrixClient({
  projectId,
  periodEnd,
  commitments,
  matrix,
  requireSubtierWaivers,
}: WaiverMatrixClientProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [periodOpen, setPeriodOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")

  const totals = useMemo(() => {
    let total = 0
    let received = 0
    for (const row of matrix) {
      for (const req of row.requirements) {
        total += 1
        if ((req as RequirementView).received) received += 1
      }
    }
    return { total, received, missing: total - received }
  }, [matrix])

  const groups = useMemo(() => {
    const term = search.trim().toLowerCase()
    return matrix
      .map((row) => {
        const requirements = (row.requirements as RequirementView[]).filter((req) => {
          const matchesStatus =
            statusFilter === "all" ||
            (statusFilter === "received" ? req.received : !req.received)
          const matchesSearch =
            term.length === 0 ||
            req.claimant_company_name.toLowerCase().includes(term) ||
            row.through_company_name.toLowerCase().includes(term)
          return matchesStatus && matchesSearch
        })
        return { row, requirements }
      })
      .filter((group) => group.requirements.length > 0)
  }, [matrix, search, statusFilter])

  function handlePeriodChange(next: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return
    router.push(`/projects/${projectId}/financials/waivers?periodEnd=${next}`)
  }

  async function handleAddClaimant(values: ClaimantFormValues): Promise<boolean> {
    const commitment = commitments.find((item) => item.id === values.commitment_id)
    if (!commitment?.company_id) {
      toast.error("Selected commitment has no first-tier company")
      return false
    }
    return await new Promise<boolean>((resolve) => {
      startTransition(async () => {
        const result = await createSubtierRequirementAction({
          projectId,
          commitmentId: values.commitment_id,
          throughCompanyId: commitment.company_id!,
          claimantCompanyName: values.claimant_company_name,
          periodEnd,
          amountCents: Math.round(values.amount_dollars * 100),
          waiverType: values.waiver_type,
        })
        if (result.success) {
          toast.success("Claimant added", { description: values.claimant_company_name })
          router.refresh()
          resolve(true)
        } else {
          toast.error(result.error)
          resolve(false)
        }
      })
    })
  }

  const hasCommitments = commitments.some((item) => item.company_id)

  return (
    <>
      <WaiverClaimantSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        commitments={commitments}
        periodEnd={periodEnd}
        isSubmitting={pending}
        onSubmit={handleAddClaimant}
      />

      <div className="flex min-h-full flex-col">
        {/* Header */}
        <div className="sticky top-0 z-20 flex flex-col gap-3 border-b bg-background px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <Popover open={periodOpen} onOpenChange={setPeriodOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 justify-start gap-2 px-3 font-normal"
                >
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span className="flex flex-col items-start leading-none">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Pay period ending
                    </span>
                    <span className="text-sm tabular-nums">
                      {formatLocalDate(periodEnd, "MMM d, yyyy")}
                    </span>
                  </span>
                  <ChevronDown className="ml-1 h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <CalendarPicker
                  mode="single"
                  selected={parseLocalDate(periodEnd) ?? undefined}
                  onSelect={(date) => {
                    if (date) handlePeriodChange(format(date, "yyyy-MM-dd"))
                    setPeriodOpen(false)
                  }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
            <div className="relative sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search claimants..."
                className="h-9 pl-9"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className="flex items-center gap-1.5">
              {filterOrder.map((key) => {
                const active = statusFilter === key
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setStatusFilter(key)}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {filterLabel[key]}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 lg:justify-end">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>
                Enforcement{" "}
                <span className={requireSubtierWaivers ? "text-success" : "text-muted-foreground"}>
                  {requireSubtierWaivers ? "on" : "off"}
                </span>
              </span>
            </div>
            <Button onClick={() => setSheetOpen(true)} disabled={!hasCommitments}>
              <Plus className="mr-2 h-4 w-4" />
              Add claimant
            </Button>
          </div>
        </div>

        {/* Summary strip */}
        <div className="flex items-center gap-4 border-b bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
          <span>
            <span className="font-medium text-foreground tabular-nums">{totals.total}</span> claimant
            {totals.total === 1 ? "" : "s"}
          </span>
          <span className="text-success">
            <span className="font-medium tabular-nums">{totals.received}</span> received
          </span>
          <span className={totals.missing > 0 ? "text-warning" : ""}>
            <span className="font-medium tabular-nums">{totals.missing}</span> missing
          </span>
        </div>

        {/* Body */}
        <div className="flex-1">
          {groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-24 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <ShieldCheck className="h-6 w-6 text-muted-foreground" />
              </div>
              <div className="max-w-sm">
                <p className="font-medium">
                  {matrix.length === 0 || totals.total === 0
                    ? "No waiver requirements this pay period"
                    : "No claimants match your filters"}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {matrix.length === 0 || totals.total === 0
                    ? "Add the suppliers and sub-subcontractors whose waivers must be collected before payment."
                    : "Try a different status or clear the search."}
                </p>
              </div>
              {(matrix.length === 0 || totals.total === 0) && hasCommitments ? (
                <Button className="mt-1" onClick={() => setSheetOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add claimant
                </Button>
              ) : null}
              {!hasCommitments ? (
                <p className="text-xs text-muted-foreground">
                  Create a first-tier subcontract commitment to require sub-tier waivers.
                </p>
              ) : null}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="pl-4">Claimant</TableHead>
                  <TableHead className="w-[140px]">Type</TableHead>
                  <TableHead className="w-[140px] text-right">Amount</TableHead>
                  <TableHead className="w-[140px] pr-4 text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map(({ row, requirements }) => {
                  const groupReceived = requirements.filter((req) => req.received).length
                  const complete = groupReceived === requirements.length
                  return (
                    <GroupRows
                      key={`${row.commitment_id}:${row.through_company_id}`}
                      companyName={row.through_company_name}
                      tierOneCount={row.tier_one.length}
                      groupReceived={groupReceived}
                      groupTotal={requirements.length}
                      complete={complete}
                      requirements={requirements}
                    />
                  )
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </>
  )
}

function GroupRows({
  companyName,
  tierOneCount,
  groupReceived,
  groupTotal,
  complete,
  requirements,
}: {
  companyName: string
  tierOneCount: number
  groupReceived: number
  groupTotal: number
  complete: boolean
  requirements: RequirementView[]
}) {
  return (
    <>
      <TableRow className="border-t-2 bg-muted/25 hover:bg-muted/25">
        <TableCell colSpan={3} className="py-2 pl-4">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">{companyName}</span>
            {tierOneCount > 0 ? (
              <span className="text-xs text-muted-foreground">
                · {tierOneCount} first-tier waiver{tierOneCount === 1 ? "" : "s"} on file
              </span>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="py-2 pr-4 text-right">
          <Badge
            variant="outline"
            className={cn(
              "font-normal tabular-nums",
              complete
                ? "border-success/30 bg-success/15 text-success"
                : "border-warning/40 bg-warning/15 text-warning",
            )}
          >
            {groupReceived}/{groupTotal} received
          </Badge>
        </TableCell>
      </TableRow>
      {requirements.map((req) => (
        <TableRow key={req.id} className="h-12">
          <TableCell className="pl-4">
            <span className="text-sm font-medium">{req.claimant_company_name}</span>
          </TableCell>
          <TableCell>
            <Badge variant="outline" className="font-normal">
              {waiverTypeLabel[req.waiver_type] ?? req.waiver_type}
            </Badge>
          </TableCell>
          <TableCell className="text-right text-sm tabular-nums">
            {req.amount_cents > 0 ? usd.format(req.amount_cents / 100) : "—"}
          </TableCell>
          <TableCell className="pr-4 text-right">
            {req.received ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Received
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-warning">
                <Clock className="h-3.5 w-3.5" />
                Missing
              </span>
            )}
          </TableCell>
        </TableRow>
      ))}
    </>
  )
}
