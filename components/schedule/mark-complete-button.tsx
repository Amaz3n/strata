"use client"

import { useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Check } from "@/components/icons"
import { updateScheduleItemAction } from "@/app/(app)/schedule/actions"

/**
 * One-click completion for the org Schedule desk's attention list. Per the
 * desk rule it calls the same server action the project workbench uses —
 * everything else (dates, dependencies) stays in the project schedule.
 */
export function MarkScheduleItemCompleteButton({ itemId, itemName }: { itemId: string; itemName: string }) {
  const [pending, startTransition] = useTransition()

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      className="relative z-10 h-7 gap-1 px-2 text-xs"
      onClick={() =>
        startTransition(async () => {
          try {
            await updateScheduleItemAction(itemId, { status: "completed", progress: 100 })
            toast.success(`Marked "${itemName}" complete`)
          } catch {
            toast.error("Couldn't mark it complete — try from the project schedule.")
          }
        })
      }
    >
      <Check className="size-3.5" />
      Done
    </Button>
  )
}
