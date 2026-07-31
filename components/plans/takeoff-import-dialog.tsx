"use client"

import { useEffect, useMemo, useState } from "react"

import { AlertTriangle, Check } from "@/components/icons"
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
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  parseTakeoffPaste,
  type TakeoffImportElevation,
  type TakeoffImportLine,
} from "@/lib/plans/takeoff-import"
import type { CostCode } from "@/lib/types"
import { cn } from "@/lib/utils"

const PREVIEW_CAP = 60

/**
 * Estimators keep takeoffs in a spreadsheet, so the import accepts the clipboard
 * as-is and reports what it understood before anything is committed. A row it
 * cannot read is named and skipped rather than aborting the paste — a single bad
 * cost code should not cost somebody two hundred good lines.
 */
export function TakeoffImportDialog({
  open,
  onOpenChange,
  costCodes,
  elevations,
  hasExistingLines,
  onImport,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  costCodes: CostCode[]
  elevations: TakeoffImportElevation[]
  hasExistingLines: boolean
  onImport: (lines: TakeoffImportLine[], mode: "append" | "replace") => void
}) {
  const [text, setText] = useState("")
  const [headerMode, setHeaderMode] = useState<"auto" | "header" | "none">("auto")
  const [replace, setReplace] = useState(false)

  useEffect(() => {
    if (!open) {
      setText("")
      setHeaderMode("auto")
      setReplace(false)
    }
  }, [open])

  const preview = useMemo(
    () => parseTakeoffPaste({ text, costCodes, elevations, headerMode }),
    [text, costCodes, elevations, headerMode],
  )

  const codeById = useMemo(() => new Map(costCodes.map((code) => [code.id, code])), [costCodes])
  const elevationById = useMemo(() => new Map(elevations.map((item) => [item.id, item.code])), [elevations])
  const shown = preview.rows.slice(0, PREVIEW_CAP)

  function commit() {
    const lines = preview.rows.map((row) => row.line).filter((line): line is TakeoffImportLine => line !== null)
    if (lines.length === 0) return
    onImport(lines, replace ? "replace" : "append")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] gap-0 overflow-hidden rounded-none p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Paste a takeoff</DialogTitle>
          <DialogDescription>
            Copy the rows straight out of Excel or Sheets. Columns can be in any order when the first row names
            them — otherwise they read as cost code, description, quantity, UOM, unit cost.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto px-5 py-4">
          <Textarea
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={
              "cost code\tdescription\tquantity\tuom\tunit cost\n06100\tWall framing\t1\tls\t24,500\n06100\tRoof trusses\t38\tea\t412.50"
            }
            className="min-h-40 rounded-none font-mono text-xs"
          />

          {text.trim() === "" ? (
            <p className="text-[11px] text-muted-foreground">
              Nothing pasted yet. Every row is checked against your cost codes before you commit it.
            </p>
          ) : preview.fatal ? (
            <p className="flex items-start gap-1.5 border border-destructive/40 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              {preview.fatal}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <p className="text-[11px] tabular-nums text-muted-foreground">
                  <span className="text-foreground">{preview.readyCount} ready</span>
                  {preview.errorCount > 0 ? (
                    <span className="ml-2 text-destructive">{preview.errorCount} skipped</span>
                  ) : null}
                  <span className="ml-2">· {preview.delimiter === "tab" ? "tab" : "comma"} separated</span>
                </p>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Checkbox
                      checked={preview.hasHeader}
                      onCheckedChange={(checked) => setHeaderMode(checked === true ? "header" : "none")}
                    />
                    First row is a header
                  </label>
                  {hasExistingLines ? (
                    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Checkbox checked={replace} onCheckedChange={(checked) => setReplace(checked === true)} />
                      Replace the existing takeoff
                    </label>
                  ) : null}
                </div>
              </div>

              <div className="overflow-x-auto border">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                      <th className="w-8 px-2 py-1.5 text-right font-medium">#</th>
                      <th className="w-16 px-2 py-1.5 text-left font-medium">Elev</th>
                      <th className="w-20 px-2 py-1.5 text-left font-medium">Code</th>
                      <th className="px-2 py-1.5 text-left font-medium">Description</th>
                      <th className="w-20 px-2 py-1.5 text-right font-medium">Qty</th>
                      <th className="w-12 px-2 py-1.5 text-left font-medium">UOM</th>
                      <th className="w-24 px-2 py-1.5 text-right font-medium">Unit cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((row) => (
                      <tr
                        key={row.rowNumber}
                        className={cn("border-b border-border/60 last:border-b-0", row.error && "bg-destructive/5")}
                      >
                        <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{row.rowNumber}</td>
                        {row.line ? (
                          <>
                            <td className="px-2 py-1 text-muted-foreground">
                              {row.line.elevationId === "base"
                                ? "Base"
                                : elevationById.get(row.line.elevationId) ?? "—"}
                            </td>
                            <td className="px-2 py-1 font-mono text-[10px]">
                              {codeById.get(row.line.costCodeId)?.code ?? "—"}
                            </td>
                            <td className="max-w-0 truncate px-2 py-1">{row.line.description}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{row.line.quantity}</td>
                            <td className="px-2 py-1 text-muted-foreground">{row.line.uom}</td>
                            <td className="px-2 py-1 text-right tabular-nums">
                              {row.line.unitCostDollars === "" ? (
                                <span className="text-muted-foreground">—</span>
                              ) : (
                                row.line.unitCostDollars
                              )}
                            </td>
                          </>
                        ) : (
                          <td className="px-2 py-1 text-destructive" colSpan={6}>
                            {row.error}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.rows.length > PREVIEW_CAP ? (
                <p className="text-[10px] text-muted-foreground">
                  Showing the first {PREVIEW_CAP} of {preview.rows.length} rows — all {preview.readyCount} readable
                  rows will import.
                </p>
              ) : null}
            </>
          )}
        </div>

        <DialogFooter className="border-t px-5 py-3">
          <Button variant="outline" className="rounded-none" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="rounded-none" onClick={commit} disabled={preview.readyCount === 0}>
            <Check className="mr-1 h-3.5 w-3.5" />
            {replace ? "Replace with" : "Add"} {preview.readyCount || ""}{" "}
            {preview.readyCount === 1 ? "line" : "lines"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
