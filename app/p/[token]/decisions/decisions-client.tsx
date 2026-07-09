"use client"

import { useState, useTransition } from "react"
import { format } from "date-fns"

import type { Decision } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"
import { decidePortalDecisionAction } from "./actions"

function costDeltaLabel(cents?: number | null) {
  if (cents == null || cents === 0) return "No cost change"
  const amount = `$${Math.abs(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`
  return cents > 0 ? `+${amount}` : `-${amount}`
}

function statusBadge(status: string) {
  if (status === "approved") return <Badge variant="secondary">Approved</Badge>
  if (status === "declined") return <Badge variant="destructive">Declined</Badge>
  return <Badge variant="outline">Awaiting your decision</Badge>
}

export function DecisionsPortalClient({
  token,
  decisions: initialDecisions,
}: {
  token: string
  decisions: Decision[]
}) {
  const { toast } = useToast()
  const [decisions, setDecisions] = useState(initialDecisions)
  const [active, setActive] = useState<Decision | null>(null)
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [isPending, startTransition] = useTransition()

  const openDecision = (decision: Decision) => {
    setActive(decision)
    setSelectedOptionId(decision.options[0]?.id ?? null)
    setNote("")
  }

  const submit = (approve: boolean) => {
    if (!active) return
    if (approve && active.options.length > 0 && !selectedOptionId) {
      toast({ title: "Pick an option", description: "Select one of the options to approve." })
      return
    }
    startTransition(async () => {
      try {
        const updated = await decidePortalDecisionAction(token, {
          decision_id: active.id,
          approve,
          selected_option_id: approve ? selectedOptionId : null,
          note: note.trim() || null,
        })
        setDecisions((prev) => prev.map((d) => (d.id === updated.id ? updated : d)))
        setActive(null)
        toast({
          title: approve ? "Decision approved" : "Decision declined",
          description: "Your builder has been notified.",
        })
      } catch (error) {
        toast({
          title: "Could not record your decision",
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  const pending = decisions.filter((d) => d.status === "pending")
  const decided = decisions.filter((d) => d.status !== "pending")

  return (
    <div className="min-h-screen bg-background px-4 py-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Decisions</p>
          <h1 className="text-2xl font-bold">Your decisions</h1>
          <p className="text-sm text-muted-foreground">
            Approvals your builder needs from you to keep the project moving.
          </p>
        </header>

        {decisions.length === 0 && (
          <Card>
            <CardContent className="p-6 text-center text-muted-foreground">
              Nothing needs your attention right now.
            </CardContent>
          </Card>
        )}

        {pending.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Waiting on you</h2>
            {pending.map((decision) => (
              <Card key={decision.id}>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-base">{decision.title}</CardTitle>
                  {statusBadge(decision.status)}
                </CardHeader>
                <CardContent className="space-y-3">
                  {decision.description && (
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap">{decision.description}</p>
                  )}
                  {decision.due_date && (
                    <p className="text-xs text-muted-foreground">
                      Needed by {format(new Date(`${decision.due_date}T00:00:00`), "MMM d, yyyy")}
                    </p>
                  )}
                  <Button size="sm" onClick={() => openDecision(decision)}>
                    Review & decide
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {decided.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Decided</h2>
            {decided.map((decision) => {
              const selected = decision.options.find((option) => option.id === decision.selected_option_id)
              return (
                <Card key={decision.id}>
                  <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="text-base">{decision.title}</CardTitle>
                    {statusBadge(decision.status)}
                  </CardHeader>
                  <CardContent className="space-y-1">
                    {selected && (
                      <p className="text-sm">
                        Selected: <span className="font-medium">{selected.label}</span>
                        {" · "}
                        <span className="text-muted-foreground">{costDeltaLabel(selected.cost_delta_cents)}</span>
                      </p>
                    )}
                    {decision.decision_note && (
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap">{decision.decision_note}</p>
                    )}
                    {decision.approved_at && (
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(decision.approved_at), "MMM d, yyyy")}
                      </p>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <Dialog open={!!active} onOpenChange={(open) => (open ? null : setActive(null))}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{active?.title}</DialogTitle>
            {active?.description && <DialogDescription>{active.description}</DialogDescription>}
          </DialogHeader>

          <div className="space-y-4">
            {active && active.options.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Options</p>
                {active.options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setSelectedOptionId(option.id)}
                    className={cn(
                      "w-full border p-3 text-left transition-colors",
                      selectedOptionId === option.id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/50",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{option.label}</span>
                      <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                        {costDeltaLabel(option.cost_delta_cents)}
                      </span>
                    </div>
                    {option.description && (
                      <p className="mt-1 text-xs text-muted-foreground">{option.description}</p>
                    )}
                  </button>
                ))}
              </div>
            )}

            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note for your builder (optional)"
              rows={3}
            />

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => submit(false)} disabled={isPending}>
                Decline
              </Button>
              <Button onClick={() => submit(true)} disabled={isPending}>
                {isPending ? "Saving..." : "Approve"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
