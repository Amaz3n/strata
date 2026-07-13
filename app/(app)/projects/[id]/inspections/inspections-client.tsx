"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { unwrapAction } from "@/lib/action-result"
import type { ChecklistTemplate, Inspection, InspectionDetail, InspectionItem } from "@/lib/services/inspections"
import type { CreateInspectionInput } from "@/lib/validation/inspections"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  completeInspectionAction,
  createInspectionAction,
  createObservationFromInspectionItemAction,
  createPunchFromInspectionItemAction,
  updateInspectionAction,
  updateInspectionItemAction,
} from "./actions"
import { InspectionForm } from "@/components/inspections/inspection-form"
import type { ProjectLocation } from "@/lib/services/locations"
import { Plus } from "@/components/icons"

const resultStyles: Record<string, string> = {
  pass: "bg-success/15 text-success border-success/30",
  fail: "bg-destructive/15 text-destructive border-destructive/30",
  partial: "bg-warning/15 text-warning border-warning/30",
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
  const [pending, startTransition] = useTransition()
  const [locationFilter, setLocationFilter] = useState("all")
  const [sheetOpen, setSheetOpen] = useState(Boolean(scheduleLink))
  const [isCreating, setIsCreating] = useState(false)

  const submit = (work: () => Promise<void>) =>
    startTransition(() => {
      void work().catch((error) => toast.error(error instanceof Error ? error.message : "Something went wrong"))
    })

  const filteredInspections = inspections.filter((inspection) => locationFilter === "all" || inspection.location_id === locationFilter)

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
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Select value={locationFilter} onValueChange={setLocationFilter}>
          <SelectTrigger className="w-full sm:w-56"><SelectValue placeholder="Location" /></SelectTrigger>
          <SelectContent><SelectItem value="all">All locations</SelectItem>{locations.map((location) => <SelectItem key={location.id} value={location.id}>{location.full_path}</SelectItem>)}</SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link href="/settings/checklists">Checklist library</Link>
          </Button>
          <Button onClick={() => setSheetOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New inspection
          </Button>
        </div>
      </div>

      <div className="border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">#</TableHead>
              <TableHead>Title</TableHead>
              <TableHead className="w-24">Type</TableHead>
              <TableHead className="w-32">Location</TableHead>
              <TableHead className="w-32">Inspector</TableHead>
              <TableHead className="w-28">Date</TableHead>
              <TableHead className="w-24 text-center">Deficient</TableHead>
              <TableHead className="w-28">Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredInspections.length ? (
              filteredInspections.map((inspection) => (
                <TableRow
                  key={inspection.id}
                  className="cursor-pointer"
                  onClick={() => router.push(`/projects/${projectId}/inspections?inspection=${inspection.id}`)}
                >
                  <TableCell className="font-mono text-xs">{inspection.inspection_number}</TableCell>
                  <TableCell className="font-medium">{inspection.title}</TableCell>
                  <TableCell className="capitalize text-muted-foreground">{inspection.kind}</TableCell>
                  <TableCell className="text-muted-foreground">{inspection.location ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{inspection.inspector_name ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {inspection.inspected_at ? new Date(inspection.inspected_at).toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell className="text-center tabular-nums">
                    {inspection.deficient_count ? inspection.deficient_count : "—"}
                  </TableCell>
                  <TableCell>
                    {inspection.result ? (
                      <Badge variant="outline" className={cn("uppercase", resultStyles[inspection.result])}>{inspection.result}</Badge>
                    ) : (
                      <Badge variant="outline" className="capitalize">{inspection.status.replace(/_/g, " ")}</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                  {inspections.length ? (
                    "No inspections match this location."
                  ) : (
                    <div className="flex flex-col items-center gap-2">
                      <span>No inspections yet.</span>
                      <Button variant="outline" size="sm" onClick={() => setSheetOpen(true)}>
                        <Plus className="mr-2 h-4 w-4" />
                        New inspection
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {selected ? (
        <InspectionRunPanel
          key={selected.id}
          projectId={projectId}
          inspection={selected}
          companies={companies}
          pending={pending}
          submit={submit}
        />
      ) : null}

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
    </div>
  )
}

function InspectionRunPanel({
  projectId,
  inspection,
  companies,
  pending,
  submit,
}: {
  projectId: string
  inspection: InspectionDetail
  companies: Array<{ id: string; name: string }>
  pending: boolean
  submit: (work: () => Promise<void>) => void
}) {
  const router = useRouter()
  const [items, setItems] = useState<InspectionItem[]>(inspection.items)
  const [notes, setNotes] = useState(inspection.notes ?? "")
  const readOnly = inspection.status === "completed"

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
    <section className="border">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b p-4">
        <div>
          <p className="font-mono text-xs text-muted-foreground">
            INSP-{inspection.inspection_number} · {inspection.kind.toUpperCase()}
          </p>
          <h2 className="text-lg font-semibold">{inspection.title}</h2>
          <p className="text-sm text-muted-foreground">
            {[inspection.location, inspection.inspector_name].filter(Boolean).join(" · ") || "—"}
            {deficientCount > 0 ? ` · ${deficientCount} deficient` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <a href={`/projects/${projectId}/exports/inspection?id=${inspection.id}`} target="_blank" rel="noreferrer">
              Export PDF
            </a>
          </Button>
          {!readOnly ? (
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
          ) : (
            <Badge variant="outline" className={cn("self-center uppercase", inspection.result ? resultStyles[inspection.result] : undefined)}>
              {inspection.result ?? "completed"}
            </Badge>
          )}
        </div>
      </div>

      <div className="divide-y">
        {Array.from(sections).map(([section, sectionItems]) => (
          <div key={section || "__none__"}>
            {section ? (
              <p className="bg-muted/40 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{section}</p>
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
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">This inspection has no checklist items.</p>
        ) : null}
      </div>

      <div className="border-t p-4">
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
    </section>
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
    <div className={cn("px-4 py-3", item.is_deficient && "bg-destructive/[0.04]")}>
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
        <div className="mt-2 flex flex-wrap items-center gap-2">
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
      ) : null}
    </div>
  )
}
