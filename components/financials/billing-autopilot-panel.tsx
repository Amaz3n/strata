"use client"

import { useState, useTransition } from "react"
import { Bot, CheckCircle2, RefreshCw, ShieldAlert } from "lucide-react"
import { toast } from "sonner"

import { prepareBillingAutopilotAction } from "@/app/(app)/projects/[id]/financials/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { BillingAutopilotState } from "@/lib/services/billing-autopilot"

import { unwrapAction } from "@/lib/action-result"

export function BillingAutopilotPanel({
  projectId,
  initialState,
}: {
  projectId: string
  initialState: BillingAutopilotState
}) {
  const [state, setState] = useState(initialState)
  const [isPending, startTransition] = useTransition()

  if (!state.enabled) return null

  function analyze() {
    startTransition(async () => {
      try {
        const next = await prepareBillingAutopilotAction(projectId)
        setState(next)
        toast.success("Arc Autopilot analysis refreshed")
      } catch (error) {
        toast.error("Unable to run Arc Autopilot", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  const run = state.run
  const readyCount = run?.items.filter((item) => item.status === "suggested").length ?? 0

  return (
    <section className="border-b bg-slate-950 px-4 py-4 text-slate-50 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 rounded-md bg-white/10 p-2">
            <Bot className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold">Arc Autopilot</h2>
              <Badge className="border-white/15 bg-white/10 text-slate-100 hover:bg-white/10">Experimental</Badge>
              {run ? <span className="text-xs text-slate-400">{run.billing_model.replaceAll("_", " ")}</span> : null}
            </div>
            <p className="mt-1 text-sm text-slate-300">
              {run
                ? `${readyCount} billing opportunities ready, ${run.blocker_count} requiring attention. Nothing is posted or sent automatically.`
                : "Analyze the project billing model, evidence, and contractual triggers before preparing an invoice."}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {run ? (
            <>
              <div className="text-right">
                <div className="text-lg font-semibold">{formatMoney(run.proposed_invoice_cents)}</div>
                <div className="text-xs text-slate-400">{run.readiness_score}% readiness</div>
              </div>
              {run.blocker_count > 0 ? (
                <ShieldAlert className="h-5 w-5 text-amber-300" />
              ) : (
                <CheckCircle2 className="h-5 w-5 text-emerald-300" />
              )}
            </>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={isPending}
            onClick={analyze}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
            {run ? "Refresh analysis" : "Analyze billing"}
          </Button>
        </div>
      </div>

      {run?.items.length ? (
        <div className="mt-4 grid gap-2 lg:grid-cols-3">
          {run.items.slice(0, 6).map((item) => (
            <div key={item.id ?? `${item.item_type}-${item.source_id ?? item.title}`} className="border border-white/10 bg-white/[0.04] p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm font-medium">{item.title}</div>
                <Badge
                  className={
                    item.status === "suggested"
                      ? "bg-emerald-400/15 text-emerald-200 hover:bg-emerald-400/15"
                      : item.status === "blocked"
                        ? "bg-red-400/15 text-red-200 hover:bg-red-400/15"
                        : "bg-amber-400/15 text-amber-100 hover:bg-amber-400/15"
                  }
                >
                  {item.status === "suggested" ? "Ready" : item.status === "blocked" ? "Blocked" : "Review"}
                </Badge>
              </div>
              <div className="mt-2 text-sm font-semibold">{formatMoney(item.amount_cents)}</div>
              {item.description ? <p className="mt-1 line-clamp-2 text-xs text-slate-400">{item.description}</p> : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}
