"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import { formatDistanceToNow } from "date-fns"
import { AlertCircle, ArrowUpRight, Check, ChevronRight, ExternalLink, Plug, RefreshCcw } from "lucide-react"
import { toast } from "sonner"

import {
  listAccountingSyncHistoryAction,
  listAccountingSyncQueueAction,
  resolveAccountingConflictAction,
  syncAllAccountingPendingAction,
  syncAccountingItemAction,
  type AccountingSyncHistoryItem,
  type AccountingSyncEntityType,
  type AccountingSyncQueueItem,
} from "@/app/(app)/integrations/accounting-sync-actions"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { QboImportPanel } from "@/components/integrations/qbo-import-sheet"
import { listQboImportConnectionsAction } from "@/app/(app)/integrations/qbo-import-actions"
import { cn } from "@/lib/utils"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId?: string
  projectName?: string | null
  connectionId?: string
  initialTab?: "sync" | "import" | "history"
  /** Optional: open an invoice's detail when its row is clicked. */
  onOpenInvoice?: (invoiceId: string) => void
}

const SETTINGS_HREF = "/settings?tab=integrations"

/**
 * Entity types a conflict can actually be resolved for. Payments and inbound
 * events have no "Arc's version" to re-push, so they keep only Retry.
 */
type ResolvableEntityType = "invoice" | "expense" | "bill"

function resolvableEntityType(item: AccountingSyncQueueItem): ResolvableEntityType | null {
  if (item.status !== "needs_review" && item.status !== "conflict") return null
  return item.entityType === "invoice" || item.entityType === "expense" || item.entityType === "bill" ? item.entityType : null
}

// Payments and bill payments are presented together under one "Payments" section.
const SECTIONS: { key: string; label: string; types: AccountingSyncEntityType[] }[] = [
  { key: "invoice", label: "Invoices", types: ["invoice"] },
  { key: "expense", label: "Expenses", types: ["expense"] },
  { key: "bill", label: "Bills", types: ["bill"] },
  { key: "payment", label: "Payments", types: ["payment", "bill_payment"] },
  { key: "webhook", label: "Inbound events", types: ["webhook_event"] },
]

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function formatRelative(value?: string | null) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return formatDistanceToNow(date, { addSuffix: true })
}

export function AccountingSyncSheet({ open, onOpenChange, projectId, projectName, connectionId, initialTab = "sync", onOpenInvoice }: Props) {
  const [items, setItems] = useState<AccountingSyncQueueItem[]>([])
  const [connected, setConnected] = useState(true)
  const [provider, setProvider] = useState<{ key: string; name: string; supportsImport: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncingAll, setSyncingAll] = useState(false)
  const [syncingId, setSyncingId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<"sync" | "import" | "history">(initialTab)
  const [history, setHistory] = useState<AccountingSyncHistoryItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [showFailedOnly, setShowFailedOnly] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [ignoredEvents, setIgnoredEvents] = useState<{ count: number; reasons: Array<{ reason: string; count: number }> }>({
    count: 0,
    reasons: [],
  })
  const [ignoredExpanded, setIgnoredExpanded] = useState(false)
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  /** A `take_remote` awaiting confirmation — it overwrites Arc's copy. */
  const [pendingTakeRemote, setPendingTakeRemote] = useState<AccountingSyncQueueItem | null>(null)
  const [importConnections, setImportConnections] = useState<{ id: string; label: string; company: string | null }[]>([])
  const [importConnectionId, setImportConnectionId] = useState(connectionId ?? "")
  /**
   * What to call the thing on the other end. Falls back to a plain noun rather
   * than a brand: an org with no connection yet has no provider to name, and
   * guessing one is how "QuickBooks" ended up hardcoded in the first place.
   */
  const providerName = provider?.name ?? "Accounting"
  // Import needs a destination project and a provider that can be read from.
  // A batch/file target can be written to but never queried.
  const canImport = Boolean(projectId) && provider?.supportsImport === true

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const queue = await listAccountingSyncQueueAction({ projectId })
      setItems(queue.items)
      setConnected(queue.connected)
      setProvider(queue.provider)
      setTruncated(queue.truncated)
      setIgnoredEvents(queue.ignoredEvents)
    } catch (error: any) {
      toast.error("Couldn't load the sync queue", { description: error?.message ?? "Try again." })
    } finally {
      setLoading(false)
    }
  }, [projectId])

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      setHistory(await listAccountingSyncHistoryAction({ projectId }))
    } catch (error: any) {
      toast.error("Couldn't load sync history", { description: error?.message ?? "Try again." })
    } finally {
      setHistoryLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (open) {
      void load()
      void loadHistory()
      void listQboImportConnectionsAction().then((rows) => {
        setImportConnections(rows)
        setImportConnectionId((current) => connectionId ?? (current || rows[0]?.id || ""))
      }).catch(() => setImportConnections([]))
    }
  }, [open, load, loadHistory, connectionId])

  useEffect(() => {
    if (open) setActiveTab(canImport ? initialTab : initialTab === "import" ? "sync" : initialTab)
  }, [canImport, initialTab, open])

  // Three different problems used to be summed into one "failed" number: a push
  // that errored, a record a person has to resolve, and a genuine Arc/provider
  // disagreement need different actions, so they get their own counters.
  const errorCount = useMemo(() => items.filter((item) => item.status === "error").length, [items])
  const needsReviewCount = useMemo(() => items.filter((item) => item.status === "needs_review").length, [items])
  const conflictCount = useMemo(() => items.filter((item) => item.status === "conflict").length, [items])
  const attentionCount = errorCount + needsReviewCount + conflictCount
  const pendingCount = items.length - attentionCount
  const lastSyncedAt = useMemo(
    () => history.find((entry) => entry.status !== "error" && entry.syncedAt)?.syncedAt ?? null,
    [history],
  )

  const healthTone =
    attentionCount > 0
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : pendingCount > 0
        ? "border-warning/30 bg-warning/10 text-warning"
        : "border-success/30 bg-success/10 text-success"
  const healthLabel = attentionCount > 0 ? "Needs attention" : pendingCount > 0 ? "Waiting to sync" : "In sync"

  // Failed rows float to the top within each section so problems surface first.
  const sections = useMemo(
    () =>
      SECTIONS.map((section) => {
        const sectionItems = items
          .filter((item) => section.types.includes(item.entityType))
          .filter((item) => !showFailedOnly || item.status !== "pending")
          .sort((a, b) => Number(b.status !== "pending") - Number(a.status !== "pending"))
        const total = sectionItems.reduce((sum, item) => sum + item.amountCents, 0)
        return { ...section, items: sectionItems, total }
      }).filter((section) => section.items.length > 0),
    [items, showFailedOnly],
  )

  const handleSyncAll = async () => {
    if (syncingAll || items.length === 0) return
    setSyncingAll(true)
    try {
      const result = await syncAllAccountingPendingAction({ projectId })
      if (result.failed > 0) {
        toast.warning(`Queued ${result.queued}, ${result.failed} could not be queued`, { description: result.errors[0] ?? "Open the failed items to see why." })
      } else {
        toast.success(
          result.queued > 0
            ? `Queued ${result.queued} for ${providerName}. They post within a few minutes.`
            : "Nothing to sync",
        )
      }
    } catch (error: any) {
      toast.error("Sync failed", { description: error?.message ?? "Try again." })
    } finally {
      setSyncingAll(false)
      await Promise.all([load(), loadHistory()])
    }
  }

  const handleSyncOne = async (item: AccountingSyncQueueItem) => {
    if (syncingId) return
    setSyncingId(item.id)
    try {
      const result = await syncAccountingItemAction(item.entityType, item.id)
      if (item.entityType === "webhook_event") {
        toast.success("Webhook event queued")
      } else if (result.reason === "books_authoritative") {
        toast.info("Arc is the ledger of record — nothing pushed")
      } else if (result.skipped) {
        toast.info("Nothing to push")
      } else {
        toast.success(`Queued for ${providerName}`)
      }
    } catch (error: any) {
      toast.error("Sync failed", { description: error?.message ?? "Try again." })
    } finally {
      setSyncingId(null)
      await Promise.all([load(), loadHistory()])
    }
  }

  const handleResolve = async (item: AccountingSyncQueueItem, resolution: "keep_arc" | "take_remote") => {
    const entityType = resolvableEntityType(item)
    if (!entityType || resolvingId) return
    setResolvingId(item.id)
    try {
      const result = await resolveAccountingConflictAction({ entityType, id: item.id, resolution })
      if (result.resolved) {
        toast.success(
          resolution === "keep_arc"
            ? `Queued Arc's version for ${providerName}`
            : `Applied the ${providerName} version to Arc`,
        )
      } else {
        toast.error("Couldn't resolve", { description: result.error ?? "Try again." })
      }
    } catch (error: any) {
      toast.error("Couldn't resolve", { description: error?.message ?? "Try again." })
    } finally {
      setResolvingId(null)
      await Promise.all([load(), loadHistory()])
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className={cn(
          "flex w-full flex-col gap-0 overflow-hidden p-0 shadow-2xl transition-[max-width] duration-300 ease-out sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)]",
          // The import grid needs room for its destination column, so the sheet widens on that tab.
          activeTab === "import" ? "sm:max-w-5xl" : "sm:max-w-xl",
        )}
      >
        <SheetHeader className="border-b px-6 pb-4 pt-6">
          <div className="flex items-center gap-2 pr-8">
            <SheetTitle className="text-lg">{providerName}</SheetTitle>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 text-xs font-medium",
                connected ? "text-success" : "text-muted-foreground",
              )}
            >
              <span className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-muted-foreground/50")} />
              {connected ? "Connected" : "Not connected"}
            </span>
            {connected && projectName ? (
              <span className="ml-auto truncate text-xs text-muted-foreground">{projectName}</span>
            ) : null}
          </div>
          <SheetDescription className="sr-only">
            Sync, import, and review {providerName} activity{projectName ? ` for ${projectName}` : ""}.
          </SheetDescription>
        </SheetHeader>

        {/*
          A disconnected or expired connection is exactly when a backlog exists,
          so hiding the queue behind "connect QuickBooks" hid the thing the user
          came to see. The prompt is only the whole story when there is genuinely
          nothing queued; otherwise it becomes a banner over the real list.
        */}
        {!connected && items.length === 0 && !loading ? (
          <ConnectPrompt providerName={providerName} />
        ) : (
          <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as "sync" | "import" | "history")}
            className="flex min-h-0 flex-1 flex-col"
          >
            <TabsList
              className={cn(
                "grid h-11 w-full rounded-none border-b bg-transparent p-0",
                canImport ? "grid-cols-3" : "grid-cols-2",
              )}
            >
              {(["sync", canImport ? "import" : null, "history"] as const)
                .filter((value): value is "sync" | "import" | "history" => value !== null)
                .map((value) => (
                  <TabsTrigger
                    key={value}
                    value={value}
                    className="h-full rounded-none border-0 border-b-2 border-transparent bg-transparent capitalize shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    {value}
                  </TabsTrigger>
                ))}
            </TabsList>

            <TabsContent value="sync" className="m-0 flex min-h-0 flex-1 flex-col">
              {!connected ? (
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-warning bg-warning/10 px-6 py-3">
                  <p className="text-sm">
                    <span className="font-medium">No active {providerName} connection.</span>{" "}
                    <span className="text-muted-foreground">
                      These are waiting and will not post until it is reconnected.
                    </span>
                  </p>
                  <Button asChild size="sm" variant="outline" className="h-8 shrink-0">
                    <Link href={SETTINGS_HREF}>Reconnect</Link>
                  </Button>
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-3 border-b px-6 py-3">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                  <Badge variant="secondary" className={cn("h-6 rounded-none border", healthTone)}>
                    {healthLabel}
                  </Badge>
                  <Badge variant="secondary" className="h-6 rounded-none">
                    {pendingCount} queued
                  </Badge>
                  {attentionCount > 0 ? (
                    <button type="button" onClick={() => setShowFailedOnly((value) => !value)} className="flex flex-wrap items-center gap-1.5">
                      {errorCount > 0 ? (
                        <Badge
                          variant="secondary"
                          className={cn(
                            "h-6 gap-1 rounded-none border-destructive/30 bg-destructive/10 text-destructive",
                            showFailedOnly && "ring-1 ring-destructive/40",
                          )}
                        >
                          <AlertCircle className="size-3" />
                          {errorCount} failed
                        </Badge>
                      ) : null}
                      {needsReviewCount > 0 ? (
                        <Badge
                          variant="secondary"
                          className={cn(
                            "h-6 gap-1 rounded-none border-warning/30 bg-warning/10 text-warning",
                            showFailedOnly && "ring-1 ring-warning/40",
                          )}
                        >
                          <AlertCircle className="size-3" />
                          {needsReviewCount} need review
                        </Badge>
                      ) : null}
                      {conflictCount > 0 ? (
                        <Badge
                          variant="secondary"
                          className={cn(
                            "h-6 gap-1 rounded-none border-warning/30 bg-warning/10 text-warning",
                            showFailedOnly && "ring-1 ring-warning/40",
                          )}
                        >
                          <AlertCircle className="size-3" />
                          {conflictCount} in conflict
                        </Badge>
                      ) : null}
                    </button>
                  ) : null}
                  {lastSyncedAt ? (
                    <span className="truncate text-muted-foreground">Last synced {formatRelative(lastSyncedAt)}</span>
                  ) : null}
                  {truncated ? (
                    <span className="truncate text-muted-foreground">Showing the most recent 500 per type</span>
                  ) : null}
                </div>
                <Button
                  onClick={handleSyncAll}
                  disabled={syncingAll || loading || items.length === 0}
                  size="sm"
                  className="h-8 shrink-0"
                >
                  {syncingAll ? <Spinner className="mr-1.5 size-4" /> : <RefreshCcw className="mr-1.5 size-4" />}
                  Sync now
                </Button>
              </div>
              {ignoredEvents.count > 0 ? (
                <div className="shrink-0 border-b bg-muted/20 px-6 py-2">
                  <button
                    type="button"
                    onClick={() => setIgnoredExpanded((value) => !value)}
                    className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronRight className={cn("size-3 shrink-0 transition-transform", ignoredExpanded && "rotate-90")} />
                    <span>
                      {ignoredEvents.count} inbound {ignoredEvents.count === 1 ? "change was" : "changes were"} ignored
                    </span>
                  </button>
                  {ignoredExpanded ? (
                    <ul className="mt-1.5 space-y-1 pl-[18px]">
                      {ignoredEvents.reasons.map((entry) => (
                        <li key={entry.reason} className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
                          <span className="min-w-0 flex-1">{entry.reason}</span>
                          <span className="shrink-0 tabular-nums">{entry.count}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              <ScrollArea className="flex-1">
                {loading && items.length === 0 ? (
                  <ListSkeleton />
                ) : items.length === 0 ? (
                  <CenteredState
                    tone="success"
                    icon={<Check className="size-5" />}
                    title="Everything is in sync"
                    body={`New invoices, expenses, bills, and payments appear here until ${providerName} accepts them.`}
                  />
                ) : sections.length === 0 ? (
                  <CenteredState
                    tone="muted"
                    icon={<Check className="size-5" />}
                    title="No failed items"
                    body="Clear the filter to see everything that's still queued."
                  />
                ) : (
                  <div className="divide-y">
                    {sections.map((section) => (
                      <section key={section.key}>
                        <div className="flex items-center justify-between gap-2 bg-muted/30 px-6 py-2">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{section.label}</span>
                            <span className="text-xs text-muted-foreground">{section.items.length}</span>
                          </div>
                          <span className="text-xs tabular-nums text-muted-foreground">{formatMoney(section.total)}</span>
                        </div>
                        <ul>
                          {section.items.map((item) => (
                            <SyncRow
                              key={`${item.entityType}:${item.id}`}
                              item={item}
                              syncing={syncingId === item.id}
                              disabled={Boolean(syncingId) || syncingAll}
                              providerName={providerName}
                              resolving={resolvingId === item.id}
                              resolveDisabled={Boolean(resolvingId) || syncingAll}
                              onKeepArc={() => void handleResolve(item, "keep_arc")}
                              onTakeRemote={() => setPendingTakeRemote(item)}
                              onSync={() => handleSyncOne(item)}
                              onOpen={item.entityType === "invoice" && onOpenInvoice ? () => onOpenInvoice(item.id) : undefined}
                            />
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </TabsContent>

            {canImport && projectId ? (
              <TabsContent value="import" className="m-0 flex min-h-0 flex-1 flex-col">
                <QboImportPanel
                  active={open && activeTab === "import"}
                  connectionId={importConnectionId}
                  connections={importConnections}
                  onConnectionChange={setImportConnectionId}
                  projectId={projectId}
                  projectName={projectName}
                  onCancel={() => onOpenChange(false)}
                />
              </TabsContent>
            ) : null}

            <TabsContent value="history" className="m-0 flex min-h-0 flex-1 flex-col">
              <ScrollArea className="flex-1">
                {historyLoading && history.length === 0 ? (
                  <ListSkeleton />
                ) : history.length === 0 ? (
                  <CenteredState
                    tone="muted"
                    icon={<Check className="size-5" />}
                    title="No sync history yet"
                    body="Synced and imported records will appear here."
                  />
                ) : (
                  <ul className="divide-y">
                    {history.map((item) => (
                      <li key={item.id} className="flex items-center gap-3 px-6 py-3">
                        <span
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            item.status === "error" ? "bg-destructive" : "bg-success",
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{item.label}</p>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {item.entityType.replaceAll("_", " ")} · {item.direction} · {item.status}
                            {item.externalId ? ` · ${item.externalId}` : ""}
                          </p>
                          {item.error ? <p className="mt-0.5 truncate text-xs text-destructive">{item.error}</p> : null}
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(item.syncedAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </ScrollArea>
            </TabsContent>
          </Tabs>
        )}
      </SheetContent>

      <AlertDialog open={Boolean(pendingTakeRemote)} onOpenChange={(next) => !next && setPendingTakeRemote(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Take {providerName}&rsquo;s version?</AlertDialogTitle>
            <AlertDialogDescription>
              This overwrites Arc&rsquo;s copy of {pendingTakeRemote?.label ?? "this record"} with the {providerName}{" "}
              version. Anything edited in Arc since the two diverged is replaced.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = pendingTakeRemote
                setPendingTakeRemote(null)
                if (target) void handleResolve(target, "take_remote")
              }}
            >
              Overwrite Arc&rsquo;s copy
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  )
}

function ConnectPrompt({ providerName }: { providerName: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Plug className="size-5" />
      </div>
      <p className="mt-4 text-sm font-medium">{providerName} isn&rsquo;t connected</p>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">
        Connect an accounting system to push records and import existing transactions into Arc.
      </p>
      <Button asChild className="mt-5">
        <Link href={SETTINGS_HREF}>
          Open accounting settings
          <ExternalLink className="ml-1.5 size-4" />
        </Link>
      </Button>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-3 p-6">
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="h-14 animate-pulse bg-muted/60" />
      ))}
    </div>
  )
}

function CenteredState({
  tone,
  icon,
  title,
  body,
}: {
  tone: "success" | "muted"
  icon: React.ReactNode
  title: string
  body: string
}) {
  return (
    <div className="flex h-full min-h-80 flex-col items-center justify-center px-8 text-center">
      <div
        className={cn(
          "flex size-11 items-center justify-center rounded-full",
          tone === "success"
            ? "bg-success/10 text-success"
            : "bg-muted text-muted-foreground",
        )}
      >
        {icon}
      </div>
      <p className="mt-4 text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">{body}</p>
    </div>
  )
}

function SyncRow({
  item,
  syncing,
  disabled,
  providerName,
  resolving,
  resolveDisabled,
  onKeepArc,
  onTakeRemote,
  onSync,
  onOpen,
}: {
  item: AccountingSyncQueueItem
  syncing: boolean
  disabled: boolean
  providerName: string
  resolving: boolean
  resolveDisabled: boolean
  onKeepArc: () => void
  onTakeRemote: () => void
  onSync: () => void
  onOpen?: () => void
}) {
  const failed = item.status !== "pending"
  const lastAttempt = formatRelative(item.lastAttemptAt)
  const canResolve = resolvableEntityType(item) !== null

  return (
    <li className="group flex items-center gap-3 px-6 py-3 transition-colors hover:bg-muted/20">
      <span
        className={cn("size-1.5 shrink-0 rounded-full", failed ? "bg-destructive" : "bg-warning")}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {onOpen ? (
            <button type="button" onClick={onOpen} className="truncate text-sm font-medium hover:text-primary">
              {item.label}
            </button>
          ) : (
            <span className="truncate text-sm font-medium">{item.label}</span>
          )}
          {onOpen && <ArrowUpRight className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          {item.sublabel && <span className="truncate">{item.sublabel}</span>}
          {item.sublabel && (lastAttempt || failed) && <span aria-hidden>·</span>}
          {item.status === "conflict" ? (
            <span className="truncate font-medium text-destructive">
              Conflict — {item.error || "Arc and the accounting system disagree about this record"}
            </span>
          ) : failed ? (
            <span className="truncate text-destructive">{item.error || (item.status === "needs_review" ? "Needs review" : "Sync failed")}</span>
          ) : (
            <span className="truncate">{lastAttempt ? `Last tried ${lastAttempt}` : "Waiting to sync"}</span>
          )}
        </div>
        {canResolve ? (
          <div className="mt-1.5 flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onKeepArc}
              disabled={resolveDisabled}
            >
              {resolving ? <Spinner className="mr-1.5 size-3" /> : null}
              Keep Arc&rsquo;s version
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={onTakeRemote}
              disabled={resolveDisabled}
            >
              Take {providerName}&rsquo;s version
            </Button>
          </div>
        ) : null}
      </div>
      <span className="shrink-0 text-sm font-medium tabular-nums">{formatMoney(item.amountCents)}</span>
      <Button
        variant={failed ? "default" : "outline"}
        size="sm"
        className="h-8 shrink-0"
        onClick={onSync}
        disabled={disabled}
      >
        {syncing ? <Spinner className="size-3.5" /> : <RefreshCcw className="size-3.5" />}
        <span className="ml-1.5 hidden sm:inline">{item.entityType === "webhook_event" ? "Retry" : failed ? "Retry" : "Sync"}</span>
      </Button>
    </li>
  )
}
