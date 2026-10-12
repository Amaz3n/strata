"use client"

import { AlertTriangle, Lock } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { CONFIGURATION_LOCK_REASONS, type ConfigurationFix } from "@/lib/selections/configuration-fixes"
import type { ConfigurationViolation } from "@/lib/selections/configuration-rules"
import { formatMoneyCents } from "@/lib/utils"

function describe(violation: ConfigurationViolation) {
  return violation.kind === "requires"
    ? `${violation.sourceName} needs ${violation.targetName} on the same home.`
    : `${violation.sourceName} can't be combined with ${violation.targetName}.`
}

function priceDelta(cents: number) {
  if (cents === 0) return "No price change"
  return `${cents > 0 ? "+" : "−"}${formatMoneyCents(Math.abs(cents))}`
}

/**
 * The option rules a configuration breaks, each in a plain sentence, with the
 * corrections that would make it valid. A correction that would touch a locked
 * or committed choice is shown but cannot be applied here: it names the reason
 * and points to the change-order path. Applying calls back to the page, which
 * runs its existing mutation — the server re-checks locks and rules.
 */
export function ConfigurationIssues({
  violations,
  fixes,
  loading = false,
  error = null,
  pendingFixId = null,
  disabled = false,
  changeOrderHint,
  onApply,
}: {
  violations: ConfigurationViolation[]
  fixes: ConfigurationFix[]
  loading?: boolean
  error?: string | null
  pendingFixId?: string | null
  disabled?: boolean
  /** What to do about a blocked correction, e.g. "Contact your builder to request a change order." */
  changeOrderHint: string
  onApply: (fix: ConfigurationFix) => void
}) {
  if (loading) {
    return (
      <div className="space-y-2 border-l-2 border-l-border px-4 py-3" aria-busy="true">
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-8 w-full" />
      </div>
    )
  }
  if (error) {
    return (
      <p role="alert" className="flex items-start gap-2 border-l-2 border-l-destructive bg-destructive/5 px-4 py-3 text-xs text-destructive">
        <AlertTriangle className="mt-px size-3.5 shrink-0" />
        <span>Configuration rules could not be checked: {error}</span>
      </p>
    )
  }
  if (!violations.length) return null

  const shown = new Set<string>()
  return (
    <section role="alert" aria-label="Configuration issues" className="border-l-2 border-l-destructive bg-destructive/5">
      <ul className="divide-y divide-border">
        {violations.map((violation) => {
          const resolving = fixes.filter((fix) => fix.resolves.includes(violation.id))
          const own = resolving.filter((fix) => !shown.has(fix.id))
          own.forEach((fix) => shown.add(fix.id))
          const applicable = own.filter((fix) => fix.applicable)
          const blocked = own.filter((fix) => !fix.applicable)
          return (
            <li key={violation.id} className="space-y-2 px-4 py-3">
              <p className="flex items-start gap-2 text-[13px] font-medium text-foreground">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                <span>{describe(violation)}</span>
              </p>
              {applicable.length > 0 ? (
                <div className="flex flex-wrap gap-2 pl-5">
                  {applicable.map((fix) => (
                    <Button
                      key={fix.id}
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={disabled || pendingFixId !== null}
                      onClick={() => onApply(fix)}
                      className="h-auto gap-2 bg-background py-1.5 text-left"
                    >
                      {pendingFixId === fix.id ? <Spinner className="size-3.5" /> : null}
                      <span className="text-xs font-medium">{fix.label}</span>
                      <span className="text-[11px] tabular-nums text-muted-foreground">{priceDelta(fix.priceDeltaCents)}</span>
                    </Button>
                  ))}
                </div>
              ) : null}
              {blocked.map((fix) => (
                <p key={fix.id} className="flex items-start gap-2 pl-5 text-xs text-muted-foreground">
                  <Lock className="mt-px size-3.5 shrink-0" />
                  <span>
                    <span className="font-medium text-foreground">{fix.label}</span> needs a change order because{" "}
                    {fix.blockedBy ? CONFIGURATION_LOCK_REASONS[fix.blockedBy] : "it cannot be changed here"}. {changeOrderHint}
                  </span>
                </p>
              ))}
              {own.length === 0 ? (
                <p className="pl-5 text-xs text-muted-foreground">
                  {resolving.length > 0 ? "A correction above also fixes this." : "No single change fixes this — choose different options to resolve it."}
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
