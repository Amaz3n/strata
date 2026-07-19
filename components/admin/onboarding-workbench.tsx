"use client"

import Link from "next/link"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { AlertTriangle, CheckCircle2, ChevronDown, Circle, Clock, ExternalLink, Flag } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction, type ActionResult } from "@/lib/action-result"
import { ONBOARDING_READINESS_ITEMS } from "@/lib/data/onboarding-readiness"

type Stage = {
  definition: { key: string; label: string; owner: string; importer?: string; skippable: boolean; help: string }
  state: { status: string; notes?: string; evidence?: Record<string, unknown> }
  gates: Array<{ key: string; passed: boolean; message: string; count?: number }>
}

type ReadinessAuditItem = { key: string; passed: boolean; verified_by?: string; volume?: string }
type Run = { id: string; status: string; target_live_date?: string | null; notes?: string | null; readiness_audit?: ReadinessAuditItem[] }

interface Props {
  org: { id: string; name: string; slug: string; product_tier: string }
  run: Run
  stages: Stage[]
  onComplete: (formData: FormData) => Promise<ActionResult<unknown>>
  onSkip: (formData: FormData) => Promise<ActionResult<unknown>>
  onUpdate: (formData: FormData) => Promise<ActionResult<unknown>>
  onMarkLive: (formData: FormData) => Promise<ActionResult<unknown>>
  onResetSample: (formData: FormData) => Promise<ActionResult<unknown>>
}

function StatusMark({ status }: { status: string }) {
  if (status === "done") return <CheckCircle2 className="size-4 text-success" />
  if (status === "skipped") return <Circle className="size-4 text-muted-foreground" />
  if (status === "in_progress") return <Clock className="size-4 text-primary" />
  return <Circle className="size-4 text-muted-foreground/60" />
}

export function OnboardingWorkbench({ org, run, stages, onComplete, onSkip, onUpdate, onMarkLive, onResetSample }: Props) {
  const [busy, startTransition] = useTransition()
  const [openStage, setOpenStage] = useState<string | null>(stages.find((stage) => stage.state.status === "in_progress")?.definition.key ?? null)

  const submit = (formData: FormData, action: (data: FormData) => Promise<ActionResult<unknown>>, success: string) => {
    startTransition(async () => {
      try {
        unwrapAction(await action(formData))
        toast.success(success)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to update onboarding")
      }
    })
  }

  const completed = stages.filter((stage) => ["done", "skipped"].includes(stage.state.status)).length

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{org.name}</h1>
            <Badge variant={run.status === "live" ? "default" : "secondary"}>{run.status}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Production onboarding · {completed} of {stages.length} stages resolved</p>
        </div>
        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline"><Link href="/admin/customers">Customer desk</Link></Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => {
            if (!window.confirm("Reset Cypress Landing sample data? Only entities marked as sample will be replaced.")) return
            const data = new FormData(); data.set("orgId", org.id); submit(data, onResetSample, "Sample community reset")
          }}>Reset sample community</Button>
          {run.status === "active" ? (
            <Button size="sm" disabled={busy || completed !== stages.length} onClick={() => {
              const data = new FormData(); data.set("runId", run.id); data.set("orgId", org.id); submit(data, onMarkLive, "Onboarding marked live")
            }}><Flag /> Mark live</Button>
          ) : null}
        </div>
      </div>

      <form action={(data) => submit(data, onUpdate, "Run details saved")} className="grid gap-3 border bg-muted/10 p-4 md:grid-cols-[180px_1fr_auto]">
        <input type="hidden" name="runId" value={run.id} /><input type="hidden" name="orgId" value={org.id} />
        <label className="space-y-1 text-xs font-medium">Target live date<Input name="targetLiveDate" type="date" defaultValue={run.target_live_date ?? ""} /></label>
        <label className="space-y-1 text-xs font-medium">Run notes<Input name="notes" defaultValue={run.notes ?? ""} placeholder="Pilot scope, controller decision, rollout wave notes…" /></label>
        <Button type="submit" size="sm" variant="outline" className="self-end" disabled={busy}>Save</Button>
      </form>

      <details className="border bg-muted/10">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Scale-readiness audit · {(run.readiness_audit ?? []).filter((item) => item.passed).length}/15 passed</summary>
        <form action={(data) => submit(data, onUpdate, "Readiness audit saved")} className="space-y-4 border-t p-4">
          <input type="hidden" name="runId" value={run.id} /><input type="hidden" name="orgId" value={org.id} /><input type="hidden" name="readinessAuditSubmitted" value="true" />
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-xs font-medium">Verified by<Input name="readinessVerifiedBy" required defaultValue={run.readiness_audit?.[0]?.verified_by ?? ""} placeholder="Name or team" /></label>
            <label className="space-y-1 text-xs font-medium">Test volume<Input name="readinessVolume" required defaultValue={run.readiness_audit?.[0]?.volume ?? ""} placeholder="250 projects / 400 lots" /></label>
          </div>
          <div className="divide-y border">
            {ONBOARDING_READINESS_ITEMS.map(([key, label], index) => (
              <label key={key} className="grid grid-cols-[28px_20px_minmax(0,1fr)] items-center gap-2 px-3 py-2 text-sm">
                <span className="text-xs tabular-nums text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                <input type="checkbox" name="readinessPassed" value={key} defaultChecked={run.readiness_audit?.some((item) => item.key === key && item.passed)} className="size-4 accent-primary" />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={busy}>Save audit evidence</Button>
        </form>
      </details>

      <div className="divide-y border">
        {stages.map((stage, index) => {
          const failing = stage.gates.filter((gate) => !gate.passed)
          const evidence = Object.entries(stage.state.evidence ?? {}).map(([key, value]) => `${key.replace(/_/g, " ")}: ${String(value)}`).join(" · ")
          return (
            <Collapsible key={stage.definition.key} open={openStage === stage.definition.key} onOpenChange={(open) => setOpenStage(open ? stage.definition.key : null)}>
              <CollapsibleTrigger className="grid w-full grid-cols-[32px_24px_minmax(0,1fr)_auto_auto] items-center gap-2 px-3 py-3 text-left hover:bg-muted/30">
                <span className="text-xs tabular-nums text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                <StatusMark status={stage.state.status} />
                <span className="min-w-0"><span className="block text-sm font-medium">{stage.definition.label}</span><span className="block truncate text-xs text-muted-foreground">{evidence || stage.definition.help}</span></span>
                <Badge variant="outline" className="hidden sm:inline-flex">{stage.definition.owner.replace("_", " ")}</Badge>
                <ChevronDown className={`size-4 text-muted-foreground transition-transform ${openStage === stage.definition.key ? "rotate-180" : ""}`} />
              </CollapsibleTrigger>
              <CollapsibleContent className="border-t bg-muted/10 px-4 py-4">
                <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Validation gates</p>
                    {stage.gates.length === 0 ? <p className="text-sm text-muted-foreground">No automated gates for this stage.</p> : stage.gates.map((gate) => (
                      <div key={gate.key} className="flex items-start gap-2 text-sm">
                        {gate.passed ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />}
                        <span className={gate.passed ? "text-foreground" : "text-muted-foreground"}>{gate.message}</span>
                      </div>
                    ))}
                    {stage.definition.importer ? (
                      <Button asChild size="sm" variant="outline" className="mt-2"><Link href={`/admin/customers/${org.id}/onboarding/import/${stage.definition.importer}`}>Open importer <ExternalLink /></Link></Button>
                    ) : null}
                  </div>
                  {run.status === "active" && !["done", "skipped"].includes(stage.state.status) ? (
                    <div className="space-y-3 border-l pl-4">
                      <form action={(data) => submit(data, onComplete, `${stage.definition.label} completed`)} className="space-y-2">
                        <input type="hidden" name="runId" value={run.id} /><input type="hidden" name="orgId" value={org.id} /><input type="hidden" name="stageKey" value={stage.definition.key} />
                        <Textarea name="notes" rows={2} placeholder="Completion notes or evidence context" />
                        {stage.definition.key === "pilot_live" ? <Input name="evidence" placeholder='{"arc_native_project_id":"uuid"}' /> : null}
                        <Button type="submit" size="sm" disabled={busy || failing.length > 0}>Mark done</Button>
                      </form>
                      {stage.definition.skippable ? (
                        <form action={(data) => submit(data, onSkip, `${stage.definition.label} skipped`)} className="space-y-2 border-t pt-3">
                          <input type="hidden" name="runId" value={run.id} /><input type="hidden" name="orgId" value={org.id} /><input type="hidden" name="stageKey" value={stage.definition.key} />
                          <Input name="reason" placeholder="Required skip reason" required minLength={3} />
                          <Button type="submit" size="sm" variant="outline" disabled={busy}>Skip stage</Button>
                        </form>
                      ) : null}
                    </div>
                  ) : <div className="text-sm text-muted-foreground">{stage.state.notes || "Stage resolved."}</div>}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )
        })}
      </div>
    </div>
  )
}
