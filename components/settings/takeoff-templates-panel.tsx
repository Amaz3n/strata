"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SettingsError, SettingsGroup } from "@/components/settings/settings-section"
import { Textarea } from "@/components/ui/textarea"
import { Plus, Ruler, Trash2 } from "@/components/icons"
import { formatMoneyCentsExact } from "@/lib/utils"
import { unwrapAction } from "@/lib/action-result"
import {
  CONDITION_UOM_DESCRIPTIONS,
  CONDITION_UOMS,
  MEASURE_UOM_LABELS,
  conditionSourceUom,
  conversionSummary,
  formatQuantity,
  type ConditionFactors,
  type ConditionUom,
} from "@/lib/drawings/measure"
import { factorRuleViolation } from "@/lib/validation/takeoff"
import type { ConditionTemplate } from "@/lib/services/takeoff-templates"
import {
  createConditionTemplateAction,
  deleteConditionTemplateAction,
  listTakeoffCostCodesAction,
  updateConditionTemplateAction,
} from "@/app/(app)/drawings/takeoff-actions"

type TakeoffCostCode = Awaited<ReturnType<typeof listTakeoffCostCodesAction>>[number]

interface TemplateGroup {
  group: string
  templates: ConditionTemplate[]
}

const CONTAINER = "mx-auto w-full max-w-3xl space-y-8 px-5 py-6 lg:px-8 lg:py-8"

/** Select has no empty value, so "no cost code" needs a sentinel. */
const NO_COST_CODE = "none"

/** The quantity the editor's worked example is stated against. */
const EXAMPLE_QUANTITY = 100

export function TakeoffTemplatesPanel({
  groups,
  groupNames,
  costCodes,
  total,
  cap,
  canManage,
}: {
  groups: TemplateGroup[]
  groupNames: string[]
  costCodes: TakeoffCostCode[]
  total: number
  cap: number
  canManage: boolean
}) {
  const router = useRouter()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<ConditionTemplate | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ConditionTemplate | null>(null)
  const [deleting, startDelete] = useTransition()

  const costCodeById = useMemo(
    () => new Map(costCodes.map((code) => [code.id, code])),
    [costCodes],
  )

  const atCap = total >= cap

  const handleDelete = (template: ConditionTemplate) => {
    startDelete(async () => {
      try {
        unwrapAction(await deleteConditionTemplateAction(template.id))
        setConfirmDelete(null)
        toast.success(`Removed "${template.name}" from the library`)
        router.refresh()
      } catch (error) {
        toast.error("Couldn't delete this template", { description: (error as Error).message })
      }
    })
  }

  return (
    <div className={CONTAINER}>
      {total === 0 ? (
        <LibraryEmpty canManage={canManage} onCreate={() => setCreating(true)} />
      ) : (
        <>
          <div className="flex min-h-8 items-start justify-between gap-3">
            <p className="max-w-xl text-xs leading-5 text-muted-foreground">
              Conditions you reuse job to job, with their units, axis factors, cost codes and rates.
              Applying one copies it — later edits here never reprice a job already taken off.
            </p>
            <Button
              size="sm"
              className="h-8 shrink-0 gap-1.5"
              onClick={() => setCreating(true)}
              disabled={!canManage || atCap}
            >
              <Plus className="size-3.5" />
              New template
            </Button>
          </div>

          {!canManage ? (
            <p className="text-xs leading-5 text-muted-foreground">
              You can read the library, but editing it needs takeoff access.
            </p>
          ) : null}

          {groups.map((entry) => (
            <SettingsGroup key={entry.group} title={entry.group}>
              {entry.templates.map((template) => (
                <TemplateRow
                  key={template.id}
                  template={template}
                  costCode={template.cost_code_id ? costCodeById.get(template.cost_code_id) ?? null : null}
                  canManage={canManage}
                  onEdit={() => setEditing(template)}
                  onDelete={() => setConfirmDelete(template)}
                />
              ))}
            </SettingsGroup>
          ))}

          <p className="microlabel">
            {total} of {cap} templates
            {atCap ? " — the library is full, delete one to add another" : ""}
          </p>
        </>
      )}

      <TemplateDialog
        key={editing?.id ?? "create"}
        open={creating || editing !== null}
        template={editing}
        groupNames={groupNames}
        costCodes={costCodes}
        onOpenChange={(open) => {
          if (open) return
          setCreating(false)
          setEditing(null)
        }}
        onSaved={() => {
          setCreating(false)
          setEditing(null)
          router.refresh()
        }}
      />

      <AlertDialog open={confirmDelete !== null} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <AlertDialogContent>
          {confirmDelete ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete &ldquo;{confirmDelete.name}&rdquo;?</AlertDialogTitle>
                <AlertDialogDescription>
                  It leaves the library for future takeoffs. Conditions already created from it were
                  copied, not linked, so no job changes. This can&apos;t be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(event) => {
                    event.preventDefault()
                    handleDelete(confirmDelete)
                  }}
                  disabled={deleting}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {deleting ? "Deleting…" : "Delete"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function TemplateRow({
  template,
  costCode,
  canManage,
  onEdit,
  onDelete,
}: {
  template: ConditionTemplate
  costCode: TakeoffCostCode | null
  canManage: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const money = [
    template.waste_pct > 0 ? `${formatQuantity(template.waste_pct)}% waste` : null,
    template.unit_cost_cents != null
      ? `${formatMoneyCentsExact(template.unit_cost_cents)} / ${MEASURE_UOM_LABELS[template.uom]}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <div className="group flex items-start justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-5 text-foreground">{template.name}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{unitSentence(template)}</p>
        <p className="mt-0.5 text-xs leading-5 tabular-nums text-muted-foreground sm:hidden">
          {[costCodeLabel(costCode), money].filter(Boolean).join(" · ") || "No cost code"}
        </p>
      </div>

      <div className="hidden w-56 shrink-0 text-right sm:block">
        <p className="truncate text-xs leading-5 text-muted-foreground">
          {costCodeLabel(costCode) ?? "No cost code"}
        </p>
        <p className="mt-0.5 truncate text-xs leading-5 tabular-nums text-muted-foreground">
          {money || "Live rate"}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button variant="outline" size="sm" onClick={onEdit} disabled={!canManage}>
          Edit
        </Button>
        {canManage ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={onDelete}
            aria-label={`Delete ${template.name}`}
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function LibraryEmpty({ canManage, onCreate }: { canManage: boolean; onCreate: () => void }) {
  return (
    <Empty className="border-0 py-20">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Ruler />
        </EmptyMedia>
        <EmptyTitle>No condition templates yet</EmptyTitle>
        <EmptyDescription>
          A library normally starts from a real job: finish a takeoff, select the conditions you built
          and choose &ldquo;Save as templates&rdquo; in the takeoff panel. You can also add them here
          by hand.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {canManage ? (
          <Button size="sm" onClick={onCreate}>
            <Plus className="mr-1.5 size-3.5" />
            New template
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">
            Ask someone with takeoff access to build the library.
          </p>
        )}
      </EmptyContent>
    </Empty>
  )
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

/** How an SF condition carries the axis the plan cannot show. */
type AxisMode = "none" | "height" | "pitch"

interface TemplateDraft {
  name: string
  uom: ConditionUom
  axis: AxisMode
  depthIn: string
  heightFt: string
  pitchRise: string
  tonsPerCy: string
  costCodeId: string
  wastePct: string
  unitCost: string
  groupName: string
  shareWithClients: boolean
  notes: string
}

function toDraft(template: ConditionTemplate | null): TemplateDraft {
  if (!template) {
    return {
      name: "",
      uom: "sf",
      axis: "none",
      depthIn: "",
      heightFt: "",
      pitchRise: "",
      tonsPerCy: "",
      costCodeId: NO_COST_CODE,
      wastePct: "",
      unitCost: "",
      groupName: "",
      shareWithClients: false,
      notes: "",
    }
  }
  return {
    name: template.name,
    uom: template.uom,
    axis: template.height_ft != null ? "height" : template.pitch_rise != null ? "pitch" : "none",
    depthIn: template.depth_in != null ? String(template.depth_in) : "",
    heightFt: template.height_ft != null ? String(template.height_ft) : "",
    pitchRise: template.pitch_rise != null ? String(template.pitch_rise) : "",
    tonsPerCy: template.tons_per_cy != null ? String(template.tons_per_cy) : "",
    costCodeId: template.cost_code_id ?? NO_COST_CODE,
    wastePct: template.waste_pct ? String(template.waste_pct) : "",
    unitCost: template.unit_cost_cents != null ? (template.unit_cost_cents / 100).toString() : "",
    groupName: template.group_name ?? "",
    shareWithClients: template.share_with_clients,
    notes: template.notes ?? "",
  }
}

function TemplateDialog({
  open,
  template,
  groupNames,
  costCodes,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  template: ConditionTemplate | null
  groupNames: string[]
  costCodes: TakeoffCostCode[]
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<TemplateDraft>(() => toDraft(template))
  const [error, setError] = useState<string | null>(null)
  const [saving, startSave] = useTransition()

  useEffect(() => {
    if (open) {
      setDraft(toDraft(template))
      setError(null)
    }
  }, [open, template])

  const patch = (values: Partial<TemplateDraft>) => setDraft((prev) => ({ ...prev, ...values }))

  // Changing the unit changes which factors are legal, so the illegal ones are
  // cleared rather than left to fail validation on save.
  const changeUom = (uom: ConditionUom) =>
    setDraft((prev) => ({
      ...prev,
      uom,
      axis: "none",
      heightFt: "",
      pitchRise: "",
      depthIn: uom === "cy" || uom === "ton" ? prev.depthIn : "",
      tonsPerCy: uom === "ton" ? prev.tonsPerCy : "",
    }))

  const changeAxis = (axis: AxisMode) =>
    setDraft((prev) => ({
      ...prev,
      axis,
      heightFt: axis === "height" ? prev.heightFt : "",
      pitchRise: axis === "pitch" ? prev.pitchRise : "",
    }))

  const factors = draftFactors(draft)
  const violation = factorRuleViolation({ uom: draft.uom, ...factors })
  const sourceUom = conditionSourceUom(draft.uom, factors)
  const example = conversionSummary(EXAMPLE_QUANTITY, draft.uom, factors)
  const canSave = draft.name.trim().length > 0 && !violation && !saving

  const submit = () => {
    if (!canSave) return
    setError(null)
    startSave(async () => {
      try {
        const shared = {
          depth_in: factors.depth_in ?? null,
          height_ft: factors.height_ft ?? null,
          pitch_rise: factors.pitch_rise ?? null,
          tons_per_cy: factors.tons_per_cy ?? null,
          cost_code_id: draft.costCodeId === NO_COST_CODE ? null : draft.costCodeId,
          waste_pct: numberOrNull(draft.wastePct) ?? 0,
          unit_cost_cents: centsOrNull(draft.unitCost),
          share_with_clients: draft.shareWithClients,
          notes: draft.notes.trim() || null,
          group_name: draft.groupName.trim() || null,
        }

        if (template) {
          // The row's own `updated_at` is the guard: if anyone else saved since
          // this dialog opened, the write is refused instead of clobbering them.
          unwrapAction(
            await updateConditionTemplateAction(
              template.id,
              { name: draft.name.trim(), ...shared },
              template.updated_at,
            ),
          )
          toast.success("Template updated")
        } else {
          unwrapAction(
            await createConditionTemplateAction({
              name: draft.name.trim(),
              uom: draft.uom,
              ...shared,
            }),
          )
          toast.success("Template added to the library")
        }
        onSaved()
      } catch (caught) {
        setError((caught as Error).message)
      }
    })
  }

  const showDepth = draft.uom === "cy" || draft.uom === "ton"
  const showDensity = draft.uom === "ton"
  const showAxisChoice = draft.uom === "sf"
  const showPitchOnly = draft.uom === "sq"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg gap-0 overflow-y-auto p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="text-sm font-medium">
            {template ? "Edit template" : "New template"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            One template becomes one condition — one unit, one cost code. Applying it copies these
            values into the job.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-5 py-5">
          <section className="space-y-2">
            <Label htmlFor="template-name" className="microlabel">
              Name
            </Label>
            <Input
              id="template-name"
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder="4in slab on grade"
              maxLength={120}
              autoFocus
            />
          </section>

          <section className="space-y-2">
            <p className="microlabel">Reports in</p>
            {template ? (
              <p className="text-sm leading-5 text-foreground">
                {MEASURE_UOM_LABELS[draft.uom]}
                <span className="ml-2 text-xs text-muted-foreground">
                  Unit is fixed — delete and re-create to change it
                </span>
              </p>
            ) : (
              <Select value={draft.uom} onValueChange={(value) => changeUom(value as ConditionUom)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONDITION_UOMS.map((uom) => (
                    <SelectItem key={uom} value={uom}>
                      {MEASURE_UOM_LABELS[uom]} — {CONDITION_UOM_DESCRIPTIONS[uom]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p className="text-xs leading-5 text-muted-foreground">
              Measured on the sheet in <span className="font-medium text-foreground">{MEASURE_UOM_LABELS[sourceUom]}</span>
              {sourceUom === draft.uom ? " — reported exactly as measured." : "."}
            </p>
          </section>

          {showAxisChoice ? (
            <section className="space-y-2">
              <p className="microlabel">Axis factor</p>
              <Select value={draft.axis} onValueChange={(value) => changeAxis(value as AxisMode)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None — trace the area directly</SelectItem>
                  <SelectItem value="height">Wall height — walk the run in LF, report SF</SelectItem>
                  <SelectItem value="pitch">Roof pitch — trace plan area, report sloped SF</SelectItem>
                </SelectContent>
              </Select>
              {draft.axis === "height" ? (
                <FactorInput
                  id="template-height"
                  label="Wall height (ft)"
                  value={draft.heightFt}
                  placeholder="8"
                  onChange={(value) => patch({ heightFt: value })}
                />
              ) : null}
              {draft.axis === "pitch" ? (
                <FactorInput
                  id="template-pitch"
                  label="Rise per 12"
                  value={draft.pitchRise}
                  placeholder="6"
                  onChange={(value) => patch({ pitchRise: value })}
                />
              ) : null}
            </section>
          ) : null}

          {showPitchOnly ? (
            <FactorInput
              id="template-pitch"
              label="Roof pitch — rise per 12 (optional)"
              value={draft.pitchRise}
              placeholder="6"
              onChange={(value) => patch({ pitchRise: value })}
            />
          ) : null}

          {showDepth ? (
            <FactorInput
              id="template-depth"
              label="Depth (in)"
              value={draft.depthIn}
              placeholder="4"
              onChange={(value) => patch({ depthIn: value })}
            />
          ) : null}

          {showDensity ? (
            <FactorInput
              id="template-density"
              label="Density (tons per CY)"
              value={draft.tonsPerCy}
              placeholder="1.4"
              onChange={(value) => patch({ tonsPerCy: value })}
            />
          ) : null}

          {example ? (
            <p className="text-xs leading-5 tabular-nums text-muted-foreground">
              Worked example: {example}
            </p>
          ) : null}

          <section className="space-y-2">
            <p className="microlabel">Cost code</p>
            <Select value={draft.costCodeId} onValueChange={(value) => patch({ costCodeId: value })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_COST_CODE}>No cost code</SelectItem>
                {costCodes.map((code) => (
                  <SelectItem key={code.id} value={code.id}>
                    {code.code} {code.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </section>

          <div className="grid gap-4 sm:grid-cols-2">
            <section className="space-y-2">
              <Label htmlFor="template-waste" className="microlabel">
                Waste %
              </Label>
              <Input
                id="template-waste"
                type="number"
                min="0"
                max="100"
                step="0.1"
                inputMode="decimal"
                className="tabular-nums"
                value={draft.wastePct}
                onChange={(event) => patch({ wastePct: event.target.value })}
                placeholder="0"
              />
            </section>
            <section className="space-y-2">
              <Label htmlFor="template-rate" className="microlabel">
                Pinned rate
              </Label>
              <Input
                id="template-rate"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                className="tabular-nums"
                value={draft.unitCost}
                onChange={(event) => patch({ unitCost: event.target.value })}
                placeholder="Live rate"
              />
            </section>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Leave the rate blank to price from the cost code every time it is applied.
          </p>

          <section className="space-y-2">
            <Label htmlFor="template-group" className="microlabel">
              Group
            </Label>
            <Input
              id="template-group"
              list="takeoff-template-groups"
              value={draft.groupName}
              onChange={(event) => patch({ groupName: event.target.value })}
              placeholder="Concrete"
              maxLength={60}
            />
            <datalist id="takeoff-template-groups">
              {groupNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </section>

          <section className="space-y-2">
            <Label htmlFor="template-notes" className="microlabel">
              Notes
            </Label>
            <Textarea
              id="template-notes"
              value={draft.notes}
              onChange={(event) => patch({ notes: event.target.value })}
              rows={2}
              maxLength={2000}
              placeholder="What this covers, and what it doesn't"
            />
          </section>

          <div className="flex items-start gap-2.5">
            <Checkbox
              id="template-share"
              checked={draft.shareWithClients}
              onCheckedChange={(checked) => patch({ shareWithClients: checked === true })}
              className="mt-0.5"
            />
            <Label htmlFor="template-share" className="text-sm font-normal leading-5 text-foreground">
              Share this quantity with clients
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Conditions made from this template start visible on client-facing takeoff exports.
              </span>
            </Label>
          </div>

          {violation ? <SettingsError>{violation}</SettingsError> : null}
          {error ? <SettingsError>{error}</SettingsError> : null}
        </div>

        <DialogFooter className="border-t border-border px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSave}>
            {saving ? "Saving…" : template ? "Save changes" : "Add template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FactorInput({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string
  label: string
  value: string
  placeholder: string
  onChange: (value: string) => void
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="microlabel">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min="0"
        step="0.01"
        inputMode="decimal"
        className="tabular-nums"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function numberOrNull(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === "") return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function centsOrNull(value: string): number | null {
  const dollars = numberOrNull(value)
  return dollars == null ? null : Math.round(dollars * 100)
}

function draftFactors(draft: TemplateDraft): ConditionFactors {
  return {
    depth_in: numberOrNull(draft.depthIn),
    height_ft: numberOrNull(draft.heightFt),
    pitch_rise: numberOrNull(draft.pitchRise),
    tons_per_cy: numberOrNull(draft.tonsPerCy),
  }
}

function templateFactors(template: ConditionTemplate): ConditionFactors {
  return {
    depth_in: template.depth_in,
    height_ft: template.height_ft,
    pitch_rise: template.pitch_rise,
    tons_per_cy: template.tons_per_cy,
  }
}

/**
 * `SF · measured in LF × 8′ high`. The source unit is spelled out whenever it
 * differs from the reporting unit, so nobody has to guess what to trace.
 */
function unitSentence(template: ConditionTemplate): string {
  const factors = templateFactors(template)
  const source = conditionSourceUom(template.uom, factors)
  const parts: string[] = []

  if (source !== template.uom) parts.push(`measured in ${MEASURE_UOM_LABELS[source]}`)
  if (template.height_ft != null) parts.push(`× ${formatQuantity(template.height_ft)}′ high`)
  if (template.depth_in != null) parts.push(`× ${formatQuantity(template.depth_in)}″ deep`)
  if (template.pitch_rise != null) parts.push(`× ${formatQuantity(template.pitch_rise)}/12 pitch`)
  if (template.tons_per_cy != null) parts.push(`× ${formatQuantity(template.tons_per_cy)} t/CY`)

  const label = MEASURE_UOM_LABELS[template.uom]
  return parts.length > 0 ? `${label} · ${parts.join(" ")}` : label
}

function costCodeLabel(costCode: TakeoffCostCode | null): string | null {
  if (!costCode) return null
  return `${costCode.code} ${costCode.name}`
}
