"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { format } from "date-fns"
import { unwrapAction } from "@/lib/action-result"
import type { Observation, SafetyIncident, ToolboxTalk } from "@/lib/services/safety"
import { useIsMobile } from "@/hooks/use-mobile"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import {
  Attachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
} from "@/components/ui/attachment"
import { AlertTriangle, Eye, Users, Plus, Search, Shield, CalendarDays, FileText } from "@/components/icons"
import { cn } from "@/lib/utils"
import { useOfflineSafetyDrafts, type OfflineSafetyDraft } from "@/lib/hooks/use-offline-safety-drafts"
import { AttachmentField } from "@/components/files"
import { uploadFileAction } from "@/app/(app)/documents/actions"
import {
  createObservationAction,
  createSafetyIncidentAction,
  createToolboxTalkAction,
  deleteToolboxTalkAction,
  updateObservationAction,
  updateSafetyIncidentAction,
} from "./actions"
import { LocationPicker } from "@/components/locations/location-picker"
import type { ProjectLocation } from "@/lib/services/locations"

const SEVERITY_LABELS: Record<string, string> = {
  near_miss: "Near miss",
  first_aid: "First aid",
  medical_treatment: "Medical treatment",
  lost_time: "Lost time",
  fatality: "Fatality",
}

const severityStyles: Record<string, string> = {
  near_miss: "bg-muted text-muted-foreground border-muted",
  first_aid: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  medical_treatment: "bg-warning/15 text-warning border-warning/30",
  lost_time: "bg-destructive/15 text-destructive border-destructive/30",
  fatality: "bg-destructive/25 text-destructive border-destructive/40",
}

const INCIDENT_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  under_review: "Under review",
  closed: "Closed",
}

const incidentStatusStyles: Record<string, string> = {
  open: "bg-warning/20 text-warning border-warning/40",
  under_review: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  closed: "bg-muted text-muted-foreground border-muted",
}

const observationCategoryStyles: Record<string, string> = {
  positive: "bg-success/15 text-success border-success/30",
  at_risk: "bg-warning/15 text-warning border-warning/30",
  deficiency: "bg-destructive/15 text-destructive border-destructive/30",
}

type RecordType = "incident" | "observation" | "talk"

type SafetyRecord =
  | { type: "incident"; id: string; data: SafetyIncident }
  | { type: "observation"; id: string; data: Observation }
  | { type: "talk"; id: string; data: ToolboxTalk }

const typeMeta: Record<RecordType, { label: string; short: string; icon: React.ComponentType<{ className?: string }>; dot: string }> = {
  incident: { label: "Incident", short: "Incidents", icon: AlertTriangle, dot: "bg-destructive" },
  observation: { label: "Observation", short: "Observations", icon: Eye, dot: "bg-blue-500" },
  talk: { label: "Toolbox Talk", short: "Toolbox Talks", icon: Users, dot: "bg-muted-foreground/50" },
}

type CompanyOption = { id: string; name: string }

function recordDate(record: SafetyRecord): number {
  if (record.type === "incident") return new Date(record.data.occurred_at).getTime()
  if (record.type === "observation") return new Date(record.data.created_at).getTime()
  return new Date(`${record.data.held_at}T12:00:00`).getTime()
}

function recordRef(record: SafetyRecord): string {
  if (record.type === "incident") return `#${record.data.incident_number}`
  if (record.type === "observation") return `#${record.data.observation_number}`
  return "—"
}

function recordSummary(record: SafetyRecord): string {
  if (record.type === "talk") return record.data.topic
  return record.data.description
}

function recordParty(record: SafetyRecord): string | null {
  if (record.type === "incident") return record.data.involved_company_name ?? null
  if (record.type === "observation") return record.data.company_name ?? null
  return record.data.presenter_name ?? null
}

function statusBucket(record: SafetyRecord): "open" | "closed" | "logged" {
  if (record.type === "incident") return record.data.status === "closed" ? "closed" : "open"
  if (record.type === "observation") return record.data.status === "resolved" ? "closed" : "open"
  return "logged"
}

function TypeBadge({ type }: { type: RecordType }) {
  const meta = typeMeta[type]
  const Icon = meta.icon
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <Icon className="h-3.5 w-3.5" />
      {meta.label}
    </span>
  )
}

function TagCell({ record }: { record: SafetyRecord }) {
  if (record.type === "incident") {
    return (
      <Badge variant="outline" className={cn("text-[10px] font-normal", severityStyles[record.data.severity])}>
        {SEVERITY_LABELS[record.data.severity] ?? record.data.severity}
      </Badge>
    )
  }
  if (record.type === "observation") {
    return record.data.category ? (
      <Badge variant="outline" className={cn("text-[10px] font-normal capitalize", observationCategoryStyles[record.data.category])}>
        {record.data.category.replace(/_/g, " ")}
      </Badge>
    ) : (
      <span className="text-xs capitalize text-muted-foreground">{record.data.kind}</span>
    )
  }
  const count = record.data.attendee_count ?? record.data.attendees.length
  return <span className="text-xs text-muted-foreground tabular-nums">{count} attendee{count === 1 ? "" : "s"}</span>
}

function StatusCell({ record }: { record: SafetyRecord }) {
  if (record.type === "incident") {
    return (
      <Badge variant="outline" className={cn("text-[10px] font-normal", incidentStatusStyles[record.data.status])}>
        {INCIDENT_STATUS_LABELS[record.data.status] ?? record.data.status.replace(/_/g, " ")}
      </Badge>
    )
  }
  if (record.type === "observation") {
    const resolved = record.data.status === "resolved"
    return (
      <Badge variant="outline" className={cn("text-[10px] font-normal capitalize", resolved ? "bg-success/15 text-success border-success/30" : "bg-warning/20 text-warning border-warning/40")}>
        {record.data.status}
      </Badge>
    )
  }
  return <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">Logged</Badge>
}

export function SafetyClient({
  projectId,
  incidents,
  talks,
  observations,
  companies,
  initialTab,
  initialIncidentId,
  initialObservationId,
  locations,
  canManageLocations,
}: {
  projectId: string
  incidents: SafetyIncident[]
  talks: ToolboxTalk[]
  observations: Observation[]
  companies: CompanyOption[]
  initialTab?: string
  initialIncidentId?: string
  initialObservationId?: string
  locations: ProjectLocation[]
  canManageLocations: boolean
}) {
  const isMobile = useIsMobile()
  const offline = useOfflineSafetyDrafts(projectId)

  const records = useMemo<SafetyRecord[]>(() => {
    const all: SafetyRecord[] = [
      ...incidents.map((data): SafetyRecord => ({ type: "incident", id: data.id, data })),
      ...observations.map((data): SafetyRecord => ({ type: "observation", id: data.id, data })),
      ...talks.map((data): SafetyRecord => ({ type: "talk", id: data.id, data })),
    ]
    return all.sort((a, b) => recordDate(b) - recordDate(a))
  }, [incidents, observations, talks])

  const [search, setSearch] = useState("")
  const [typeFilter, setTypeFilter] = useState<"all" | RecordType>(
    initialTab === "talks" ? "talk" : initialTab === "observations" ? "observation" : "all",
  )
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "closed">("all")

  const [incidentSheet, setIncidentSheet] = useState<{ open: boolean; selected: SafetyIncident | null }>(() => {
    const initial = initialIncidentId ? incidents.find((incident) => incident.id === initialIncidentId) ?? null : null
    return { open: Boolean(initial), selected: initial }
  })
  const [observationSheet, setObservationSheet] = useState<{ open: boolean; selected: Observation | null }>(() => {
    const initial = initialObservationId ? observations.find((observation) => observation.id === initialObservationId) ?? null : null
    return { open: Boolean(initial), selected: initial }
  })
  const [talkSheet, setTalkSheet] = useState<{ open: boolean; selected: ToolboxTalk | null }>({ open: false, selected: null })

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return records.filter((record) => {
      if (typeFilter !== "all" && record.type !== typeFilter) return false
      if (statusFilter !== "all" && statusBucket(record) !== statusFilter) return false
      if (term.length === 0) return true
      return [recordRef(record), recordSummary(record), recordParty(record) ?? ""].some((value) => value.toLowerCase().includes(term))
    })
  }, [records, search, typeFilter, statusFilter])

  const openRecord = (record: SafetyRecord) => {
    if (record.type === "incident") setIncidentSheet({ open: true, selected: record.data })
    else if (record.type === "observation") setObservationSheet({ open: true, selected: record.data })
    else setTalkSheet({ open: true, selected: record.data })
  }

  const openStates = [
    { key: "incident" as const, label: "Report incident", onClick: () => setIncidentSheet({ open: true, selected: null }) },
    { key: "observation" as const, label: "Log observation", onClick: () => setObservationSheet({ open: true, selected: null }) },
    { key: "talk" as const, label: "Record toolbox talk", onClick: () => setTalkSheet({ open: true, selected: null }) },
  ]

  const filterOptions: Array<"all" | RecordType> = ["all", "incident", "observation", "talk"]

  return (
    <>
      <IncidentSheet
        open={incidentSheet.open}
        selected={incidentSheet.selected}
        onOpenChange={(open) => setIncidentSheet((prev) => ({ ...prev, open }))}
        projectId={projectId}
        companies={companies}
        locations={locations}
        canManageLocations={canManageLocations}
        saveOfflineDraft={offline.saveDraft}
      />
      <ObservationSheet
        open={observationSheet.open}
        selected={observationSheet.selected}
        onOpenChange={(open) => setObservationSheet((prev) => ({ ...prev, open }))}
        projectId={projectId}
        companies={companies}
        locations={locations}
        canManageLocations={canManageLocations}
        saveOfflineDraft={offline.saveDraft}
      />
      <ToolboxTalkSheet
        open={talkSheet.open}
        selected={talkSheet.selected}
        onOpenChange={(open) => setTalkSheet((prev) => ({ ...prev, open }))}
        projectId={projectId}
        saveOfflineDraft={offline.saveDraft}
      />

      <div className="-mx-4 -mb-4 -mt-6 flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden bg-background">
        {isMobile ? (
          <div className="sticky top-0 z-20 shrink-0 border-b bg-background/95 backdrop-blur-sm">
            <div className="flex items-center gap-2 px-3 pt-3">
              <Input placeholder="Search safety..." className="h-10 text-sm" value={search} onChange={(event) => setSearch(event.target.value)} inputMode="search" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" className="h-10 w-10 shrink-0" aria-label="New safety record"><Plus className="h-4 w-4" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {openStates.map((item) => <DropdownMenuItem key={item.key} onClick={item.onClick}>{item.label}</DropdownMenuItem>)}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="flex gap-1.5 overflow-x-auto px-3 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {filterOptions.map((key) => {
                const active = typeFilter === key
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTypeFilter(key)}
                    className={cn(
                      "shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                      active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground active:bg-muted",
                    )}
                  >
                    {key === "all" ? "All" : typeMeta[key].short}
                  </button>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="sticky top-0 z-20 flex shrink-0 flex-col gap-3 border-b bg-background px-4 py-3 sm:min-h-14 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative w-full sm:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input placeholder="Search safety..." className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} />
              </div>
              <Select value={typeFilter} onValueChange={(value) => setTypeFilter(value as "all" | RecordType)}>
                <SelectTrigger className="w-full sm:w-40"><SelectValue placeholder="Type" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="incident">Incidents</SelectItem>
                  <SelectItem value="observation">Observations</SelectItem>
                  <SelectItem value="talk">Toolbox Talks</SelectItem>
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as "all" | "open" | "closed")}>
                <SelectTrigger className="w-full sm:w-36"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="closed">Closed / resolved</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="w-full sm:w-auto"><Plus className="mr-2 h-4 w-4" />New</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {openStates.map((item) => <DropdownMenuItem key={item.key} onClick={item.onClick}>{item.label}</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}

        {offline.drafts.length > 0 ? (
          <div className="shrink-0 border-b px-4 py-3">
            <OfflineDraftQueue drafts={offline.drafts} isOnline={offline.isOnline} onDiscard={offline.discardDraft} />
          </div>
        ) : null}

        {isMobile ? (
          <div className="min-h-0 flex-1 overflow-auto">
            {filtered.length === 0 ? (
              <MobileEmpty onNew={openStates[0].onClick} hasRecords={records.length > 0} />
            ) : (
              <ul className="divide-y">
                {filtered.map((record) => {
                  const meta = typeMeta[record.type]
                  return (
                    <li key={`${record.type}-${record.id}`} className="flex items-stretch">
                      <button type="button" onClick={() => openRecord(record)} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left active:bg-muted/60">
                        <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", meta.dot)} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium leading-tight">{recordSummary(record)}</p>
                          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                            {[meta.label, recordRef(record) !== "—" ? recordRef(record) : null, recordParty(record)].filter(Boolean).join(" · ")}
                          </p>
                        </div>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{new Date(recordDate(record)).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-[150px]">Type</TableHead>
                  <TableHead className="w-[72px]">Ref</TableHead>
                  <TableHead className="w-[110px]">Date</TableHead>
                  <TableHead className="min-w-[280px]">Summary</TableHead>
                  <TableHead className="hidden lg:table-cell w-[150px]">Detail</TableHead>
                  <TableHead className="hidden md:table-cell w-[180px]">Company / Presenter</TableHead>
                  <TableHead className="hidden sm:table-cell w-[130px]">Status</TableHead>
                </TableRow>
              </TableHeader>
              {filtered.length ? (
                <TableBody>
                  {filtered.map((record) => (
                    <TableRow key={`${record.type}-${record.id}`} className="group h-[60px] cursor-pointer hover:bg-muted/30" onClick={() => openRecord(record)}>
                      <TableCell><TypeBadge type={record.type} /></TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{recordRef(record)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{new Date(recordDate(record)).toLocaleDateString()}</TableCell>
                      <TableCell className="max-w-0"><span className="block truncate text-sm font-medium">{recordSummary(record)}</span></TableCell>
                      <TableCell className="hidden lg:table-cell"><TagCell record={record} /></TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-muted-foreground">{recordParty(record) ?? "—"}</TableCell>
                      <TableCell className="hidden sm:table-cell"><StatusCell record={record} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              ) : null}
            </Table>
            {filtered.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                  <Shield className="h-6 w-6 text-muted-foreground" />
                </div>
                <div className="max-w-[420px]">
                  <p className="font-medium text-foreground">{records.length ? "Nothing matches your filters" : "No safety records yet"}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {records.length ? "Try a different search, type, or status." : "Report an incident, log an observation, or record a toolbox talk to get started."}
                  </p>
                </div>
                {records.length ? null : (
                  <Button size="sm" className="mt-1" onClick={openStates[0].onClick}><Plus className="mr-2 h-4 w-4" />Report incident</Button>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </>
  )
}

function MobileEmpty({ onNew, hasRecords }: { onNew: () => void; hasRecords: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
        <Shield className="h-6 w-6 text-muted-foreground" />
      </div>
      <div>
        <p className="font-medium">{hasRecords ? "Nothing matches" : "No safety records yet"}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{hasRecords ? "Try a different filter." : "Report your first safety record."}</p>
      </div>
      {hasRecords ? null : <Button className="mt-1" onClick={onNew}><Plus className="mr-2 h-4 w-4" />Report incident</Button>}
    </div>
  )
}

function OfflineDraftQueue({ drafts, isOnline, onDiscard }: { drafts: OfflineSafetyDraft[]; isOnline: boolean; onDiscard: (id: string) => Promise<void> }) {
  return (
    <div className="space-y-2 border border-warning/40 bg-warning/10 p-3 text-sm">
      <div className="font-medium">{drafts.length} safety draft{drafts.length === 1 ? "" : "s"} not synced</div>
      <p className="text-xs text-muted-foreground">
        {isOnline ? "Connection restored. Re-enter each draft below and submit it when ready." : "Draft text is saved on this device until the connection returns."}
        {" "}Photos and sign-in sheets are not stored offline and must be reattached before submission.
      </p>
      {drafts.map((draft) => (
        <details key={draft.id} className="border bg-background px-3 py-2">
          <summary className="cursor-pointer capitalize">{draft.kind.replaceAll("_", " ")} · {new Date(draft.createdAt).toLocaleString()}</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(draft.values, null, 2)}</pre>
          {draft.evidence.length > 0 ? <p className="mt-2 text-xs font-medium text-warning">Reattach: {draft.evidence.map((file) => file.name).join(", ")}</p> : null}
          <Button className="mt-2" size="sm" variant="outline" onClick={() => void onDiscard(draft.id)}>Discard draft</Button>
        </details>
      ))}
    </div>
  )
}

function useSubmit() {
  const [pending, startTransition] = useTransition()
  const submit = (work: () => Promise<void>) =>
    startTransition(() => {
      void work().catch((error) => toast.error(error instanceof Error ? error.message : "Something went wrong"))
    })
  return { pending, submit }
}

const sheetContentClass = "flex flex-col p-0 shadow-2xl fast-sheet-animation sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-lg"
const sheetStyle = { animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties

function IncidentSheet({ open, selected, onOpenChange, projectId, companies, locations, canManageLocations, saveOfflineDraft }: {
  open: boolean
  selected: SafetyIncident | null
  onOpenChange: (open: boolean) => void
  projectId: string
  companies: CompanyOption[]
  locations: ProjectLocation[]
  canManageLocations: boolean
  saveOfflineDraft: ReturnType<typeof useOfflineSafetyDrafts>["saveDraft"]
}) {
  const router = useRouter()
  const { pending, submit } = useSubmit()
  const [locationId, setLocationId] = useState<string | null>(selected?.location_id ?? null)
  const [locationPath, setLocationPath] = useState<string | null>(selected?.location ?? null)
  const [occurredDate, setOccurredDate] = useState<Date | undefined>(selected ? new Date(selected.occurred_at) : undefined)
  const [occurredTime, setOccurredTime] = useState(selected ? format(new Date(selected.occurred_at), "HH:mm") : "")
  const [dateOpen, setDateOpen] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])

  useEffect(() => {
    if (!open) return
    setLocationId(selected?.location_id ?? null)
    setLocationPath(selected?.location ?? null)
    setOccurredDate(selected ? new Date(selected.occurred_at) : undefined)
    setOccurredTime(selected ? format(new Date(selected.occurred_at), "HH:mm") : "")
    setPendingFiles([])
  }, [open, selected])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" mobileFullscreen className={sheetContentClass} style={sheetStyle}>
        <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6">
          <div className="flex flex-wrap items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-primary" />
            <SheetTitle>{selected ? `Incident #${selected.incident_number}` : "Report incident"}</SheetTitle>
            {selected ? (
              <>
                <a href={`/projects/${projectId}/exports/incident?id=${selected.id}`} target="_blank" rel="noreferrer" className="ml-1">
                  <Button variant="ghost" size="sm" type="button">PDF</Button>
                </a>
                <Badge variant="outline" className={cn("text-[10px] font-normal", severityStyles[selected.severity])}>{SEVERITY_LABELS[selected.severity] ?? selected.severity}</Badge>
                <Badge variant="outline" className={cn("text-[10px] font-normal", incidentStatusStyles[selected.status])}>{INCIDENT_STATUS_LABELS[selected.status] ?? selected.status.replace(/_/g, " ")}</Badge>
              </>
            ) : null}
          </div>
          <SheetDescription className="text-left">
            {selected ? "Investigation record — update status and root cause as it progresses." : "Lost-time and fatality reports alert org admins by email."}
          </SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            if (!occurredDate) {
              toast.error("Select the date it occurred")
              return
            }
            const form = new FormData(event.currentTarget)
            const occurred = new Date(occurredDate)
            const [hours, minutes] = (occurredTime || "00:00").split(":").map(Number)
            occurred.setHours(hours || 0, minutes || 0, 0, 0)
            const shared = {
              occurred_at: occurred.toISOString(),
              severity: form.get("severity"),
              classification: form.get("classification") || null,
              location_id: locationId === selected?.location_id ? undefined : locationId,
              location: locationPath,
              description: form.get("description"),
              involved_company_id: form.get("involved_company_id") && form.get("involved_company_id") !== "__none__" ? form.get("involved_company_id") : null,
              involved_person_name: form.get("involved_person_name") || null,
              witness_names: form.get("witness_names") || null,
              immediate_action: form.get("immediate_action") || null,
              is_osha_recordable: form.get("is_osha_recordable") === "on",
            }
            const pendingPhoto = pendingFiles[0] ?? null
            submit(async () => {
              if (!navigator.onLine && !selected) {
                await saveOfflineDraft("incident", { ...shared, project_id: projectId }, pendingPhoto ? [pendingPhoto] : [])
                toast.success("Incident draft saved offline. Evidence must be reattached before submission.")
                onOpenChange(false)
                return
              }
              if (selected) {
                unwrapAction(await updateSafetyIncidentAction(projectId, selected.id, {
                  ...shared,
                  root_cause: form.get("root_cause") || null,
                  status: form.get("status") || undefined,
                }))
                toast.success("Incident updated")
              } else {
                let photoFileId: string | null = null
                if (pendingPhoto && pendingPhoto.size > 0) {
                  const upload = new FormData()
                  upload.append("file", pendingPhoto)
                  upload.append("projectId", projectId)
                  upload.append("category", "photos")
                  upload.append("visibility", "private")
                  upload.append("folderPath", "/safety/incidents")
                  photoFileId = unwrapAction(await uploadFileAction(upload)).id
                }
                unwrapAction(await createSafetyIncidentAction({ ...shared, project_id: projectId, photo_file_id: photoFileId }))
                toast.success("Incident reported")
              }
              onOpenChange(false)
              router.refresh()
            })
          }}
        >
          <div className="min-h-0 flex-1 space-y-6 overflow-auto px-6 py-4">
            <section className="space-y-4">
              <h4 className="text-sm font-medium">Details</h4>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Date occurred</Label>
                  <Popover open={dateOpen} onOpenChange={setDateOpen}>
                    <PopoverTrigger asChild>
                      <Button type="button" variant="outline" className={cn("w-full justify-start font-normal", !occurredDate && "text-muted-foreground")}>
                        <CalendarDays className="mr-2 h-4 w-4" />
                        {occurredDate ? format(occurredDate, "MMM d, yyyy") : "Select date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar mode="single" selected={occurredDate} onSelect={(date) => { setOccurredDate(date); setDateOpen(false) }} initialFocus />
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="space-y-2">
                  <Label>Time</Label>
                  <Input type="time" value={occurredTime} onChange={(event) => setOccurredTime(event.target.value)} className="w-full" />
                </div>
                <div className="space-y-2">
                  <Label>Severity</Label>
                  <Select name="severity" defaultValue={selected?.severity ?? "near_miss"}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(SEVERITY_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Classification</Label>
                  <Select name="classification" defaultValue={selected?.classification ?? "injury"}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="injury">Injury</SelectItem>
                      <SelectItem value="illness">Illness</SelectItem>
                      <SelectItem value="property_damage">Property damage</SelectItem>
                      <SelectItem value="environmental">Environmental</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>Location</Label>
                  <LocationPicker projectId={projectId} locations={locations} value={locationId} canCreate={canManageLocations} disabled={pending} placeholder={selected?.location ?? "Select location"} onValueChange={(id, path) => { setLocationId(id); setLocationPath(path) }} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>Description</Label>
                  <Textarea name="description" required rows={4} defaultValue={selected?.description ?? ""} placeholder="What happened..." />
                </div>
              </div>
            </section>

            <Separator />

            <section className="space-y-4">
              <h4 className="text-sm font-medium">Involved parties</h4>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Involved company</Label>
                  <Select name="involved_company_id" defaultValue={selected?.involved_company_id ?? "__none__"}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">None / own forces</SelectItem>
                      {companies.map((company) => <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Involved person</Label>
                  <Input name="involved_person_name" defaultValue={selected?.involved_person_name ?? ""} className="w-full" />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>Witnesses</Label>
                  <Input name="witness_names" defaultValue={selected?.witness_names ?? ""} placeholder="Names, comma separated" className="w-full" />
                </div>
              </div>
            </section>

            <Separator />

            <section className="space-y-4">
              <h4 className="text-sm font-medium">Response</h4>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label>Immediate action taken</Label>
                  <Textarea name="immediate_action" rows={2} defaultValue={selected?.immediate_action ?? ""} />
                </div>
              </div>
              {selected ? (
                <AttachmentField
                  projectId={projectId}
                  entityType="safety_incident"
                  entityId={selected.id}
                  legacyFileId={selected.photo_file_id}
                  folderPath="/safety/incidents"
                  label="Photos & evidence"
                  emptyHint="Drag and drop or click to add site photos, statements, or documents"
                  disabled={pending}
                />
              ) : (
                <div className="space-y-2">
                  <AttachmentField
                    projectId={projectId}
                    folderPath="/safety/incidents"
                    multiple={false}
                    label="Incident photo"
                    emptyHint="Drag and drop or click to add an incident photo"
                    pendingFiles={pendingFiles}
                    onPendingChange={setPendingFiles}
                    disabled={pending}
                  />
                  <p className="text-xs text-muted-foreground">More photos and documents can be attached after the incident is saved.</p>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Checkbox name="is_osha_recordable" id="osha-recordable" defaultChecked={selected?.is_osha_recordable} />
                <Label htmlFor="osha-recordable" className="font-normal">OSHA recordable</Label>
              </div>
            </section>

            {selected ? (
              <>
                <Separator />
                <section className="space-y-4">
                  <h4 className="text-sm font-medium">Investigation</h4>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2 sm:col-span-2">
                      <Label>Root cause</Label>
                      <Textarea name="root_cause" rows={2} defaultValue={selected.root_cause ?? ""} />
                    </div>
                    <div className="space-y-2 sm:col-span-2">
                      <Label>Status</Label>
                      <Select name="status" defaultValue={selected.status}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="open">Open</SelectItem>
                          <SelectItem value="under_review">Under review</SelectItem>
                          <SelectItem value="closed">Closed</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </section>
              </>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2 border-t bg-muted/30 p-4">
            <div className="flex-1" />
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? "Saving..." : selected ? "Save changes" : "Report incident"}</Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function ObservationSheet({ open, selected, onOpenChange, projectId, companies, locations, canManageLocations, saveOfflineDraft }: {
  open: boolean
  selected: Observation | null
  onOpenChange: (open: boolean) => void
  projectId: string
  companies: CompanyOption[]
  locations: ProjectLocation[]
  canManageLocations: boolean
  saveOfflineDraft: ReturnType<typeof useOfflineSafetyDrafts>["saveDraft"]
}) {
  const router = useRouter()
  const { pending, submit } = useSubmit()
  const [locationId, setLocationId] = useState<string | null>(selected?.location_id ?? null)
  const [locationPath, setLocationPath] = useState<string | null>(selected?.location ?? null)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])

  useEffect(() => {
    if (open) {
      setLocationId(selected?.location_id ?? null)
      setLocationPath(selected?.location ?? null)
      setPendingFiles([])
    }
  }, [open, selected])

  const resolve = () => {
    if (!selected) return
    submit(async () => {
      unwrapAction(await updateObservationAction(projectId, selected.id, { status: "resolved" }))
      toast.success("Observation resolved")
      onOpenChange(false)
      router.refresh()
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" mobileFullscreen className={sheetContentClass} style={sheetStyle}>
        <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6">
          <div className="flex flex-wrap items-center gap-2">
            <Eye className="h-5 w-5 text-primary" />
            <SheetTitle>{selected ? `Observation #${selected.observation_number}` : "Log observation"}</SheetTitle>
            {selected ? (
              <>
                {selected.category ? <Badge variant="outline" className={cn("text-[10px] font-normal capitalize", observationCategoryStyles[selected.category])}>{selected.category.replace(/_/g, " ")}</Badge> : null}
                <Badge variant="outline" className={cn("text-[10px] font-normal capitalize", selected.status === "resolved" ? "bg-success/15 text-success border-success/30" : "bg-warning/20 text-warning border-warning/40")}>{selected.status}</Badge>
              </>
            ) : null}
          </div>
          <SheetDescription className="text-left">
            {selected ? "Update the observation, reassign it, or mark it resolved." : "Capture a safety or quality observation from the field."}
          </SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            const form = new FormData(event.currentTarget)
            const companyValue = String(form.get("company_id") || "__none__")
            const shared = {
              kind: form.get("kind"),
              category: form.get("category") || null,
              description: form.get("description"),
              location_id: selected ? (locationId === selected.location_id ? undefined : locationId) : locationId,
              location: locationPath,
              company_id: companyValue === "__none__" ? null : companyValue,
            }
            const pendingPhoto = pendingFiles[0] ?? null
            submit(async () => {
              if (!navigator.onLine && !selected) {
                await saveOfflineDraft("observation", { ...shared, project_id: projectId }, pendingPhoto ? [pendingPhoto] : [])
                toast.success("Observation draft saved offline. Photo must be reattached before submission.")
                onOpenChange(false)
                return
              }
              if (selected) {
                unwrapAction(await updateObservationAction(projectId, selected.id, {
                  category: shared.category,
                  description: shared.description,
                  location_id: shared.location_id,
                  location: shared.location,
                  company_id: shared.company_id,
                  status: form.get("status") || undefined,
                }))
                toast.success("Observation updated")
              } else {
                let photoFileId: string | null = null
                if (pendingPhoto && pendingPhoto.size > 0) {
                  const upload = new FormData()
                  upload.append("file", pendingPhoto)
                  upload.append("projectId", projectId)
                  upload.append("category", "photos")
                  upload.append("visibility", "private")
                  upload.append("folderPath", "/safety/observations")
                  photoFileId = unwrapAction(await uploadFileAction(upload)).id
                }
                unwrapAction(await createObservationAction({ ...shared, project_id: projectId, photo_file_id: photoFileId }))
                toast.success("Observation recorded")
              }
              onOpenChange(false)
              router.refresh()
            })
          }}
        >
          <div className="min-h-0 flex-1 space-y-6 overflow-auto px-6 py-4">
            <section className="space-y-4">
              <h4 className="text-sm font-medium">Details</h4>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Type</Label>
                  <Select name="kind" defaultValue={selected?.kind ?? "safety"} disabled={Boolean(selected)}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="safety">Safety</SelectItem>
                      <SelectItem value="quality">Quality</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Category</Label>
                  <Select name="category" defaultValue={selected?.category ?? "at_risk"}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="positive">Positive</SelectItem>
                      <SelectItem value="at_risk">At risk</SelectItem>
                      <SelectItem value="deficiency">Deficiency</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea name="description" required rows={4} defaultValue={selected?.description ?? ""} placeholder="What did you observe..." />
              </div>
            </section>

            <Separator />

            <section className="space-y-4">
              <h4 className="text-sm font-medium">Attribution</h4>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Company</Label>
                  <Select name="company_id" defaultValue={selected?.company_id ?? "__none__"}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No company</SelectItem>
                      {companies.map((company) => <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Location</Label>
                  <LocationPicker projectId={projectId} locations={locations} value={locationId} canCreate={canManageLocations} disabled={pending} placeholder={selected?.location ?? "Select location"} onValueChange={(id, path) => { setLocationId(id); setLocationPath(path) }} />
                </div>
              </div>
              {selected ? (
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select name="status" defaultValue={selected.status}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="open">Open</SelectItem>
                      <SelectItem value="resolved">Resolved</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </section>

            <Separator />

            <section className="space-y-4">
              <h4 className="text-sm font-medium">Photos</h4>
              {selected ? (
                <AttachmentField
                  projectId={projectId}
                  entityType="observation"
                  entityId={selected.id}
                  legacyFileId={selected.photo_file_id}
                  folderPath="/safety/observations"
                  label="Photos"
                  emptyHint="Drag and drop or click to add photos"
                  disabled={pending}
                />
              ) : (
                <AttachmentField
                  projectId={projectId}
                  folderPath="/safety/observations"
                  multiple={false}
                  label="Photo"
                  emptyHint="Drag and drop or click to add a photo"
                  pendingFiles={pendingFiles}
                  onPendingChange={setPendingFiles}
                  disabled={pending}
                />
              )}
            </section>
          </div>
          <div className="flex shrink-0 items-center gap-2 border-t bg-muted/30 p-4">
            {selected && selected.status === "open" ? (
              <Button type="button" variant="outline" onClick={resolve} disabled={pending}>Resolve</Button>
            ) : null}
            <div className="flex-1" />
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? "Saving..." : selected ? "Save changes" : "Log observation"}</Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function ToolboxTalkSheet({ open, selected, onOpenChange, projectId, saveOfflineDraft }: {
  open: boolean
  selected: ToolboxTalk | null
  onOpenChange: (open: boolean) => void
  projectId: string
  saveOfflineDraft: ReturnType<typeof useOfflineSafetyDrafts>["saveDraft"]
}) {
  const router = useRouter()
  const { pending, submit } = useSubmit()
  const [signInFiles, setSignInFiles] = useState<File[]>([])

  useEffect(() => {
    if (open) setSignInFiles([])
  }, [open, selected])

  const remove = () => {
    if (!selected) return
    submit(async () => {
      unwrapAction(await deleteToolboxTalkAction(projectId, selected.id))
      toast.success("Toolbox talk deleted")
      onOpenChange(false)
      router.refresh()
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" mobileFullscreen className={sheetContentClass} style={sheetStyle}>
        <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6">
          <div className="flex flex-wrap items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            <SheetTitle>{selected ? selected.topic : "Record toolbox talk"}</SheetTitle>
          </div>
          <SheetDescription className="text-left">
            {selected ? `Held ${new Date(`${selected.held_at}T12:00:00`).toLocaleDateString()}` : "Log a safety talk and its signed attendance."}
          </SheetDescription>
        </SheetHeader>

        {selected ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-6 overflow-auto px-6 py-4">
              <section className="space-y-3">
                <h4 className="text-sm font-medium">Details</h4>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Presenter</p>
                    <p>{selected.presenter_name ?? "—"}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Attendees</p>
                    <p className="tabular-nums">{selected.attendee_count ?? selected.attendees.length}</p>
                  </div>
                </div>
                {selected.file_id ? (
                  <Attachment state="done" className="w-full">
                    <AttachmentMedia variant="icon">
                      <FileText className="h-4 w-4" />
                    </AttachmentMedia>
                    <AttachmentContent>
                      <AttachmentTitle>Signed attendance sheet</AttachmentTitle>
                      <AttachmentDescription>Tap to view</AttachmentDescription>
                    </AttachmentContent>
                    <AttachmentActions className="pr-1.5">
                      <AttachmentAction asChild aria-label="View signed attendance sheet">
                        <a href={`/api/files/${selected.file_id}/raw`} target="_blank" rel="noreferrer">
                          <Eye className="h-4 w-4" />
                        </a>
                      </AttachmentAction>
                    </AttachmentActions>
                  </Attachment>
                ) : null}
              </section>
              {selected.attendees.length > 0 ? (
                <>
                  <Separator />
                  <section className="space-y-2">
                    <h4 className="text-sm font-medium">Attendee list</h4>
                    <ul className="space-y-1 text-sm">
                      {selected.attendees.map((attendee, index) => (
                        <li key={`${attendee.name}-${index}`} className="flex justify-between gap-3 border-b py-1 last:border-0">
                          <span>{attendee.name}</span>
                          {attendee.company ? <span className="text-muted-foreground">{attendee.company}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </section>
                </>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2 border-t bg-muted/30 p-4">
              <Button type="button" variant="outline" onClick={remove} disabled={pending} className="text-destructive hover:text-destructive">Delete</Button>
              <div className="flex-1" />
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Close</Button>
            </div>
          </div>
        ) : (
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              submit(async () => {
                const attendees = String(form.get("attendees") ?? "")
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean)
                  .map((line) => {
                    const [name, ...companyParts] = line.split("|").map((part) => part.trim())
                    return { name, company: companyParts.join(" | ") || null }
                  })
                const signInSheet = signInFiles[0] ?? null
                const payload = {
                  project_id: projectId,
                  held_at: form.get("held_at"),
                  topic: form.get("topic"),
                  presenter_name: form.get("presenter_name") || null,
                  attendee_count: attendees.length || (form.get("attendee_count") ? Number(form.get("attendee_count")) : null),
                  attendees,
                }
                if (!navigator.onLine) {
                  await saveOfflineDraft("toolbox_talk", payload, signInSheet ? [signInSheet] : [])
                  toast.success("Toolbox talk draft saved offline. Sign-in evidence must be reattached.")
                  onOpenChange(false)
                  return
                }
                let fileId: string | null = null
                if (signInSheet && signInSheet.size > 0) {
                  const upload = new FormData()
                  upload.append("file", signInSheet)
                  upload.append("projectId", projectId)
                  upload.append("category", "other")
                  upload.append("visibility", "private")
                  upload.append("folderPath", "/safety/toolbox-talks")
                  fileId = unwrapAction(await uploadFileAction(upload)).id
                }
                unwrapAction(await createToolboxTalkAction({ ...payload, file_id: fileId }))
                toast.success("Toolbox talk recorded")
                onOpenChange(false)
                router.refresh()
              })
            }}
          >
            <div className="min-h-0 flex-1 space-y-4 overflow-auto px-6 py-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Date held</Label>
                  <Input name="held_at" type="date" required disabled={pending} />
                </div>
                <div className="space-y-2">
                  <Label>Presenter</Label>
                  <Input name="presenter_name" placeholder="Presenter" disabled={pending} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Topic</Label>
                <Input name="topic" required placeholder="e.g. Ladder safety" disabled={pending} />
              </div>
              <div className="space-y-2">
                <Label>Attendees</Label>
                <Textarea name="attendees" rows={5} placeholder={"Attendees, one per line\nName | Company"} disabled={pending} />
              </div>
              <div className="space-y-2">
                <Label>Attendee count (if names unavailable)</Label>
                <Input name="attendee_count" type="number" min={0} placeholder="0" disabled={pending} />
              </div>
              <AttachmentField
                projectId={projectId}
                accept="image/*,.pdf"
                multiple={false}
                label="Signed attendance sheet"
                emptyHint="Drag and drop or click to add the signed sheet"
                pendingFiles={signInFiles}
                onPendingChange={setSignInFiles}
                disabled={pending}
              />
            </div>
            <div className="flex shrink-0 items-center gap-2 border-t bg-muted/30 p-4">
              <div className="flex-1" />
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
              <Button type="submit" disabled={pending}>{pending ? "Saving..." : "Record talk"}</Button>
            </div>
          </form>
        )}
      </SheetContent>
    </Sheet>
  )
}
