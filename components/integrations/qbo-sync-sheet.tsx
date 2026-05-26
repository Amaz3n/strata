"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { formatDistanceToNow } from "date-fns"
import { AlertCircle, ArrowUpRight, Check, RefreshCcw } from "lucide-react"
import { toast } from "sonner"

import {
  listQboSyncQueueAction,
  syncAllQboPendingAction,
  syncQboItemAction,
  type QboSyncEntityType,
  type QboSyncItem,
} from "@/app/(app)/integrations/qbo-sync-actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Optional: open an invoice's detail when its row is clicked. */
  onOpenInvoice?: (invoiceId: string) => void
}

// Payments and bill payments are presented together under one "Payments" section.
const SECTIONS: { key: string; label: string; types: QboSyncEntityType[] }[] = [
  { key: "invoice", label: "Invoices", types: ["invoice"] },
  { key: "expense", label: "Expenses", types: ["expense"] },
  { key: "bill", label: "Bills", types: ["bill"] },
  { key: "payment", label: "Payments", types: ["payment", "bill_payment"] },
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

export function QboSyncSheet({ open, onOpenChange, onOpenInvoice }: Props) {
  const [items, setItems] = useState<QboSyncItem[]>([])
  const [connected, setConnected] = useState(true)
  const [loading, setLoading] = useState(false)
  const [syncingAll, setSyncingAll] = useState(false)
  const [syncingId, setSyncingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const queue = await listQboSyncQueueAction()
      setItems(queue.items)
      setConnected(queue.connected)
    } catch (error: any) {
      toast.error("Couldn't load the sync queue", { description: error?.message ?? "Try again." })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const failedCount = useMemo(() => items.filter((item) => item.status === "error").length, [items])
  const pendingCount = items.length - failedCount

  const sections = useMemo(
    () =>
      SECTIONS.map((section) => {
        const sectionItems = items.filter((item) => section.types.includes(item.entityType))
        const total = sectionItems.reduce((sum, item) => sum + item.amountCents, 0)
        return { ...section, items: sectionItems, total }
      }).filter((section) => section.items.length > 0),
    [items],
  )

  const handleSyncAll = async () => {
    if (syncingAll || items.length === 0) return
    setSyncingAll(true)
    try {
      const result = await syncAllQboPendingAction()
      if (result.failed > 0) {
        toast.warning(`Synced ${result.synced}, ${result.failed} failed`, { description: "Open the failed items to see why." })
      } else {
        toast.success(result.synced > 0 ? `Synced ${result.synced} to QuickBooks` : "Nothing to sync")
      }
      await load()
    } finally {
      setSyncingAll(false)
    }
  }

  const handleSyncOne = async (item: QboSyncItem) => {
    if (syncingId) return
    setSyncingId(item.id)
    try {
      await syncQboItemAction(item.entityType, item.id)
      toast.success("Synced to QuickBooks")
      await load()
    } catch (error: any) {
      toast.error("Sync failed", { description: error?.message ?? "Try again." })
      await load()
    } finally {
      setSyncingId(null)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="flex w-full flex-col gap-0 overflow-hidden p-0 shadow-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-xl"
      >
        <SheetHeader className="space-y-3 border-b px-6 pb-5 pt-6">
          <div className="flex items-start justify-between gap-4 pr-8">
            <div className="space-y-1">
              <SheetTitle className="text-lg">QuickBooks sync</SheetTitle>
              <SheetDescription className="text-left">
                {connected
                  ? "Records sync to QuickBooks automatically every few minutes. Push everything now if you don't want to wait."
                  : "Connect QuickBooks in Settings to start syncing."}
              </SheetDescription>
            </div>
            <Button onClick={handleSyncAll} disabled={!connected || syncingAll || loading || items.length === 0} className="shrink-0">
              {syncingAll ? <Spinner className="mr-1.5 size-4" /> : <RefreshCcw className="mr-1.5 size-4" />}
              Sync now
            </Button>
          </div>
          {connected && (
            <div className="flex items-center gap-2 text-xs">
              <Badge variant="secondary" className="h-6 rounded-none">
                {pendingCount} waiting
              </Badge>
              {failedCount > 0 && (
                <Badge variant="secondary" className="h-6 gap-1 rounded-none border-destructive/30 bg-destructive/10 text-destructive">
                  <AlertCircle className="size-3" />
                  {failedCount} failed
                </Badge>
              )}
            </div>
          )}
        </SheetHeader>

        <ScrollArea className="flex-1">
          {loading && items.length === 0 ? (
            <div className="space-y-3 p-6">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="h-14 animate-pulse bg-muted/60" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-full min-h-80 flex-col items-center justify-center px-8 text-center">
              <div className="flex size-11 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <Check className="size-5" />
              </div>
              <p className="mt-4 text-sm font-medium">Everything is in sync</p>
              <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                New invoices, expenses, bills, and payments will appear here until QuickBooks accepts them.
              </p>
            </div>
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
      </SheetContent>
    </Sheet>
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
  const failed = item.status === "error"
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
            <span className="truncate text-destructive">{item.error || "Sync failed"}</span>
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
        <span className="ml-1.5 hidden sm:inline">{failed ? "Retry" : "Sync"}</span>
      </Button>
    </li>
  )
}
