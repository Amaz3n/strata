"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { format } from "date-fns"
import { toast } from "sonner"

import type { BidPackage } from "@/lib/services/bids"
import type { CostCode } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
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
import { createBidPackageAction } from "@/app/(app)/projects/[id]/bids/actions"
import { createProspectBidPackageAction } from "@/app/(app)/pipeline/prospects/[prospectId]/bids/actions"
import { BidStatusBadge } from "@/components/bids/bid-status-badge"

interface BidPackagesClientProps {
  projectId?: string
  prospectId?: string
  packages: BidPackage[]
  tradeOptions: string[]
  costCodes: CostCode[]
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
const ALL_STATUSES = "__all__"
const sortOptions = [
  { value: "needs_attention", label: "Needs attention" },
  { value: "due_soon", label: "Due soon" },
  { value: "coverage", label: "Lowest coverage" },
  { value: "lowest_bid", label: "Lowest bid" },
  { value: "newest", label: "Newest" },
] as const

type SortOption = (typeof sortOptions)[number]["value"]

function formatCurrency(cents?: number | null): string {
  if (cents == null) return "-"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function getDueInfo(dueAt?: string | null): { label: string; tone: string; weight: number; timestamp: number } {
  if (!dueAt) return { label: "-", tone: "text-muted-foreground", weight: 3, timestamp: Number.POSITIVE_INFINITY }
  const dueDate = new Date(dueAt)
  const now = new Date()
  const msUntilDue = dueDate.getTime() - now.getTime()
  const daysUntilDue = Math.ceil(msUntilDue / 86_400_000)

  if (msUntilDue < 0) {
    return { label: format(dueDate, "MMM d, h:mm a"), tone: "text-rose-600 font-medium", weight: 0, timestamp: dueDate.getTime() }
  }
  if (daysUntilDue <= 2) {
    return { label: format(dueDate, "MMM d, h:mm a"), tone: "text-amber-600 font-medium", weight: 1, timestamp: dueDate.getTime() }
  }
  return { label: format(dueDate, "MMM d, h:mm a"), tone: "text-muted-foreground", weight: 2, timestamp: dueDate.getTime() }
}

function combineDateAndTime(date: Date, time: string): Date {
  const [hoursRaw, minutesRaw] = time.split(":")
  const hours = Number.parseInt(hoursRaw ?? "", 10)
  const minutes = Number.parseInt(minutesRaw ?? "", 10)

  const next = new Date(date)
  next.setHours(Number.isFinite(hours) ? hours : 17, Number.isFinite(minutes) ? minutes : 0, 0, 0)
  return next
}

export function BidPackagesClient({
  projectId,
  prospectId,
  packages,
  tradeOptions,
  costCodes,
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
  const [costCodeId, setCostCodeId] = useState("__none__")
  const [budgetLineId, setBudgetLineId] = useState<string | null>(null)
  const [trade, setTrade] = useState(NO_TRADE_VALUE)
  const [dueDate, setDueDate] = useState<Date | undefined>(undefined)
  const [dueTime, setDueTime] = useState("17:00")
  const [scope, setScope] = useState("")
  const [instructions, setInstructions] = useState("")
  const [initialDraftApplied, setInitialDraftApplied] = useState(false)

  useEffect(() => {
    if (initialDraftApplied || !initialDraft) return
    if (initialDraft.title) setTitle(initialDraft.title)
    if (initialDraft.scope) setScope(initialDraft.scope)
    if (initialDraft.cost_code_id) setCostCodeId(initialDraft.cost_code_id)
    if (initialDraft.budget_line_id) setBudgetLineId(initialDraft.budget_line_id)
    if (initialDraft.amount_cents && initialDraft.amount_cents > 0) {
      setInstructions(`Budget target: ${formatCurrency(initialDraft.amount_cents)}`)
    }
    setCreateOpen(true)
    setInitialDraftApplied(true)
  }, [initialDraft, initialDraftApplied])

  const filtered = useMemo(() => {
    const term = search.toLowerCase()
    const visible = items.filter((item) => {
      const haystack = [item.title, item.trade ?? "", item.scope ?? "", item.cost_code_code ?? "", item.cost_code_name ?? ""]
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
      const aDue = getDueInfo(a.due_at)
      const bDue = getDueInfo(b.due_at)

      if (sortBy === "due_soon") return aDue.timestamp - bDue.timestamp
      if (sortBy === "coverage") return aResponses / Math.max(aInvites, 1) - bResponses / Math.max(bInvites, 1)
      if (sortBy === "lowest_bid") return (a.lowest_bid_cents ?? Number.POSITIVE_INFINITY) - (b.lowest_bid_cents ?? Number.POSITIVE_INFINITY)
      if (sortBy === "newest") return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()

      const aNeedsResponses = aInvites > 0 && aResponses < aInvites
      const bNeedsResponses = bInvites > 0 && bResponses < bInvites
      const aAttention = (aNeedsResponses ? 0 : 4) + aDue.weight
      const bAttention = (bNeedsResponses ? 0 : 4) + bDue.weight
      if (aAttention !== bAttention) return aAttention - bAttention
      return aDue.timestamp - bDue.timestamp
    })
  }, [items, search, sortBy, statusFilter])

  const resetForm = () => {
    setTitle("")
    setCostCodeId("__none__")
    setBudgetLineId(null)
    setTrade(NO_TRADE_VALUE)
    setDueDate(undefined)
    setDueTime("17:00")
    setScope("")
    setInstructions("")
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
          cost_code_id: costCodeId === "__none__" ? null : costCodeId,
          budget_line_id: budgetLineId,
          trade: trade === NO_TRADE_VALUE ? null : trade,
          scope: scope.trim() || null,
          instructions: instructions.trim() || null,
          due_at: dueDate ? combineDateAndTime(dueDate, dueTime).toISOString() : null,
        }
        const created = projectId
          ? await createBidPackageAction(projectId, payload)
          : await createProspectBidPackageAction(prospectId ?? "", payload)
        setItems((prev) => [created, ...prev])
        toast.success("Bid package created")
        resetForm()
        setCreateOpen(false)
      } catch (error: any) {
        toast.error("Failed to create package", { description: error?.message ?? "Please try again." })
      }
    })
  }

  return (
    <div className="space-y-4">
      <Sheet
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) resetForm()
        }}
      >
        <SheetContent
          side="right"
          mobileFullscreen
          className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
          style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
        >
          <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
            <SheetTitle>New bid package</SheetTitle>
            <SheetDescription>
              {createDescription ?? "Create an invite-to-bid package for this project."}
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Electrical - Rough & Trim" />
            </div>
            <div className="space-y-2">
              <Label>Cost code</Label>
              <Select value={costCodeId} onValueChange={setCostCodeId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select cost code" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No cost code yet</SelectItem>
                  {costCodes.map((code) => (
                    <SelectItem key={code.id} value={code.id}>
                      {code.code ? `${code.code} — ${code.name}` : code.name}
                    </SelectItem>
                  ))}
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
                      {dueDate ? format(dueDate, "LLL dd, y") : "Pick a date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar mode="single" selected={dueDate} onSelect={setDueDate} initialFocus />
                  </PopoverContent>
                </Popover>
              </div>
              <div className="space-y-2">
                <Label>Due time</Label>
                <Input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Scope</Label>
              <Textarea value={scope} onChange={(e) => setScope(e.target.value)} placeholder="Scope notes" />
            </div>
            <div className="space-y-2">
              <Label>Instructions</Label>
              <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Bid instructions" />
            </div>
          </div>
          <SheetFooter className="border-t bg-background/80 px-6 py-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <SheetClose asChild>
                <Button variant="outline" className="w-full sm:flex-1">
                  Cancel
                </Button>
              </SheetClose>
              <Button onClick={handleCreate} disabled={isCreating} className="w-full sm:flex-1">
                {isCreating ? "Creating..." : "Create package"}
              </Button>
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="grid flex-1 gap-2 sm:grid-cols-[minmax(220px,1fr)_160px_180px]">
          <Input
            placeholder="Search bid packages..."
            className="w-full"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
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
          New bid package
        </Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="px-4 py-4">Package</TableHead>
              <TableHead className="px-4 py-4">Trade</TableHead>
              <TableHead className="px-4 py-4">Cost code</TableHead>
              <TableHead className="px-4 py-4 text-center">Status</TableHead>
              <TableHead className="px-4 py-4 text-center">Responses</TableHead>
              <TableHead className="px-4 py-4 text-right">Low bid</TableHead>
              <TableHead className="px-4 py-4 text-center">Due</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-12 text-center text-muted-foreground">
                  No bid packages yet.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((pkg) => {
                const href = `${detailBasePath ?? `/projects/${projectId}/bids`}/${pkg.id}`
                const inviteCount = pkg.invite_count ?? 0
                const responseCount = pkg.response_count ?? 0
                const dueInfo = getDueInfo(pkg.due_at)

                return (
                <TableRow
                  key={pkg.id}
                  className="divide-x hover:bg-muted/40 cursor-pointer"
                  onClick={() => router.push(href)}
                >
                  <TableCell className="px-4 py-4">
                    <Link
                      href={href}
                      className="font-medium hover:underline"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {pkg.title}
                    </Link>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground">{pkg.trade ?? "—"}</TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground">
                    {pkg.cost_code_code ? `${pkg.cost_code_code} ${pkg.cost_code_name ? `· ${pkg.cost_code_name}` : ""}` : "—"}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <BidStatusBadge status={pkg.status} />
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <Badge variant={inviteCount > 0 && responseCount < inviteCount ? "outline" : "secondary"}>
                      {responseCount} of {inviteCount}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-right text-sm tabular-nums">
                    {formatCurrency(pkg.lowest_bid_cents)}
                  </TableCell>
                  <TableCell className={cn("px-4 py-4 text-center text-sm", dueInfo.tone)}>
                    {dueInfo.label}
                  </TableCell>
                </TableRow>
              )})
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
