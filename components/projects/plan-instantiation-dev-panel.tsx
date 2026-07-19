"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"

import { instantiatePlanDevAction, listPlanInstantiationOptionsAction } from "@/app/(app)/projects/[id]/plan-instantiation-actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { unwrapAction } from "@/lib/action-result"
import type { PlanInstantiationOption } from "@/lib/services/plan-instantiation"

export function PlanInstantiationDevPanel({ projectId }: { projectId: string }) {
  const [options, setOptions] = useState<PlanInstantiationOption[]>([])
  const [selected, setSelected] = useState("")
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10))
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ warnings: string[]; errors: string[] } | null>(null)

  useEffect(() => {
    let active = true
    listPlanInstantiationOptionsAction(projectId).then((response) => {
      if (!active) return
      try {
        const rows = unwrapAction(response)
        setOptions(rows)
        setSelected(rows[0] ? `${rows[0].versionId}:${rows[0].elevationId ?? "base"}` : "")
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not load plan options")
      } finally {
        setLoading(false)
      }
    })
    return () => { active = false }
  }, [projectId])

  const execute = async (dryRun: boolean) => {
    const option = options.find((item) => `${item.versionId}:${item.elevationId ?? "base"}` === selected)
    if (!option) return
    setRunning(true)
    try {
      const output = unwrapAction(await instantiatePlanDevAction({
        projectId,
        lotId: option.lotId,
        housePlanVersionId: option.versionId,
        elevationId: option.elevationId,
        communityId: option.communityId,
        startDate,
        dryRun,
      }))
      setResult(output)
      if (output.success) toast.success(dryRun ? "Plan validation passed" : "Plan instantiated")
      else toast.error("Instantiation completed with step errors")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Instantiation failed")
    } finally {
      setRunning(false)
    }
  }

  return <div className="mt-6 space-y-3 border border-dashed p-3">
    <div><Label>Developer: instantiate plan</Label><p className="text-xs text-muted-foreground">Temporary QA trigger; WS05 replaces this with start release.</p></div>
    {loading ? <p className="text-sm text-muted-foreground">Loading released plans…</p> : options.length === 0 ? <p className="text-sm text-muted-foreground">Link this project to a lot with an available released plan first.</p> : <>
      <Select value={selected} onValueChange={setSelected}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={`${option.versionId}:${option.elevationId ?? "base"}`} value={`${option.versionId}:${option.elevationId ?? "base"}`}>{option.planCode} · {option.planName} · v{option.versionNumber}{option.elevationCode ? ` · Elev ${option.elevationCode}` : ""}</SelectItem>)}</SelectContent></Select>
      <div className="space-y-1"><Label>Schedule start</Label><Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></div>
      <div className="flex gap-2"><Button type="button" variant="outline" onClick={() => void execute(true)} disabled={running}>Dry run</Button><Button type="button" onClick={() => void execute(false)} disabled={running}>{running ? "Running…" : "Instantiate plan"}</Button></div>
      {result ? <div className="text-xs"><p>{result.warnings.length} warnings · {result.errors.length} errors</p>{[...result.warnings, ...result.errors].map((message) => <p key={message} className="text-muted-foreground">{message}</p>)}</div> : null}
    </>}
  </div>
}
