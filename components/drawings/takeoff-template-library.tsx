"use client"

/**
 * The library, at the two moments it matters inside a takeoff.
 *
 * `TemplateLibraryDialog` — starting a job. Pick the conditions you already
 * know you need instead of retyping them with their cost codes, waste, and
 * depths. Applying copies them; nothing stays bound, so editing a condition here
 * never reprices a job that already went out.
 *
 * `HarvestTemplatesDialog` — finishing one. Keep what you built. This is how a
 * library gets its first rows, which is why the offer lives in the takeoff panel
 * and not only in Settings: the moment an estimator knows a condition is worth
 * keeping is the moment they just finished using it.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Loader2, Search } from "lucide-react"

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
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { unwrapAction } from "@/lib/action-result"
import {
  conditionSourceUom,
  conversionSummary,
  MEASURE_UOM_LABELS,
} from "@/lib/drawings/measure"
import {
  groupTemplates,
  UNGROUPED_LABEL,
  type ConditionTemplate,
} from "@/lib/drawings/condition-templates"
import {
  applyConditionTemplatesAction,
  listConditionTemplatesAction,
  saveConditionsAsTemplatesAction,
} from "@/app/(app)/drawings/takeoff-actions"

const rate = (cents: number) =>
  (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  })

/** One line describing what a template will measure and report. */
function templateSummary(template: ConditionTemplate): string {
  const source = conditionSourceUom(template.uom, template)
  const parts: string[] = []
  if (source === template.uom) {
    parts.push(MEASURE_UOM_LABELS[template.uom])
  } else {
    parts.push(
      `${MEASURE_UOM_LABELS[source]} → ${MEASURE_UOM_LABELS[template.uom]}`,
    )
  }
  // The factors, spelled out — "CY" alone does not tell you it is a 4in slab.
  const factorText = conversionSummary(1, template.uom, template)
  if (factorText) {
    const detail = factorText.replace(/^[\d,.]+ \w+ /, "").replace(/ = .*$/, "")
    if (detail) parts.push(detail)
  }
  if (template.waste_pct > 0) parts.push(`+${template.waste_pct}% waste`)
  if (template.unit_cost_cents != null) {
    parts.push(`${rate(template.unit_cost_cents)}/${MEASURE_UOM_LABELS[template.uom]}`)
  }
  return parts.join(" · ")
}

export function TemplateLibraryDialog({
  open,
  scope,
  onOpenChange,
  onApplied,
}: {
  open: boolean
  scope: { project_id: string } | { house_plan_version_id: string }
  onOpenChange: (open: boolean) => void
  onApplied: () => void
}) {
  const [templates, setTemplates] = useState<ConditionTemplate[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    let cancelled = false
    listConditionTemplatesAction()
      .then((result) => {
        if (cancelled) return
        if (result.success) setTemplates(result.data)
        else {
          setError(result.error)
          setTemplates([])
        }
      })
      .catch(() => {
        if (cancelled) return
        setError("Failed to load the library")
        setTemplates([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const groups = useMemo(() => {
    if (!templates) return []
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? templates.filter(
          (template) =>
            template.name.toLowerCase().includes(needle) ||
            (template.group_name ?? "").toLowerCase().includes(needle),
        )
      : templates
    return groupTemplates(filtered)
  }, [templates, query])

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleApply = useCallback(async () => {
    if (checked.size === 0) return
    setApplying(true)
    try {
      const result = unwrapAction(
        await applyConditionTemplatesAction({ ...scope, template_ids: Array.from(checked) }),
      )
      // Skips are reported, never silent — a template that did not land because
      // the name was taken is exactly the thing an estimator needs to hear.
      const notes: string[] = []
      if (result.skipped.length > 0) {
        notes.push(`${result.skipped.length} already here (${result.skipped.join(", ")})`)
      }
      if (result.over_cap.length > 0) {
        notes.push(`${result.over_cap.length} over the condition limit`)
      }
      toast.success(
        `Added ${result.created} condition${result.created === 1 ? "" : "s"}`,
        notes.length > 0 ? { description: notes.join(" · ") } : undefined,
      )
      onApplied()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add from library")
    } finally {
      setApplying(false)
    }
  }, [checked, scope, onApplied])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add from library</DialogTitle>
          <DialogDescription>
            Conditions you keep across jobs. Adding copies them — edit them here without
            touching the library.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 border px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the library"
            className="h-6 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            autoFocus
          />
        </div>

        {templates === null ? (
          <div className="space-y-2 py-6" aria-busy>
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-8 animate-pulse bg-muted" />
            ))}
          </div>
        ) : error ? (
          <p className="py-10 text-center text-sm text-destructive">{error}</p>
        ) : templates.length === 0 ? (
          <div className="space-y-1.5 py-10 text-center">
            <p className="text-sm font-medium">Your library is empty</p>
            <p className="text-xs text-muted-foreground">
              Build the conditions you need on this job, then select them and choose
              &ldquo;Save to library&rdquo; — next job starts with them already there.
            </p>
          </div>
        ) : groups.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Nothing in the library matches &ldquo;{query}&rdquo;
          </p>
        ) : (
          <ScrollArea className="max-h-[22rem]">
            <div className="space-y-3 pr-2">
              {groups.map((group) => (
                <div key={group.group}>
                  <div className="microlabel sticky top-0 bg-background py-1">
                    {group.group === UNGROUPED_LABEL ? "Ungrouped" : group.group}
                  </div>
                  <ul className="divide-y border-t">
                    {group.templates.map((template) => (
                      <li key={template.id}>
                        <label
                          className={cn(
                            "flex cursor-pointer items-start gap-2.5 py-2 pr-1",
                            checked.has(template.id) && "bg-muted/50",
                          )}
                        >
                          <Checkbox
                            checked={checked.has(template.id)}
                            onCheckedChange={() => toggle(template.id)}
                            className="mt-0.5"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">{template.name}</span>
                            <span className="mt-0.5 block truncate text-[11px] tabular-nums text-muted-foreground">
                              {templateSummary(template)}
                            </span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>
            Cancel
          </Button>
          <Button onClick={() => void handleApply()} disabled={applying || checked.size === 0}>
            {applying && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {checked.size === 0 ? "Select conditions" : `Add ${checked.size}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function HarvestTemplatesDialog({
  open,
  conditionIds,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  conditionIds: string[]
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [group, setGroup] = useState("")
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const result = unwrapAction(
        await saveConditionsAsTemplatesAction({
          condition_ids: conditionIds,
          group_name: group.trim() || null,
        }),
      )
      toast.success(
        `Saved ${result.created} to the library`,
        result.skipped.length > 0
          ? { description: `${result.skipped.length} already there: ${result.skipped.join(", ")}` }
          : undefined,
      )
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save to library")
    } finally {
      setSaving(false)
    }
  }, [conditionIds, group, onSaved])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Save {conditionIds.length} condition{conditionIds.length === 1 ? "" : "s"} to the library
          </DialogTitle>
          <DialogDescription>
            The name, unit, factors, cost code, waste and rate are kept. Measurements and
            the sheet color are not — those belong to this job.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="template-group">Group</Label>
          <Input
            id="template-group"
            value={group}
            onChange={(event) => setGroup(event.target.value)}
            placeholder="Concrete, Framing, Finishes…"
            autoFocus
          />
          <p className="text-[11px] text-muted-foreground">
            Optional. One flat level — it is a shelf, not an outline.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Save to library
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
