"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { formatDistanceToNow } from "date-fns"
import { toast } from "sonner"

import { listInvoiceSyncQueueAction } from "@/app/(app)/invoices/actions"
import type { Invoice, Project } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AlertCircle, CheckCircle2, Clock, ExternalLink, Loader2, MoreHorizontal, RefreshCcw, Search, Zap } from "@/components/icons"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

type QueueFilter = "attention" | "pending" | "failed" | "all"

type SyncQueueRow = {
  invoice: Invoice
  latestSync: {
    id: string
    entity_id?: string | null
    status?: string | null
    last_synced_at?: string | null
    error_message?: string | null
    qbo_id?: string | null
    created_at?: string | null
  } | null
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoices: Invoice[]
  projects: Project[]
  onRefreshInvoices: () => Promise<void>
  onSyncPending: () => Promise<void>
  onRetryFailed: () => Promise<void>
  onSyncOne: (invoiceId: string) => Promise<void>
  onOpenInvoice: (invoiceId: string) => void
  onEditInvoice: (invoice: Invoice) => void
  refreshing?: boolean
  syncingPending?: boolean
  retryingFailed?: boolean
  syncingInvoiceId?: string | null
}

function formatMoneyFromCents(cents?: number | null) {
  const dollars = (cents ?? 0) / 100
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function formatRelative(value?: string | null) {
  if (!value) return "Not attempted yet"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Unknown"
  return `${formatDistanceToNow(date, { addSuffix: true })}`
}

function statusConfig(status: Invoice["qbo_sync_status"]) {
  if (status === "error") {
    return {
      label: "Failed",
      icon: AlertCircle,
      className: "border-destructive/30 bg-destructive/10 text-destructive",
    }
  }

  if (status === "pending") {
    return {
      label: "Pending",
      icon: Clock,
      className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    }
  }

  return {
    label: "Synced",
    icon: CheckCircle2,
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  }
}

export function InvoiceSyncQueueSheet({
  open,
  onOpenChange,
  invoices,
  projects,
  onRefreshInvoices,
  onSyncPending,
  onRetryFailed,
  onSyncOne,
  onOpenInvoice,
  onEditInvoice,
  refreshing,
  syncingPending,
  retryingFailed,
  syncingInvoiceId,
}: Props) {
  const [rows, setRows] = useState<SyncQueueRow[]>([])
  const [loading, setLoading] = useState(false)
  const [activeFilter, setActiveFilter] = useState<QueueFilter>("attention")
  const [search, setSearch] = useState("")
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null)

  const projectLookup = useMemo(() => {
    return projects.reduce<Record<string, Project>>((acc, project) => {
      acc[project.id] = project
      return acc
    }, {})
  }, [projects])

  const fallbackRows = useMemo<SyncQueueRow[]>(
    () =>
      invoices
        .filter((invoice) => invoice.qbo_sync_status === "pending" || invoice.qbo_sync_status === "error")
        .map((invoice) => ({ invoice, latestSync: null })),
    [invoices],
  )

  const displayRows = rows.length > 0 || lastLoadedAt ? rows : fallbackRows
  const counts = useMemo(
    () => ({
      all: displayRows.length,
      pending: displayRows.filter((row) => row.invoice.qbo_sync_status === "pending").length,
      failed: displayRows.filter((row) => row.invoice.qbo_sync_status === "error").length,
      attention: displayRows.filter((row) => row.invoice.qbo_sync_status === "error" || !row.latestSync?.qbo_id).length,
    }),
    [displayRows],
  )

  const visibleRows = useMemo(() => {
    const term = search.trim().toLowerCase()

    return displayRows.filter((row) => {
      const projectName = row.invoice.project_id ? projectLookup[row.invoice.project_id]?.name : ""
      const matchesFilter =
        activeFilter === "all"
          ? true
          : activeFilter === "attention"
            ? row.invoice.qbo_sync_status === "error" || !row.latestSync?.qbo_id
            : activeFilter === "pending"
              ? row.invoice.qbo_sync_status === "pending"
              : row.invoice.qbo_sync_status === "error"

      const matchesSearch =
        term.length === 0 ||
        [row.invoice.invoice_number, row.invoice.title, projectName, row.latestSync?.error_message, row.latestSync?.qbo_id]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(term))

      return matchesFilter && matchesSearch
    })
  }, [activeFilter, displayRows, projectLookup, search])

  const loadQueue = useCallback(
    async (options?: { silent?: boolean }) => {
      setLoading(true)
      try {
        const projectId = projects.length === 1 ? projects[0]?.id : undefined
        const nextRows = await listInvoiceSyncQueueAction(projectId)
        setRows(nextRows as SyncQueueRow[])
        setLastLoadedAt(new Date())
        if (!options?.silent) toast.success("Sync queue refreshed")
      } catch (error: any) {
        toast.error("Could not load sync queue", { description: error?.message ?? "Please try again." })
      } finally {
        setLoading(false)
      }
    },
    [projects],
  )

  useEffect(() => {
    if (!open) return
    void loadQueue({ silent: true })
  }, [loadQueue, open])

  async function runAndReload(action: () => Promise<void>) {
    await action()
    await loadQueue({ silent: true })
  }

  async function refreshEverything() {
    await onRefreshInvoices()
    await loadQueue()
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:ml-auto sm:mr-4 sm:mt-4 flex w-full flex-col gap-0 overflow-hidden p-0 shadow-2xl sm:h-[calc(100vh-2rem)] sm:max-w-lg fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
      >
        <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6">
          <div className="flex items-center gap-2 pr-8">
            <Zap className="h-5 w-5 text-primary" />
            <SheetTitle>QuickBooks sync</SheetTitle>
            <Badge variant="secondary" className="border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">
              {counts.pending} pending
            </Badge>
            {counts.failed > 0 ? (
              <Badge variant="secondary" className="border border-destructive/30 bg-destructive/10 text-destructive">
                {counts.failed} failed
              </Badge>
            ) : null}
          </div>
          <SheetDescription className="text-left">Resolve invoice syncs and inspect the latest QBO response.</SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="space-y-6 px-6 py-4">
            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-1">
                <Clock className="h-4 w-4" />
                {counts.all} queued
              </div>
              <div className="flex items-center gap-1">
                <AlertCircle className="h-4 w-4" />
                {counts.failed} failed
              </div>
              <div className="flex items-center gap-1">
                <RefreshCcw className="h-4 w-4" />
                {lastLoadedAt ? `Updated ${formatRelative(lastLoadedAt.toISOString())}` : "Loads latest attempts on open"}
              </div>
            </div>

            <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-medium">Queue actions</h4>
                  <p className="text-xs text-muted-foreground">Run pending syncs or queue retries for failed invoices.</p>
                </div>
                <Button variant="outline" size="sm" onClick={refreshEverything} disabled={loading || refreshing}>
                  {loading || refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                  Refresh
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" size="sm" onClick={() => runAndReload(onSyncPending)} disabled={syncingPending || counts.pending === 0}>
                  {syncingPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                  Run pending
                </Button>
                <Button variant="outline" size="sm" onClick={() => runAndReload(onRetryFailed)} disabled={retryingFailed || counts.failed === 0}>
                  {retryingFailed ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertCircle className="h-4 w-4" />}
                  Queue retries
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search invoice, project, or QBO error"
                  className="h-9 bg-muted/30 pl-9 shadow-none"
                />
              </div>

              <Tabs value={activeFilter} onValueChange={(value) => setActiveFilter(value as QueueFilter)} className="w-full gap-0">
                <TabsList className="h-9 w-full justify-start overflow-x-auto rounded-md bg-muted/70 p-1">
                  <QueueTab value="attention" label="Needs attention" count={counts.attention} />
                  <QueueTab value="pending" label="Pending" count={counts.pending} />
                  <QueueTab value="failed" label="Failed" count={counts.failed} />
                  <QueueTab value="all" label="All" count={counts.all} />
                </TabsList>
              </Tabs>
            </div>

            <Separator />

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">Invoices</h4>
                <span className="text-xs text-muted-foreground">{visibleRows.length} shown</span>
              </div>

              {loading && displayRows.length === 0 ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div key={index} className="h-24 animate-pulse rounded-lg bg-muted/60" />
                  ))}
                </div>
              ) : visibleRows.length === 0 ? (
                <QueueEmptyState filter={activeFilter} hasSearch={search.trim().length > 0} />
              ) : (
                <div className="space-y-2">
                  {visibleRows.map((row) => (
                    <QueueRow
                      key={row.invoice.id}
                      row={row}
                      projectName={row.invoice.project_id ? projectLookup[row.invoice.project_id]?.name : undefined}
                      syncing={syncingInvoiceId === row.invoice.id}
                      onSync={() => runAndReload(() => onSyncOne(row.invoice.id))}
                      onOpen={() => onOpenInvoice(row.invoice.id)}
                      onEdit={() => onEditInvoice(row.invoice)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

function QueueTab({ value, label, count }: { value: QueueFilter; label: string; count: number }) {
  return (
    <TabsTrigger value={value} className="h-7 gap-2 rounded-sm px-2.5 text-xs data-[state=active]:shadow-none">
      {label}
      <Badge variant="secondary" className="h-4 rounded-sm px-1 text-[10px]">
        {count}
      </Badge>
    </TabsTrigger>
  )
}

function QueueRow({
  row,
  projectName,
  syncing,
  onSync,
  onOpen,
  onEdit,
}: {
  row: SyncQueueRow
  projectName?: string
  syncing: boolean
  onSync: () => void
  onOpen: () => void
  onEdit: () => void
}) {
  const { invoice, latestSync } = row
  const config = statusConfig(invoice.qbo_sync_status)
  const StatusIcon = config.icon
  const invoiceLabel = invoice.invoice_number || invoice.title || "Untitled invoice"
  const total = invoice.total_cents ?? invoice.totals?.total_cents
  const lastAttempt = latestSync?.last_synced_at ?? latestSync?.created_at
  const error = latestSync?.error_message

  return (
    <div className="rounded-lg border bg-background p-3 transition-colors hover:bg-muted/20">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onOpen} className="truncate text-sm font-semibold hover:text-primary">
              {invoiceLabel}
            </button>
            <Badge variant="outline" className={cn("gap-1 border", config.className)}>
              <StatusIcon className="h-3 w-3" />
              {config.label}
            </Badge>
            {latestSync?.qbo_id && (
              <Badge variant="outline" className="rounded-sm text-[10px]">
                QBO {latestSync.qbo_id}
              </Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{projectName ?? "No project"}</span>
            <span>{formatMoneyFromCents(total)}</span>
            <span>Last attempt: {formatRelative(lastAttempt)}</span>
          </div>
          {error ? (
            <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive">{error}</div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">Waiting for QuickBooks to accept this invoice. Use sync now if the automatic job is delayed.</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant={invoice.qbo_sync_status === "error" ? "default" : "outline"} onClick={onSync} disabled={syncing}>
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            <span className="hidden sm:inline">{invoice.qbo_sync_status === "error" ? "Retry" : "Sync"}</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">Queue item actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onOpen}>
                <ExternalLink className="mr-2 h-4 w-4" />
                View invoice
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onEdit}>Edit invoice</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onSync} disabled={syncing}>
                {invoice.qbo_sync_status === "error" ? "Retry now" : "Sync now"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
}

function QueueEmptyState({ filter, hasSearch }: { filter: QueueFilter; hasSearch: boolean }) {
  const copy = hasSearch
    ? "No queue items match your search."
    : filter === "failed"
      ? "No failed invoice syncs."
      : filter === "pending"
        ? "No pending invoices waiting on QuickBooks."
        : "The QuickBooks invoice queue is clear."

  return (
    <div className="flex h-full min-h-80 items-center justify-center p-8 text-center">
      <div className="max-w-sm">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted">
          <CheckCircle2 className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="mt-4 text-sm font-medium">{copy}</p>
        <p className="mt-1 text-sm text-muted-foreground">New failures and pending invoices will appear here as invoices are created or retried.</p>
      </div>
    </div>
  )
}
