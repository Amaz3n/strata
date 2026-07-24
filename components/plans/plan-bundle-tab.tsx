"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { CheckCircle2, Circle, Save } from "@/components/icons"
import { uploadFileAction } from "@/app/(app)/documents/actions"
import { updatePlanVersionAction } from "@/app/(app)/plans/actions"
import type { ReleaseGate } from "@/components/plans/plan-detail-client"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { unwrapAction } from "@/lib/action-result"
import type { BudgetTemplateDto } from "@/lib/services/budget-templates"
import type { ChecklistTemplate } from "@/lib/services/inspections"
import type { HousePlanDto, HousePlanVersionDto, SelectionTemplateCategoryDto } from "@/lib/services/house-plans"
import type { ScheduleTemplate } from "@/lib/types"
import { cn } from "@/lib/utils"

function BundleSnapshotSummary({ snapshot }: { snapshot: Record<string, unknown> | null }) {
  if (!snapshot) return <p className="text-xs text-muted-foreground">No release snapshot is available.</p>
  const budget = typeof snapshot.budget_template === "object" && snapshot.budget_template ? (snapshot.budget_template as Record<string, unknown>) : null
  const schedule = typeof snapshot.schedule_template === "object" && snapshot.schedule_template ? (snapshot.schedule_template as Record<string, unknown>) : null
  const checklists = Array.isArray(snapshot.checklists) ? snapshot.checklists : []
  const selections = Array.isArray(snapshot.selection_categories) ? snapshot.selection_categories : []
  const budgetLines = budget && Array.isArray(budget.lines) ? budget.lines.length : 0
  const scheduleItems = schedule && Array.isArray(schedule.items) ? schedule.items.length : 0
  return (
    <div className="grid gap-3 border p-4 text-xs sm:grid-cols-2">
      <div>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Budget</p>
        <p className="mt-1">{String(budget?.name ?? "None")}{budget ? ` · ${budgetLines} lines` : ""}</p>
      </div>
      <div>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Schedule</p>
        <p className="mt-1">{String(schedule?.name ?? "None")}{schedule ? ` · ${scheduleItems} items` : ""}</p>
      </div>
      <div>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Checklists</p>
        <p className="mt-1">{checklists.length} captured</p>
      </div>
      <div>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Selection categories</p>
        <p className="mt-1">{selections.length} captured</p>
      </div>
      <div>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Plan set</p>
        <p className="mt-1">{snapshot.drawing_source_file_id ? "PDF captured" : "None"}</p>
      </div>
      <div>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Captured</p>
        <p className="mt-1">{typeof snapshot.captured_at === "string" ? new Date(snapshot.captured_at).toLocaleString() : "At release"}</p>
      </div>
    </div>
  )
}

export function PlanBundleTab({
  plan,
  version,
  budgetTemplates,
  scheduleTemplates,
  checklistTemplates,
  selectionCategories,
  editable,
  gates,
}: {
  plan: HousePlanDto
  version: HousePlanVersionDto
  budgetTemplates: BudgetTemplateDto[]
  scheduleTemplates: ScheduleTemplate[]
  checklistTemplates: ChecklistTemplate[]
  selectionCategories: SelectionTemplateCategoryDto[]
  editable: boolean
  gates: ReleaseGate[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [label, setLabel] = useState(version.label ?? "")
  const [notes, setNotes] = useState(version.notes ?? "")
  const [budget, setBudget] = useState(version.budget_template_id ?? "none")
  const [schedule, setSchedule] = useState(version.schedule_template_id ?? "none")
  const [drawing, setDrawing] = useState(version.drawing_source_file_id ?? "")
  const [drawingName, setDrawingName] = useState<string | null>(null)
  const [checks, setChecks] = useState<string[]>(version.checklist_template_ids)
  const [selections, setSelections] = useState<string[]>(version.selection_category_ids)

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
        toast.success("Bundle saved")
        router.refresh()
      } catch (error) {
        toast.error("Unable to save bundle", { description: error instanceof Error ? error.message : undefined })
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
        toast.success("Plan-set PDF uploaded — save the bundle to attach it")
      } catch (error) {
        toast.error("Plan-set upload failed", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <div className="space-y-4">
        {editable ? (
          <div className="grid gap-4 border p-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label className="text-xs">Version label <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input className="h-8 rounded-none text-xs" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="2027 repricing" />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">Notes <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input className="h-8 rounded-none text-xs" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="What changed in this version" />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">Budget template</Label>
              <Select value={budget} onValueChange={setBudget}>
                <SelectTrigger className="h-8 rounded-none text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None — takeoff prices the budget</SelectItem>
                  {budgetTemplates.map((template) => (
                    <SelectItem key={template.id} value={template.id}>{template.name} · {template.line_count} lines</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">Schedule template</Label>
              <Select value={schedule} onValueChange={setSchedule}>
                <SelectTrigger className="h-8 rounded-none text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {scheduleTemplates.map((template) => (
                    <SelectItem key={template.id} value={template.id}>{template.name} · {template.items.length} items</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label className="text-xs">Plan-set PDF</Label>
              <Input type="file" accept="application/pdf" disabled={pending} className="rounded-none text-xs" onChange={(event) => uploadPlanSet(event.target.files?.[0])} />
              <p className="text-[11px] text-muted-foreground">
                {drawing
                  ? drawingName
                    ? `Uploaded: ${drawingName} (save the bundle to attach)`
                    : "A plan-set PDF is attached. Instantiation seeds it into each lot's canonical drawing set."
                  : "No plan set attached. Starts generated from this version will begin without drawings."}
              </p>
            </div>
            <div className="grid gap-2 sm:col-span-2">
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
                          setChecks((current) => (checked ? [...current, template.id] : current.filter((id) => id !== template.id)))
                        }
                      />
                      {template.name} · {template.item_count}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label className="text-xs">Selection categories</Label>
              {selectionCategories.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">No selection template categories exist yet. They seed the buyer's design-studio selections at start.</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {selectionCategories.map((category) => (
                    <label key={category.id} className="flex items-center gap-2 border p-2 text-xs">
                      <Checkbox
                        checked={selections.includes(category.id)}
                        onCheckedChange={(checked) =>
                          setSelections((current) => (checked ? [...current, category.id] : current.filter((id) => id !== category.id)))
                        }
                      />
                      {category.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="sm:col-span-2">
              <Button size="sm" className="rounded-none" onClick={save} disabled={pending}>
                <Save className="mr-1.5 h-4 w-4" />
                {pending ? "Saving…" : "Save bundle"}
              </Button>
            </div>
          </div>
        ) : (
          <BundleSnapshotSummary snapshot={version.bundle_snapshot} />
        )}
      </div>
      <div className="border p-4">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Release readiness</p>
        <ul className="mt-3 space-y-2">
          {gates.map((gate) => (
            <li key={gate.label} className="flex items-center gap-2 text-xs">
              {gate.ok ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
              ) : (
                <Circle className={cn("h-4 w-4 shrink-0", gate.required ? "text-destructive" : "text-muted-foreground")} />
              )}
              <span className={cn(!gate.ok && gate.required ? "text-destructive" : undefined)}>
                {gate.label}
                {!gate.required ? <span className="text-muted-foreground"> (optional)</span> : null}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Releasing snapshots the bundle and locks the version. Lots started on it keep it forever; re-pricing means a new version.
        </p>
      </div>
    </div>
  )
}
