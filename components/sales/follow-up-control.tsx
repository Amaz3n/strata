"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

import {
  completeDealFollowUpAction,
  setDealFollowUpAction,
} from "@/app/(app)/sales/actions"
import { Check, ChevronDown, Clock } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction, type ActionResult } from "@/lib/action-result"
import { cn } from "@/lib/utils"

/** Morning of the target day — a follow-up is something you do, not a deadline. */
const FOLLOW_UP_HOUR = 9

function atFollowUpHour(daysFromToday: number): string {
  const date = new Date()
  date.setDate(date.getDate() + daysFromToday)
  date.setHours(FOLLOW_UP_HOUR, 0, 0, 0)
  return date.toISOString()
}

function fromDateInput(value: string): string {
  const [year, month, day] = value.split("-").map(Number)
  return new Date(year, month - 1, day, FOLLOW_UP_HOUR, 0, 0, 0).toISOString()
}

function toDateInput(value: string | null): string {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) return ""
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}

const QUICK_OPTIONS: { label: string; days: number }[] = [
  { label: "Tomorrow", days: 1 },
  { label: "In 3 days", days: 3 },
  { label: "Next week", days: 7 },
  { label: "In 2 weeks", days: 14 },
]

interface FollowUpControlProps {
  /** Null for a deal with no lead record behind it — an imported agreement. */
  prospectId: string | null
  followUpAt: string | null
  /** `inline` sits in a board row; `block` is the deal file's own control. */
  variant?: "inline" | "block"
  className?: string
}

/**
 * Set, snooze, or work off a follow-up without leaving the row. The Monday
 * ritual is thirty of these — at one page navigation each, the consultant goes
 * back to the notes app on their phone.
 */
export function FollowUpControl({ prospectId, followUpAt, variant = "inline", className }: FollowUpControlProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [customDate, setCustomDate] = useState(() => toDateInput(followUpAt))

  if (!prospectId) return null

  const commit = (operation: () => Promise<ActionResult<unknown>>, message: string) => {
    startTransition(async () => {
      try {
        unwrapAction(await operation())
        setOpen(false)
        toast({ title: message })
        router.refresh()
      } catch (error) {
        toast({ title: "Could not update the follow-up", description: (error as Error).message })
      }
    })
  }

  const scheduled = Boolean(followUpAt)
  const isBlock = variant === "block"

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={pending}
          aria-label={scheduled ? "Snooze follow-up" : "Set a follow-up"}
          title={scheduled ? "Snooze follow-up" : "Set a follow-up"}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 border border-transparent text-[11px] font-medium text-muted-foreground transition-colors hover:border-border hover:bg-background hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50",
            isBlock
              ? "h-8 w-full justify-between border-border bg-background px-2.5 text-xs"
              // Icon-only in a row: the label competed with the next action for
              // width. Always rendered, never hover-only — hover does not exist
              // on the tablet a consultant carries around the model home.
              : "size-6 justify-center text-muted-foreground/70 group-hover:text-muted-foreground",
            className,
          )}
        >
          {isBlock ? (
            <>
              <span className="inline-flex items-center gap-1.5">
                <Clock className="size-3.5" />
                {scheduled ? "Change follow-up" : "Set a follow-up"}
              </span>
              <ChevronDown className="size-3.5" />
            </>
          ) : (
            <Clock className="size-3.5" />
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent align={isBlock ? "start" : "end"} className="w-56 rounded-none p-0">
        <p className="border-b px-3 py-2 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          {scheduled ? "Snooze follow-up" : "Follow up"}
        </p>
        <div className="p-1">
          {QUICK_OPTIONS.map((option) => (
            <button
              key={option.label}
              type="button"
              disabled={pending}
              onClick={() => commit(() => setDealFollowUpAction(prospectId, atFollowUpHour(option.days)), `Follow-up set for ${option.label.toLowerCase()}`)}
              className="flex w-full items-center justify-between px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50"
            >
              {option.label}
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {new Date(atFollowUpHour(option.days)).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            </button>
          ))}
        </div>

        <Separator />
        <div className="flex items-center gap-1.5 p-2">
          <Input
            type="date"
            aria-label="Follow-up date"
            value={customDate}
            onChange={(event) => setCustomDate(event.target.value)}
            className="h-7 rounded-none text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !customDate}
            className="h-7 shrink-0 rounded-none px-2 text-xs"
            onClick={() => commit(() => setDealFollowUpAction(prospectId, fromDateInput(customDate)), "Follow-up set")}
          >
            Set
          </Button>
        </div>

        {scheduled ? (
          <>
            <Separator />
            <div className="p-1">
              <button
                type="button"
                disabled={pending}
                onClick={() => commit(() => completeDealFollowUpAction(prospectId, { kind: "call" }), "Call logged, follow-up cleared")}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs font-medium hover:bg-muted disabled:opacity-50"
              >
                <Check className="size-3.5 text-success" />
                Called — mark done
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => commit(() => setDealFollowUpAction(prospectId, null), "Follow-up cleared")}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                Clear without logging
              </button>
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
