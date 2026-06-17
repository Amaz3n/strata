"use client"

import Link from "next/link"
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronRight, ChevronsUpDown, Download, ExternalLink, Link2, Plug, Search, X } from "lucide-react"
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
} from "@/components/ui/command"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

type QboImportPanelProps = {
  /** When false, the panel skips loading (it lives in a tab that mounts only when active). */
  active?: boolean
  /** Context project: defaults the project filter + the fallback header project for multi-line records. */
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

const SECTION_LABEL: Record<QboImportEntityType, string> = SECTIONS.reduce(
  (acc, section) => {
    acc[section.key] = section.label
    return acc
  },
  {} as Record<QboImportEntityType, string>,
)

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

function isPaymentType(type: QboImportEntityType) {
  return type === "payment" || type === "bill_payment"
}

function hasAllocatableLines(record: QboImportRecord) {
  return Boolean(record.lines && record.lines.length > 0)
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

/**
 * QuickBooks import grid — the body of the "Import" tab inside `QboSyncSheet` (the sheet widens when
 * this tab is active to make the grid usable). The context project defaults the left filter and is
 * the multi-line header fallback, but every record is importable into its own project (org-wide).
 * Records group by type; the **destination project is an always-visible, inline-editable column** so
 * nothing files silently. Rows auto-fill from the QBO customer→project link; anything unmapped shows
 * an amber "assign" and blocks import until resolved.
 */
export function QboImportPanel({ active = true, projectId, onCancel }: QboImportPanelProps) {
  const [records, setRecords] = useState<QboImportRecord[]>([])
  const [alreadyImportedCounts, setAlreadyImportedCounts] = useState<Partial<Record<QboImportEntityType, number>>>({})
  const [connected, setConnected] = useState(true)
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [lookback, setLookback] = useState("365")
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all")
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
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
  // Arc projects for the destination pickers, and the per-record line→project + record→project overrides.
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  const [allocations, setAllocations] = useState<Record<string, Record<string, string>>>({})
  const [destinations, setDestinations] = useState<Record<string, string>>({})

  const load = useCallback(async (lookbackValue: string) => {
    const requestId = ++loadRequestId.current
    setLoading(true)
    try {
      const listing = await listQboImportRecordsAction({ sinceDate: sinceDateFor(lookbackValue) })
      if (requestId !== loadRequestId.current) return
      setRecords(listing.records)
      setAlreadyImportedCounts(listing.alreadyImportedCounts ?? {})
      setConnected(listing.connected)
      setSelected(new Set())
      // A QBO query for one entity type can fail while the rest succeed. Warn rather than silently
      // showing zero of that type (e.g. vendor credits "disappearing" when their query 400s).
      if (listing.loadErrors && listing.loadErrors.length > 0) {
        const labels = listing.loadErrors
          .map((error) => SECTION_LABEL[error.entityType] ?? error.entityType)
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
    setDestinations({})
    setExpanded(new Set())
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
      if (!hasAllocatableLines(record)) return true
      const effective = recordAllocations(record)
      return record.lines!.every((line) => effective[line.lineId])
    },
    [recordAllocations],
  )

  // Single-document destination (invoices). Override → customer-linked suggestion → empty (unassigned,
  // which blocks import). We deliberately do NOT fall back to the context project, so a record never
  // files into the wrong project silently — the user assigns it (or bulk-assigns) on purpose.
  const invoiceDestination = useCallback(
    (record: QboImportRecord): string => destinations[rowKey(record)] ?? record.suggestedProjectId ?? "",
    [destinations],
  )

  // Has the user (or a suggestion) given this record a complete home yet?
  const needsAssignment = useCallback(
    (record: QboImportRecord): boolean => {
      if (isPaymentType(record.entityType)) return false
      if (hasAllocatableLines(record)) return !isFullyAllocated(record)
      return !invoiceDestination(record)
    },
    [isFullyAllocated, invoiceDestination],
  )

  // The project sent to the importer for this record. Payments derive it from the linked doc; multi-line
  // records resolve per line and only need a header fallback (the context project).
  const importProjectIdFor = useCallback(
    (record: QboImportRecord): string | undefined => {
      if (isPaymentType(record.entityType)) return undefined
      if (hasAllocatableLines(record)) return destinations[rowKey(record)] ?? projectId
      return invoiceDestination(record) || undefined
    },
    [destinations, projectId, invoiceDestination],
  )

  const setLineAllocation = (record: QboImportRecord, lineId: string, target: string) => {
    setAllocations((prev) => ({
      ...prev,
      [rowKey(record)]: { ...(prev[rowKey(record)] ?? {}), [lineId]: target },
    }))
  }

  const setInvoiceDestination = (record: QboImportRecord, target: string) => {
    setDestinations((prev) => ({ ...prev, [rowKey(record)]: target }))
  }

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
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
  // actually has records in view — otherwise we'd auto-filter to an empty list.
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

  const toggleSectionCollapse = (key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
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
  const selectedNeedingAssignment = useMemo(
    () => selectedItems.filter(needsAssignment),
    [selectedItems, needsAssignment],
  )

  // Bulk-assign: drop every selected record into one project at once. Single-doc records get the
  // destination; multi-line records get every line set to that project. Payments are skipped (their
  // project comes from the linked document).
  const bulkAssign = (target: string) => {
    setDestinations((prev) => {
      const next = { ...prev }
      for (const item of selectedItems) {
        if (!isPaymentType(item.entityType) && !hasAllocatableLines(item)) next[rowKey(item)] = target
      }
      return next
    })
    setAllocations((prev) => {
      const next = { ...prev }
      for (const item of selectedItems) {
        if (hasAllocatableLines(item)) {
          const lineMap = { ...(next[rowKey(item)] ?? {}) }
          for (const line of item.lines!) lineMap[line.lineId] = target
          next[rowKey(item)] = lineMap
        }
      }
      return next
    })
    const name = projects.find((p) => p.id === target)?.name
    toast.success(`Assigned ${selectedItems.length} record${selectedItems.length === 1 ? "" : "s"}${name ? ` to ${name}` : ""}`)
  }

  const handleImport = async () => {
    if (importing || selectedItems.length === 0 || selectedNeedingAssignment.length > 0) return
    setImporting(true)
    try {
      const result = await importQboRecordsAction({
        items: selectedItems.map((item) => {
          const alloc = recordAllocations(item)
          return {
            qboId: item.qboId,
            entityType: item.entityType,
            projectId: importProjectIdFor(item),
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
            ? `Imported ${result.imported} record${result.imported === 1 ? "" : "s"}${result.skipped ? ` · ${result.skipped} already imported` : ""}`
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

  const totalAlreadyImported = Object.values(alreadyImportedCounts).reduce((sum, count) => sum + (count ?? 0), 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!connected ? (
        <EmptyState
          icon={<Plug className="size-5" />}
          title="QuickBooks isn't connected"
          body="Connect QuickBooks in Settings, then come back to import existing transactions."
        />
      ) : (
        <>
          {/* Toolbar */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2.5">
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by number or name"
                className="h-9 pl-9 pr-9"
              />
              {search ? (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              ) : null}
            </div>
            <Select value={typeFilter} onValueChange={(value) => setTypeFilter(value as TypeFilter)} disabled={loading || importing}>
              <SelectTrigger className="h-9 w-44 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types ({records.length})</SelectItem>
                <SelectSeparator />
                {SECTIONS.map((section) => (
                  <SelectItem key={section.key} value={section.key}>
                    {section.label} ({typeCounts[section.key]} new
                    {alreadyImportedCounts[section.key] ? `, ${alreadyImportedCounts[section.key]} in Arc` : ""})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={lookback} onValueChange={setLookback} disabled={loading || importing}>
              <SelectTrigger className="h-9 w-32 text-xs">
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
            {projectFilterOptions.length > 0 ? (
              <Popover open={projectFilterOpen} onOpenChange={setProjectFilterOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={projectFilterOpen}
                    className="h-9 w-48 justify-between px-3 text-xs font-normal"
                    disabled={loading || importing}
                  >
                    <span className="truncate">
                      {projectFilter === "all"
                        ? "All QBO projects"
                        : projectFilterOptions.find((option) => option.id === projectFilter)?.name ?? projectFilter}
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
                        <CommandItem
                          value="all"
                          onSelect={() => {
                            setProjectFilter("all")
                            setProjectFilterOpen(false)
                          }}
                          className="text-xs"
                        >
                          <Check className={cn("mr-2 size-3", projectFilter === "all" ? "opacity-100" : "opacity-0")} />
                          All QBO projects
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
                              className={cn("mr-2 size-3", projectFilter === option.id ? "opacity-100" : "opacity-0")}
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
          </div>

          {lastImport && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-emerald-500/10 px-4 py-2.5 text-xs">
              <span className="font-medium text-emerald-700 dark:text-emerald-400">Imported successfully.</span>
              {(lastImport.invoice > 0 || lastImport.payment > 0 || lastImport.client_deposit > 0) && (
                <ImportLink href={`/projects/${projectId}/financials/receivables`} label="Open Receivables" />
              )}
              {(lastImport.bill > 0 || lastImport.bill_payment > 0 || lastImport.vendor_credit > 0) && (
                <ImportLink href={`/projects/${projectId}/financials/payables`} label="Open Payables" />
              )}
              {(lastImport.expense > 0 || lastImport.journal_entry > 0) && (
                <ImportLink href={`/projects/${projectId}/expenses`} label="Open Expenses" />
              )}
            </div>
          )}

          {/* Column header */}
          {sections.length > 0 ? (
            <div className="flex shrink-0 items-center gap-3 border-b bg-muted/20 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <span className="w-4" />
              <span className="flex-1">Document</span>
              <span className="hidden w-20 text-right sm:block">Date</span>
              <span className="w-28 text-right">Amount</span>
              <span className="w-56">Destination project</span>
            </div>
          ) : null}

          {/* Grid */}
          <ScrollArea className="min-h-0 flex-1">
            {loading && records.length === 0 ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 8 }).map((_, index) => (
                  <div key={index} className="h-11 animate-pulse rounded bg-muted/60" />
                ))}
              </div>
            ) : records.length === 0 ? (
              <EmptyState
                icon={<Download className="size-5" />}
                title="Nothing to import"
                body={
                  totalAlreadyImported > 0
                    ? `No new QuickBooks transactions in this window. ${totalAlreadyImported} already ${totalAlreadyImported === 1 ? "exists" : "exist"} in Arc.`
                    : "No QuickBooks transactions were returned in this window. Widen the date range or reload the connection."
                }
              />
            ) : sections.length === 0 ? (
              <EmptyState
                icon={<Search className="size-5" />}
                title="No matches"
                body={
                  typeFilter !== "all" && (alreadyImportedCounts[typeFilter] ?? 0) > 0
                    ? `No new ${SECTION_LABEL[typeFilter]?.toLowerCase() ?? "records"} to import. ${alreadyImportedCounts[typeFilter]} already in Arc.`
                    : "No transactions match your search or filter. Try clearing them."
                }
              />
            ) : (
              <div>
                {sections.map((section) => {
                  const open = !collapsedSections.has(section.key)
                  const allSelected = section.items.every((item) => selected.has(rowKey(item)))
                  const selectedCount = section.items.filter((item) => selected.has(rowKey(item))).length
                  const subtotal = section.items.reduce((sum, item) => sum + item.amountCents, 0)
                  return (
                    <section key={section.key} className="border-b">
                      <div className="flex items-center gap-3 bg-muted/40 px-4 py-2">
                        <Checkbox
                          checked={allSelected}
                          onCheckedChange={() => toggleSection(section.items, allSelected)}
                          disabled={importing}
                          aria-label={`Select all ${section.label}`}
                        />
                        <button
                          type="button"
                          onClick={() => toggleSectionCollapse(section.key)}
                          className="flex flex-1 items-center gap-2 text-left"
                        >
                          <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")} />
                          <span className="text-sm font-semibold">{section.label}</span>
                          <span className="text-xs text-muted-foreground">{section.items.length}</span>
                          {selectedCount > 0 ? (
                            <span className="text-xs font-medium text-primary">{selectedCount} selected</span>
                          ) : null}
                        </button>
                        <span className="text-xs tabular-nums text-muted-foreground">{formatMoney(subtotal)}</span>
                      </div>
                      {open ? (
                        <ul>
                          {section.items.map((item) => {
                            const key = rowKey(item)
                            return (
                              <li key={key}>
                                <ImportGridRow
                                  record={item}
                                  projects={projects}
                                  selected={selected.has(key)}
                                  expanded={expanded.has(key)}
                                  disabled={importing}
                                  blocked={!canImportRecord(item)}
                                  needsAssignment={needsAssignment(item)}
                                  invoiceDestination={invoiceDestination(item)}
                                  lineValues={allocations[key] ?? {}}
                                  recordAllocations={recordAllocations(item)}
                                  onToggleSelect={() => toggle(key)}
                                  onToggleExpand={() => toggleExpand(key)}
                                  onSetInvoiceDestination={(target) => setInvoiceDestination(item, target)}
                                  onSetLine={(lineId, target) => setLineAllocation(item, lineId, target)}
                                />
                              </li>
                            )
                          })}
                        </ul>
                      ) : null}
                    </section>
                  )
                })}
              </div>
            )}
          </ScrollArea>

          {/* Footer */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
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
                <span className="text-sm text-muted-foreground">Select transactions, then assign and import</span>
              )}
              {selectedNeedingAssignment.length > 0 ? (
                <span className="shrink-0 text-xs text-amber-700 dark:text-amber-400">
                  · {selectedNeedingAssignment.length} need a project
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {selectedItems.length > 0 ? (
                <ProjectPicker
                  projects={projects}
                  current=""
                  disabled={importing}
                  placeholder="Assign selected to…"
                  onChange={bulkAssign}
                  className="h-8 w-48"
                />
              ) : null}
              {onCancel ? (
                <Button variant="outline" size="sm" className="h-8" onClick={onCancel} disabled={importing}>
                  Close
                </Button>
              ) : null}
              <Button
                onClick={handleImport}
                disabled={importing || loading || selectedItems.length === 0 || selectedNeedingAssignment.length > 0}
                size="sm"
                className="h-8"
              >
                {importing ? <Spinner className="mr-1.5 size-4" /> : <Download className="mr-1.5 size-4" />}
                Import{selectedItems.length > 0 ? ` ${selectedItems.length}` : ""}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ImportGridRow({
  record,
  projects,
  selected,
  expanded,
  disabled,
  blocked,
  needsAssignment,
  invoiceDestination,
  lineValues,
  recordAllocations,
  onToggleSelect,
  onToggleExpand,
  onSetInvoiceDestination,
  onSetLine,
}: {
  record: QboImportRecord
  projects: { id: string; name: string }[]
  selected: boolean
  expanded: boolean
  disabled: boolean
  blocked: boolean
  needsAssignment: boolean
  invoiceDestination: string
  lineValues: Record<string, string>
  recordAllocations: Record<string, string>
  onToggleSelect: () => void
  onToggleExpand: () => void
  onSetInvoiceDestination: (projectId: string) => void
  onSetLine: (lineId: string, projectId: string) => void
}) {
  const isPayment = isPaymentType(record.entityType)
  const hasLines = hasAllocatableLines(record)
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name

  return (
    <div className={cn("border-t", selected && "bg-primary/5", blocked && "opacity-60")}>
      <div className="flex items-center gap-3 px-4 py-2">
        <Checkbox
          checked={selected}
          onCheckedChange={onToggleSelect}
          disabled={disabled || blocked}
          aria-label="Select for import"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {record.docNumber ? `#${record.docNumber}` : record.counterparty ?? "Untitled"}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {record.docNumber && record.counterparty ? <span className="truncate">{record.counterparty}</span> : null}
            {record.balanceCents != null && record.balanceCents > 0 && (
              <span className="shrink-0">{formatMoney(record.balanceCents)} open</span>
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
        <span className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">
          {formatDate(record.date)}
        </span>
        <span className="w-28 shrink-0 text-right text-sm tabular-nums">{formatMoney(record.amountCents)}</span>
        <div className="w-56 shrink-0">
          {isPayment ? (
            <PaymentDestination record={record} expanded={expanded} onToggleExpand={onToggleExpand} />
          ) : hasLines ? (
            <LineSummaryButton
              record={record}
              effective={recordAllocations}
              expanded={expanded}
              needsAssignment={needsAssignment}
              projectName={projectName}
              onToggleExpand={onToggleExpand}
            />
          ) : (
            <ProjectPicker
              projects={projects}
              current={invoiceDestination}
              disabled={disabled}
              placeholder="Choose project…"
              onChange={onSetInvoiceDestination}
              className="h-8 w-full"
              invalidWhenEmpty
            />
          )}
        </div>
      </div>

      {/* Expansion: per-line allocation (multi-line) or read-only payment split */}
      {expanded && hasLines ? (
        <div className="space-y-2 border-t bg-muted/20 px-4 py-3 pl-11">
          <p className="text-xs font-medium text-muted-foreground">Allocate each line to a project</p>
          <ul className="space-y-2">
            {record.lines!.map((line) => (
              <LineAllocationRow
                key={line.lineId}
                line={line}
                projects={projects}
                current={lineValues[line.lineId] ?? line.suggestedProjectId ?? ""}
                disabled={disabled}
                onChange={(target) => onSetLine(line.lineId, target)}
              />
            ))}
          </ul>
        </div>
      ) : null}
      {expanded && isPayment && record.linkedDocs && record.linkedDocs.length > 0 ? (
        <div className="border-t bg-muted/20 px-4 py-3 pl-11">
          <LinkedDocsBreakdown record={record} />
        </div>
      ) : null}
    </div>
  )
}

/** Read-only destination for payments — project is the linked document's, so it's shown, not chosen. */
function PaymentDestination({
  record,
  expanded,
  onToggleExpand,
}: {
  record: QboImportRecord
  expanded: boolean
  onToggleExpand: () => void
}) {
  if (record.dependencyStatus === "missing") {
    return <span className="text-xs text-destructive">Import its document first</span>
  }
  if (record.linkedDocs && record.linkedDocs.length > 0) {
    return (
      <button
        type="button"
        onClick={onToggleExpand}
        className="flex h-8 w-full items-center justify-between rounded-md border px-2 text-xs text-muted-foreground hover:bg-muted/50"
      >
        <span className="truncate">
          From {record.linkedDocs.length} {record.linkedEntityType === "invoice" ? "invoice" : "bill"}
          {record.linkedDocs.length === 1 ? "" : "s"}
        </span>
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")} />
      </button>
    )
  }
  return <span className="text-xs text-muted-foreground">From linked document</span>
}

/** Multi-line destination summary that expands to the per-line allocation editor. */
function LineSummaryButton({
  record,
  effective,
  expanded,
  needsAssignment,
  projectName,
  onToggleExpand,
}: {
  record: QboImportRecord
  effective: Record<string, string>
  expanded: boolean
  needsAssignment: boolean
  projectName: (id: string) => string | undefined
  onToggleExpand: () => void
}) {
  const lineCount = record.lines!.length
  const distinct = new Set(Object.values(effective))
  const label = needsAssignment
    ? `Assign ${lineCount} line${lineCount === 1 ? "" : "s"}`
    : distinct.size === 1
      ? projectName([...distinct][0]) ?? "1 project"
      : `Split · ${distinct.size} projects`

  return (
    <button
      type="button"
      onClick={onToggleExpand}
      className={cn(
        "flex h-8 w-full items-center justify-between rounded-md border px-2 text-xs hover:bg-muted/50",
        needsAssignment && "border-amber-500 text-amber-700 dark:text-amber-400",
      )}
    >
      <span className="truncate">{label}</span>
      <ChevronRight className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")} />
    </button>
  )
}

function LinkedDocsBreakdown({ record }: { record: QboImportRecord }) {
  const docs = record.linkedDocs ?? []
  const isInvoice = record.linkedEntityType === "invoice"
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
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
  return (
    <li className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-foreground">{line.description}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {line.qboCustomerName ?? "No QBO customer"} · {formatMoney(line.amountCents)}
        </div>
      </div>
      <ProjectPicker
        projects={projects}
        current={current}
        disabled={disabled}
        placeholder="Choose project…"
        onChange={onChange}
        className="h-8 w-56 shrink-0"
        invalidWhenEmpty
      />
    </li>
  )
}

/** Searchable project combobox shared by the destination column, line allocation, and bulk-assign. */
function ProjectPicker({
  projects,
  current,
  disabled,
  placeholder,
  onChange,
  className,
  invalidWhenEmpty,
}: {
  projects: { id: string; name: string }[]
  current: string
  disabled: boolean
  placeholder: string
  onChange: (projectId: string) => void
  className?: string
  invalidWhenEmpty?: boolean
}) {
  const [open, setOpen] = useState(false)
  const currentName = projects.find((p) => p.id === current)?.name
  const unassigned = !current

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "justify-between px-2 text-xs font-normal",
            invalidWhenEmpty && unassigned && "border-amber-500 text-amber-700 dark:text-amber-400",
            className,
          )}
        >
          <span className="truncate" title={currentName ?? placeholder}>
            {currentName ?? placeholder}
          </span>
          <ChevronsUpDown className="ml-2 size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-56 p-0" align="start">
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
                  <Check className={cn("mr-2 size-3", current === project.id ? "opacity-100" : "opacity-0")} />
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
    <div className="flex h-full min-h-80 flex-1 flex-col items-center justify-center px-8 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">{icon}</div>
      <p className="mt-4 text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">{body}</p>
    </div>
  )
}
