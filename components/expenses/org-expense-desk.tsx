"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { format, parseISO } from "date-fns"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Paperclip, Plus } from "@/components/icons"
import { OrgExpenseCaptureSheet } from "@/components/expenses/org-expense-capture-sheet"
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
import { OVERHEAD_CATEGORIES, OVERHEAD_CATEGORY_LABELS, isOverheadCategory } from "@/lib/financials/overhead"
import type { OrgExpense, OrgExpenseDesk as OrgExpenseDeskData } from "@/lib/services/org-expenses"
import {
  approveOrgExpenseAction,
  assignExpenseHomeAction,
  rejectOrgExpenseAction,
} from "@/app/(app)/payables/expenses/actions"

const QUEUES = [
  { key: "review", label: "Review" },
  { key: "unsorted", label: "Unsorted" },
  { key: "overhead", label: "Overhead" },
  { key: "all", label: "All" },
] as const

const EMPTY: Record<OrgExpenseDeskData["queue"], string> = {
  review: "Nothing waiting for review.",
  unsorted: "Every expense has a job or a category.",
  overhead: "No overhead expenses yet.",
  all: "No expenses yet. Add the first receipt.",
}

const STATUS_TONE: Record<string, string> = {
  submitted: "text-muted-foreground",
  approved: "text-success",
  invoiced: "text-success",
  rejected: "text-destructive",
}

function statusLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ")
}

function homeValue(home: OrgExpense["home"]) {
  if (home.kind === "job") return `job:${home.projectId}`
  if (home.kind === "overhead") return `cat:${home.category}`
  return "unsorted"
}

export function OrgExpenseDesk({ desk }: { desk: OrgExpenseDeskData }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [captureOpen, setCaptureOpen] = useState(false)
  const prefix = desk.month.complete ? "" : "≥ "

  function run(expenseId: string, work: () => Promise<{ success: boolean; error?: string }>) {
    setBusyId(expenseId)
    startTransition(async () => {
      const result = await work()
      setBusyId(null)
      if (!result.success) {
        toast.error(result.error ?? "Something went wrong.")
        return
      }
      router.refresh()
    })
  }

  function assign(row: OrgExpense, value: string) {
    const projectId = value.startsWith("job:") ? value.slice(4) : null
    const category = value.startsWith("cat:") ? value.slice(4) : null
    run(row.id, () =>
      assignExpenseHomeAction(
        {
          expense_id: row.id,
          expected_updated_at: row.updatedAt,
          project_id: projectId,
          overhead_category: isOverheadCategory(category) ? category : null,
        },
        row.projectId,
      ),
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-4 border-b px-4 py-2 text-sm">
        <Link className="text-muted-foreground hover:text-foreground" href="/payables">Payables</Link>
        <Link className="text-muted-foreground hover:text-foreground" href="/payables/waivers">Waivers</Link>
        <span className="font-medium" aria-current="page">Expenses</span>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3 border-b px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
          <div>
            <p className="microlabel">Overhead this month</p>
            <p className="text-right font-mono text-lg font-semibold tabular-nums">
              {prefix}{formatMoneyFromCents(desk.month.overheadCents)}
            </p>
          </div>
          <div>
            <p className="microlabel">Job cost this month</p>
            <p className="text-right font-mono text-lg font-semibold tabular-nums">
              {prefix}{formatMoneyFromCents(desk.month.jobCostCents)}
            </p>
          </div>
          {desk.month.byCategory.length > 0 ? (
            <ul className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-xs">
              {desk.month.byCategory.map((entry) => (
                <li key={entry.category} className="contents">
                  <span className="text-muted-foreground">{entry.label}</span>
                  <span className="text-right font-mono tabular-nums">{formatMoneyFromCents(entry.cents)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {desk.canWrite ? (
          <Button size="sm" onClick={() => setCaptureOpen(true)}>
            <Plus data-icon="inline-start" />
            Add expense
          </Button>
        ) : null}
      </div>

      <nav className="flex gap-1 border-b px-4 sm:px-6" aria-label="Expense queues">
        {QUEUES.map(({ key, label }) => {
          const active = desk.queue === key
          const count = key === "all" ? null : desk.counts[key]
          return (
            <Link
              key={key}
              href={key === "review" ? "/payables/expenses" : `/payables/expenses?queue=${key}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
                active ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
              {count !== null ? <span className="ml-1.5 font-mono text-xs tabular-nums text-muted-foreground">{count}</span> : null}
            </Link>
          )
        })}
      </nav>

      {desk.rows.length === 0 ? (
        <p className="px-6 py-12 text-center text-sm text-muted-foreground">{EMPTY[desk.queue]}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4 sm:pl-6">Date</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-64">Home</TableHead>
                <TableHead>Submitted by</TableHead>
                <TableHead className="w-10"><span className="sr-only">Receipt</span></TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="w-44 pr-4 sm:pr-6"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {desk.rows.map((row) => {
                const busy = pending && busyId === row.id
                const editable = row.status !== "rejected" && row.status !== "locked"
                const jobListed = !row.projectId || desk.jobs.some((job) => job.id === row.projectId)
                return (
                  <TableRow key={row.id} className={cn(busy && "opacity-60")}>
                    <TableCell className="whitespace-nowrap pl-4 tabular-nums sm:pl-6">
                      {format(parseISO(row.expenseDate), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell className="max-w-48 truncate">{row.vendorName ?? "—"}</TableCell>
                    <TableCell className="max-w-64 truncate text-muted-foreground">{row.description ?? "—"}</TableCell>
                    <TableCell>
                      {desk.canWrite && editable ? (
                        <Select value={homeValue(row.home)} onValueChange={(value) => assign(row, value)} disabled={busy}>
                          <SelectTrigger
                            size="sm"
                            className={cn("w-full", row.home.kind === "unsorted" && "text-warning")}
                            aria-label="Home"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="unsorted">Unsorted</SelectItem>
                            <SelectGroup>
                              <SelectLabel>Jobs</SelectLabel>
                              {!jobListed && row.projectId ? (
                                <SelectItem value={`job:${row.projectId}`}>{row.homeLabel}</SelectItem>
                              ) : null}
                              {desk.jobs.map((job) => (
                                <SelectItem key={job.id} value={`job:${job.id}`}>{job.name}</SelectItem>
                              ))}
                            </SelectGroup>
                            <SelectGroup>
                              <SelectLabel>Overhead</SelectLabel>
                              {OVERHEAD_CATEGORIES.map((category) => (
                                <SelectItem key={category} value={`cat:${category}`}>{OVERHEAD_CATEGORY_LABELS[category]}</SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className={cn(row.home.kind === "unsorted" && "text-warning")}>{row.homeLabel}</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-40 truncate text-muted-foreground">{row.submittedBy ?? "—"}</TableCell>
                    <TableCell>
                      {row.hasReceipt ? <Paperclip className="size-4 text-muted-foreground" aria-label="Has receipt" /> : null}
                    </TableCell>
                    <TableCell className={cn("whitespace-nowrap", STATUS_TONE[row.status] ?? "text-muted-foreground")}>
                      {statusLabel(row.status)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatMoneyFromCents(row.totalCents)}</TableCell>
                    <TableCell className="pr-4 sm:pr-6">
                      {desk.canApprove && row.status === "submitted" ? (
                        <div className="flex justify-end gap-1.5">
                          <span title={row.home.kind === "unsorted" ? "Pick a job or an overhead category before approving." : undefined}>
                            <Button
                              size="sm"
                              disabled={busy || row.home.kind === "unsorted"}
                              onClick={() => run(row.id, () => approveOrgExpenseAction({ expense_id: row.id }, row.projectId))}
                            >
                              Approve
                            </Button>
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => run(row.id, () => rejectOrgExpenseAction({ expense_id: row.id }, row.projectId))}
                          >
                            Reject
                          </Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          {desk.truncated ? (
            <p className="border-t px-4 py-2 text-xs text-muted-foreground sm:px-6">
              Showing the latest {desk.cap} of {desk.total}
            </p>
          ) : null}
        </div>
      )}

      {desk.canWrite ? (
        <OrgExpenseCaptureSheet open={captureOpen} onOpenChange={setCaptureOpen} jobs={desk.jobs} onSaved={() => router.refresh()} />
      ) : null}
    </div>
  )
}
