"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import type { BidPackage } from "@/lib/services/bids"
import { getBidPackageStage } from "@/lib/bids/stage"
import type { CostCode } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { CalendarDays, Plus } from "@/components/icons"
import { createBidPackageAction } from "@/app/(app)/bids/actions"
import { CostCodeSelectItems } from "@/components/cost-codes/cost-code-select-items"
import { unwrapAction } from "@/lib/action-result"
import {
  STAGE_LABELS,
  US_TIMEZONES,
  formatDueDate,
  isDuePast,
  money,
  relativeDueDate,
  signedMoney,
} from "@/components/bids/bid-workbench-helpers"
import type { BidPackageStage } from "@/lib/bids/stage"

interface BudgetLineOption {
  id: string
  description: string | null
  amount_cents: number | null
}

interface BidPackagesClientProps {
  projectId?: string
  prospectId?: string
  packages: BidPackage[]
  tradeOptions: string[]
  costCodes: CostCode[]
  budgetLines?: BudgetLineOption[]
  detailBasePath?: string
  createDescription?: string
  initialDraft?: {
    title?: string | null
    scope?: string | null
    cost_code_id?: string | null
    budget_line_id?: string | null
    amount_cents?: number | null
  } | null
}

const NO_TRADE_VALUE = "__none__"
const NO_COST_CODE = "__none__"
const ALL_STATUSES = "__all__"
const DEFAULT_TZ = "America/New_York"

const sortOptions = [
  { value: "needs_attention", label: "Needs attention" },
  { value: "due_soon", label: "Due soon" },
  { value: "coverage", label: "Lowest coverage" },
  { value: "lowest_bid", label: "Lowest bid" },
  { value: "newest", label: "Newest" },
] as const

type SortOption = (typeof sortOptions)[number]["value"]
type BidMode = "quote" | "tender"

const STAGE_TONE: Record<BidPackageStage, string> = {
  setup: "text-muted-foreground",
  bidding: "text-primary",
  leveling: "text-warning",
  awarded: "text-success",
  cancelled: "text-muted-foreground",
}

function combineDateAndTime(date: Date, time: string): Date {
  const [hoursRaw, minutesRaw] = time.split(":")
  const hours = Number.parseInt(hoursRaw ?? "", 10)
  const minutes = Number.parseInt(minutesRaw ?? "", 10)
  const next = new Date(date)
  next.setHours(Number.isFinite(hours) ? hours : 17, Number.isFinite(minutes) ? minutes : 0, 0, 0)
  return next
}

function CoverageBar({ responses, invited }: { responses: number; invited: number }) {
  const ratio = invited > 0 ? Math.min(1, responses / invited) : 0
  const incomplete = invited > 0 && responses < invited
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className={cn("h-full rounded-full", incomplete ? "bg-warning" : "bg-success")}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
      <span className="tabular-nums text-xs text-muted-foreground">
        {responses} of {invited}
      </span>
    </div>
  )
}

export function BidPackagesClient({
  projectId,
  prospectId,
  packages,
  tradeOptions,
  costCodes,
  budgetLines = [],
  detailBasePath,
  createDescription,
  initialDraft = null,
}: BidPackagesClientProps) {
  const router = useRouter()
  const [items, setItems] = useState(packages)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState(ALL_STATUSES)
  const [sortBy, setSortBy] = useState<SortOption>("needs_attention")
  const [createOpen, setCreateOpen] = useState(false)
  const [isCreating, startCreating] = useTransition()

  const [title, setTitle] = useState("")
  const [costCodeId, setCostCodeId] = useState(NO_COST_CODE)
  const [budgetLineId, setBudgetLineId] = useState<string | null>(null)
  const [trade, setTrade] = useState(NO_TRADE_VALUE)
  const [mode, setMode] = useState<BidMode>("quote")
  const [dueDate, setDueDate] = useState<Date | undefined>(undefined)
  const [dueTime, setDueTime] = useState("17:00")
  const [dueTz, setDueTz] = useState(DEFAULT_TZ)
  const [bondRequired, setBondRequired] = useState(false)
  const [scope, setScope] = useState("")
  const [instructions, setInstructions] = useState("")
  const [initialDraftApplied, setInitialDraftApplied] = useState(false)

  useEffect(() => {
    setItems(packages)
  }, [packages])

  useEffect(() => {
    if (initialDraftApplied || !initialDraft) return
    if (initialDraft.title) setTitle(initialDraft.title)
    if (initialDraft.scope) setScope(initialDraft.scope)
    if (initialDraft.cost_code_id) setCostCodeId(initialDraft.cost_code_id)
    if (initialDraft.budget_line_id) setBudgetLineId(initialDraft.budget_line_id)
    if (initialDraft.amount_cents && initialDraft.amount_cents > 0) {
      setInstructions(`Budget target: ${money(initialDraft.amount_cents)}`)
    }
    setCreateOpen(true)
    setInitialDraftApplied(true)
  }, [initialDraft, initialDraftApplied])

  const coveredBudgetLineIds = useMemo(
    () => new Set(items.map((item) => item.budget_line_id).filter((id): id is string => Boolean(id))),
    [items],
  )

  const filtered = useMemo(() => {
    const term = search.toLowerCase()
    const visible = items.filter((item) => {
      const haystack = [
        item.title,
        item.trade ?? "",
        item.scope ?? "",
        item.cost_code_code ?? "",
        item.cost_code_name ?? "",
      ]
        .join(" ")
        .toLowerCase()
      if (term && !haystack.includes(term)) return false
      if (statusFilter !== ALL_STATUSES && item.status !== statusFilter) return false
      return true
    })

    return [...visible].sort((a, b) => {
      const aInvites = a.invite_count ?? 0
      const bInvites = b.invite_count ?? 0
      const aResponses = a.response_count ?? 0
      const bResponses = b.response_count ?? 0
      const aDue = a.due_at ? new Date(a.due_at).getTime() : Number.POSITIVE_INFINITY
      const bDue = b.due_at ? new Date(b.due_at).getTime() : Number.POSITIVE_INFINITY

      if (sortBy === "due_soon") return aDue - bDue
      if (sortBy === "coverage") {
        return aResponses / Math.max(aInvites, 1) - bResponses / Math.max(bInvites, 1)
      }
      if (sortBy === "lowest_bid") {
        return (a.lowest_bid_cents ?? Number.POSITIVE_INFINITY) - (b.lowest_bid_cents ?? Number.POSITIVE_INFINITY)
      }
      if (sortBy === "newest") return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()

      const aNeeds = aInvites > 0 && aResponses < aInvites
      const bNeeds = bInvites > 0 && bResponses < bInvites
      if (aNeeds !== bNeeds) return aNeeds ? -1 : 1
      return aDue - bDue
    })
  }, [items, search, sortBy, statusFilter])

  const uncoveredBudgetLines = useMemo(() => {
    if (!projectId) return []
    const term = search.toLowerCase()
    return budgetLines.filter((line) => {
      if (coveredBudgetLineIds.has(line.id)) return false
      if (statusFilter !== ALL_STATUSES) return false
      if (term && !(line.description ?? "").toLowerCase().includes(term)) return false
      return true
    })
  }, [budgetLines, coveredBudgetLineIds, projectId, search, statusFilter])

  const resetForm = () => {
    setTitle("")
    setCostCodeId(NO_COST_CODE)
    setBudgetLineId(null)
    setTrade(NO_TRADE_VALUE)
    setMode("quote")
    setDueDate(undefined)
    setDueTime("17:00")
    setDueTz(DEFAULT_TZ)
    setBondRequired(false)
    setScope("")
    setInstructions("")
  }

  const openCreateForBudgetLine = (line: BudgetLineOption) => {
    resetForm()
    setTitle(line.description?.trim() || "New package")
    setBudgetLineId(line.id)
    if (line.amount_cents && line.amount_cents > 0) {
      setInstructions(`Budget target: ${money(line.amount_cents)}`)
    }
    setCreateOpen(true)
  }

  const handleCreate = () => {
    if (!title.trim()) {
      toast.error("Title is required")
      return
    }
    startCreating(async () => {
      try {
        if (!projectId && !prospectId) {
          throw new Error("Missing bid package context")
        }
        const payload = {
          title: title.trim(),
          cost_code_id: costCodeId === NO_COST_CODE ? null : costCodeId,
          budget_line_id: budgetLineId,
          trade: trade === NO_TRADE_VALUE ? null : trade,
          mode,
          bond_required: mode === "tender" ? bondRequired : false,
          scope: scope.trim() || null,
          instructions: instructions.trim() || null,
          due_at: dueDate ? combineDateAndTime(dueDate, dueTime).toISOString() : null,
          due_tz: dueDate ? dueTz : null,
        }
        const created = unwrapAction(await createBidPackageAction({ projectId, prospectId }, payload))
        setItems((prev) => [created, ...prev])
        toast.success("Bid package created")
        resetForm()
        setCreateOpen(false)
      } catch (error) {
        toast.error("Failed to create package", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  const basePath = detailBasePath ?? (projectId ? `/projects/${projectId}/bids` : "")
  const columnCount = projectId ? 7 : 6

  return (
    <div className="space-y-4">
      <Sheet
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) resetForm()
        }}
      >
        <SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-lg">
          <SheetHeader className="border-b px-6 py-4">
            <SheetTitle>New bid package</SheetTitle>
            <SheetDescription>
              {createDescription ?? "Create an invite-to-bid package for this project."}
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 space-y-5 overflow-y-auto px-6 py-4">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Electrical — Rough & Trim"
              />
            </div>

            <div className="space-y-2">
              <Label>Bid type</Label>
              <div className="grid grid-cols-2 gap-2">
                {(["quote", "tender"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setMode(option)}
                    className={cn(
                      "flex flex-col items-start gap-0.5 border px-3 py-2 text-left text-sm transition-colors",
                      mode === option
                        ? "border-primary bg-primary/5 text-foreground"
                        : "border-border text-muted-foreground hover:bg-muted/50",
                    )}
                  >
                    <span className="font-medium capitalize">{option}</span>
                    <span className="text-xs text-muted-foreground">
                      {option === "quote" ? "Single number, scope optional" : "Line-item scope, apples-to-apples"}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Cost code</Label>
              <Select value={costCodeId} onValueChange={setCostCodeId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select cost code" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_COST_CODE}>No cost code yet</SelectItem>
                  <CostCodeSelectItems costCodes={costCodes} />
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Trade</Label>
              <Select value={trade} onValueChange={setTrade}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select trade" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_TRADE_VALUE}>No trade</SelectItem>
                  {tradeOptions.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Due date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className={cn("w-full justify-start text-left font-normal", !dueDate && "text-muted-foreground")}
                    >
                      <CalendarDays className="mr-2 h-4 w-4" />
                      {dueDate ? formatDueDate(combineDateAndTime(dueDate, dueTime).toISOString(), dueTz) : "Pick a date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar mode="single" selected={dueDate} onSelect={setDueDate} initialFocus />
                  </PopoverContent>
                </Popover>
              </div>
              <div className="space-y-2">
                <Label>Due time</Label>
                <Input type="time" value={dueTime} onChange={(event) => setDueTime(event.target.value)} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Timezone</Label>
              <Select value={dueTz} onValueChange={setDueTz}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {US_TIMEZONES.map((zone) => (
                    <SelectItem key={zone.value} value={zone.value}>
                      {zone.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {mode === "tender" ? (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={bondRequired} onCheckedChange={(value) => setBondRequired(value === true)} />
                <span>Payment &amp; performance bond required</span>
              </label>
            ) : null}

            <div className="space-y-2">
              <Label>Scope</Label>
              <Textarea value={scope} onChange={(event) => setScope(event.target.value)} placeholder="Scope notes" />
            </div>
            <div className="space-y-2">
              <Label>Instructions</Label>
              <Textarea
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="Bid instructions"
              />
            </div>
          </div>
          <SheetFooter className="border-t px-6 py-4">
            <div className="flex w-full gap-2">
              <SheetClose asChild>
                <Button variant="outline" className="flex-1">
                  Cancel
                </Button>
              </SheetClose>
              <Button onClick={handleCreate} disabled={isCreating} className="flex-1">
                {isCreating ? "Creating…" : "Create package"}
              </Button>
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="grid flex-1 gap-2 sm:grid-cols-[minmax(220px,1fr)_160px_180px]">
          <Input
            placeholder="Search packages…"
            className="w-full"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATUSES}>All statuses</SelectItem>
              {["draft", "sent", "open", "closed", "awarded", "cancelled"].map((option) => (
                <SelectItem key={option} value={option}>
                  {option[0].toUpperCase() + option.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={(value) => setSortBy(value as SortOption)}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              {sortOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New package
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4 py-2.5">Trade / Package</TableHead>
              {projectId ? <TableHead className="px-4 py-2.5 text-right">Budget</TableHead> : null}
              <TableHead className="px-4 py-2.5 text-right">Coverage</TableHead>
              <TableHead className="px-4 py-2.5 text-right">Low bid</TableHead>
              {projectId ? <TableHead className="px-4 py-2.5 text-right">Δ Budget</TableHead> : null}
              <TableHead className="px-4 py-2.5">Stage</TableHead>
              <TableHead className="px-4 py-2.5">Due</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && uncoveredBudgetLines.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columnCount} className="py-12 text-center text-sm text-muted-foreground">
                  {search || statusFilter !== ALL_STATUSES
                    ? "No packages match your filters."
                    : "No bid packages yet. Create one to invite vendors."}
                </TableCell>
              </TableRow>
            ) : (
              <>
                {filtered.map((pkg) => {
                  const href = `${basePath}/${pkg.id}`
                  const invited = pkg.invite_count ?? 0
                  const responses = pkg.response_count ?? 0
                  const stage = getBidPackageStage(pkg)
                  const variance =
                    pkg.budget_cents != null && pkg.lowest_bid_cents != null
                      ? pkg.lowest_bid_cents - pkg.budget_cents
                      : null
                  const overdue = isDuePast(pkg.due_at) && stage === "bidding"
                  return (
                    <TableRow
                      key={pkg.id}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => router.push(href)}
                    >
                      <TableCell className="px-4 py-2.5">
                        <div className="font-medium">{pkg.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {pkg.trade ?? "No trade"}
                          {pkg.cost_code_code ? ` · ${pkg.cost_code_code}` : ""}
                        </div>
                      </TableCell>
                      {projectId ? (
                        <TableCell className="px-4 py-2.5 text-right tabular-nums text-sm">
                          {money(pkg.budget_cents)}
                        </TableCell>
                      ) : null}
                      <TableCell className="px-4 py-2.5">
                        <CoverageBar responses={responses} invited={invited} />
                      </TableCell>
                      <TableCell className="px-4 py-2.5 text-right tabular-nums text-sm">
                        {money(pkg.lowest_bid_cents)}
                      </TableCell>
                      {projectId ? (
                        <TableCell
                          className={cn(
                            "px-4 py-2.5 text-right tabular-nums text-sm",
                            variance == null && "text-muted-foreground",
                            variance != null && variance > 0 && "text-destructive",
                            variance != null && variance <= 0 && "text-success",
                          )}
                        >
                          {variance == null ? "—" : signedMoney(variance)}
                        </TableCell>
                      ) : null}
                      <TableCell className={cn("px-4 py-2.5 text-sm", STAGE_TONE[stage])}>
                        {STAGE_LABELS[stage]}
                      </TableCell>
                      <TableCell
                        className={cn("px-4 py-2.5 text-sm", overdue ? "text-destructive" : "text-muted-foreground")}
                      >
                        <div>{formatDueDate(pkg.due_at, pkg.due_tz)}</div>
                        {relativeDueDate(pkg.due_at) ? (
                          <div className="text-xs text-muted-foreground">{relativeDueDate(pkg.due_at)}</div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  )
                })}
                {uncoveredBudgetLines.map((line) => (
                  <TableRow key={`budget-${line.id}`} className="bg-muted/20">
                    <TableCell className="px-4 py-2.5">
                      <div className="font-medium text-muted-foreground">{line.description ?? "Budget line"}</div>
                      <div className="text-xs text-muted-foreground">Not out to bid</div>
                    </TableCell>
                    <TableCell className="px-4 py-2.5 text-right tabular-nums text-sm text-muted-foreground">
                      {money(line.amount_cents)}
                    </TableCell>
                    <TableCell className="px-4 py-2.5 text-right text-xs text-muted-foreground">—</TableCell>
                    <TableCell className="px-4 py-2.5 text-right text-sm text-muted-foreground">—</TableCell>
                    <TableCell className="px-4 py-2.5 text-right text-sm text-muted-foreground">—</TableCell>
                    <TableCell className="px-4 py-2.5 text-sm text-muted-foreground">—</TableCell>
                    <TableCell className="px-4 py-2.5">
                      <Button variant="outline" size="sm" className="h-7" onClick={() => openCreateForBudgetLine(line)}>
                        <Plus className="mr-1 h-3.5 w-3.5" />
                        Start package
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
