"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import type { ThroughputWeekDTO } from "@/lib/services/even-flow"
import type { SuperintendentCandidateDTO } from "@/lib/services/starts"
import { cn } from "@/lib/utils"
import { clearSuperintendentLimitsAction, setSuperintendentLimitsAction, setThroughputTargetAction } from "@/app/(app)/starts/actions"

interface Props {
  weeks: string[]
  divisions: Array<{ id: string; name: string }>
  /** Division targets are shown only for divisions the reader reaches; the org column only when their reach is the whole org. */
  showOrgTarget: boolean
  throughput: ThroughputWeekDTO[]
  superintendents: SuperintendentCandidateDTO[]
  defaultLimits: { warn: number; max: number; configured: boolean }
  canSetTargets: boolean
  canSetLimits: boolean
}

function formatWeek(value: string) {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
}

export function StartCapacitySettings({ weeks, divisions, showOrgTarget, throughput, superintendents, defaultLimits, canSetTargets, canSetLimits }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [limitDrafts, setLimitDrafts] = useState<Record<string, { warn: string; max: string }>>({})

  const scopes = [...(showOrgTarget ? [{ id: null, name: "Organization" }] : []), ...divisions.map((division) => ({ id: division.id, name: division.name }))]
  const targetFor = (weekStart: string, divisionId: string | null) => throughput.find((entry) => entry.weekStart === weekStart && entry.divisionId === divisionId)

  const run = (operation: () => Promise<unknown>, success: string, failure: string) => {
    startTransition(async () => {
      try {
        await operation()
        toast.success(success)
        router.refresh()
      } catch (error) {
        toast.error(failure, { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  const saveTarget = (weekStart: string, divisionId: string | null, raw: string, current: number | undefined) => {
    const value = raw.trim() === "" ? null : Number(raw)
    if (value === (current ?? null)) return
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 500)) {
      toast.error("A target is a whole number from 0 to 500, or empty for no cap")
      return
    }
    run(async () => { unwrapAction(await setThroughputTargetAction({ weekStart, divisionId, targetStarts: value })) }, "Throughput target saved", "Unable to save the target")
  }

  const saveLimits = (userId: string | null, key: string, current: { warn: number; max: number }) => {
    const draft = limitDrafts[key] ?? { warn: String(current.warn), max: String(current.max) }
    run(async () => {
      unwrapAction(await setSuperintendentLimitsAction({ userId, warnHouses: Number(draft.warn), maxHouses: Number(draft.max) }))
      setLimitDrafts((drafts) => Object.fromEntries(Object.entries(drafts).filter(([draftKey]) => draftKey !== key)))
    }, "Limits saved", "Unable to save the limits")
  }

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Throughput targets</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          The most houses a division, or the whole organization, starts in a week, across every community in it. A release past a target needs a reason. Empty means no cap.
        </p>
        {scopes.length === 0 ? (
          <p className="border p-6 text-center text-sm text-muted-foreground">No divisions to set a target for.</p>
        ) : (
          <div className="overflow-x-auto border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Week of</TableHead>
                  {scopes.map((scope) => <TableHead key={scope.id ?? "org"} className="text-right">{scope.name}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {weeks.map((week) => (
                  <TableRow key={week}>
                    <TableCell className="tabular-nums">{formatWeek(week)}</TableCell>
                    {scopes.map((scope) => {
                      const entry = targetFor(week, scope.id)
                      return (
                        <TableCell key={scope.id ?? "org"} className="text-right">
                          <Input
                            key={`${week}:${scope.id}:${entry?.target ?? ""}`}
                            type="number" min={0} max={500} inputMode="numeric" aria-label={`${scope.name} target, week of ${formatWeek(week)}`}
                            className="ml-auto h-7 w-20 rounded-none text-right tabular-nums"
                            defaultValue={entry?.target ?? ""} disabled={!canSetTargets || pending}
                            onBlur={(event) => saveTarget(week, scope.id, event.target.value, entry?.target)}
                          />
                          {entry ? <span className={cn("mt-0.5 block text-[10px] tabular-nums", entry.filled > entry.target ? "text-destructive" : "text-muted-foreground")}>{entry.filled} filled</span> : null}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Superintendent limits</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Houses a superintendent runs before they are stretched (warning) and before another needs a releaser&rsquo;s reason (limit). A person without their own numbers follows the organization default.
        </p>
        <div className="overflow-x-auto border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Superintendent</TableHead>
                <TableHead className="text-right">Houses</TableHead>
                <TableHead className="text-right">Warn at</TableHead>
                <TableHead className="text-right">Limit</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {[{ id: null as string | null, name: `Organization default${defaultLimits.configured ? "" : " (built in)"}`, activeHouses: null as number | null, warnAt: defaultLimits.warn, limit: defaultLimits.max }, ...superintendents.map((person) => ({ id: person.id as string | null, name: person.name, activeHouses: person.activeHouses as number | null, warnAt: person.warnAt, limit: person.limit }))].map((row) => {
                const key = row.id ?? "org"
                const draft = limitDrafts[key] ?? { warn: String(row.warnAt), max: String(row.limit) }
                const dirty = draft.warn !== String(row.warnAt) || draft.max !== String(row.limit)
                const set = (patch: Partial<{ warn: string; max: string }>) => setLimitDrafts((drafts) => ({ ...drafts, [key]: { ...draft, ...patch } }))
                return (
                  <TableRow key={key}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.activeHouses ?? "—"}</TableCell>
                    <TableCell className="text-right"><Input type="number" min={1} max={100} aria-label={`${row.name} warning`} className="ml-auto h-7 w-20 rounded-none text-right tabular-nums" value={draft.warn} disabled={!canSetLimits || pending} onChange={(event) => set({ warn: event.target.value })} /></TableCell>
                    <TableCell className="text-right"><Input type="number" min={1} max={100} aria-label={`${row.name} limit`} className="ml-auto h-7 w-20 rounded-none text-right tabular-nums" value={draft.max} disabled={!canSetLimits || pending} onChange={(event) => set({ max: event.target.value })} /></TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="outline" className="h-7 rounded-none px-2 text-[11px]" disabled={!canSetLimits || pending || !dirty} onClick={() => saveLimits(row.id, key, { warn: row.warnAt, max: row.limit })}>Save</Button>
                        {row.id ? (
                          <Button size="sm" variant="ghost" className="h-7 rounded-none px-2 text-[11px]" disabled={!canSetLimits || pending}
                            onClick={() => run(async () => { unwrapAction(await clearSuperintendentLimitsAction(row.id as string)) }, "Back to the default", "Unable to clear the limits")}>
                            Use default
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
              {superintendents.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">Nobody in this org holds a field role yet.</TableCell></TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  )
}
