"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import { formatDistanceToNow } from "date-fns"
import { AlertCircle, ArrowUpRight, Check, ExternalLink, Plug, RefreshCcw } from "lucide-react"
import { toast } from "sonner"

import {
  listQboSyncHistoryAction,
  listQboSyncQueueAction,
  syncAllQboPendingAction,
  syncQboItemAction,
  type QboSyncHistoryItem,
  type QboSyncEntityType,
  type QboSyncItem,
} from "@/app/(app)/integrations/qbo-sync-actions"
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

// Payments and bill payments are presented together under one "Payments" section.
const SECTIONS: { key: string; label: string; types: QboSyncEntityType[] }[] = [
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

export function QboSyncSheet({ open, onOpenChange, projectId, projectName, connectionId, initialTab = "sync", onOpenInvoice }: Props) {
  const [items, setItems] = useState<QboSyncItem[]>([])
  const [connected, setConnected] = useState(true)
  const [loading, setLoading] = useState(false)
  const [syncingAll, setSyncingAll] = useState(false)
  const [syncingId, setSyncingId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<"sync" | "import" | "history">(initialTab)
  const [history, setHistory] = useState<QboSyncHistoryItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [showFailedOnly, setShowFailedOnly] = useState(false)
  const [importConnections, setImportConnections] = useState<{ id: string; label: string; company: string | null }[]>([])
  const [importConnectionId, setImportConnectionId] = useState(connectionId ?? "")
  const canImport = Boolean(projectId)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const queue = await listQboSyncQueueAction({ projectId })
      setItems(queue.items)
      setConnected(queue.connected)
    } catch (error: any) {
      toast.error("Couldn't load the sync queue", { description: error?.message ?? "Try again." })
    } finally {
      setLoading(false)
    }
  }, [projectId])

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      setHistory(await listQboSyncHistoryAction({ projectId }))
    } catch (error: any) {
      toast.error("Couldn't load QuickBooks history", { description: error?.message ?? "Try again." })
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

  const failedCount = useMemo(() => items.filter((item) => item.status === "error" || item.status === "needs_review").length, [items])
  const pendingCount = items.length - failedCount
  const lastSyncedAt = useMemo(
    () => history.find((entry) => entry.status !== "error" && entry.syncedAt)?.syncedAt ?? null,
    [history],
  )

  const healthTone =
    failedCount > 0
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : pendingCount > 0
        ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
  const healthLabel = failedCount > 0 ? "Needs attention" : pendingCount > 0 ? "Waiting to sync" : "In sync"

  // Failed rows float to the top within each section so problems surface first.
  const sections = useMemo(
    () =>
      SECTIONS.map((section) => {
        const sectionItems = items
          .filter((item) => section.types.includes(item.entityType))
          .filter((item) => !showFailedOnly || item.status === "error" || item.status === "needs_review")
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
      const result = await syncAllQboPendingAction({ projectId })
      if (result.failed > 0) {
        toast.warning(`Synced ${result.synced}, ${result.failed} failed`, { description: result.errors[0] ?? "Open the failed items to see why." })
      } else {
        toast.success(result.synced > 0 ? `Synced ${result.synced} to QuickBooks` : "Nothing to sync")
      }
    } catch (error: any) {
      toast.error("Sync failed", { description: error?.message ?? "Try again." })
    } finally {
      setSyncingAll(false)
      await Promise.all([load(), loadHistory()])
    }
  }

  const handleSyncOne = async (item: QboSyncItem) => {
    if (syncingId) return
    setSyncingId(item.id)
    try {
      await syncQboItemAction(item.entityType, item.id)
      toast.success(item.entityType === "webhook_event" ? "Webhook event queued" : "Synced to QuickBooks")
    } catch (error: any) {
      toast.error("Sync failed", { description: error?.message ?? "Try again." })
    } finally {
      setSyncingId(null)
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
            <SheetTitle className="text-lg">QuickBooks</SheetTitle>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 text-xs font-medium",
                connected ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
              )}
            >
              <span className={cn("size-1.5 rounded-full", connected ? "bg-emerald-500" : "bg-muted-foreground/50")} />
              {connected ? "Connected" : "Not connected"}
            </span>
            {connected && projectName ? (
              <span className="ml-auto truncate text-xs text-muted-foreground">{projectName}</span>
            ) : null}
          </div>
          <SheetDescription className="sr-only">
            Sync, import, and review QuickBooks activity{projectName ? ` for ${projectName}` : ""}.
          </SheetDescription>
        </SheetHeader>

        {!connected ? (
          <ConnectPrompt />
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
              <div className="flex items-center justify-between gap-3 border-b px-6 py-3">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                  <Badge variant="secondary" className={cn("h-6 rounded-none border", healthTone)}>
                    {healthLabel}
                  </Badge>
                  <Badge variant="secondary" className="h-6 rounded-none">
                    {pendingCount} queued
                  </Badge>
                  {failedCount > 0 ? (
                    <button type="button" onClick={() => setShowFailedOnly((value) => !value)}>
                      <Badge
                        variant="secondary"
                        className={cn(
                          "h-6 gap-1 rounded-none border-destructive/30 bg-destructive/10 text-destructive",
                          showFailedOnly && "ring-1 ring-destructive/40",
                        )}
                      >
                        <AlertCircle className="size-3" />
                        {failedCount} failed
                      </Badge>
                    </button>
                  ) : null}
                  {lastSyncedAt ? (
                    <span className="truncate text-muted-foreground">Last synced {formatRelative(lastSyncedAt)}</span>
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
              <ScrollArea className="flex-1">
                {loading && items.length === 0 ? (
                  <ListSkeleton />
                ) : items.length === 0 ? (
                  <CenteredState
                    tone="success"
                    icon={<Check className="size-5" />}
                    title="Everything is in sync"
                    body="New invoices, expenses, bills, and payments will appear here until QuickBooks accepts them."
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
                    title="No QuickBooks history yet"
                    body="Synced and imported records will appear here."
                  />
                ) : (
                  <ul className="divide-y">
                    {history.map((item) => (
                      <li key={item.id} className="flex items-center gap-3 px-6 py-3">
                        <span
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            item.status === "error" ? "bg-destructive" : "bg-emerald-500",
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{item.label}</p>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {item.entityType.replaceAll("_", " ")} · {item.direction} · {item.status}
                            {item.qboId ? ` · QBO ${item.qboId}` : ""}
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
    </Sheet>
  )
}

function ConnectPrompt() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Plug className="size-5" />
      </div>
      <p className="mt-4 text-sm font-medium">QuickBooks isn't connected</p>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">
        Connect QuickBooks to push records and import existing transactions into Arc.
      </p>
      <Button asChild className="mt-5">
        <Link href={SETTINGS_HREF}>
          Open QuickBooks settings
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
            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
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
  onSync,
  onOpen,
}: {
  item: QboSyncItem
  syncing: boolean
  disabled: boolean
  onSync: () => void
  onOpen?: () => void
}) {
  const failed = item.status === "error" || item.status === "needs_review"
  const lastAttempt = formatRelative(item.lastAttemptAt)

  return (
    <li className="group flex items-center gap-3 px-6 py-3 transition-colors hover:bg-muted/20">
      <span
        className={cn("size-1.5 shrink-0 rounded-full", failed ? "bg-destructive" : "bg-amber-500")}
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
          {failed ? (
            <span className="truncate text-destructive">{item.error || (item.status === "needs_review" ? "Needs review" : "Sync failed")}</span>
          ) : (
            <span className="truncate">{lastAttempt ? `Last tried ${lastAttempt}` : "Waiting to sync"}</span>
          )}
        </div>
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
