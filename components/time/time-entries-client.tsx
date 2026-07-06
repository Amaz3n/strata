"use client"

import Link from "next/link"
import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import { useIsMobile } from "@/hooks/use-mobile"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Clock, MoreHorizontal, Paperclip, Plus } from "@/components/icons"

import {
  createMyTimeEntryAction,
  createTimeEntriesAction,
  createTimeEntryApprovalLinkFormAction,
  type CreateMyTimeEntryInput,
  type CreateTimeEntriesInput,
} from "@/app/(app)/projects/[id]/time/actions"
import { TimeEntryForm } from "@/components/time/time-entry-form"
import type { TeamMember } from "@/lib/types"

interface CostCodeOption {
  id: string
  code?: string | null
  name?: string | null
}

interface TimeEntry {
  id: string
  work_date: string
  worker_name: string | null
  hours: number | null
  base_rate_cents: number | null
  cost_cents: number | null
  status: string
  is_overtime: boolean | null
  is_billable: boolean | null
  attached_file_ids: string[] | null
  cost_code?: { code?: string | null; name?: string | null } | null
}

interface TimeEntriesClientProps {
  projectId: string
  initialEntries: TimeEntry[]
  costCodes: CostCodeOption[]
  teamMembers?: TeamMember[]
  defaultBurdenMultiplier?: number
  canManageCrew?: boolean
}

type StatusKey = "submitted" | "pm_approved" | "client_approved" | "rejected" | "invoiced" | string

const statusLabels: Record<string, string> = {
  submitted: "Submitted",
  pm_approved: "PM approved",
  client_approved: "Client approved",
  rejected: "Rejected",
  invoiced: "Invoiced",
}

const statusStyles: Record<string, string> = {
  submitted: "bg-warning/20 text-warning border-warning/40",
  pm_approved: "bg-primary/15 text-primary border-primary/30",
  client_approved: "bg-success/20 text-success border-success/30",
  rejected: "bg-destructive/15 text-destructive border-destructive/30",
  invoiced: "bg-muted text-muted-foreground border-muted",
}

function formatCurrency(cents: number | null | undefined) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—"
  try {
    return format(new Date(value), "MMM d, yyyy")
  } catch {
    return value
  }
}

export function TimeEntriesClient({
  projectId,
  initialEntries,
  costCodes,
  teamMembers = [],
  defaultBurdenMultiplier,
  canManageCrew = false,
}: TimeEntriesClientProps) {
  const isMobile = useIsMobile()
  const [items, setItems] = useState<TimeEntry[]>(initialEntries)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<"all" | StatusKey>("all")
  const [sheetOpen, setSheetOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  const workerSuggestions = useMemo(
    () =>
      Array.from(
        new Set([
          ...teamMembers.map((member) => member.user.full_name || member.user.email).filter(Boolean),
          ...items.map((entry) => entry.worker_name).filter((name): name is string => !!name),
        ]),
      ).slice(0, 30),
    [items, teamMembers],
  )
  const rateSuggestions = useMemo(
    () =>
      Array.from(
        new Set(
          [
            ...teamMembers.map((member) => Number(member.labor_cost_rate_cents ?? 0) / 100),
            ...items.map((entry) => Number(entry.base_rate_cents ?? 0) / 100),
          ]
            .filter((rate) => rate > 0),
        ),
      ).slice(0, 10),
    [items, teamMembers],
  )
  const crewMembers = useMemo(
    () =>
      teamMembers
        .filter((member) => member.status !== "suspended")
        .map((member) => ({
          membershipId: member.id,
          userId: member.user.id,
          name: member.user.full_name || member.user.email,
          email: member.user.email,
          costRateDollars: Number(member.labor_cost_rate_cents ?? 0) / 100,
          billRateDollars: Number(member.labor_bill_rate_cents ?? 0) / 100,
          burdenMultiplier: Number(member.labor_burden_multiplier ?? defaultBurdenMultiplier ?? 1),
          isBillable: member.labor_is_billable_default ?? true,
        })),
    [defaultBurdenMultiplier, teamMembers],
  )

  const filtered = useMemo(() => {
    const term = search.toLowerCase().trim()
    return items.filter((entry) => {
      const matchesStatus = statusFilter === "all" || entry.status === statusFilter
      if (!matchesStatus) return false
      if (!term) return true
      return [
        entry.worker_name ?? "",
        entry.cost_code?.code ?? "",
        entry.cost_code?.name ?? "",
        entry.work_date ?? "",
      ]
        .some((value) => value.toLowerCase().includes(term))
    })
  }, [items, search, statusFilter])

  async function handleCreateSelf(payload: CreateMyTimeEntryInput, attachment: File | null) {
    const formData = new FormData()
    formData.append("payload", JSON.stringify(payload))
    if (attachment) formData.append("attachment", attachment)

    return new Promise<void>((resolve, reject) => {
      startTransition(async () => {
        try {
          const next = await createMyTimeEntryAction(projectId, formData)
          setItems((next as TimeEntry[]) ?? [])
          setSheetOpen(false)
          toast.success("Time submitted for review")
          resolve()
        } catch (error: any) {
          console.error(error)
          toast.error("Could not submit time", { description: error?.message ?? "Please try again." })
          reject(error)
        }
      })
    })
  }

  async function handleCreateCrew(payload: CreateTimeEntriesInput, attachment: File | null) {
    const formData = new FormData()
    formData.append("payload", JSON.stringify(payload))
    if (attachment) formData.append("attachment", attachment)

    return new Promise<void>((resolve, reject) => {
      startTransition(async () => {
        try {
          const next = await createTimeEntriesAction(projectId, formData)
          setItems((next as TimeEntry[]) ?? [])
          setSheetOpen(false)
          toast.success(payload.crew.length > 1 ? `${payload.crew.length} entries submitted` : "Time entry submitted")
          resolve()
        } catch (error: any) {
          console.error(error)
          toast.error("Could not submit time", { description: error?.message ?? "Please try again." })
          reject(error)
        }
      })
    })
  }

  function copyApprovalLink(entryId: string) {
    startTransition(async () => {
      try {
        const result = await createTimeEntryApprovalLinkFormAction(projectId, entryId)
        await navigator.clipboard?.writeText(result.url)
        toast.success("Client approval link copied")
      } catch (error: any) {
        toast.error(error?.message ?? "Could not create approval link")
      }
    })
  }

  function rowActions(entry: TimeEntry) {
    const isSubmitted = entry.status === "submitted"
    const isPmApproved = entry.status === "pm_approved"
    const isReviewable = isSubmitted || isPmApproved
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity">
            <MoreHorizontal className="h-3.5 w-3.5" />
            <span className="sr-only">Time entry actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isReviewable ? (
            <DropdownMenuItem asChild>
              <Link href={`/projects/${projectId}/financials/review`}>Review in Financials</Link>
            </DropdownMenuItem>
          ) : null}
          {isPmApproved ? (
            <DropdownMenuItem onClick={() => copyApprovalLink(entry.id)}>Copy client link</DropdownMenuItem>
          ) : null}
          {!isReviewable ? (
            <DropdownMenuItem disabled>No actions available</DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  return (
    <>
      <TimeEntryForm
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        projectId={projectId}
        costCodes={costCodes}
        workerSuggestions={workerSuggestions}
        rateSuggestions={rateSuggestions}
        crewMembers={crewMembers}
        defaultBurdenMultiplier={defaultBurdenMultiplier}
        canManageCrew={canManageCrew}
        onSubmitSelf={handleCreateSelf}
        onSubmitCrew={handleCreateCrew}
        isSubmitting={isPending}
      />

      <div className="-mx-4 -mb-4 -mt-6 flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden bg-background">
        <div className="sticky top-0 z-20 flex shrink-0 flex-col gap-3 border-b bg-background px-4 py-3 sm:min-h-14 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              placeholder="Search worker, code..."
              className="w-full sm:w-72"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusKey)}>
                <SelectTrigger className="w-full sm:w-40">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {(["submitted", "pm_approved", "client_approved", "rejected", "invoiced"] as StatusKey[]).map((status) => (
                    <SelectItem key={status} value={status}>
                      {statusLabels[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button onClick={() => setSheetOpen(true)} className="w-full sm:w-auto">
              <Plus className="mr-2 h-4 w-4" />
              New time entry
            </Button>
          </div>
        </div>

        {isMobile ? (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <div className="space-y-3">
              {filtered.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-lg border bg-card p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-medium text-muted-foreground">{formatDate(entry.work_date)}</span>
                        <Badge
                          variant="secondary"
                          className={`capitalize border text-[11px] ${statusStyles[entry.status] ?? ""}`}
                        >
                          {statusLabels[entry.status] ?? entry.status}
                        </Badge>
                      </div>
                      <p className="font-semibold mt-1 truncate">{entry.worker_name || "Unnamed"}</p>
                      <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                        {(entry.hours ?? 0).toFixed(2)} hrs · {formatCurrency(entry.cost_cents)}
                      </p>
                      {entry.cost_code?.code ? (
                        <p className="text-xs text-muted-foreground mt-1 truncate">
                          {entry.cost_code.code} {entry.cost_code.name}
                        </p>
                      ) : null}
                    </div>
                    <div onClick={(event) => event.stopPropagation()}>{rowActions(entry)}</div>
                  </div>
                </div>
              ))}
              {filtered.length === 0 && (
                <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <Clock className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="font-medium">No time entries yet</p>
                      <p className="text-sm">Log crew hours to start invoicing T&amp;M work.</p>
                    </div>
                    <Button onClick={() => setSheetOpen(true)}>
                      <Plus className="mr-2 h-4 w-4" />
                      New time entry
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-[120px] pl-4">Date</TableHead>
                  <TableHead className="w-[28%] min-w-[200px]">Worker</TableHead>
                  <TableHead className="hidden md:table-cell w-[200px]">Cost code</TableHead>
                  <TableHead className="hidden sm:table-cell w-[120px] text-center">Status</TableHead>
                  <TableHead className="hidden lg:table-cell w-[80px] text-right">Hours</TableHead>
                  <TableHead className="hidden lg:table-cell w-[100px] text-right">Rate</TableHead>
                  <TableHead className="w-[120px] text-right">Cost</TableHead>
                  <TableHead className="w-[60px] pr-2" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((entry) => (
                  <TableRow key={entry.id} className="group h-[56px]">
                    <TableCell className="pl-4">
                      <span className="text-sm tabular-nums">{formatDate(entry.work_date)}</span>
                    </TableCell>
                    <TableCell className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium truncate">{entry.worker_name || "Unnamed"}</span>
                        {entry.is_overtime ? (
                          <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 font-normal">OT</Badge>
                        ) : null}
                        {entry.attached_file_ids?.length ? (
                          <Paperclip className="h-3 w-3 text-muted-foreground" />
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {entry.cost_code?.code ? (
                        <span className="text-xs text-muted-foreground truncate block">
                          <span className="font-medium text-foreground">{entry.cost_code.code}</span>{" "}
                          {entry.cost_code.name}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-center">
                      <Badge
                        variant="secondary"
                        className={`text-[10px] px-1.5 py-0 h-4 font-normal capitalize border ${statusStyles[entry.status] ?? ""}`}
                      >
                        {statusLabels[entry.status] ?? entry.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-right tabular-nums text-sm">
                      {(entry.hours ?? 0).toFixed(2)}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-right tabular-nums text-xs text-muted-foreground">
                      {formatCurrency(entry.base_rate_cents)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm font-medium">
                      {formatCurrency(entry.cost_cents)}
                    </TableCell>
                    <TableCell className="pr-2" onClick={(event) => event.stopPropagation()}>
                      <div className="flex items-center justify-end">{rowActions(entry)}</div>
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="h-48 text-center text-muted-foreground hover:bg-transparent">
                      <div className="flex flex-col items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                          <Clock className="h-6 w-6" />
                        </div>
                        <div className="text-center max-w-[400px]">
                          <p className="font-medium">No time entries yet</p>
                          <p className="text-sm text-muted-foreground mt-0.5">
                            Log crew hours to start invoicing T&amp;M work.
                          </p>
                        </div>
                        <div className="mt-2">
                          <Button variant="default" size="sm" onClick={() => setSheetOpen(true)}>
                            <Plus className="mr-2 h-4 w-4" />
                            New time entry
                          </Button>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  )
}
