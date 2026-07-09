"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import type { CostCode } from "@/lib/types"
import type { EstimateTemplateDto } from "@/lib/services/estimate-templates"
import {
  createEstimateTemplateAction,
  deleteEstimateTemplateAction,
  updateEstimateTemplateAction,
} from "@/app/(app)/settings/templates/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
import { Plus, Trash2, FileText, Edit, LayoutGrid } from "@/components/icons"
import { cn } from "@/lib/utils"

import { unwrapAction } from "@/lib/action-result"

type LineDraft = {
  item_type: "line" | "group"
  description: string
  quantity: number | string
  unit_cost: number | string
  cost_code_id: string | undefined
  is_optional: boolean
}

const NEW_LINE = (): LineDraft => ({ item_type: "line", description: "", quantity: 1, unit_cost: "", cost_code_id: undefined, is_optional: false })
const NEW_SECTION = (): LineDraft => ({ item_type: "group", description: "", quantity: 1, unit_cost: "", cost_code_id: undefined, is_optional: false })

const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
const noSpinner =
  "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"

function toDrafts(template: EstimateTemplateDto): LineDraft[] {
  return template.lines.map((line) => ({
    item_type: line.item_type === "group" ? "group" : "line",
    description: line.description,
    quantity: line.quantity ?? 1,
    unit_cost: line.unit_cost_cents ? line.unit_cost_cents / 100 : "",
    cost_code_id: line.cost_code_id ?? undefined,
    is_optional: line.is_optional ?? false,
  }))
}

interface Props {
  initialTemplates: EstimateTemplateDto[]
  costCodes: CostCode[]
}

export function EstimateTemplatesClient({ initialTemplates, costCodes }: Props) {
  const [templates, setTemplates] = useState(initialTemplates)
  const [editingId, setEditingId] = useState<string | "new" | null>(null)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [lines, setLines] = useState<LineDraft[]>([NEW_LINE()])
  const [pending, startTransition] = useTransition()
  const [deleteTarget, setDeleteTarget] = useState<EstimateTemplateDto | null>(null)

  const total = lines.reduce(
    (sum, l) => (l.item_type === "group" || l.is_optional ? sum : sum + (Number(l.unit_cost) || 0) * (Number(l.quantity) || 1)),
    0,
  )

  function startCreate() {
    setEditingId("new")
    setName("")
    setDescription("")
    setLines([NEW_LINE()])
  }

  function startEdit(template: EstimateTemplateDto) {
    setEditingId(template.id)
    setName(template.name)
    setDescription(template.description ?? "")
    setLines(toDrafts(template).length ? toDrafts(template) : [NEW_LINE()])
  }

  function cancel() {
    setEditingId(null)
  }

  const updateLine = (idx: number, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)))
  const removeLine = (idx: number) => setLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== idx)))

  function save() {
    if (!name.trim()) {
      toast.error("Template name is required.")
      return
    }
    const cleaned = lines.filter((l) => l.description.trim())
    if (cleaned.length === 0) {
      toast.error("Add at least one line with a description.")
      return
    }
    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      lines: cleaned.map((l) => ({
        item_type: l.item_type,
        description: l.description.trim(),
        quantity: Number(l.quantity) || 1,
        unit_cost_cents: Math.round((Number(l.unit_cost) || 0) * 100),
        cost_code_id: l.cost_code_id ?? null,
        is_optional: l.is_optional,
      })),
    }

    startTransition(async () => {
      try {
        if (editingId === "new") {
          const created = unwrapAction(await createEstimateTemplateAction(payload))
          setTemplates((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
          toast.success("Template created")
        } else if (editingId) {
          const updated = unwrapAction(await updateEstimateTemplateAction(editingId, payload))
          setTemplates((prev) => prev.map((t) => (t.id === updated.id ? updated : t)).sort((a, b) => a.name.localeCompare(b.name)))
          toast.success("Template saved")
        }
        setEditingId(null)
      } catch (error: any) {
        toast.error(error?.message ?? "Failed to save template.")
      }
    })
  }

  function confirmDelete() {
    if (!deleteTarget) return
    const target = deleteTarget
    startTransition(async () => {
      try {
        unwrapAction(await deleteEstimateTemplateAction(target.id))
        setTemplates((prev) => prev.filter((t) => t.id !== target.id))
        if (editingId === target.id) setEditingId(null)
        toast.success("Template deleted")
      } catch (error: any) {
        toast.error(error?.message ?? "Failed to delete template.")
      } finally {
        setDeleteTarget(null)
      }
    })
  }

  return (
    <div className="space-y-6">
      {editingId ? (
        <Card>
          <CardContent className="space-y-5 p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tpl-name">Template name</Label>
                <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kitchen remodel" className="h-10" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-desc">Description</Label>
                <Input id="tpl-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional — for your team" className="h-10" />
              </div>
            </div>

            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-semibold">Sections &amp; line items</Label>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setLines((p) => [...p, NEW_SECTION()])}>
                    <LayoutGrid className="mr-1.5 h-4 w-4" />
                    Section
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setLines((p) => [...p, NEW_LINE()])}>
                    <Plus className="mr-1.5 h-4 w-4" />
                    Item
                  </Button>
                </div>
              </div>

              {lines.map((line, idx) =>
                line.item_type === "group" ? (
                  <div key={idx} className="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 p-2.5">
                    <LayoutGrid className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <Input
                      value={line.description}
                      onChange={(e) => updateLine(idx, { description: e.target.value })}
                      placeholder="Section heading (e.g. Demolition)"
                      className="h-9 flex-1 font-semibold uppercase tracking-wide"
                    />
                    <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-muted-foreground" onClick={() => removeLine(idx)} disabled={lines.length === 1}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <div key={idx} className="space-y-2 border bg-muted/20 p-3">
                    <div className="flex items-end gap-2">
                      <div className="flex-1 space-y-1">
                        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Description</Label>
                        <Input value={line.description} onChange={(e) => updateLine(idx, { description: e.target.value })} placeholder="Work item" className="h-9" />
                      </div>
                      <div className="w-16 space-y-1">
                        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Qty</Label>
                        <Input type="number" min={0} step={0.01} value={line.quantity} onChange={(e) => updateLine(idx, { quantity: e.target.value })} className={cn("h-9 tabular-nums", noSpinner)} />
                      </div>
                      <div className="w-28 space-y-1">
                        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Unit cost</Label>
                        <div className="relative">
                          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 select-none text-sm text-muted-foreground">$</span>
                          <Input type="number" min={0} step={0.01} value={line.unit_cost} onChange={(e) => updateLine(idx, { unit_cost: e.target.value })} placeholder="0.00" className={cn("h-9 pl-7 tabular-nums", noSpinner)} />
                        </div>
                      </div>
                      <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-muted-foreground" onClick={() => removeLine(idx)} disabled={lines.length === 1}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <Select value={line.cost_code_id ?? "none"} onValueChange={(v) => updateLine(idx, { cost_code_id: v === "none" ? undefined : v })}>
                        <SelectTrigger className="h-9 max-w-[60%]">
                          <SelectValue placeholder="No cost code" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No cost code</SelectItem>
                          {(costCodes ?? []).map((code) => (
                            <SelectItem key={code.id} value={code.id}>
                              {code.code} · {code.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Checkbox checked={line.is_optional} onCheckedChange={(c) => updateLine(idx, { is_optional: c === true })} />
                        Optional add-on
                      </label>
                    </div>
                  </div>
                ),
              )}

              <div className="flex items-center justify-between border-t-2 border-foreground/80 pt-2.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Base total</span>
                <span className="text-base font-bold tabular-nums">{money(total * 100)}</span>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={cancel} disabled={pending}>
                Cancel
              </Button>
              <Button type="button" onClick={save} disabled={pending}>
                {pending ? "Saving…" : editingId === "new" ? "Create template" : "Save template"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Button type="button" onClick={startCreate}>
          <Plus className="mr-1.5 h-4 w-4" />
          New template
        </Button>
      )}

      <div className="space-y-2.5">
        {templates.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <FileText className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">No templates yet</p>
              <p className="max-w-sm text-xs text-muted-foreground">Create a template to start estimates faster — pre-built sections, line items, and optional add-ons.</p>
            </CardContent>
          </Card>
        ) : (
          templates.map((template) => {
            const lineCount = template.lines.filter((l) => l.item_type !== "group").length
            const sectionCount = template.lines.filter((l) => l.item_type === "group").length
            return (
              <Card key={template.id}>
                <CardContent className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{template.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {template.description ? `${template.description} · ` : ""}
                      {sectionCount > 0 ? `${sectionCount} section${sectionCount === 1 ? "" : "s"} · ` : ""}
                      {lineCount} item{lineCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button type="button" variant="ghost" size="sm" onClick={() => startEdit(template)}>
                      <Edit className="mr-1.5 h-3.5 w-3.5" />
                      Edit
                    </Button>
                    <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" onClick={() => setDeleteTarget(template)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })
        )}
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete template?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteTarget?.name}” will be removed. Estimates already created from it are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
