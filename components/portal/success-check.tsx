import { cn } from "@/lib/utils"

/**
 * A check that draws itself once, on first paint — no state, no trigger, no
 * replay. Rendering it *is* the trigger, so only render it on the arrival that
 * earned it (a redirect back from a completed flow), never on a surface the
 * reader returns to. Expressive zone only; `app/(app)` does not celebrate.
 */
export function SuccessCheck({ className }: { className?: string }) {
  return (
    <span className={cn("success-check text-success", className)} aria-hidden>
      <svg viewBox="0 0 24 24" fill="none" className="size-8">
        <path
          d="M20 6 9 17l-5-5"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}
