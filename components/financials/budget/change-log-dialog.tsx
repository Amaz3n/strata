"use client"

import { useEffect, useState } from "react"

import type { BudgetChangeLogEntry } from "@/lib/services/budgets"
import { cn } from "@/lib/utils"
import { useToast } from "@/hooks/use-toast"

import { fetchBudgetChangeLogAction } from "@/app/(app)/projects/[id]/financials/budget/actions"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

import { formatCurrency } from "./shared"

/**
 * Per-line budget history: who changed which line, when, from what to what.
 * Sits between the frozen baseline (one comparison point) and snapshots
 * (whole-budget states) — this is the edit-by-edit audit view.
 */
export function BudgetChangeLogDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
}) {
  const { toast } = useToast()
  const [entries, setEntries] = useState<BudgetChangeLogEntry[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) {
      setEntries(null)
      return
    }
    let cancelled = false
    setLoading(true)
    fetchBudgetChangeLogAction(projectId)
      .then((rows) => {
        if (!cancelled) setEntries(rows)
      })
      .catch((error) => {
        if (!cancelled) {
          toast({ title: "Couldn't load change history", description: (error as Error).message })
          setEntries([])
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, projectId, toast])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Budget change history</DialogTitle>
          <DialogDescription>
            Every saved edit to this budget's lines — who changed what, and by how much.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Loading history…</p>
          ) : !entries || entries.length === 0 ? (
            <div className="border border-dashed py-10 text-center text-sm text-muted-foreground">
              No recorded changes yet. Edits made from now on appear here line by line.
            </div>
          ) : (
            <ul className="divide-y">
              {entries.map((entry) => (
                <li key={entry.id} className="py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium">
                      {entry.actor_name ?? "System"}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {new Date(entry.at).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  {entry.summary ? (
                    <p className="mt-1 text-sm text-muted-foreground">{entry.summary}</p>
                  ) : (
                    <ul className="mt-1.5 space-y-1">
                      {entry.changes.map((change, index) => (
                        <li key={index} className="flex items-baseline justify-between gap-3 text-sm">
                          <span className="min-w-0 truncate text-muted-foreground">{change.label}</span>
                          {change.kind === "amount" ? (
                            <span className="shrink-0 tabular-nums">
                              {formatCurrency(change.from_cents)}
                              <span className="mx-1 text-muted-foreground">→</span>
                              <span
                                className={cn(
                                  "font-medium",
                                  change.to_cents > change.from_cents ? "text-destructive" : "text-success",
                                )}
                              >
                                {formatCurrency(change.to_cents)}
                              </span>
                            </span>
                          ) : change.kind === "added" ? (
                            <span className="shrink-0 tabular-nums">
                              <span className="mr-1.5 text-xs uppercase text-success">Added</span>
                              {formatCurrency(change.amount_cents)}
                            </span>
                          ) : (
                            <span className="shrink-0 tabular-nums">
                              <span className="mr-1.5 text-xs uppercase text-destructive">Removed</span>
                              {formatCurrency(change.amount_cents)}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-end border-t pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
