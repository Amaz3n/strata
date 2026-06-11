"use client"

import { useState, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Search, X, SlidersHorizontal, ArrowLeft, ArrowRight, Eye, Building2, User, Copy, Check } from "@/components/icons"
import { DateRangePicker } from "@/components/ui/date-range-picker"
import type { DateRange } from "react-day-picker"
import { formatDistanceToNow, format } from "date-fns"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import type { AuditLogEntry } from "@/lib/services/admin"

interface OrganizationOption {
  id: string
  name: string
  slug: string
}

interface UserOption {
  id: string
  fullName: string
  email: string
}

interface AuditLogClientProps {
  auditLogs: AuditLogEntry[]
  totalCount: number
  hasNextPage: boolean
  hasPrevPage: boolean
  page: number
  search: string
  action: string
  entityType: string
  user: string
  orgId: string
  timePeriod: string
  startDate: string
  endDate: string
  organizations: OrganizationOption[]
  users: UserOption[]
}

const entityTypes = [
  { value: "org", label: "Organization" },
  { value: "user", label: "User" },
  { value: "subscription", label: "Subscription" },
  { value: "payment", label: "Payment" },
  { value: "invoice", label: "Invoice" },
  { value: "project", label: "Project" },
  { value: "drawing", label: "Drawing" },
  { value: "document", label: "Document" },
]

export function AuditLogClient({
  auditLogs,
  totalCount,
  hasNextPage,
  hasPrevPage,
  page,
  search,
  action,
  entityType,
  user,
  orgId,
  timePeriod,
  startDate,
  endDate,
  organizations,
  users,
}: AuditLogClientProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()

  const [localSearch, setLocalSearch] = useState(search)
  const [selectedLog, setSelectedLog] = useState<AuditLogEntry | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Local state for custom date picker
  const [customDateRange, setCustomDateRange] = useState<DateRange | undefined>(() => {
    if (startDate) {
      return {
        from: new Date(startDate),
        to: endDate ? new Date(endDate) : undefined,
      }
    }
    return undefined
  })

  const updateFilters = (updates: any) => {
    const params = new URLSearchParams(searchParams.toString())

    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "all" && value !== "") {
        params.set(key, String(value))
      } else {
        params.delete(key)
      }
    })

    // Reset page on filter changes unless explicitly specified
    if (!("page" in updates)) {
      params.delete("page")
    }

    startTransition(() => {
      router.push(`/admin/audit?${params.toString()}`)
      router.refresh()
    })
  }

  const handleTimePeriodChange = (val: string) => {
    const updates: any = { timePeriod: val }

    if (val === "all") {
      updates.startDate = ""
      updates.endDate = ""
      setCustomDateRange(undefined)
    } else if (val === "today") {
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      const end = new Date()
      end.setHours(23, 59, 59, 999)
      updates.startDate = start.toISOString()
      updates.endDate = end.toISOString()
      setCustomDateRange(undefined)
    } else if (val === "7d") {
      const start = new Date()
      start.setDate(start.getDate() - 7)
      updates.startDate = start.toISOString()
      updates.endDate = ""
      setCustomDateRange(undefined)
    } else if (val === "30d") {
      const start = new Date()
      start.setDate(start.getDate() - 30)
      updates.startDate = start.toISOString()
      updates.endDate = ""
      setCustomDateRange(undefined)
    } else if (val === "90d") {
      const start = new Date()
      start.setDate(start.getDate() - 90)
      updates.startDate = start.toISOString()
      updates.endDate = ""
      setCustomDateRange(undefined)
    } else if (val === "custom") {
      // Don't update URL yet, let custom date picker handle it
      return
    }

    updateFilters(updates)
  }

  const clearFilters = () => {
    setLocalSearch("")
    setCustomDateRange(undefined)
    router.push("/admin/audit")
  }

  const handleCopyId = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(id)
    setCopiedId(id)
    toast.success("ID copied to clipboard")
    setTimeout(() => setCopiedId(null), 2000)
  }

  const hasActiveFilters =
    search ||
    (action && action !== "all") ||
    (entityType && entityType !== "all") ||
    (user && user !== "all") ||
    (orgId && orgId !== "all") ||
    startDate ||
    endDate

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      {/* Filters Toolbar */}
      <div className="relative z-20 shrink-0 border-b bg-background/95 backdrop-blur-sm px-4 py-3">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 flex-1">
            {/* Search Input */}
            <div className="relative w-full md:w-60">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search action or entity..."
                value={localSearch}
                onChange={(e) => setLocalSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    updateFilters({ search: localSearch })
                  }
                }}
                className="h-8 pl-8 text-xs w-full"
              />
              {localSearch && (
                <button
                  type="button"
                  onClick={() => {
                    setLocalSearch("")
                    updateFilters({ search: "" })
                  }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            {/* Action Select */}
            <Select value={action} onValueChange={(val) => updateFilters({ action: val })}>
              <SelectTrigger className="w-full md:w-28 h-8 text-xs">
                <SelectValue placeholder="All Actions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Actions</SelectItem>
                <SelectItem value="insert">Create</SelectItem>
                <SelectItem value="update">Update</SelectItem>
                <SelectItem value="delete">Delete</SelectItem>
              </SelectContent>
            </Select>

            {/* Entity Type Select */}
            <Select value={entityType} onValueChange={(val) => updateFilters({ entityType: val })}>
              <SelectTrigger className="w-full md:w-32 h-8 text-xs">
                <SelectValue placeholder="All Entities" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Entities</SelectItem>
                {entityTypes.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Organization Select */}
            <Select value={orgId} onValueChange={(val) => updateFilters({ orgId: val })}>
              <SelectTrigger className="w-full md:w-44 h-8 text-xs">
                <SelectValue placeholder="All Organizations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Organizations</SelectItem>
                {organizations.map((org) => (
                  <SelectItem key={org.id} value={org.id}>
                    {org.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* User Select */}
            <Select value={user} onValueChange={(val) => updateFilters({ user: val })}>
              <SelectTrigger className="w-full md:w-40 h-8 text-xs">
                <SelectValue placeholder="All Users" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Users</SelectItem>
                <SelectItem value="system">System (No User)</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.fullName || u.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Time Period Select */}
            <Select value={timePeriod} onValueChange={handleTimePeriodChange}>
              <SelectTrigger className="w-full md:w-32 h-8 text-xs">
                <SelectValue placeholder="All Time" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Time</SelectItem>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="7d">Last 7 Days</SelectItem>
                <SelectItem value="30d">Last 30 Days</SelectItem>
                <SelectItem value="90d">Last 90 Days</SelectItem>
                <SelectItem value="custom">Custom Range</SelectItem>
              </SelectContent>
            </Select>

            {/* Custom Date Range Picker */}
            {timePeriod === "custom" && (
              <div className="w-full md:w-52">
                <DateRangePicker
                  dateRange={customDateRange}
                  onDateRangeChange={(range) => {
                    setCustomDateRange(range)
                    if (range?.from) {
                      updateFilters({
                        startDate: range.from.toISOString(),
                        endDate: range.to ? range.to.toISOString() : "",
                        timePeriod: "custom",
                      })
                    }
                  }}
                  placeholder="Select range"
                />
              </div>
            )}

            {/* Clear Button */}
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters} className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5 mr-1" />
                Clear Filters
              </Button>
            )}
          </div>

          {/* Pagination Toolbar Header */}
          <div className="flex items-center gap-3 shrink-0 self-end xl:self-center">
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {totalCount > 0 ? (
                <>
                  Showing <b>{(page - 1) * 50 + 1}</b> – <b>{Math.min(page * 50, totalCount)}</b> of <b>{totalCount}</b> entries
                </>
              ) : (
                "0 entries"
              )}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0"
                disabled={!hasPrevPage}
                onClick={() => updateFilters({ page: page - 1 })}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0"
                disabled={!hasNextPage}
                onClick={() => updateFilters({ page: page + 1 })}
              >
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Table Content */}
      <div className={cn("relative z-10 min-h-0 flex-1 overflow-auto", isPending && "opacity-60 pointer-events-none transition-opacity")}>
        {auditLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full min-h-[400px]">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-3">
              <SlidersHorizontal className="h-7 w-7 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-base">No logs found</h3>
            <p className="text-sm text-muted-foreground mt-1 text-center max-w-sm">
              No audit log entries match your filter criteria. Try adjusting the search query or filter values.
            </p>
            {hasActiveFilters && (
              <Button className="mt-4" size="sm" variant="outline" onClick={clearFilters}>
                Clear all filters
              </Button>
            )}
          </div>
        ) : (
          <>
            {/* Desktop Table View */}
            <div className="hidden md:block">
              <Table>
                <TableHeader className="bg-muted/40 sticky top-0 z-10 border-b">
                  <TableRow>
                    <TableHead className="pl-6 w-[15%]">User</TableHead>
                    <TableHead className="w-[15%]">Organization</TableHead>
                    <TableHead className="w-[15%]">Project</TableHead>
                    <TableHead className="w-[10%]">Action</TableHead>
                    <TableHead className="w-[15%]">Entity</TableHead>
                    <TableHead>Details</TableHead>
                    <TableHead className="w-[15%]">Timestamp</TableHead>
                    <TableHead className="w-[50px] pr-4" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {auditLogs.map((log) => (
                    <TableRow
                      key={log.id}
                      onClick={() => setSelectedLog(log)}
                      className="cursor-pointer hover:bg-muted/40 transition-colors"
                    >
                      <TableCell className="pl-6 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-3">
                          <Avatar className="h-8 w-8 rounded-full border">
                            <AvatarFallback className="text-xs bg-primary/10 text-primary font-medium">
                              {log.userInitials}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <div className="font-semibold text-sm truncate max-w-[150px]">{log.userName}</div>
                            <div className="text-xs text-muted-foreground truncate max-w-[150px]">
                              {log.userEmail}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="py-3">
                        <div className="flex items-center gap-1.5 min-w-[120px]">
                          {log.orgName ? (
                            <>
                              <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              <span className="text-sm truncate max-w-[140px] font-medium text-foreground" title={log.orgName}>
                                {log.orgName}
                              </span>
                            </>
                          ) : (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-medium bg-muted/50 border-muted text-muted-foreground">
                              Platform
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="py-3">
                        {log.projectName ? (
                          <span className="text-sm truncate max-w-[140px] text-muted-foreground" title={log.projectName}>
                            {log.projectName}
                          </span>
                        ) : (
                          <span className="text-sm text-muted-foreground/50">-</span>
                        )}
                      </TableCell>
                      <TableCell className="py-3">
                        <Badge variant={getActionVariant(log.action)} className="capitalize text-[10px] px-2 py-0.5 font-medium shrink-0">
                          {log.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="min-w-[125px]">
                          <div className="font-semibold text-sm capitalize truncate">
                            {log.entityType.replace("_", " ")}
                          </div>
                          {log.entityId && (
                            <button
                              onClick={(e) => handleCopyId(log.entityId!, e)}
                              className="text-xs text-muted-foreground font-mono hover:text-foreground flex items-center gap-1 group mt-0.5"
                            >
                              <span>{log.entityId.slice(0, 8)}...</span>
                              {copiedId === log.entityId ? (
                                <Check className="h-3 w-3 text-success shrink-0" />
                              ) : (
                                <Copy className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                              )}
                            </button>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="py-3 text-sm text-muted-foreground">
                        <div className="max-w-xs md:max-w-md truncate" title={log.description || ""}>
                          {log.description || "No details available"}
                        </div>
                      </TableCell>
                      <TableCell className="py-3">
                        <div className="text-xs text-muted-foreground whitespace-nowrap min-w-[110px]">
                          <div className="font-medium text-foreground">{format(new Date(log.createdAt), "MMM d, yyyy")}</div>
                          <div>{format(new Date(log.createdAt), "HH:mm:ss")}</div>
                          <div className="text-[10px] text-muted-foreground/80 mt-0.5">
                            {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="py-3 text-right pr-4" onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setSelectedLog(log)}>
                          <Eye className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile List View */}
            <div className="md:hidden divide-y">
              {auditLogs.map((log) => (
                <div
                  key={log.id}
                  onClick={() => setSelectedLog(log)}
                  className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-muted/20 active:bg-muted/40 transition-colors cursor-pointer"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm">{log.userName}</span>
                      <Badge variant={getActionVariant(log.action)} className="capitalize text-[9px] px-1.5 py-0 h-4 font-medium">
                        {log.action}
                      </Badge>
                      {log.orgName && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          • <Building2 className="h-3 w-3" /> {log.orgName}
                        </span>
                      )}
                      {log.projectName && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          • {log.projectName}
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-semibold capitalize text-foreground">
                      {log.entityType.replace("_", " ")} {log.entityId && `(${log.entityId.slice(0, 8)})`}
                    </p>
                    <p className="text-xs text-muted-foreground line-clamp-2">{log.description || "No description"}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {format(new Date(log.createdAt), "MMM d, yyyy HH:mm:ss")} ({formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })})
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0 self-center" onClick={(e) => { e.stopPropagation(); setSelectedLog(log) }}>
                    <Eye className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Sticky Bottom Pagination Footer (Desktop + Mobile) */}
      <div className="border-t bg-background px-4 py-3 shrink-0">
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            Page <b>{page}</b> of <b>{Math.ceil(totalCount / 50) || 1}</b> • <b>{totalCount}</b> total logs
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1"
              disabled={!hasPrevPage}
              onClick={() => updateFilters({ page: page - 1 })}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1"
              disabled={!hasNextPage}
              onClick={() => updateFilters({ page: page + 1 })}
            >
              Next
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Log Detail Drawer (Sheet) */}
      <Sheet open={!!selectedLog} onOpenChange={(open) => !open && setSelectedLog(null)}>
        {selectedLog && (
          <SheetContent className="w-full sm:max-w-2xl overflow-y-auto" side="right">
            <SheetHeader className="pb-4 border-b">
              <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wide">
                <span>Audit Entry Details</span>
              </div>
              <SheetTitle className="text-xl font-bold flex items-center gap-2.5">
                <span className="capitalize">{selectedLog.entityType.replace("_", " ")}</span>
                <Badge variant={getActionVariant(selectedLog.action)} className="capitalize px-2 py-0.5">
                  {selectedLog.action}
                </Badge>
              </SheetTitle>
              <SheetDescription className="font-mono text-xs break-all flex items-center gap-1 mt-1">
                Log ID: {selectedLog.id}
                <button
                  onClick={(e) => handleCopyId(selectedLog.id, e)}
                  className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                >
                  {copiedId === selectedLog.id ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </SheetDescription>
            </SheetHeader>

            <div className="py-6 space-y-6">
              {/* Properties Grid */}
              <div className="grid grid-cols-2 gap-4 border rounded-lg p-4 bg-muted/20">
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground font-medium flex items-center gap-1">
                    <User className="h-3 w-3" /> Actor
                  </div>
                  <div className="font-semibold text-sm">{selectedLog.userName}</div>
                  <div className="text-xs text-muted-foreground">{selectedLog.userEmail}</div>
                </div>

                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground font-medium flex items-center gap-1">
                    <Building2 className="h-3 w-3" /> Organization
                  </div>
                  <div className="font-semibold text-sm">{selectedLog.orgName || "Platform (None)"}</div>
                  {selectedLog.orgId && (
                    <div className="text-[10px] text-muted-foreground font-mono break-all">{selectedLog.orgId}</div>
                  )}
                </div>

                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground font-medium flex items-center gap-1">
                    Project
                  </div>
                  <div className="font-semibold text-sm">{selectedLog.projectName || "-"}</div>
                </div>

                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground font-medium">Entity Type & ID</div>
                  <div className="font-semibold text-sm capitalize">{selectedLog.entityType.replace("_", " ")}</div>
                  {selectedLog.entityId && (
                    <div className="text-xs text-muted-foreground font-mono break-all flex items-center gap-1 mt-0.5">
                      {selectedLog.entityId}
                      <button
                        onClick={(e) => handleCopyId(selectedLog.entityId!, e)}
                        className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground shrink-0"
                      >
                        {copiedId === selectedLog.entityId ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                      </button>
                    </div>
                  )}
                </div>

                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground font-medium">Timestamp</div>
                  <div className="font-semibold text-sm">{format(new Date(selectedLog.createdAt), "MMM d, yyyy HH:mm:ss")}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(selectedLog.createdAt), { addSuffix: true })}
                  </div>
                </div>
              </div>

              {/* Description */}
              <div className="space-y-1.5">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Description</h4>
                <div className="p-3 border rounded-lg bg-background text-sm leading-relaxed font-medium">
                  {selectedLog.description || "No description provided."}
                </div>
              </div>

              {/* JSON Data Diff */}
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b pb-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {selectedLog.action === "update" ? "Changed Properties" : "Data Snapshot"}
                  </h4>
                  <Badge variant="outline" className="text-[10px]">JSON Diff</Badge>
                </div>
                {renderDataDiff(selectedLog.beforeData, selectedLog.afterData)}
              </div>
            </div>
          </SheetContent>
        )}
      </Sheet>
    </div>
  )
}

function getActionVariant(action: string) {
  switch (action) {
    case "insert":
      return "default" // Solid (Create)
    case "update":
      return "secondary" // Secondary (Update)
    case "delete":
      return "destructive" // Destructive (Delete)
    default:
      return "outline"
  }
}

function renderDataDiff(before: any, after: any) {
  const isBeforeEmpty = !before || Object.keys(before).length === 0
  const isAfterEmpty = !after || Object.keys(after).length === 0

  if (isBeforeEmpty && isAfterEmpty) {
    return <div className="text-sm text-muted-foreground italic text-center py-4 border rounded-lg">No data changes recorded.</div>
  }

  if (isBeforeEmpty) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] text-muted-foreground font-semibold uppercase">Created Data</div>
        <pre className="p-3 bg-muted rounded-lg text-xs overflow-auto max-h-80 font-mono text-foreground border leading-5">
          {JSON.stringify(after, null, 2)}
        </pre>
      </div>
    )
  }

  if (isAfterEmpty) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] text-muted-foreground font-semibold uppercase">Deleted Data</div>
        <pre className="p-3 bg-muted rounded-lg text-xs overflow-auto max-h-80 font-mono text-foreground border leading-5">
          {JSON.stringify(before, null, 2)}
        </pre>
      </div>
    )
  }

  // Handle updates - find changed properties
  const allKeys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
  const changes = allKeys
    .map((key) => {
      const valBefore = before[key]
      const valAfter = after[key]

      if (JSON.stringify(valBefore) !== JSON.stringify(valAfter)) {
        return {
          key,
          before: valBefore,
          after: valAfter,
        }
      }
      return null
    })
    .filter(Boolean)

  if (changes.length === 0) {
    return (
      <div className="space-y-2">
        <div className="text-sm text-muted-foreground italic text-center py-4 border rounded-lg">No changes detected in specific keys. Displaying full snapshot:</div>
        <pre className="p-3 bg-muted rounded-lg text-xs overflow-auto max-h-80 font-mono text-foreground border leading-5">
          {JSON.stringify(after, null, 2)}
        </pre>
      </div>
    )
  }

  return (
    <div className="border rounded-lg divide-y text-sm overflow-hidden bg-background">
      <div className="grid grid-cols-3 gap-3 bg-muted/40 p-2.5 font-semibold text-xs text-muted-foreground border-b uppercase tracking-wider">
        <div>Field</div>
        <div>Before</div>
        <div>After</div>
      </div>
      <div className="divide-y max-h-96 overflow-y-auto">
        {changes.map((change: any) => (
          <div key={change.key} className="grid grid-cols-3 gap-3 p-3 font-mono text-xs items-start hover:bg-muted/10 transition-colors">
            <div className="font-semibold text-foreground break-all self-center">{change.key}</div>
            <div className="text-destructive font-medium whitespace-pre-wrap break-all bg-destructive/5 border border-destructive/10 p-2 rounded-md leading-relaxed min-h-[32px]">
              {change.before !== undefined && change.before !== null ? (
                typeof change.before === "object" ? JSON.stringify(change.before, null, 2) : String(change.before)
              ) : (
                <span className="italic text-muted-foreground/60 text-[10px]">undefined</span>
              )}
            </div>
            <div className="text-success font-medium whitespace-pre-wrap break-all bg-success/5 border border-success/10 p-2 rounded-md leading-relaxed min-h-[32px]">
              {change.after !== undefined && change.after !== null ? (
                typeof change.after === "object" ? JSON.stringify(change.after, null, 2) : String(change.after)
              ) : (
                <span className="italic text-muted-foreground/60 text-[10px]">undefined</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
