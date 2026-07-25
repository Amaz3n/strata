"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Tag } from "@/components/icons"
import { Switch } from "@/components/ui/switch"
import { updateCostCodesEnabledAction } from "@/app/(app)/settings/cost-coding/actions"
import { unwrapAction } from "@/lib/action-result"

/**
 * The org-wide cost-codes master switch. Projects with no explicit override
 * follow this; a project can still override it in its settings.
 */
export function CostCodesEnabledSwitch({
  initialEnabled,
  canManage,
}: {
  initialEnabled: boolean
  canManage: boolean
}) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [pending, startTransition] = useTransition()

  const onToggle = (next: boolean) => {
    if (!canManage || pending) return
    const previous = enabled
    setEnabled(next)
    startTransition(async () => {
      try {
        unwrapAction(await updateCostCodesEnabledAction(next))
        toast.success(next ? "Cost codes turned on org-wide" : "Cost codes turned off org-wide")
      } catch (error) {
        setEnabled(previous)
        toast.error("Couldn't update cost coding", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  return (
    <div className="flex shrink-0 items-start justify-between gap-6 border-b border-border bg-muted/20 px-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <Tag className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Use cost codes across the organization</p>
          <p className="mt-0.5 max-w-prose text-xs leading-5 text-muted-foreground">
            {enabled
              ? "Costs, budgets, and invoices are coded to this library. Turn off to bucket by budget line instead. Individual projects can override this."
              : "Cost codes are off — projects bucket costs by budget line. The library below stays available, and individual projects can override this."}
          </p>
        </div>
      </div>
      <Switch
        aria-label="Use cost codes across the organization"
        checked={enabled}
        onCheckedChange={onToggle}
        disabled={!canManage || pending}
        className="mt-0.5 shrink-0"
      />
    </div>
  )
}
