"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, ListOrdered, Sparkles } from "lucide-react"

import type { CostCode } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"

import {
  applyBudgetFromEstimateAction,
  listBudgetEstimateSourcesAction,
  listBudgetTemplatesAction,
  proposeBudgetFromEstimateAction,
  proposeBudgetFromTemplateAction,
  saveProjectBudgetAsTemplateAction,
} from "@/app/(app)/projects/[id]/financials/budget/actions"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

import { dollarsToCents, formatCurrency, parseCsv, type ReviewLine } from "./shared"

type EstimateSourceOption = {
  id: string
  label: string
  status?: string
  total_cents: number
  line_count: number
}

/**
 * "Start from estimate" — picks a project estimate, proposes budget lines from
 * its cost basis (AI tidies the scope notes), and lets the user review/edit
 * before saving. AI proposes; the human approves.
 */
export function EstimateImportDialog({
  sourceKind = "estimate",
  open,
  onOpenChange,
  projectId,
  hasExistingBudget,
  costCodesEnabled,
}: {
  sourceKind?: "estimate" | "template"
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  hasExistingBudget: boolean
  costCodesEnabled: boolean
}) {
  const { toast } = useToast()
  const router = useRouter()
  const [isApplying, startApply] = useTransition()

  const [loadingSources, setLoadingSources] = useState(false)
  const [sources, setSources] = useState<EstimateSourceOption[]>([])
  const [selectedId, setSelectedId] = useState<string>("")
  const [generating, setGenerating] = useState(false)
  const [usedAi, setUsedAi] = useState(false)
  const [reviewLines, setReviewLines] = useState<ReviewLine[] | null>(null)

  // Load the project's estimates whenever the dialog opens.
  useEffect(() => {
    if (!open) {
      setSources([])
      setSelectedId("")
      setReviewLines(null)
      setUsedAi(false)
      return
    }
    let cancelled = false
    setLoadingSources(true)
    const load = sourceKind === "template"
      ? listBudgetTemplatesAction().then((rows) => rows.map((row) => ({
          id: row.id,
          label: row.name,
          total_cents: row.total_cents,
          line_count: row.line_count,
        })))
      : listBudgetEstimateSourcesAction(projectId)
    load
      .then((rows) => {
        if (cancelled) return
        setSources(rows)
        if (rows.length === 1) setSelectedId(rows[0].id)
      })
      .catch((error) => {
        if (!cancelled) toast({ title: `Couldn't load ${sourceKind}s`, description: (error as Error).message })
      })
      .finally(() => {
        if (!cancelled) setLoadingSources(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, projectId, sourceKind, toast])

  const generate = (estimateId: string) => {
    if (!estimateId) return
    setGenerating(true)
    setReviewLines(null)
    const build = sourceKind === "template"
      ? proposeBudgetFromTemplateAction(projectId, estimateId)
      : proposeBudgetFromEstimateAction(projectId, estimateId)
    build
      .then((draft) => {
        setUsedAi(draft.used_ai)
        setReviewLines(
          draft.lines.map((line) => ({
            cost_code_id: line.cost_code_id,
            cost_code_label: line.cost_code_label,
            description: line.description,
            amountDollars: (line.amount_cents / 100).toFixed(2),
            include: true,
          })),
        )
      })
      .catch((error) => {
        toast({ title: "Couldn't build the budget", description: (error as Error).message })
      })
      .finally(() => setGenerating(false))
  }

  const includedLines = (reviewLines ?? []).filter((line) => line.include)
  const totalCents = includedLines.reduce(
    (sum, line) => sum + (dollarsToCents(line.amountDollars) ?? 0),
    0,
  )

  const apply = () => {
    const payloadLines = includedLines
      .map((line) => ({
        cost_code_id: costCodesEnabled ? line.cost_code_id : null,
        description: line.description.trim() || "Budget line",
        amount_cents: dollarsToCents(line.amountDollars) ?? 0,
      }))
      .filter((line) => line.amount_cents >= 0)

    if (payloadLines.length === 0) {
      toast({ title: "Select at least one line" })
      return
    }

    startApply(async () => {
      try {
        unwrapAction(await applyBudgetFromEstimateAction({ project_id: projectId, lines: payloadLines }))
        toast({ title: `Budget created from ${sourceKind}` })
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast({ title: "Couldn't save the budget", description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Start budget from {sourceKind}</DialogTitle>
          <DialogDescription>
            {sourceKind === "template"
              ? "Choose a reusable template, then review and adjust every resolved line before saving."
              : "We'll turn an accepted estimate into budget lines using its cost basis (excluding markup). Review and adjust before saving."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-4 overflow-y-auto">
          {loadingSources ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Loading estimates…</p>
          ) : sources.length === 0 ? (
            <div className="border border-dashed py-10 text-center text-sm text-muted-foreground">
              No {sourceKind}s with cost lines were found{sourceKind === "estimate" ? " for this project" : ""}.
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex-1 space-y-1.5">
                  <Label>{sourceKind === "template" ? "Template" : "Estimate"}</Label>
                  <Select value={selectedId} onValueChange={setSelectedId}>
                    <SelectTrigger>
                      <SelectValue placeholder={`Select a ${sourceKind}`} />
                    </SelectTrigger>
                    <SelectContent>
                      {sources.map((source) => (
                        <SelectItem key={source.id} value={source.id}>
                          {source.label} · {source.line_count} {source.line_count === 1 ? "line" : "lines"} ·{" "}
                          {formatCurrency(source.total_cents, { compact: true })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={() => generate(selectedId)} disabled={!selectedId || generating}>
                  <Sparkles className="h-4 w-4" />
                  {generating ? "Building…" : reviewLines ? "Rebuild" : "Build budget"}
                </Button>
              </div>

              {hasExistingBudget && (
                <div className="flex items-start gap-2 border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  This project already has a budget. Saving will replace its current lines.
                </div>
              )}

              {reviewLines && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      {includedLines.length} of {reviewLines.length} lines selected
                      {usedAi ? " · scope notes tidied by AI" : ""}
                    </p>
                    <p className="text-sm font-semibold tabular-nums">{formatCurrency(totalCents)}</p>
                  </div>
                  <ReviewLinesTable
                    reviewLines={reviewLines}
                    setReviewLines={setReviewLines}
                    costCodesEnabled={costCodesEnabled}
                    scopeHeader="Scope"
                  />
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={!reviewLines || includedLines.length === 0 || isApplying}>
            {isApplying ? "Saving…" : `Create budget (${includedLines.length})`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Shared review grid for the estimate/template and CSV import flows. */
function ReviewLinesTable({
  reviewLines,
  setReviewLines,
  costCodesEnabled,
  scopeHeader,
}: {
  reviewLines: ReviewLine[]
  setReviewLines: React.Dispatch<React.SetStateAction<ReviewLine[] | null>>
  costCodesEnabled: boolean
  scopeHeader: string
}) {
  return (
    <div className="overflow-hidden border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead className="w-10 px-3" />
            {costCodesEnabled && <TableHead className="px-3">Code</TableHead>}
            <TableHead className="px-3">{scopeHeader}</TableHead>
            <TableHead className="w-[130px] px-3 text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {reviewLines.map((line, index) => (
            <TableRow key={index} className={cn(!line.include && "opacity-50")}>
              <TableCell className="px-3">
                <input
                  type="checkbox"
                  checked={line.include}
                  onChange={(event) =>
                    setReviewLines((prev) =>
                      (prev ?? []).map((item, i) =>
                        i === index ? { ...item, include: event.target.checked } : item,
                      ),
                    )
                  }
                  className="h-4 w-4 border-input"
                />
              </TableCell>
              {costCodesEnabled && (
                <TableCell className="px-3 font-mono text-xs text-muted-foreground">
                  {line.cost_code_label ?? "Uncoded"}
                </TableCell>
              )}
              <TableCell className="px-3">
                <Input
                  value={line.description}
                  onChange={(event) =>
                    setReviewLines((prev) =>
                      (prev ?? []).map((item, i) =>
                        i === index ? { ...item, description: event.target.value } : item,
                      ),
                    )
                  }
                  className="h-8"
                />
              </TableCell>
              <TableCell className="px-3 text-right">
                <Input
                  value={line.amountDollars}
                  inputMode="decimal"
                  onChange={(event) =>
                    setReviewLines((prev) =>
                      (prev ?? []).map((item, i) =>
                        i === index ? { ...item, amountDollars: event.target.value } : item,
                      ),
                    )
                  }
                  className="h-8 text-right tabular-nums"
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function SaveBudgetTemplateDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
}) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")

  useEffect(() => {
    if (!open) {
      setName("")
      setDescription("")
    }
  }, [open])

  const save = () => {
    if (!name.trim()) {
      toast({ title: "Enter a template name" })
      return
    }
    startTransition(async () => {
      try {
        unwrapAction(await saveProjectBudgetAsTemplateAction(projectId, {
          name: name.trim(),
          description: description.trim() || null,
        }))
        toast({ title: "Budget template saved" })
        onOpenChange(false)
      } catch (error) {
        toast({ title: "Couldn't save the template", description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Save budget as template</DialogTitle>
          <DialogDescription>
            Copies the current budget lines into a reusable organization template. Future project changes do not alter it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="budget-template-name">Template name</Label>
            <Input id="budget-template-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Standard single-family budget" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="budget-template-description">Description</Label>
            <Textarea id="budget-template-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Optional notes for the team" />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save template"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Imports budget lines from a CSV with code/description/amount columns. */
export function CsvImportDialog({
  open,
  onOpenChange,
  projectId,
  hasExistingBudget,
  costCodesEnabled,
  costCodes,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  hasExistingBudget: boolean
  costCodesEnabled: boolean
  costCodes: CostCode[]
}) {
  const { toast } = useToast()
  const router = useRouter()
  const [isApplying, startApply] = useTransition()
  const [reviewLines, setReviewLines] = useState<ReviewLine[] | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setReviewLines(null)
      setParseError(null)
    }
  }, [open])

  const codeIdByCode = useMemo(() => {
    const map = new Map<string, { id: string; label: string }>()
    for (const code of costCodes) {
      if (code.code) {
        const label = [code.code, code.name].filter(Boolean).join(" — ")
        map.set(code.code.trim().toLowerCase(), { id: code.id, label })
      }
    }
    return map
  }, [costCodes])

  const handleFile = async (file: File) => {
    setParseError(null)
    try {
      const text = await file.text()
      const rows = parseCsv(text)
      if (rows.length === 0) {
        setParseError("That file looks empty.")
        return
      }
      // Locate columns from the header row.
      const header = rows[0].map((cell) => cell.trim().toLowerCase())
      const findCol = (names: string[]) => header.findIndex((cell) => names.includes(cell))
      const codeCol = findCol(["code", "cost code", "cost_code"])
      const descCol = findCol(["description", "scope", "name", "budget line", "line"])
      const amountCol = findCol(["amount", "budget", "total", "cost", "revised"])
      if (descCol === -1 || amountCol === -1) {
        setParseError("Couldn't find a description and amount column. Use headers like: code, description, amount.")
        return
      }
      const parsed: ReviewLine[] = rows.slice(1).flatMap((cells) => {
        const description = (cells[descCol] ?? "").trim()
        const rawAmount = (cells[amountCol] ?? "").replace(/[$,]/g, "").trim()
        if (!description && !rawAmount) return []
        const codeText = codeCol >= 0 ? (cells[codeCol] ?? "").trim() : ""
        const matched = codeText ? codeIdByCode.get(codeText.toLowerCase()) : undefined
        const cents = dollarsToCents(rawAmount)
        return [
          {
            cost_code_id: costCodesEnabled ? matched?.id ?? null : null,
            cost_code_label: costCodesEnabled ? matched?.label ?? (codeText || null) : null,
            description: description || "Budget line",
            amountDollars: cents != null ? (cents / 100).toFixed(2) : "0.00",
            include: true,
          },
        ]
      })
      if (parsed.length === 0) {
        setParseError("No data rows found under the header.")
        return
      }
      setReviewLines(parsed)
    } catch (error) {
      setParseError((error as Error).message)
    }
  }

  const includedLines = (reviewLines ?? []).filter((line) => line.include)
  const totalCents = includedLines.reduce(
    (sum, line) => sum + (dollarsToCents(line.amountDollars) ?? 0),
    0,
  )

  const apply = () => {
    const payloadLines = includedLines.map((line) => ({
      cost_code_id: costCodesEnabled ? line.cost_code_id : null,
      description: line.description.trim() || "Budget line",
      amount_cents: dollarsToCents(line.amountDollars) ?? 0,
    }))
    if (payloadLines.length === 0) {
      toast({ title: "Select at least one line" })
      return
    }
    startApply(async () => {
      try {
        unwrapAction(await applyBudgetFromEstimateAction({ project_id: projectId, lines: payloadLines }))
        toast({ title: "Budget imported" })
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast({ title: "Couldn't import the budget", description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Import budget from CSV</DialogTitle>
          <DialogDescription>
            Upload a CSV with <span className="font-medium">description</span> and{" "}
            <span className="font-medium">amount</span> columns (and an optional{" "}
            <span className="font-medium">code</span> column). Review before saving.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-4 overflow-y-auto">
          <div className="flex items-center gap-3">
            <Input
              type="file"
              accept=".csv,text/csv"
              className="cursor-pointer"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) handleFile(file)
              }}
            />
          </div>

          {parseError && (
            <div className="flex items-start gap-2 border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {parseError}
            </div>
          )}

          {hasExistingBudget && reviewLines && (
            <div className="flex items-start gap-2 border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              This project already has a budget. Saving will replace its current lines.
            </div>
          )}

          {reviewLines && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {includedLines.length} of {reviewLines.length} lines selected
                </p>
                <p className="text-sm font-semibold tabular-nums">{formatCurrency(totalCents)}</p>
              </div>
              <ReviewLinesTable
                reviewLines={reviewLines}
                setReviewLines={setReviewLines}
                costCodesEnabled={costCodesEnabled}
                scopeHeader="Description"
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={!reviewLines || includedLines.length === 0 || isApplying}>
            {isApplying ? "Saving…" : `Import ${includedLines.length} lines`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Empty state for the unified budget table — three-step primer plus the
 * creation entry points.
 */
export function UnifiedBudgetEmptyState({
  editable,
  onCreate,
  onEstimateImport,
  onTemplateImport,
  filtered = false,
}: {
  editable: boolean
  onCreate: () => void
  onEstimateImport?: () => void
  onTemplateImport?: () => void
  filtered?: boolean
}) {
  // When the empty state is the result of a search/filter, keep it minimal.
  if (filtered) {
    return (
      <div className="flex flex-col items-center gap-2">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <ListOrdered className="h-6 w-6" />
        </div>
        <p className="font-medium">No matching budget lines</p>
        <p className="text-sm text-muted-foreground">Try clearing the search or the “need attention” filter.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-4 py-2">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <ListOrdered className="h-6 w-6" />
      </div>
      <div className="max-w-[460px] text-center">
        <p className="font-medium">Build your project budget</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Start a line for each part of the job — framing, plumbing, allowances — with the amount you
          expect to spend. Then buy it out with subcontracts &amp; POs and track spend as bills come in.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
        <span className="rounded-full bg-muted px-2.5 py-1">1 · Set budget</span>
        <span className="rounded-full bg-muted px-2.5 py-1">2 · Buy it out</span>
        <span className="rounded-full bg-muted px-2.5 py-1">3 · Track spend</span>
      </div>
      {editable && (
        <div className="flex flex-col items-center gap-2">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" onClick={onCreate}>
              Add line
            </Button>
            <Button size="sm" variant="outline" onClick={onEstimateImport}>
              <Sparkles className="h-4 w-4" />
              Start from estimate
            </Button>
            <Button size="sm" variant="outline" onClick={onTemplateImport}>
              <ListOrdered className="h-4 w-4" />
              Start from template
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
