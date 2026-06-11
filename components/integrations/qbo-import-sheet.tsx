"use client"

import Link from "next/link"
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronsUpDown, Download, ExternalLink, Link2, Plug, Search, X } from "lucide-react"
import { toast } from "sonner"

import {
  importQboRecordsAction,
  listProjectsForImportAction,
  listQboCustomersForImportAction,
  listQboImportRecordsAction,
} from "@/app/(app)/integrations/qbo-import-actions"
import { getProjectQboLinkAction } from "@/app/(app)/integrations/qbo-project-link-actions"
import type { ProjectQboLink } from "@/lib/services/qbo-project-link"
import type {
  QboImportCustomerOption,
  QboImportEntityType,
  QboImportRecord,
  QboImportLine,
} from "@/lib/services/qbo-import"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
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
  onCancel?: () => void
}

const SECTIONS: { key: QboImportEntityType; label: string }[] = [
  { key: "invoice", label: "Invoices" },
  { key: "expense", label: "Expenses" },
  { key: "bill", label: "Bills" },
  { key: "vendor_credit", label: "Vendor credits" },
  { key: "payment", label: "Invoice payments" },
  { key: "bill_payment", label: "Bill payments" },
  { key: "journal_entry", label: "Journal entries" },
  { key: "client_deposit", label: "Client deposits (historical)" },
]

const LOOKBACK_OPTIONS: { value: string; label: string; days: number | null }[] = [
  { value: "90", label: "Last 90 days", days: 90 },
  { value: "365", label: "Last 12 months", days: 365 },
  { value: "730", label: "Last 24 months", days: 730 },
  { value: "all", label: "All time", days: null },
]

const EMPTY_COUNTS: Record<QboImportEntityType, number> = {
  invoice: 0,
  expense: 0,
  bill: 0,
  vendor_credit: 0,
  payment: 0,
  bill_payment: 0,
  journal_entry: 0,
  client_deposit: 0,
}

type TypeFilter = "all" | QboImportEntityType

// cmdk's default matcher is a loose subsequence fuzzy match — typing "abc" matches any item with an
// a, b and c in order, which surfaces results that don't actually contain the typed text. Require a
// contiguous, case-insensitive substring match so the project search only shows real matches.
function substringFilter(value: string, search: string) {
  return value.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0
}

function rowKey(record: { entityType: QboImportEntityType; qboId: string }) {
  return `${record.entityType}:${record.qboId}`
}

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function formatDate(value: string | null) {
  if (!value) return "—"
  // QBO transaction dates are calendar dates (YYYY-MM-DD). Build a *local* Date from the parts so the
  // displayed day doesn't shift back: `new Date("2026-04-02")` parses as UTC midnight, which renders
  // as the previous day in EST and other negative-offset zones.
  const calendar = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  const date = calendar
    ? new Date(Number(calendar[1]), Number(calendar[2]) - 1, Number(calendar[3]))
    : new Date(value)
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
        <SheetHeader className="space-y-1 border-b px-6 pb-5 pt-6">
          <SheetTitle className="text-lg">Import from QuickBooks</SheetTitle>
          <SheetDescription className="text-left">
            Select unmatched QuickBooks transactions and import them into {projectName ?? "this project"}.
          </SheetDescription>
        </SheetHeader>
        <QboImportPanel active={open} projectId={projectId} projectName={projectName} onCancel={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  )
}

export function QboImportPanel({ active = true, projectId, projectName, onCancel }: QboImportPanelProps) {
  const [records, setRecords] = useState<QboImportRecord[]>([])
  const [connected, setConnected] = useState(true)
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [lookback, setLookback] = useState("365")
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all")
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openSections, setOpenSections] = useState<string[]>(SECTIONS.map((section) => section.key))
  const [lastImport, setLastImport] = useState<Record<QboImportEntityType, number> | null>(null)
  const [projectFilter, setProjectFilter] = useState<string>("all")
  const [projectFilterOpen, setProjectFilterOpen] = useState(false)
  const [qboLink, setQboLink] = useState<ProjectQboLink | null>(null)
  // Full QBO customer/project list — drives the project filter so every project shows, not just the
  // ones referenced by the fetched transactions.
  const [qboCustomers, setQboCustomers] = useState<QboImportCustomerOption[]>([])
  const defaultFilterApplied = useRef(false)
  const loadRequestId = useRef(0)
  const contextRequestId = useRef(0)
  // Arc projects for the per-line allocation picker, and per-record line→project overrides.
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  const [allocations, setAllocations] = useState<Record<string, Record<string, string>>>({})

  const load = useCallback(async (lookbackValue: string) => {
    const requestId = ++loadRequestId.current
    setLoading(true)
    try {
      const listing = await listQboImportRecordsAction({ sinceDate: sinceDateFor(lookbackValue) })
      if (requestId !== loadRequestId.current) return
      setRecords(listing.records)
      setConnected(listing.connected)
      setSelected(new Set())
      // A QBO query for one entity type can fail while the rest succeed. Warn rather than silently
      // showing zero of that type (e.g. vendor credits "disappearing" when their query 400s).
      if (listing.loadErrors && listing.loadErrors.length > 0) {
        const labels = listing.loadErrors
          .map((error) => SECTIONS.find((section) => section.key === error.entityType)?.label ?? error.entityType)
          .join(", ")
        toast.warning(`Couldn't load some QuickBooks records: ${labels}`, {
          description: listing.loadErrors[0]?.message ?? "Try reloading or narrowing the date range.",
        })
      }
    } catch (error: any) {
      if (requestId !== loadRequestId.current) return
      toast.error("Couldn't load QuickBooks records", { description: error?.message ?? "Try again." })
    } finally {
      if (requestId === loadRequestId.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (active) void load(lookback)
  }, [active, lookback, load])

  // The project's QBO customer/project link (set in the project settings sheet) defaults the import
  // filter so opening import from a linked project shows just that project's transactions.
  useEffect(() => {
    if (!active) return
    const requestId = ++contextRequestId.current
    defaultFilterApplied.current = false
    setProjectFilter("all")
    setQboLink(null)
    setQboCustomers([])
    setProjects([])
    setAllocations({})
    getProjectQboLinkAction({ projectId })
      .then((link) => {
        if (requestId === contextRequestId.current) setQboLink(link)
      })
      .catch(() => {})
    listProjectsForImportAction()
      .then((listing) => {
        if (requestId === contextRequestId.current) setProjects(listing)
      })
      .catch(() => {})
    listQboCustomersForImportAction()
      .then((listing) => {
        if (requestId === contextRequestId.current) setQboCustomers(listing.customers)
      })
      .catch(() => {})

    return () => {
      if (requestId === contextRequestId.current) contextRequestId.current += 1
    }
  }, [active, projectId])

  // Effective line→project for a record: the user's per-line override, else the line's suggested
  // (customer-linked) project. Only lines with a destination are included.
  const recordAllocations = useCallback(
    (record: QboImportRecord): Record<string, string> => {
      const chosen = allocations[rowKey(record)] ?? {}
      const result: Record<string, string> = {}
      for (const line of record.lines ?? []) {
        const target = chosen[line.lineId] ?? line.suggestedProjectId ?? ""
        if (target) result[line.lineId] = target
      }
      return result
    },
    [allocations],
  )

  // A record is importable once every one of its lines has a destination project (chosen or suggested).
  const isFullyAllocated = useCallback(
    (record: QboImportRecord) => {
      if (!record.lines || record.lines.length === 0) return true
      const effective = recordAllocations(record)
      return record.lines.every((line) => effective[line.lineId])
    },
    [recordAllocations],
  )

  const setLineAllocation = (record: QboImportRecord, lineId: string, projectId: string) => {
    setAllocations((prev) => ({
      ...prev,
      [rowKey(record)]: { ...(prev[rowKey(record)] ?? {}), [lineId]: projectId },
    }))
  }

  const recordByKey = useMemo(() => new Map(records.map((record) => [rowKey(record), record])), [records])

  const typeCounts = useMemo(() => {
    return records.reduce<Record<QboImportEntityType, number>>(
      (acc, record) => {
        acc[record.entityType] += 1
        return acc
      },
      { ...EMPTY_COUNTS },
    )
  }, [records])

  // Every QBO project a record touches — its per-line customers when present (so a multi-project
  // bill/expense matches each of its projects), falling back to the single header customer.
  const recordProjectIds = (record: QboImportRecord): string[] => {
    if (record.qboCustomerIds && record.qboCustomerIds.length > 0) return record.qboCustomerIds.map((c) => c.id)
    return record.qboCustomerId ? [record.qboCustomerId] : []
  }

  // Apply type + text filter, newest first.
  const filteredRecords = useMemo(() => {
    const query = search.trim().toLowerCase()
    return records
      .filter((record) => {
        if (typeFilter !== "all" && record.entityType !== typeFilter) return false
        if (projectFilter !== "all" && !recordProjectIds(record).includes(projectFilter)) return false
        if (!query) return true
        return [record.docNumber, record.counterparty, record.possibleMatch]
          .filter(Boolean)
          .some((field) => field!.toLowerCase().includes(query))
      })
      .sort(
        (a, b) =>
          (b.date ?? "").localeCompare(a.date ?? "") ||
          a.entityType.localeCompare(b.entityType) ||
          a.qboId.localeCompare(b.qboId),
      )
  }, [records, typeFilter, projectFilter, search])

  // The project filter's options. Sourced from the full live QBO customer/project list so every
  // project shows — even ones with no un-imported transactions in the current window. Any customer
  // referenced by a fetched record but missing from that list (e.g. an inactive customer that still
  // has un-imported transactions) is folded in too, so nothing in view is unfilterable.
  const projectFilterOptions = useMemo(() => {
    const map = new Map<string, string>()
    // Keep the picker focused on actual QBO Projects. Top-level customers are folded in only when
    // a transaction in the current result set references them, so legacy job-costing setups remain
    // filterable without turning this into a thousands-row customer directory.
    for (const customer of qboCustomers) {
      if (customer.isProject) map.set(customer.id, customer.name)
    }
    for (const record of records) {
      if (record.qboCustomerIds && record.qboCustomerIds.length > 0) {
        for (const customer of record.qboCustomerIds) {
          if (!map.has(customer.id)) map.set(customer.id, customer.name ?? customer.id)
        }
      } else if (record.qboCustomerId && !map.has(record.qboCustomerId)) {
        map.set(record.qboCustomerId, record.qboCustomerName ?? record.qboCustomerId)
      }
    }
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [qboCustomers, records])

  // Default the filter to the project's linked QBO project once (per open), but only if that project
  // actually has records in view — otherwise we'd auto-filter to an empty list. The full customer
  // list now always contains the linked project, so we key this on the records, not the options.
  useEffect(() => {
    if (defaultFilterApplied.current) return
    const linkedId = qboLink?.qboCustomerId
    if (!linkedId || loading) return
    if (records.some((record) => recordProjectIds(record).includes(linkedId))) {
      setProjectFilter(linkedId)
      defaultFilterApplied.current = true
    }
  }, [qboLink, records, loading])

  function canImportRecord(record: QboImportRecord) {
    return record.dependencyStatus !== "missing"
  }

  function dependencyKeys(record: QboImportRecord) {
    const keys: string[] = []
    if (record.dependencyStatus === "available_to_import" && record.linkedEntityType) {
      for (const qboId of record.linkedQboIds ?? []) keys.push(`${record.linkedEntityType}:${qboId}`)
    }
    // A bill payment that applied vendor credits pulls those credits in too, so the credit's cost
    // reduction is imported alongside the payment that settled the bill.
    for (const qboId of record.appliedVendorCreditQboIds ?? []) keys.push(`vendor_credit:${qboId}`)
    return keys.filter((key) => recordByKey.has(key))
  }

  const sections = useMemo(
    () =>
      SECTIONS.map((section) => ({
        ...section,
        items: filteredRecords.filter((record) => record.entityType === section.key),
      })).filter((section) => section.items.length > 0),
    [filteredRecords],
  )

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
  // Selected multi-line records that still have an unassigned line — block import until resolved.
  const selectedNeedingAllocation = useMemo(
    () => selectedItems.filter((item) => !isFullyAllocated(item)),
    [selectedItems, isFullyAllocated],
  )

  const handleImport = async () => {
    if (importing || selectedItems.length === 0 || selectedNeedingAllocation.length > 0) return
    setImporting(true)
    try {
      const result = await importQboRecordsAction({
        projectId,
        items: selectedItems.map((item) => {
          const alloc = recordAllocations(item)
          return {
            qboId: item.qboId,
            entityType: item.entityType,
            allocations: Object.keys(alloc).length > 0 ? alloc : undefined,
          }
        }),
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
            { ...EMPTY_COUNTS },
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

  if (!connected) {
    return (
      <EmptyState
        icon={<Plug className="size-5" />}
        title="QuickBooks isn't connected"
        body="Connect QuickBooks in Settings, then come back to import existing transactions."
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Full-bleed search */}
      <div className="relative shrink-0 border-b">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by number or name"
          className="h-11 rounded-none border-0 bg-transparent pl-11 pr-10 text-sm shadow-none focus-visible:ring-0"
        />
        {search ? (
          <button
            type="button"
            onClick={() => setSearch("")}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>

      {/* Combined type + period filter */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-6 py-2.5">
        <div className="inline-flex">
          <Select value={typeFilter} onValueChange={(value) => setTypeFilter(value as TypeFilter)} disabled={loading || importing}>
            <SelectTrigger className="h-8 w-36 rounded-none border-r-0 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types ({records.length})</SelectItem>
              <SelectSeparator />
              {SECTIONS.map((section) => (
                <SelectItem key={section.key} value={section.key}>
                  {section.label} ({typeCounts[section.key]})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={lookback} onValueChange={setLookback} disabled={loading || importing}>
            <SelectTrigger className="h-8 w-32 rounded-none text-xs">
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
        </div>
        <div className="flex items-center gap-2">
          {projectFilterOptions.length > 0 ? (
            <Popover open={projectFilterOpen} onOpenChange={setProjectFilterOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={projectFilterOpen}
                  className="h-8 w-40 justify-between rounded-none text-xs px-3 font-normal"
                  disabled={loading || importing}
                >
                  <span
                    className="truncate"
                    title={
                      projectFilter === "all"
                        ? "All projects"
                        : projectFilterOptions.find((option) => option.id === projectFilter)?.name ?? projectFilter
                    }
                  >
                    {projectFilter === "all"
                      ? "All projects"
                      : projectFilterOptions.find((option) => option.id === projectFilter)?.name ?? projectFilter}
                  </span>
                  <ChevronsUpDown className="ml-2 size-3 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-0" align="end">
                <Command filter={substringFilter}>
                  <CommandInput placeholder="Search project..." className="h-8" />
                  <CommandList>
                    <CommandEmpty>No project found.</CommandEmpty>
                    <CommandGroup>
                      <CommandItem
                        value="all"
                        onSelect={() => {
                          setProjectFilter("all")
                          setProjectFilterOpen(false)
                        }}
                        className="text-xs"
                      >
                        <Check
                          className={cn(
                            "mr-2 size-3",
                            projectFilter === "all" ? "opacity-100" : "opacity-0"
                          )}
                        />
                        All projects
                      </CommandItem>
                      {projectFilterOptions.map((option) => (
                        <CommandItem
                          key={option.id}
                          value={option.name}
                          onSelect={() => {
                            setProjectFilter(option.id)
                            setProjectFilterOpen(false)
                          }}
                          className="text-xs"
                        >
                          <Check
                            className={cn(
                              "mr-2 size-3",
                              projectFilter === option.id ? "opacity-100" : "opacity-0"
                            )}
                          />
                          <span className="truncate" title={option.name}>
                            {option.name}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          ) : null}
          <span className="shrink-0 text-xs text-muted-foreground">{filteredRecords.length} shown</span>
        </div>
      </div>

      {lastImport && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-emerald-500/10 px-6 py-3 text-xs">
          <span className="font-medium text-emerald-700 dark:text-emerald-400">Imported successfully.</span>
          {(lastImport.invoice > 0 || lastImport.payment > 0 || lastImport.client_deposit > 0) && <ImportLink href={`/projects/${projectId}/financials/receivables`} label="Open Receivables" />}
          {(lastImport.bill > 0 || lastImport.bill_payment > 0 || lastImport.vendor_credit > 0) && <ImportLink href={`/projects/${projectId}/financials/payables`} label="Open Payables" />}
          {(lastImport.expense > 0 || lastImport.journal_entry > 0) && <ImportLink href={`/projects/${projectId}/expenses`} label="Open Expenses" />}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        {loading && records.length === 0 ? (
          <div className="space-y-3 p-6">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-14 animate-pulse bg-muted/60" />
            ))}
          </div>
        ) : records.length === 0 ? (
          <EmptyState
            icon={<Download className="size-5" />}
            title="Nothing to import"
            body="Every QuickBooks transaction in this window already exists in Arc. Widen the date range to look further back."
          />
        ) : sections.length === 0 ? (
          <EmptyState
            icon={<Search className="size-5" />}
            title="No matches"
            body="No transactions match your search or filter. Try clearing them."
          />
        ) : (
          <Accordion type="multiple" value={openSections} onValueChange={setOpenSections} className="w-full">
            {sections.map((section) => {
              const allSelected = section.items.every((item) => selected.has(rowKey(item)))
              const selectedCount = section.items.filter((item) => selected.has(rowKey(item))).length
              return (
                <AccordionItem key={section.key} value={section.key} className="border-b">
                  <div className="flex items-center bg-muted/30">
                    <div className="pl-6">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={() => toggleSection(section.items, allSelected)}
                        disabled={importing}
                        className="rounded-none"
                        aria-label={`Select all ${section.label}`}
                      />
                    </div>
                    <AccordionTrigger className="flex-1 px-3 py-2.5 hover:no-underline">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{section.label}</span>
                        <span className="text-xs text-muted-foreground">{section.items.length}</span>
                        {selectedCount > 0 ? (
                          <span className="text-xs font-medium text-primary">{selectedCount} selected</span>
                        ) : null}
                      </div>
                    </AccordionTrigger>
                  </div>
                  <AccordionContent className="pb-0">
                    <ul>
                      {section.items.map((item) => (
                        <li key={rowKey(item)}>
                          <ImportRow
                            record={item}
                            selected={selected.has(rowKey(item))}
                            disabled={importing}
                            blocked={!canImportRecord(item)}
                            onToggle={() => toggle(rowKey(item))}
                          />
                          {/* Surface the per-line allocation when there's a real choice to make: more
                              than one line, a line with no suggested project, or a line whose suggested
                              project (from its QBO customer link) diverges from the project being
                              imported into — so a single line never silently lands elsewhere. */}
                          {selected.has(rowKey(item)) &&
                          item.lines &&
                          item.lines.length > 0 &&
                          (item.lines.length > 1 ||
                            item.lines.some(
                              (line) => !line.suggestedProjectId || line.suggestedProjectId !== projectId,
                            )) ? (
                            <LineAllocationEditor
                              record={item}
                              projects={projects}
                              value={allocations[rowKey(item)] ?? {}}
                              disabled={importing}
                              onChange={(lineId, projectId) => setLineAllocation(item, lineId, projectId)}
                            />
                          ) : null}
                          {/* Read-only breakdown for payments: shows how the payment splits across the
                              QBO invoices/bills it pays and which project each portion lands in. The
                              project is the linked document's project, so there's nothing to choose. */}
                          {selected.has(rowKey(item)) && item.linkedDocs && item.linkedDocs.length > 0 ? (
                            <LinkedDocsBreakdown record={item} />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </AccordionContent>
                </AccordionItem>
              )
            })}
          </Accordion>
        )}
      </ScrollArea>

      {/* Footer: selection summary + actions */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-t px-6 py-3">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          {selectedItems.length > 0 ? (
            <>
              <span className="truncate">
                <span className="font-medium text-foreground">{selectedItems.length} selected</span>
                <span className="text-muted-foreground"> · {formatMoney(selectedTotal)}</span>
              </span>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Clear
              </button>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">Select transactions to import</span>
          )}
          {selectedNeedingAllocation.length > 0 ? (
            <span className="shrink-0 text-xs text-amber-700 dark:text-amber-400">
              · {selectedNeedingAllocation.length} need a project assigned
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onCancel ? (
            <Button variant="outline" size="sm" className="h-8" onClick={onCancel} disabled={importing}>
              Cancel
            </Button>
          ) : null}
          <Button
            onClick={handleImport}
            disabled={importing || loading || selectedItems.length === 0 || selectedNeedingAllocation.length > 0}
            size="sm"
            className="h-8"
          >
            {importing ? <Spinner className="mr-1.5 size-4" /> : <Download className="mr-1.5 size-4" />}
            Import{selectedItems.length > 0 ? ` ${selectedItems.length}` : ""}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ImportRow({
  record,
  selected,
  disabled,
  blocked,
  onToggle,
}: {
  record: QboImportRecord
  selected: boolean
  disabled: boolean
  blocked: boolean
  onToggle: () => void
}) {
  const isPayment = record.entityType === "payment" || record.entityType === "bill_payment"
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled || blocked}
      className={cn(
        "flex w-full items-start gap-3 border-t px-6 py-3 text-left transition-colors hover:bg-muted/40",
        selected && "bg-primary/5",
        blocked && "cursor-not-allowed opacity-60",
      )}
    >
      <Checkbox checked={selected} className="mt-0.5 rounded-none" tabIndex={-1} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">
            {record.docNumber ? `#${record.docNumber}` : record.counterparty ?? "Untitled"}
          </span>
          <span className="shrink-0 text-sm tabular-nums">{formatMoney(record.amountCents)}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {record.docNumber && record.counterparty ? <span className="truncate">{record.counterparty}</span> : null}
          <span className="shrink-0">{formatDate(record.date)}</span>
          {record.balanceCents != null && record.balanceCents > 0 && (
            <span className="shrink-0">· {formatMoney(record.balanceCents)} open</span>
          )}
          {isPayment && (
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-0.5",
                record.dependencyStatus === "missing" && "text-destructive",
                record.dependencyStatus === "available_to_import" && "text-amber-700 dark:text-amber-400",
                record.dependencyStatus === "already_in_arc" && "text-emerald-700 dark:text-emerald-400",
              )}
            >
              <Link2 className="size-3" />
              {record.dependencyMessage ?? (record.hasLinks ? "linked" : "unlinked")}
            </span>
          )}
          {record.possibleMatch ? (
            <span className="shrink-0 text-amber-700 dark:text-amber-400">Possible match: {record.possibleMatch}</span>
          ) : null}
        </div>
      </div>
    </button>
  )
}

function LinkedDocsBreakdown({ record }: { record: QboImportRecord }) {
  const docs = record.linkedDocs ?? []
  const isInvoice = record.linkedEntityType === "invoice"
  return (
    <div className="border-t bg-muted/20 py-2.5 pl-12 pr-6">
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        Splits across {docs.length} {isInvoice ? (docs.length === 1 ? "invoice" : "invoices") : docs.length === 1 ? "bill" : "bills"}
      </p>
      <ul className="space-y-1.5">
        {docs.map((doc) => (
          <li key={doc.qboId} className="flex items-center gap-3 text-xs">
            <span className="min-w-0 flex-1 truncate">
              <span className="text-foreground">{doc.docLabel ?? `${isInvoice ? "Invoice" : "Bill"} ${doc.qboId}`}</span>
              {doc.inArc ? (
                <span className="text-muted-foreground"> → {doc.projectName ?? "No project"}</span>
              ) : (
                <span className="text-amber-700 dark:text-amber-400"> · import {isInvoice ? "invoice" : "bill"} first</span>
              )}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{formatMoney(doc.amountCents)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function LineAllocationEditor({
  record,
  projects,
  value,
  disabled,
  onChange,
}: {
  record: QboImportRecord
  projects: { id: string; name: string }[]
  value: Record<string, string>
  disabled: boolean
  onChange: (lineId: string, projectId: string) => void
}) {
  return (
    <div className="border-t bg-muted/20 py-2.5 pl-12 pr-6">
      <p className="mb-2 text-xs font-medium text-muted-foreground">Allocate each line to a project</p>
      <ul className="space-y-2">
        {(record.lines ?? []).map((line) => {
          const current = value[line.lineId] ?? line.suggestedProjectId ?? ""
          return (
            <LineAllocationRow
              key={line.lineId}
              line={line}
              projects={projects}
              current={current}
              disabled={disabled}
              onChange={(projectId) => onChange(line.lineId, projectId)}
            />
          )
        })}
      </ul>
    </div>
  )
}

function LineAllocationRow({
  line,
  projects,
  current,
  disabled,
  onChange,
}: {
  line: QboImportLine
  projects: { id: string; name: string }[]
  current: string
  disabled: boolean
  onChange: (projectId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const unassigned = !current
  const currentProjectName = projects.find((p) => p.id === current)?.name

  return (
    <li className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-foreground">{line.description}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {line.qboCustomerName ?? "No QBO customer"} · {formatMoney(line.amountCents)}
        </div>
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className={cn(
              "h-7 w-48 shrink-0 justify-between rounded-none text-xs px-2 font-normal",
              unassigned && "border-amber-500 text-amber-700"
            )}
          >
            <span className="truncate" title={currentProjectName ?? "Choose project…"}>
              {currentProjectName ?? "Choose project…"}
            </span>
            <ChevronsUpDown className="ml-2 size-3 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0" align="end">
          <Command filter={substringFilter}>
            <CommandInput placeholder="Search project..." className="h-8" />
            <CommandList>
              <CommandEmpty>No project found.</CommandEmpty>
              <CommandGroup>
                {projects.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={project.name}
                    onSelect={() => {
                      onChange(project.id)
                      setOpen(false)
                    }}
                    className="text-xs"
                  >
                    <Check
                      className={cn(
                        "mr-2 size-3",
                        current === project.id ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="truncate" title={project.name}>
                      {project.name}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </li>
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
