"use client"

import Link from "next/link"
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import { Download, ExternalLink, Link2, Plug } from "lucide-react"
import { toast } from "sonner"

import {
  importQboRecordsAction,
  listQboImportRecordsAction,
} from "@/app/(app)/integrations/qbo-import-actions"
import type { QboImportEntityType, QboImportRecord } from "@/lib/services/qbo-import"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  projectName?: string | null
}

type QboImportPanelProps = {
  active?: boolean
  projectId: string
  projectName?: string | null
}

const SECTIONS: { key: QboImportEntityType; label: string }[] = [
  { key: "invoice", label: "Invoices" },
  { key: "expense", label: "Expenses" },
  { key: "bill", label: "Bills" },
  { key: "payment", label: "Invoice payments" },
  { key: "bill_payment", label: "Bill payments" },
]

const TYPE_LABELS: Record<QboImportEntityType, string> = {
  invoice: "Invoices",
  expense: "Expenses",
  bill: "Bills",
  payment: "Invoice payments",
  bill_payment: "Bill payments",
}

const LOOKBACK_OPTIONS: { value: string; label: string; days: number | null }[] = [
  { value: "90", label: "Last 90 days", days: 90 },
  { value: "365", label: "Last 12 months", days: 365 },
  { value: "730", label: "Last 24 months", days: 730 },
  { value: "all", label: "All time", days: null },
]

function rowKey(record: { entityType: QboImportEntityType; qboId: string }) {
  return `${record.entityType}:${record.qboId}`
}

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function formatDate(value: string | null) {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function sinceDateFor(value: string): string | null {
  const option = LOOKBACK_OPTIONS.find((o) => o.value === value)
  if (!option || option.days == null) return null
  const d = new Date()
  d.setDate(d.getDate() - option.days)
  return d.toISOString().split("T")[0]
}

export function QboImportSheet({ open, onOpenChange, projectId, projectName }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="flex w-full flex-col gap-0 overflow-hidden p-0 shadow-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-xl"
      >
        <SheetHeader className="space-y-3 border-b px-6 pb-5 pt-6">
          <div className="space-y-1 pr-8">
            <SheetTitle className="text-lg">Import from QuickBooks</SheetTitle>
            <SheetDescription className="text-left">
              Select unmatched QuickBooks invoices, expenses, bills, or payments and import them into {projectName ?? "this project"}.
            </SheetDescription>
          </div>
        </SheetHeader>
        <QboImportPanel active={open} projectId={projectId} projectName={projectName} />
      </SheetContent>
    </Sheet>
  )
}

export function QboImportPanel({ active = true, projectId, projectName }: QboImportPanelProps) {
  const [records, setRecords] = useState<QboImportRecord[]>([])
  const [connected, setConnected] = useState(true)
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [lookback, setLookback] = useState("365")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [visibleTypes, setVisibleTypes] = useState<Set<QboImportEntityType>>(
    () => new Set(SECTIONS.map((section) => section.key)),
  )
  const [lastImport, setLastImport] = useState<Record<QboImportEntityType, number> | null>(null)

  const load = useCallback(
    async (lookbackValue: string) => {
      setLoading(true)
      try {
        const listing = await listQboImportRecordsAction({ sinceDate: sinceDateFor(lookbackValue) })
        setRecords(listing.records)
        setConnected(listing.connected)
        setSelected(new Set())
      } catch (error: any) {
        toast.error("Couldn't load QuickBooks records", { description: error?.message ?? "Try again." })
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (active) void load(lookback)
  }, [active, lookback, load])

  const sections = useMemo(
    () =>
      SECTIONS.map((section) => ({
        ...section,
        items: records.filter((record) => record.entityType === section.key && visibleTypes.has(record.entityType)),
      })).filter((section) => section.items.length > 0),
    [records, visibleTypes],
  )

  const recordByKey = useMemo(() => new Map(records.map((record) => [rowKey(record), record])), [records])

  function dependencyKeys(record: QboImportRecord) {
    if (record.dependencyStatus !== "available_to_import" || !record.linkedEntityType) return []
    return (record.linkedQboIds ?? []).map((qboId) => `${record.linkedEntityType}:${qboId}`).filter((key) => recordByKey.has(key))
  }

  function canImportRecord(record: QboImportRecord) {
    return record.dependencyStatus !== "missing"
  }

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      const record = recordByKey.get(key)
      if (next.has(key)) {
        next.delete(key)
      } else if (record && canImportRecord(record)) {
        next.add(key)
        for (const dependencyKey of dependencyKeys(record)) next.add(dependencyKey)
      }
      return next
    })
  }

  const toggleSection = (items: QboImportRecord[], allSelected: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const item of items) {
        const key = rowKey(item)
        if (allSelected) next.delete(key)
        else if (canImportRecord(item)) {
          next.add(key)
          for (const dependencyKey of dependencyKeys(item)) next.add(dependencyKey)
        }
      }
      return next
    })
  }

  const selectedItems = useMemo(
    () => records.filter((record) => selected.has(rowKey(record))),
    [records, selected],
  )
  const selectedTotal = useMemo(
    () => selectedItems.reduce((sum, item) => sum + item.amountCents, 0),
    [selectedItems],
  )

  const visibleTypeCounts = useMemo(() => {
    return records.reduce<Record<QboImportEntityType, number>>(
      (acc, record) => {
        acc[record.entityType] += 1
        return acc
      },
      { invoice: 0, expense: 0, bill: 0, payment: 0, bill_payment: 0 },
    )
  }, [records])

  function toggleType(type: QboImportEntityType) {
    setVisibleTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type) && next.size > 1) next.delete(type)
      else next.add(type)
      return next
    })
  }

  const handleImport = async () => {
    if (importing || selectedItems.length === 0) return
    setImporting(true)
    try {
      const result = await importQboRecordsAction({
        projectId,
        items: selectedItems.map((item) => ({ qboId: item.qboId, entityType: item.entityType })),
      })

      if (result.failed > 0) {
        const firstError = result.errors[0]?.message
        toast.warning(
          `Imported ${result.imported}, ${result.failed} failed${result.skipped ? `, ${result.skipped} already imported` : ""}`,
          { description: firstError ?? "Open the items to see why." },
        )
      } else {
        toast.success(
          result.imported > 0
            ? `Imported ${result.imported} into ${projectName ?? "this project"}${result.skipped ? ` (${result.skipped} already imported)` : ""}`
            : "Nothing new to import",
        )
      }
      if (result.imported > 0) {
        setLastImport(
          selectedItems.reduce<Record<QboImportEntityType, number>>(
            (acc, item) => {
              acc[item.entityType] += 1
              return acc
            },
            { invoice: 0, expense: 0, bill: 0, payment: 0, bill_payment: 0 },
          ),
        )
      }
      await load(lookback)
    } catch (error: any) {
      toast.error("Import failed", { description: error?.message ?? "Try again." })
    } finally {
      setImporting(false)
    }
  }

  return (
    <>
      {connected && (
        <div className="flex shrink-0 flex-col gap-2 border-b bg-muted/20 px-6 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-2">
            <p className="text-xs text-muted-foreground">Import unmatched QuickBooks transactions into:</p>
            <div className="inline-flex max-w-full items-center border bg-background px-2.5 py-1 text-xs font-medium">
              <span className="truncate">{projectName ?? "Current project"}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Select value={lookback} onValueChange={setLookback} disabled={loading || importing}>
              <SelectTrigger className="h-8 w-44 rounded-none text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOOKBACK_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Badge variant="secondary" className="h-6 rounded-none">
              {records.length} unmatched
            </Badge>
          </div>
        </div>
      )}

      {connected && (
        <div className="flex shrink-0 gap-2 overflow-x-auto border-b px-6 py-2">
          {SECTIONS.map((section) => (
            <button
              key={section.key}
              type="button"
              onClick={() => toggleType(section.key)}
              className={cn(
                "flex h-8 shrink-0 items-center gap-1.5 border px-2.5 text-xs font-medium transition-colors",
                visibleTypes.has(section.key) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {section.label}
              <span className="bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{visibleTypeCounts[section.key]}</span>
            </button>
          ))}
        </div>
      )}

      {lastImport && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-emerald-500/10 px-6 py-3 text-xs">
          <span className="font-medium text-emerald-700 dark:text-emerald-400">Imported successfully.</span>
          {(lastImport.invoice > 0 || lastImport.payment > 0) && <ImportLink href={`/projects/${projectId}/financials/receivables`} label="Open Receivables" />}
          {(lastImport.bill > 0 || lastImport.bill_payment > 0) && <ImportLink href={`/projects/${projectId}/financials/payables`} label="Open Payables" />}
          {lastImport.expense > 0 && <ImportLink href={`/projects/${projectId}/expenses`} label="Open Expenses" />}
        </div>
      )}

        <ScrollArea className="flex-1">
          {!connected ? (
            <EmptyState
              icon={<Plug className="size-5" />}
              title="QuickBooks isn't connected"
              body="Connect QuickBooks in Settings, then come back to import existing transactions."
            />
          ) : loading && records.length === 0 ? (
            <div className="space-y-3 p-6">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className="h-14 animate-pulse bg-muted/60" />
              ))}
            </div>
          ) : records.length === 0 ? (
            <EmptyState
              icon={<Download className="size-5" />}
              title="Nothing to import"
              body="Every QuickBooks transaction in this window already exists in Arc. Widen the date range to look further back."
            />
          ) : (
            <div className="divide-y">
              {sections.map((section) => {
                const allSelected = section.items.every((item) => selected.has(rowKey(item)))
                return (
                  <section key={section.key}>
                    <button
                      type="button"
                      onClick={() => toggleSection(section.items, allSelected)}
                      className="flex w-full items-center justify-between gap-2 bg-muted/30 px-6 py-2 text-left hover:bg-muted/50"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{section.label}</span>
                        <span className="text-xs text-muted-foreground">{section.items.length}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">{allSelected ? "Deselect all" : "Select all"}</span>
                    </button>
                    <ul>
                      {section.items.map((item) => {
                        const key = rowKey(item)
                        const blocked = !canImportRecord(item)
                        return (
                          <li key={key}>
                            <button
                              type="button"
                              onClick={() => toggle(key)}
                              disabled={importing || blocked}
                              className={cn(
                                "flex w-full items-start gap-3 px-6 py-3 text-left transition-colors hover:bg-muted/40",
                                selected.has(key) && "bg-primary/5",
                                blocked && "cursor-not-allowed opacity-60",
                              )}
                            >
                              <Checkbox checked={selected.has(key)} className="mt-0.5 rounded-none" tabIndex={-1} />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-baseline justify-between gap-2">
                                  <span className="truncate text-sm font-medium">
                                    {item.docNumber ? `#${item.docNumber}` : item.counterparty ?? "Untitled"}
                                  </span>
                                  <span className="shrink-0 text-sm tabular-nums">{formatMoney(item.amountCents)}</span>
                                </div>
                                <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                                  {item.docNumber && item.counterparty ? <span className="truncate">{item.counterparty}</span> : null}
                                  <span className="shrink-0">{formatDate(item.date)}</span>
                                  {item.balanceCents != null && item.balanceCents > 0 && (
                                    <span className="shrink-0">· {formatMoney(item.balanceCents)} open</span>
                                  )}
                                  {(item.entityType === "payment" || item.entityType === "bill_payment") && (
                                    <span className={cn(
                                      "inline-flex shrink-0 items-center gap-0.5",
                                      item.dependencyStatus === "missing" && "text-destructive",
                                      item.dependencyStatus === "available_to_import" && "text-amber-700 dark:text-amber-400",
                                      item.dependencyStatus === "already_in_arc" && "text-emerald-700 dark:text-emerald-400",
                                    )}>
                                      <Link2 className="size-3" />
                                      {item.dependencyMessage ?? (item.hasLinks ? "linked" : "unlinked")}
                                    </span>
                                  )}
                                  {item.possibleMatch ? (
                                    <span className="shrink-0 text-amber-700 dark:text-amber-400">Possible match: {item.possibleMatch}</span>
                                  ) : null}
                                </div>
                              </div>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </section>
                )
              })}
              <p className="px-6 py-3 text-xs text-muted-foreground">
                Tip: payments attach to their invoice or bill. Import the invoice/bill first (or select both together) so
                the payment can link up.
              </p>
            </div>
          )}
        </ScrollArea>

        {connected && (
          <div className="flex items-center justify-between gap-3 border-t px-6 py-4">
            <div className="text-sm text-muted-foreground">
              {selectedItems.length > 0 ? (
                <>
                  <span className="font-medium text-foreground">{selectedItems.length} selected</span> · {formatMoney(selectedTotal)}
                </>
              ) : (
                "Select transactions to import"
              )}
            </div>
            <Button onClick={handleImport} disabled={importing || loading || selectedItems.length === 0} className="shrink-0">
              {importing ? <Spinner className="mr-1.5 size-4" /> : <Download className="mr-1.5 size-4" />}
              Import{selectedItems.length > 0 ? ` ${selectedItems.length}` : ""}
            </Button>
          </div>
        )}
    </>
  )
}

function ImportLink({ href, label }: { href: string; label: string }) {
  return (
    <Button asChild variant="outline" size="sm" className="h-7 bg-background px-2 text-xs">
      <Link href={href}>
        {label}
        <ExternalLink className="ml-1.5 size-3" />
      </Link>
    </Button>
  )
}

function EmptyState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="flex h-full min-h-80 flex-col items-center justify-center px-8 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">{icon}</div>
      <p className="mt-4 text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">{body}</p>
    </div>
  )
}
