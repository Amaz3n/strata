"use client"

import { useMemo, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { unwrapAction } from "@/lib/action-result"
import type { ChecklistTemplate, Inspection, InspectionDetail, InspectionItem } from "@/lib/services/inspections"
import type { CreateInspectionInput } from "@/lib/validation/inspections"
import { useIsMobile } from "@/hooks/use-mobile"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import {
  Attachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
} from "@/components/ui/attachment"
import { cn } from "@/lib/utils"
import {
  completeInspectionAction,
  createInspectionAction,
  createObservationFromInspectionItemAction,
  createPunchFromInspectionItemAction,
  updateInspectionAction,
  updateInspectionItemAction,
} from "./actions"
import { uploadFileAction } from "@/app/(app)/documents/actions"
import { InspectionForm } from "@/components/inspections/inspection-form"
import type { ProjectLocation } from "@/lib/services/locations"
import { Plus, Search, ClipboardCheck, Upload, X, Eye, Loader2 } from "@/components/icons"

const resultStyles: Record<string, string> = {
  pass: "bg-success/15 text-success border-success/30",
  fail: "bg-destructive/15 text-destructive border-destructive/30",
  partial: "bg-warning/15 text-warning border-warning/30",
}

const statusStyles: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  in_progress: "bg-warning/20 text-warning border-warning/40",
  completed: "bg-success/15 text-success border-success/30",
}

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  in_progress: "In progress",
  completed: "Completed",
}

function resultDot(inspection: Inspection): string {
  if (inspection.result === "pass") return "bg-success"
  if (inspection.result === "fail") return "bg-destructive"
  if (inspection.result === "partial") return "bg-warning"
  if (inspection.status === "in_progress") return "bg-warning"
  return "bg-muted-foreground/40"
}

function ResultBadge({ inspection }: { inspection: Inspection }) {
  if (inspection.result) {
    return <Badge variant="outline" className={cn("text-[10px] font-normal uppercase", resultStyles[inspection.result])}>{inspection.result}</Badge>
  }
  return <Badge variant="outline" className={cn("text-[10px] font-normal", statusStyles[inspection.status])}>{STATUS_LABELS[inspection.status] ?? inspection.status.replace(/_/g, " ")}</Badge>
}

export function InspectionsClient({
  projectId,
  inspections,
  templates,
  selected,
  companies,
  locations,
  canManageLocations,
  scheduleLink,
}: {
  projectId: string
  inspections: Inspection[]
  templates: ChecklistTemplate[]
  selected?: InspectionDetail | null
  companies: Array<{ id: string; name: string }>
  locations: ProjectLocation[]
  canManageLocations: boolean
  scheduleLink?: { id: string; title: string } | null
}) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const [isCreating, setIsCreating] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(Boolean(scheduleLink))
  const [search, setSearch] = useState("")
  const [kindFilter, setKindFilter] = useState<"all" | "safety" | "quality">("all")
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "completed">("all")
  const [locationFilter, setLocationFilter] = useState("all")

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return inspections.filter((inspection) => {
      if (kindFilter !== "all" && inspection.kind !== kindFilter) return false
      if (statusFilter === "completed" && inspection.status !== "completed") return false
      if (statusFilter === "open" && inspection.status === "completed") return false
      if (locationFilter !== "all" && inspection.location_id !== locationFilter) return false
      if (term.length === 0) return true
      return [String(inspection.inspection_number), inspection.title, inspection.inspector_name ?? "", inspection.location ?? ""].some((value) =>
        value.toLowerCase().includes(term),
      )
    })
  }, [inspections, search, kindFilter, statusFilter, locationFilter])

  const openInspection = (id: string) => router.push(`/projects/${projectId}/inspections?inspection=${id}`)
  const closeInspection = () => router.push(`/projects/${projectId}/inspections`)

  const handleCreate = async (payload: CreateInspectionInput) => {
    setIsCreating(true)
    try {
      const inspection = unwrapAction(await createInspectionAction(payload))
      setSheetOpen(false)
      toast.success("Inspection started")
      router.push(`/projects/${projectId}/inspections?inspection=${inspection.id}`)
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong")
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <>
      <InspectionForm
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        projectId={projectId}
        templates={templates}
        locations={locations}
        canManageLocations={canManageLocations}
        scheduleLink={scheduleLink}
        isSubmitting={isCreating}
        onSubmit={handleCreate}
      />

      {selected ? (
        <InspectionDetailSheet
          key={selected.id}
          projectId={projectId}
          inspection={selected}
          companies={companies}
          open
          onOpenChange={(open) => { if (!open) closeInspection() }}
        />
      ) : null}

      <div className="-mx-4 -mb-4 -mt-6 flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden bg-background">
        {isMobile ? (
          <div className="sticky top-0 z-20 shrink-0 border-b bg-background/95 backdrop-blur-sm">
            <div className="flex items-center gap-2 px-3 pt-3">
              <Input placeholder="Search inspections..." className="h-10 text-sm" value={search} onChange={(event) => setSearch(event.target.value)} inputMode="search" />
              <Button size="icon" className="h-10 w-10 shrink-0" onClick={() => setSheetOpen(true)} aria-label="New inspection"><Plus className="h-4 w-4" /></Button>
            </div>
            <div className="flex gap-1.5 overflow-x-auto px-3 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {(["all", "safety", "quality"] as const).map((key) => {
                const active = kindFilter === key
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setKindFilter(key)}
                    className={cn(
                      "shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                      active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground active:bg-muted",
                    )}
                  >
                    {key === "all" ? "All" : key}
                  </button>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="sticky top-0 z-20 flex shrink-0 flex-col gap-3 border-b bg-background px-4 py-3 sm:min-h-14 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input placeholder="Search inspections..." className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} />
              </div>
              <Select value={kindFilter} onValueChange={(value) => setKindFilter(value as "all" | "safety" | "quality")}>
                <SelectTrigger className="w-full sm:w-32"><SelectValue placeholder="Type" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="safety">Safety</SelectItem>
                  <SelectItem value="quality">Quality</SelectItem>
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as "all" | "open" | "completed")}>
                <SelectTrigger className="w-full sm:w-36"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                </SelectContent>
              </Select>
              <Select value={locationFilter} onValueChange={setLocationFilter}>
                <SelectTrigger className="w-full sm:w-44"><SelectValue placeholder="Location" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All locations</SelectItem>
                  {locations.map((location) => <SelectItem key={location.id} value={location.id}>{location.full_path}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex w-full gap-2 sm:w-auto">
              <Button variant="outline" asChild className="w-full sm:w-auto">
                <Link href="/settings/checklists">Checklist library</Link>
              </Button>
              <Button onClick={() => setSheetOpen(true)} className="w-full sm:w-auto">
                <Plus className="mr-2 h-4 w-4" />
                New inspection
              </Button>
            </div>
          </div>
        )}

        {isMobile ? (
          <div className="min-h-0 flex-1 overflow-auto">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
                  <ClipboardCheck className="h-6 w-6 text-muted-foreground" />
                </div>
                <div>
                  <p className="font-medium">{inspections.length ? "Nothing matches" : "No inspections yet"}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{inspections.length ? "Try a different filter." : "Start your first inspection."}</p>
                </div>
                {inspections.length ? null : <Button className="mt-1" onClick={() => setSheetOpen(true)}><Plus className="mr-2 h-4 w-4" />New inspection</Button>}
              </div>
            ) : (
              <ul className="divide-y">
                {filtered.map((inspection) => (
                  <li key={inspection.id} className="flex items-stretch">
                    <button type="button" onClick={() => openInspection(inspection.id)} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left active:bg-muted/60">
                      <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", resultDot(inspection))} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium leading-tight">{inspection.title}</p>
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {[`INSP-${inspection.inspection_number}`, inspection.kind, inspection.location, inspection.deficient_count ? `${inspection.deficient_count} deficient` : null].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                      <ResultBadge inspection={inspection} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-[72px]">Ref</TableHead>
                  <TableHead className="min-w-[260px]">Title</TableHead>
                  <TableHead className="hidden sm:table-cell w-[96px]">Type</TableHead>
                  <TableHead className="hidden lg:table-cell w-[160px]">Location</TableHead>
                  <TableHead className="hidden xl:table-cell w-[150px]">Inspector</TableHead>
                  <TableHead className="hidden md:table-cell w-[110px]">Date</TableHead>
                  <TableHead className="hidden sm:table-cell w-[96px] text-center">Deficient</TableHead>
                  <TableHead className="w-[130px]">Result</TableHead>
                </TableRow>
              </TableHeader>
              {filtered.length ? (
                <TableBody>
                  {filtered.map((inspection) => (
                    <TableRow key={inspection.id} className="group h-[60px] cursor-pointer hover:bg-muted/30" onClick={() => openInspection(inspection.id)}>
                      <TableCell className="font-mono text-xs text-muted-foreground">{inspection.inspection_number}</TableCell>
                      <TableCell className="max-w-0"><span className="block truncate text-sm font-medium">{inspection.title}</span></TableCell>
                      <TableCell className="hidden sm:table-cell capitalize text-sm text-muted-foreground">{inspection.kind}</TableCell>
                      <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">{inspection.location ?? "—"}</TableCell>
                      <TableCell className="hidden xl:table-cell text-sm text-muted-foreground">{inspection.inspector_name ?? "—"}</TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-muted-foreground">{inspection.inspected_at ? new Date(inspection.inspected_at).toLocaleDateString() : "—"}</TableCell>
                      <TableCell className="hidden sm:table-cell text-center text-sm tabular-nums">
                        {inspection.deficient_count ? <span className="text-destructive">{inspection.deficient_count}</span> : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-2">
                          <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", resultDot(inspection))} />
                          <ResultBadge inspection={inspection} />
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              ) : null}
            </Table>
            {filtered.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                  <ClipboardCheck className="h-6 w-6 text-muted-foreground" />
                </div>
                <div className="max-w-[420px]">
                  <p className="font-medium text-foreground">{inspections.length ? "Nothing matches your filters" : "No inspections yet"}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {inspections.length ? "Try a different search, type, status, or location." : "Run a safety or quality checklist to start documenting inspections."}
                  </p>
                </div>
                {inspections.length ? null : (
                  <Button size="sm" className="mt-1" onClick={() => setSheetOpen(true)}><Plus className="mr-2 h-4 w-4" />New inspection</Button>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </>
  )
}

function InspectionDetailSheet({
  projectId,
  inspection,
  companies,
  open,
  onOpenChange,
}: {
  projectId: string
  inspection: InspectionDetail
  companies: Array<{ id: string; name: string }>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [items, setItems] = useState<InspectionItem[]>(inspection.items)
  const [notes, setNotes] = useState(inspection.notes ?? "")
  const readOnly = inspection.status === "completed"

  const submit = (work: () => Promise<void>) =>
    startTransition(() => {
      void work().catch((error) => toast.error(error instanceof Error ? error.message : "Something went wrong"))
    })

  const patchItem = (itemId: string, patch: Record<string, unknown>) => {
    submit(async () => {
      const updated = unwrapAction(await updateInspectionItemAction(itemId, patch))
      setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
    })
  }

  const sections = new Map<string, InspectionItem[]>()
  for (const item of items) {
    const key = item.section ?? ""
    const list = sections.get(key) ?? []
    list.push(item)
    sections.set(key, list)
  }

  const deficientCount = items.filter((item) => item.is_deficient).length

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="flex flex-col p-0 shadow-2xl fast-sheet-animation sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-2xl"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
      >
        <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6">
          <div className="flex flex-wrap items-center gap-2">
            <ClipboardCheck className="h-5 w-5 text-primary" />
            <SheetTitle>INSP-{inspection.inspection_number}</SheetTitle>
            <a href={`/projects/${projectId}/exports/inspection?id=${inspection.id}`} target="_blank" rel="noreferrer" className="ml-1">
              <Button variant="ghost" size="sm" type="button">PDF</Button>
            </a>
            <Badge variant="outline" className="text-[10px] font-normal capitalize">{inspection.kind}</Badge>
            <ResultBadge inspection={inspection} />
          </div>
          <SheetDescription className="text-left">
            {inspection.title}
            {[inspection.location, inspection.inspector_name].filter(Boolean).length > 0 ? ` · ${[inspection.location, inspection.inspector_name].filter(Boolean).join(" · ")}` : ""}
            {deficientCount > 0 ? ` · ${deficientCount} deficient` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-auto">
          <div className="divide-y">
            {Array.from(sections).map(([section, sectionItems]) => (
              <div key={section || "__none__"}>
                {section ? (
                  <p className="bg-muted/40 px-6 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{section}</p>
                ) : null}
                {sectionItems.map((item) => (
                  <InspectionItemRow
                    key={item.id}
                    projectId={projectId}
                    item={item}
                    companies={companies}
                    readOnly={readOnly}
                    pending={pending}
                    onPatch={patchItem}
                    submit={submit}
                    onItemUpdated={(updated) => setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))}
                  />
                ))}
              </div>
            ))}
            {items.length === 0 ? (
              <p className="px-6 py-10 text-center text-sm text-muted-foreground">This inspection has no checklist items.</p>
            ) : null}
          </div>

          <div className="border-t p-6">
            <Textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Inspection notes..."
              rows={3}
              disabled={readOnly || pending}
              onBlur={() => {
                if (readOnly || notes === (inspection.notes ?? "")) return
                submit(async () => {
                  unwrapAction(await updateInspectionAction(projectId, inspection.id, { notes: notes || null }))
                })
              }}
            />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t bg-muted/30 p-4">
          <span className="text-sm text-muted-foreground">
            {deficientCount > 0 ? `${deficientCount} deficient item${deficientCount === 1 ? "" : "s"}` : "No deficiencies"}
          </span>
          <div className="flex-1" />
          {readOnly ? (
            <Badge variant="outline" className={cn("uppercase", inspection.result ? resultStyles[inspection.result] : undefined)}>
              {inspection.result ?? "completed"}
            </Badge>
          ) : (
            <Button
              disabled={pending}
              onClick={() =>
                submit(async () => {
                  if (notes !== (inspection.notes ?? "")) {
                    unwrapAction(await updateInspectionAction(projectId, inspection.id, { notes: notes || null }))
                  }
                  const completed = unwrapAction(await completeInspectionAction(projectId, inspection.id))
                  toast.success(`Inspection completed — ${completed.result?.toUpperCase()}`)
                  router.refresh()
                })
              }
            >
              Complete inspection
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function InspectionItemRow({
  projectId,
  item,
  companies,
  readOnly,
  pending,
  onPatch,
  submit,
  onItemUpdated,
}: {
  projectId: string
  item: InspectionItem
  companies: Array<{ id: string; name: string }>
  readOnly: boolean
  pending: boolean
  onPatch: (itemId: string, patch: Record<string, unknown>) => void
  submit: (work: () => Promise<void>) => void
  onItemUpdated: (item: InspectionItem) => void
}) {
  const [note, setNote] = useState(item.note ?? "")
  const [actionCompany, setActionCompany] = useState<string>("__none__")

  const responseButtons: Array<{ value: string; label: string; activeClass: string }> =
    item.response_type === "yes_no"
      ? [
          { value: "yes", label: "Yes", activeClass: "bg-success/15 text-success border-success/40" },
          { value: "no", label: "No", activeClass: "bg-destructive/15 text-destructive border-destructive/40" },
          { value: "n/a", label: "N/A", activeClass: "bg-muted text-muted-foreground border-border" },
        ]
      : [
          { value: "pass", label: "Pass", activeClass: "bg-success/15 text-success border-success/40" },
          { value: "fail", label: "Fail", activeClass: "bg-destructive/15 text-destructive border-destructive/40" },
          { value: "n/a", label: "N/A", activeClass: "bg-muted text-muted-foreground border-border" },
        ]

  const isFreeform = item.response_type === "text" || item.response_type === "number"

  return (
    <div className={cn("px-6 py-3", item.is_deficient && "bg-destructive/[0.04]")}>
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm">{item.prompt}</p>
        {isFreeform ? (
          <Input
            className="h-9 w-44"
            type={item.response_type === "number" ? "number" : "text"}
            defaultValue={item.response ?? ""}
            disabled={readOnly}
            onBlur={(event) => {
              const value = event.target.value.trim()
              if (value === (item.response ?? "")) return
              onPatch(item.id, { response: value || null })
            }}
          />
        ) : (
          <div className="flex gap-1.5">
            {responseButtons.map((button) => (
              <button
                key={button.value}
                type="button"
                disabled={readOnly || pending}
                onClick={() => onPatch(item.id, { response: item.response === button.value ? null : button.value })}
                className={cn(
                  "h-9 min-w-14 border px-3 text-xs font-medium transition-colors",
                  item.response === button.value ? button.activeClass : "border-border bg-background text-muted-foreground hover:bg-muted",
                )}
              >
                {button.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {item.is_deficient ? (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 w-full max-w-md text-xs"
              value={note}
              placeholder="Deficiency note..."
              disabled={readOnly}
              onChange={(event) => setNote(event.target.value)}
              onBlur={() => {
                if (note === (item.note ?? "")) return
                onPatch(item.id, { note: note || null })
              }}
            />
            {item.punch_item_id ? (
              <Badge variant="outline" className="text-[10px]">Punch item created</Badge>
            ) : null}
            {item.observation_id ? (
              <Badge variant="outline" className="text-[10px]">Observation created</Badge>
            ) : null}
            {!item.punch_item_id || !item.observation_id ? (
              <div className="flex items-center gap-1.5">
                <Select value={actionCompany} onValueChange={setActionCompany}>
                  <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No company</SelectItem>
                    {companies.map((company) => (
                      <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!item.punch_item_id ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={pending}
                    onClick={() =>
                      submit(async () => {
                        const updated = unwrapAction(
                          await createPunchFromInspectionItemAction(projectId, item.id, {
                            company_id: actionCompany === "__none__" ? null : actionCompany,
                          }),
                        )
                        onItemUpdated(updated)
                        toast.success("Punch item created")
                      })
                    }
                  >
                    Create punch item
                  </Button>
                ) : null}
                {!item.observation_id ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={pending}
                    onClick={() =>
                      submit(async () => {
                        const updated = unwrapAction(
                          await createObservationFromInspectionItemAction(projectId, item.id, {
                            company_id: actionCompany === "__none__" ? null : actionCompany,
                          }),
                        )
                        onItemUpdated(updated)
                        toast.success("Observation created")
                      })
                    }
                  >
                    Create observation
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <ItemDeficiencyPhoto projectId={projectId} item={item} readOnly={readOnly} onPatch={onPatch} />
        </div>
      ) : null}
    </div>
  )
}

function ItemDeficiencyPhoto({
  projectId,
  item,
  readOnly,
  onPatch,
}: {
  projectId: string
  item: InspectionItem
  readOnly: boolean
  onPatch: (itemId: string, patch: Record<string, unknown>) => void
}) {
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const upload = async (file: File) => {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append("file", file)
      fd.append("projectId", projectId)
      fd.append("category", "photos")
      fd.append("visibility", "private")
      fd.append("folderPath", "/inspections")
      const uploaded = unwrapAction(await uploadFileAction(fd))
      onPatch(item.id, { photo_file_id: uploaded.id })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to upload photo")
    } finally {
      setUploading(false)
    }
  }

  if (uploading) {
    return (
      <Attachment state="uploading" className="w-full max-w-md">
        <AttachmentMedia variant="icon">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>Uploading…</AttachmentTitle>
          <AttachmentDescription>Attaching deficiency photo</AttachmentDescription>
        </AttachmentContent>
      </Attachment>
    )
  }

  if (item.photo_file_id) {
    return (
      <Attachment state="done" className="w-full max-w-md">
        <AttachmentMedia variant="image">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/files/${item.photo_file_id}/raw`} alt="Deficiency photo" />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>Deficiency photo</AttachmentTitle>
          <AttachmentDescription>Tap to view full size</AttachmentDescription>
        </AttachmentContent>
        <AttachmentActions className="pr-1.5">
          <AttachmentAction asChild aria-label="View deficiency photo">
            <a href={`/api/files/${item.photo_file_id}/raw`} target="_blank" rel="noreferrer">
              <Eye className="h-4 w-4" />
            </a>
          </AttachmentAction>
          {readOnly ? null : (
            <AttachmentAction onClick={() => onPatch(item.id, { photo_file_id: null })} aria-label="Remove deficiency photo">
              <X className="h-4 w-4" />
            </AttachmentAction>
          )}
        </AttachmentActions>
      </Attachment>
    )
  }

  if (readOnly) return null

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ""
          if (file) void upload(file)
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="flex w-full max-w-md items-center justify-center gap-2 border border-dashed bg-card px-3 py-3 text-xs text-muted-foreground transition-colors hover:bg-muted/50"
      >
        <Upload className="h-4 w-4" />
        Add deficiency photo
      </button>
    </>
  )
}
