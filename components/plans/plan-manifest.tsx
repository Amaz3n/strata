"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { FileText, Save, Upload } from "@/components/icons"
import { uploadFileAction } from "@/app/(app)/documents/actions"
import { updatePlanVersionAction } from "@/app/(app)/plans/actions"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { unwrapAction } from "@/lib/action-result"
import type { BudgetTemplateDto } from "@/lib/services/budget-templates"
import type { ChecklistTemplate } from "@/lib/services/inspections"
import type { HousePlanDto, HousePlanVersionDto, SelectionTemplateCategoryDto } from "@/lib/services/house-plans"
import type { ScheduleTemplate } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The recipe, read as a list of consequences rather than a set of dropdowns:
 * every row is something that will exist inside a real house the moment a lot is
 * released on this edition. Changing one is a side effect of reading it.
 */
export function PlanManifest({
  plan,
  version,
  budgetTemplates,
  scheduleTemplates,
  checklistTemplates,
  selectionCategories,
  editable,
}: {
  plan: HousePlanDto
  version: HousePlanVersionDto
  budgetTemplates: BudgetTemplateDto[]
  scheduleTemplates: ScheduleTemplate[]
  checklistTemplates: ChecklistTemplate[]
  selectionCategories: SelectionTemplateCategoryDto[]
  editable: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [label, setLabel] = useState(version.label ?? "")
  const [notes, setNotes] = useState(version.notes ?? "")
  const [budget, setBudget] = useState(version.budget_template_id ?? "none")
  const [schedule, setSchedule] = useState(version.schedule_template_id ?? "none")
  const [drawing, setDrawing] = useState(version.drawing_source_file_id ?? "")
  const [drawingName, setDrawingName] = useState<string | null>(null)
  const [checks, setChecks] = useState<string[]>(version.checklist_template_ids)
  const [selections, setSelections] = useState<string[]>(version.selection_category_ids)

  const scheduleTemplate = scheduleTemplates.find((template) => template.id === version.schedule_template_id) ?? null
  const budgetTemplate = budgetTemplates.find((template) => template.id === version.budget_template_id) ?? null
  const checklistNames = checklistTemplates
    .filter((template) => version.checklist_template_ids.includes(template.id))
    .map((template) => template.name)
  const selectionNames = selectionCategories
    .filter((category) => version.selection_category_ids.includes(category.id))
    .map((category) => category.name)

  function save() {
    startTransition(async () => {
      try {
        unwrapAction(
          await updatePlanVersionAction(plan.id, version.id, {
            label: label.trim() || null,
            notes: notes.trim() || null,
            budgetTemplateId: budget === "none" ? null : budget,
            scheduleTemplateId: schedule === "none" ? null : schedule,
            drawingSourceFileId: drawing || null,
            checklistTemplateIds: checks,
            selectionCategoryIds: selections,
          }),
        )
        toast.success("Recipe saved")
        setOpen(false)
        router.refresh()
      } catch (error) {
        toast.error("Unable to save the recipe", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function uploadPlanSet(file: File | undefined) {
    if (!file) return
    if (file.type !== "application/pdf") {
      toast.error("Choose a PDF plan set")
      return
    }
    startTransition(async () => {
      try {
        const formData = new FormData()
        formData.set("file", file)
        formData.set("category", "plans")
        formData.set("visibility", "private")
        const uploaded = unwrapAction(await uploadFileAction(formData))
        setDrawing(uploaded.id)
        setDrawingName(file.name)
        toast.success("Plan set uploaded — save the recipe to attach it")
      } catch (error) {
        toast.error("Plan-set upload failed", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  const snapshot = version.status === "draft" ? null : version.bundle_snapshot
  const snapshotChecklists = Array.isArray(snapshot?.checklists) ? (snapshot?.checklists as unknown[]) : []
  const snapshotSelections = Array.isArray(snapshot?.selection_categories)
    ? (snapshot?.selection_categories as unknown[])
    : []
  const snapshotSchedule =
    snapshot && typeof snapshot.schedule_template === "object" && snapshot.schedule_template
      ? (snapshot.schedule_template as Record<string, unknown>)
      : null
  const snapshotScheduleItems = snapshotSchedule && Array.isArray(snapshotSchedule.items) ? snapshotSchedule.items.length : 0

  return (
    <section id="plan-recipe" className="scroll-mt-10 border-b">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Start recipe</h3>
          <p className="truncate text-[11px] text-muted-foreground">
            {version.takeoff_line_count > 0 || version.budget_template_id ? "Budget ready" : "Budget missing"}
            {" · "}
            {version.schedule_template_id ? "Schedule ready" : "Schedule missing"}
            {" · "}
            {version.drawing_source_file_id ? "Plan set attached" : "No plan set"}
            {" · "}
            {version.checklist_template_ids.length} checklists
            {" · "}
            {version.selection_category_ids.length} selection categories
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 rounded-none px-2 text-[11px]"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Hide recipe" : "View recipe"}
          </Button>
          {editable && expanded ? (
            <Button size="sm" variant="ghost" className="h-7 rounded-none px-2 text-[11px]" onClick={() => setOpen(true)}>
              Edit
            </Button>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <>
          <dl className="divide-y border-t">
            <ManifestRow
              title={
                version.budget_template_id
                  ? `Budget — ${budgetTemplate?.name ?? "template"}`
                  : "Budget — generated from the takeoff"
              }
              detail={
                version.budget_template_id
                  ? `${budgetTemplate?.line_count ?? 0} template lines`
                  : `${version.takeoff_line_count} takeoff line${version.takeoff_line_count === 1 ? "" : "s"}, priced by the price book at release`
              }
              missing={version.takeoff_line_count === 0 && !version.budget_template_id}
              missingLabel="No cost basis — a released house would start with an empty budget"
            />
            <ManifestRow
              title={
                snapshot
                  ? `Schedule — ${typeof snapshotSchedule?.name === "string" ? snapshotSchedule.name : "captured at release"}`
                  : scheduleTemplate
                    ? `Schedule — ${scheduleTemplate.name}`
                    : "Schedule"
              }
              detail={
                snapshot
                  ? `${snapshotScheduleItems} items`
                  : scheduleTemplate
                    ? `${scheduleTemplate.items.length} items, offset from the start date`
                    : ""
              }
              missing={!version.schedule_template_id}
              missingLabel="Required — without it a released house starts with an empty calendar"
            />
            <ManifestRow
              title="Plan set"
              detail={
                version.drawing_source_file_id
                  ? "Versioned onto the house's canonical drawing set at start"
                  : "Houses started from this edition begin without drawings"
              }
              action={
                version.drawing_source_file_id ? (
                  <a
                    href={`/api/files/${version.drawing_source_file_id}/raw`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-[11px] text-primary hover:underline"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    Open
                  </a>
                ) : null
              }
            />
            <ManifestRow
              title={`Field checklists — ${snapshot ? snapshotChecklists.length : version.checklist_template_ids.length}`}
              detail={checklistNames.length > 0 ? checklistNames.join(" · ") : "None attached"}
            />
            <ManifestRow
              title={`Selection sheet — ${snapshot ? snapshotSelections.length : version.selection_category_ids.length} categor${(snapshot ? snapshotSelections.length : version.selection_category_ids.length) === 1 ? "y" : "ies"}`}
              detail={
                selectionNames.length > 0
                  ? selectionNames.join(" · ")
                  : "Buyers on this edition start with no selection sheet"
              }
            />
          </dl>

          {version.notes ? <p className="border-t px-4 py-2 text-[11px] text-muted-foreground">{version.notes}</p> : null}
        </>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto rounded-none sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>What v{version.version_number} generates</DialogTitle>
            <DialogDescription>
              Everything picked here is copied into a real house the moment a lot starts on this edition, and frozen when
              it is released.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label className="text-xs">
                  Edition label <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  className="h-8 rounded-none text-xs"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="2027 repricing"
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">
                  Notes <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  className="h-8 rounded-none text-xs"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="What changed in this edition"
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Budget</Label>
                <Select value={budget} onValueChange={setBudget}>
                  <SelectTrigger className="h-8 rounded-none text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Generated from the takeoff</SelectItem>
                    {budgetTemplates.map((template) => (
                      <SelectItem key={template.id} value={template.id}>
                        {template.name} · {template.line_count} lines
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Schedule template</Label>
                <Select value={schedule} onValueChange={setSchedule}>
                  <SelectTrigger className="h-8 rounded-none text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {scheduleTemplates.map((template) => (
                      <SelectItem key={template.id} value={template.id}>
                        {template.name} · {template.items.length} items
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="plan-set" className="flex cursor-pointer items-center gap-1.5 text-xs">
                <Upload className="h-3.5 w-3.5" />
                Plan-set PDF
              </Label>
              <Input
                id="plan-set"
                type="file"
                accept="application/pdf"
                disabled={pending}
                className="rounded-none text-xs"
                onChange={(event) => uploadPlanSet(event.target.files?.[0])}
              />
              <p className="text-[11px] text-muted-foreground">
                {drawing
                  ? drawingName
                    ? `Uploaded: ${drawingName} — save to attach it`
                    : "Attached. Instantiation seeds it into each lot's canonical drawing set."
                  : "No plan set attached."}
              </p>
            </div>

            <div className="grid gap-2">
              <Label className="text-xs">Checklists</Label>
              {checklistTemplates.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">No checklist templates exist yet.</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {checklistTemplates.map((template) => (
                    <label key={template.id} className="flex items-center gap-2 border p-2 text-xs">
                      <Checkbox
                        checked={checks.includes(template.id)}
                        onCheckedChange={(checked) =>
                          setChecks((current) =>
                            checked ? [...current, template.id] : current.filter((id) => id !== template.id),
                          )
                        }
                      />
                      <span className="truncate">
                        {template.name} · {template.item_count}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-2">
              <Label className="text-xs">Selection categories</Label>
              {selectionCategories.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  No selection template categories exist yet. They seed the buyer&apos;s design-studio selections at start.
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {selectionCategories.map((category) => (
                    <label key={category.id} className="flex items-center gap-2 border p-2 text-xs">
                      <Checkbox
                        checked={selections.includes(category.id)}
                        onCheckedChange={(checked) =>
                          setSelections((current) =>
                            checked ? [...current, category.id] : current.filter((id) => id !== category.id),
                          )
                        }
                      />
                      <span className="truncate">{category.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" className="rounded-none" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button className="rounded-none" onClick={save} disabled={pending}>
              <Save className="mr-1.5 h-4 w-4" />
              {pending ? "Saving…" : "Save recipe"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function ManifestRow({
  title,
  detail,
  missing,
  missingLabel,
  action,
}: {
  title: string
  detail: string
  missing?: boolean
  missingLabel?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-2.5">
      <div className="min-w-0">
        <dt className={cn("text-xs", missing && "text-destructive")}>{title}</dt>
        <dd className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {missing && missingLabel ? <span className="text-destructive">{missingLabel}</span> : detail}
        </dd>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
