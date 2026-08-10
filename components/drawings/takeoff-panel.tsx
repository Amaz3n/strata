"use client"

/**
 * The takeoff panel: a docked list of conditions, live against the geometry
 * on the sheet.
 *
 * Rows are dense and money-shaped, not cards — an estimator scans twenty of
 * these and compares extended totals down a column. The only color is each
 * condition's identity chip, which matches its geometry on the drawing; state
 * (stale, unscaled, out of sync) is carried by text and the standard state
 * tokens, never by tinting the row.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import {
  AlertTriangle,
  BookmarkPlus,
  ChevronRight,
  Download,
  Library,
  ListChecks,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Send,
  Trash2,
  X,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { unwrapAction } from "@/lib/action-result"
import { formatQuantity, MEASURE_UOM_LABELS } from "@/lib/drawings/measure"
import type { ConditionRollup, TakeoffCondition } from "@/lib/services/takeoff"
import {
  deleteTakeoffConditionAction,
  exportConditionRollupCsvAction,
  getConditionRollupAction,
  listConditionTemplatesAction,
} from "@/app/(app)/drawings/takeoff-actions"
import { ConditionEditorDialog } from "./takeoff-condition-editor"
import { TakeoffSyncDialog } from "./takeoff-sync-dialog"
import { TakeoffRevisionBand } from "./takeoff-revision-band"
import { SheetCoverageSheet } from "./takeoff-coverage-sheet"
import { HarvestTemplatesDialog, TemplateLibraryDialog } from "./takeoff-template-library"

const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })

export interface TakeoffPanelProps {
  /** Exactly one of these; a condition lives on a project or a plan version. */
  projectId?: string | null
  housePlanVersionId?: string | null
  /** Sheet currently open, so the panel can say what is on screen. */
  activeSheetId?: string | null
  /**
   * Project whose drawings are on screen. Same as `projectId` for a project
   * takeoff; for a plan-version takeoff it is the lot project carrying the
   * sheets, which is what the revision-review queue is keyed on.
   */
  sheetProjectId?: string | null
  selectedConditionId: string | null
  initialRollup?: Promise<ConditionRollup[]> | null
  onInitialRollupConsumed?: () => void
  /**
   * Deep link target (`?condition=`). Armed once, as soon as the rollup that
   * carries it lands — arriving from an estimate line means that line is what
   * the next measurement belongs to.
   */
  initialConditionId?: string | null
  /** Passes the whole condition: the viewer needs its color to draw with. */
  onSelectCondition: (condition: TakeoffCondition | null) => void
  onHighlightCondition: (conditionId: string | null) => void
  /** Bumped by the viewer whenever a measurement is saved or deleted. */
  refreshToken: number
  canWrite: boolean
  onClose: () => void
}

export function TakeoffPanel({
  projectId,
  housePlanVersionId,
  activeSheetId,
  sheetProjectId,
  selectedConditionId,
  initialRollup = null,
  onInitialRollupConsumed,
  initialConditionId = null,
  onSelectCondition,
  onHighlightCondition,
  refreshToken,
  canWrite,
  onClose,
}: TakeoffPanelProps) {
  const [rollups, setRollups] = useState<ConditionRollup[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<TakeoffCondition | null>(null)
  const [creating, setCreating] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [harvestOpen, setHarvestOpen] = useState(false)
  const [coverageOpen, setCoverageOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const initialRollupRef = useRef(initialRollup)

  const scope = useMemo(
    () =>
      projectId
        ? { project_id: projectId }
        : housePlanVersionId
          ? { house_plan_version_id: housePlanVersionId }
          : null,
    [projectId, housePlanVersionId],
  )

  const load = useCallback(async () => {
    if (!scope) return
    try {
      setError(null)
      const prefetched = initialRollupRef.current
      initialRollupRef.current = null
      if (prefetched) onInitialRollupConsumed?.()
      setRollups(await (prefetched ?? getConditionRollupAction(scope)))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load takeoff")
      setRollups([])
    }
  }, [onInitialRollupConsumed, scope])

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  // Arm the deep-linked condition once. Guarded by a ref rather than by
  // `selectedConditionId` so that deselecting it doesn't re-arm on the next
  // rollup refresh.
  const armedInitialRef = useRef(false)
  useEffect(() => {
    if (armedInitialRef.current || !initialConditionId || !rollups) return
    const match = rollups.find((rollup) => rollup.condition.id === initialConditionId)
    if (!match) return
    armedInitialRef.current = true
    onSelectCondition(match.condition)
  }, [initialConditionId, rollups, onSelectCondition])

  const totals = useMemo(() => {
    if (!rollups) return { extended: 0, priced: 0, conditions: 0 }
    let extended = 0
    let priced = 0
    for (const rollup of rollups) {
      if (rollup.extended_cents !== null) {
        extended += rollup.extended_cents
        priced += 1
      }
    }
    return { extended, priced, conditions: rollups.length }
  }, [rollups])

  const checkedRollups = useMemo(
    () => (rollups ?? []).filter((r) => checkedIds.has(r.condition.id)),
    [rollups, checkedIds],
  )
  const selectedRollup = useMemo(
    () => (rollups ?? []).find((rollup) => rollup.condition.id === selectedConditionId) ?? null,
    [rollups, selectedConditionId],
  )

  const toggleChecked = (conditionId: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev)
      if (next.has(conditionId)) next.delete(conditionId)
      else next.add(conditionId)
      return next
    })
  }

  /**
   * The CSV is built server-side and handed back as a string, then downloaded
   * from a blob — no route, no temp file, and the browser never sees a URL that
   * could be shared past the permission check that produced it.
   */
  const handleExport = useCallback(async () => {
    if (!scope) return
    setExporting(true)
    try {
      const result = unwrapAction(await exportConditionRollupCsvAction(scope))
      const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = result.filename
      link.click()
      URL.revokeObjectURL(url)
      toast.success(`Exported ${result.condition_count} conditions`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to export")
    } finally {
      setExporting(false)
    }
  }, [scope])

  const handleDelete = async (rollup: ConditionRollup) => {
    const warning = rollup.sync
      ? `"${rollup.condition.name}" is synced to an estimate line. Deleting it marks that line detached and releases ${rollup.markup_count} measurement(s). Continue?`
      : `Delete "${rollup.condition.name}"? Its ${rollup.markup_count} measurement(s) stay on the sheet, unassigned.`
    if (!window.confirm(warning)) return

    setDeletingId(rollup.condition.id)
    try {
      const result = unwrapAction(await deleteTakeoffConditionAction(rollup.condition.id))
      if (selectedConditionId === rollup.condition.id) onSelectCondition(null)
      toast.success(
        result.detached_lines > 0
          ? `Condition deleted — ${result.detached_lines} estimate line(s) marked detached`
          : "Condition deleted",
      )
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete condition")
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="flex h-full w-[380px] flex-col border-l bg-background max-md:w-full">
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm font-semibold">Takeoff</div>
          <div className="microlabel mt-0.5">
            {totals.conditions} condition{totals.conditions === 1 ? "" : "s"}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {canWrite && (
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" />
              Condition
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Takeoff options">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {canWrite && (
                <DropdownMenuItem onSelect={() => setLibraryOpen(true)}>
                  <Library className="mr-2 h-3.5 w-3.5" />
                  Add from library
                </DropdownMenuItem>
              )}
              {canWrite && (
                <DropdownMenuItem
                  disabled={checkedRollups.length === 0}
                  onSelect={() => setHarvestOpen(true)}
                >
                  <BookmarkPlus className="mr-2 h-3.5 w-3.5" />
                  {checkedRollups.length === 0
                    ? "Save to library"
                    : `Save ${checkedRollups.length} to library`}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setCoverageOpen(true)}>
                <ListChecks className="mr-2 h-3.5 w-3.5" />
                Sheet coverage
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={exporting || (rollups?.length ?? 0) === 0}
                onSelect={(event) => {
                  event.preventDefault()
                  void handleExport()
                }}
              >
                {exporting ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="mr-2 h-3.5 w-3.5" />
                )}
                Export quantities (CSV)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onClose} aria-label="Close takeoff">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {(sheetProjectId ?? projectId) && (
        <TakeoffRevisionBand
          projectId={(sheetProjectId ?? projectId) as string}
          refreshToken={refreshToken}
          canWrite={canWrite}
          onResolved={() => void load()}
        />
      )}

      {rollups === null ? (
        <PanelSkeleton />
      ) : error ? (
        <PanelError message={error} onRetry={() => void load()} />
      ) : rollups.length === 0 ? (
        <PanelEmpty
          canWrite={canWrite}
          onCreate={() => setCreating(true)}
          onOpenLibrary={() => setLibraryOpen(true)}
        />
      ) : (
        <ScrollArea className="flex-1">
          <TooltipProvider delayDuration={300}>
            <ul className="divide-y">
              {rollups.map((rollup) => (
                <ConditionRow
                  key={rollup.condition.id}
                  rollup={rollup}
                  selected={selectedConditionId === rollup.condition.id}
                  checked={checkedIds.has(rollup.condition.id)}
                  expanded={expandedId === rollup.condition.id}
                  activeSheetId={activeSheetId ?? null}
                  canWrite={canWrite}
                  deleting={deletingId === rollup.condition.id}
                  onSelect={() =>
                    onSelectCondition(
                      selectedConditionId === rollup.condition.id ? null : rollup.condition,
                    )
                  }
                  onToggleCheck={() => toggleChecked(rollup.condition.id)}
                  onToggleExpand={() =>
                    setExpandedId((prev) => (prev === rollup.condition.id ? null : rollup.condition.id))
                  }
                  onHover={onHighlightCondition}
                  onEdit={() => setEditing(rollup.condition)}
                  onDelete={() => void handleDelete(rollup)}
                />
              ))}
            </ul>
          </TooltipProvider>
        </ScrollArea>
      )}

      {rollups !== null && rollups.length > 0 && (
        <footer className="border-t px-3 py-2.5">
          <div className="flex items-baseline justify-between">
            <span className="microlabel">
              {totals.priced === totals.conditions
                ? "Total"
                : `Total · ${totals.priced} of ${totals.conditions} priced`}
            </span>
            <span className="text-base font-semibold tabular-nums">{money(totals.extended)}</span>
          </div>
          {canWrite && (
            <Button
              size="sm"
              className="mt-2.5 w-full gap-1.5"
              disabled={checkedRollups.length === 0}
              onClick={() => setSyncOpen(true)}
            >
              <Send className="h-3.5 w-3.5" />
              {checkedRollups.length === 0
                ? "Select conditions to send"
                : `Send ${checkedRollups.length} to…`}
            </Button>
          )}
        </footer>
      )}

      {(creating || editing) && scope && (
        <ConditionEditorDialog
          open
          condition={editing}
          scope={scope}
          onOpenChange={(open) => {
            if (!open) {
              setCreating(false)
              setEditing(null)
            }
          }}
          onSaved={(condition) => {
            setCreating(false)
            setEditing(null)
            void load()
            // A brand-new condition is armed immediately — the next click on
            // the sheet should measure into it without another step.
            if (!editing) onSelectCondition(condition)
          }}
        />
      )}

      {syncOpen && (
        <TakeoffSyncDialog
          open
          projectId={projectId}
          housePlanVersionId={housePlanVersionId}
          rollups={checkedRollups}
          onOpenChange={setSyncOpen}
          onSynced={() => {
            setSyncOpen(false)
            setCheckedIds(new Set())
            void load()
          }}
        />
      )}

      {libraryOpen && scope && (
        <TemplateLibraryDialog
          open
          scope={scope}
          onOpenChange={setLibraryOpen}
          onApplied={() => {
            setLibraryOpen(false)
            void load()
          }}
        />
      )}

      {harvestOpen && (
        <HarvestTemplatesDialog
          open
          conditionIds={checkedRollups.map((rollup) => rollup.condition.id)}
          onOpenChange={setHarvestOpen}
          onSaved={() => {
            setHarvestOpen(false)
            setCheckedIds(new Set())
          }}
        />
      )}

      {coverageOpen && (
        <SheetCoverageSheet
          open
          scope={
            projectId
              ? { project_id: projectId }
              : {
                  house_plan_version_id: housePlanVersionId as string,
                  source_project_ids: sheetProjectId ? [sheetProjectId] : [],
                }
          }
          declarationScope={scope}
          canWrite={canWrite}
          onOpenChange={setCoverageOpen}
        />
      )}
    </div>
  )
}

function ConditionRow({
  rollup,
  selected,
  checked,
  expanded,
  activeSheetId,
  canWrite,
  deleting,
  onSelect,
  onToggleCheck,
  onToggleExpand,
  onHover,
  onEdit,
  onDelete,
}: {
  rollup: ConditionRollup
  selected: boolean
  checked: boolean
  expanded: boolean
  activeSheetId: string | null
  canWrite: boolean
  deleting: boolean
  onSelect: () => void
  onToggleCheck: () => void
  onToggleExpand: () => void
  onHover: (conditionId: string | null) => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { condition } = rollup
  const uomLabel = MEASURE_UOM_LABELS[condition.uom]
  const onThisSheet = activeSheetId
    ? rollup.sheets.find((sheet) => sheet.drawing_sheet_id === activeSheetId)
    : null

  return (
    <li
      className={cn("relative", selected && "bg-muted/50")}
      onMouseEnter={() => onHover(condition.id)}
      onMouseLeave={() => onHover(null)}
    >
      {/* Selection is the arming gesture: the next measurement joins this
          condition, so it gets a full-height marker, not a subtle tint. */}
      {selected && (
        <span
          className="absolute inset-y-0 left-0 w-[3px]"
          style={{ backgroundColor: condition.color }}
          aria-hidden
        />
      )}
      <div className="flex items-start gap-2 px-3 py-2.5 pl-3.5">
        {canWrite && (
          <Checkbox
            checked={checked}
            onCheckedChange={onToggleCheck}
            className="mt-1"
            aria-label={`Select ${condition.name} to send`}
          />
        )}

        <button
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 text-left"
          aria-pressed={selected}
        >
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: condition.color }}
              aria-hidden
            />
            <span className="truncate text-sm font-medium">{condition.name}</span>
          </div>

          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-sm tabular-nums">
              {formatQuantity(rollup.effective_quantity)}
              <span className="ml-1 text-xs text-muted-foreground">{uomLabel}</span>
            </span>
            {condition.waste_pct > 0 && (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                +{condition.waste_pct}% waste
              </span>
            )}
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            {rollup.cost_code && (
              <span className="tabular-nums">{rollup.cost_code.code}</span>
            )}
            {rollup.effective_unit_cost_cents !== null ? (
              <span className="tabular-nums">
                {money(rollup.effective_unit_cost_cents)}/{uomLabel}
              </span>
            ) : (
              <span className="text-warning">No rate</span>
            )}
            <span>
              {rollup.markup_count} measurement{rollup.markup_count === 1 ? "" : "s"}
              {rollup.deduction_count > 0 && `, ${rollup.deduction_count} deducted`}
            </span>
            {onThisSheet && (
              <span className="tabular-nums">
                {formatQuantity(onThisSheet.quantity)} {uomLabel} here
              </span>
            )}
          </div>

          {/* The arithmetic behind a converted number, in place. A CY figure is
              only checkable if you can see the SF and the depth it came from. */}
          {rollup.conversion_summary && (
            <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
              {rollup.conversion_summary}
            </p>
          )}

          <ConditionFlags rollup={rollup} />
        </button>

        <div className="flex flex-col items-end gap-1">
          <span className="text-sm font-medium tabular-nums">
            {rollup.extended_cents !== null ? money(rollup.extended_cents) : "—"}
          </span>
          {canWrite && (
            <div className="flex items-center">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    onClick={onEdit}
                    aria-label={`Edit ${condition.name}`}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">Edit condition</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    onClick={onDelete}
                    disabled={deleting}
                    aria-label={`Delete ${condition.name}`}
                  >
                    {deleting ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">Delete condition</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      </div>

      {rollup.sheets.length > 0 && (
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex w-full items-center gap-1 px-3 pb-2 pl-9 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
          {rollup.sheets.length} sheet{rollup.sheets.length === 1 ? "" : "s"}
        </button>
      )}

      {expanded && (
        <ul className="pb-2 pl-9 pr-3">
          {rollup.sheets.map((sheet) => (
            <li
              key={sheet.drawing_sheet_id}
              className={cn(
                "flex items-baseline justify-between gap-2 py-0.5 text-[11px]",
                sheet.drawing_sheet_id === activeSheetId && "font-medium text-foreground",
              )}
            >
              <span className="truncate text-muted-foreground">
                {sheet.sheet_number}
                {sheet.sheet_title ? ` · ${sheet.sheet_title}` : ""}
              </span>
              <span className="tabular-nums">
                {formatQuantity(sheet.quantity)} {MEASURE_UOM_LABELS[rollup.condition.uom]}
              </span>
            </li>
          ))}
          {rollup.sheets_truncated > 0 && (
            <li className="py-0.5 text-[11px] text-muted-foreground">
              +{rollup.sheets_truncated} more sheet{rollup.sheets_truncated === 1 ? "" : "s"}
            </li>
          )}
        </ul>
      )}
    </li>
  )
}

/** Everything that makes a number less trustworthy than it looks. */
function ConditionFlags({ rollup }: { rollup: ConditionRollup }) {
  const flags: Array<{ key: string; label: string; tone: "warning" | "muted" }> = []

  // Loudest first: a net-negative condition is a mistake, not a nuance.
  if (rollup.net_negative) {
    flags.push({
      key: "net-negative",
      label: "Deductions exceed the areas — counted as 0",
      tone: "warning",
    })
  }
  if (rollup.duplicate_suspect_sheets.length > 0) {
    flags.push({
      key: "duplicate",
      label: `${rollup.duplicate_suspect_sheets.join(" and ")} match — measured twice?`,
      tone: "warning",
    })
  }
  if (rollup.unscaled_markup_count > 0) {
    flags.push({
      key: "unscaled",
      label: `${rollup.unscaled_markup_count} awaiting scale`,
      tone: "warning",
    })
  }
  if (rollup.pending_review_count > 0) {
    flags.push({
      key: "review",
      label: `${rollup.pending_review_count} awaiting revision check`,
      tone: "warning",
    })
  }
  if (rollup.stale_markup_count > 0) {
    flags.push({
      key: "stale",
      label: `${rollup.stale_markup_count} on an old revision`,
      tone: "warning",
    })
  }
  if (rollup.sync?.detached) {
    flags.push({ key: "detached", label: "Estimate line detached", tone: "muted" })
  } else if (rollup.sync?.hand_edited) {
    flags.push({ key: "edited", label: "Estimate line hand-edited", tone: "warning" })
  } else if (rollup.sync?.quantity_changed) {
    flags.push({ key: "drifted", label: "Estimate is out of date", tone: "warning" })
  } else if (rollup.sync) {
    flags.push({ key: "synced", label: "Synced", tone: "muted" })
  }

  if (flags.length === 0) return null

  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {flags.map((flag) => (
        <Badge
          key={flag.key}
          variant="outline"
          className={cn(
            "h-4 gap-1 px-1.5 text-[10px] font-normal",
            flag.tone === "warning" && "border-warning/40 text-warning",
          )}
        >
          {flag.tone === "warning" && <AlertTriangle className="h-2.5 w-2.5" />}
          {flag.label}
        </Badge>
      ))}
    </div>
  )
}

function PanelSkeleton() {
  return (
    <div className="flex-1 space-y-px p-3" aria-busy>
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="space-y-2 py-2.5">
          <div className="h-3 w-2/3 animate-pulse bg-muted" />
          <div className="h-3 w-1/3 animate-pulse bg-muted" />
        </div>
      ))}
    </div>
  )
}

function PanelError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <AlertTriangle className="h-5 w-5 text-destructive" />
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}

function PanelEmpty({
  canWrite,
  onCreate,
  onOpenLibrary,
}: {
  canWrite: boolean
  onCreate: () => void
  onOpenLibrary: () => void
}) {
  const [hasLibrary, setHasLibrary] = useState(false)

  // The library is offered FIRST when the org has one, because on the second job
  // onward the honest answer to "nothing measured yet" is "you already have
  // these conditions, take them".
  useEffect(() => {
    let cancelled = false
    listConditionTemplatesAction()
      .then((result) => {
        if (!cancelled && result.success) setHasLibrary(result.data.length > 0)
      })
      .catch(() => {
        if (!cancelled) setHasLibrary(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm font-medium">Nothing measured yet</p>
      <p className="text-xs text-muted-foreground">
        A condition is what you price — &ldquo;LVP flooring&rdquo;, &ldquo;base trim&rdquo;. Create one, then
        measure it on the sheet.
      </p>
      {canWrite && (
        <div className="flex flex-col items-center gap-2">
          {hasLibrary && (
            <Button size="sm" className="gap-1.5" onClick={onOpenLibrary}>
              <Library className="h-3.5 w-3.5" />
              Add from your library
            </Button>
          )}
          <Button
            size="sm"
            variant={hasLibrary ? "outline" : "default"}
            className="gap-1.5"
            onClick={onCreate}
          >
            <Plus className="h-3.5 w-3.5" />
            New condition
          </Button>
        </div>
      )}
    </div>
  )
}
