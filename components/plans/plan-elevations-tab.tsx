"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Plus, Save } from "@/components/icons"
import { upsertElevationAction } from "@/app/(app)/plans/actions"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import type { HousePlanDto, HousePlanElevationDto } from "@/lib/services/house-plans"

type ElevationDraft = {
  name: string
  swingApplicable: boolean
  heatedSqftDelta: string
  isActive: boolean
}

function toDraft(elevation: HousePlanElevationDto): ElevationDraft {
  return {
    name: elevation.name ?? "",
    swingApplicable: elevation.swing_applicable,
    heatedSqftDelta: String(elevation.heated_sqft_delta),
    isActive: elevation.is_active,
  }
}

export function PlanElevationsTab({ plan, canWrite }: { plan: HousePlanDto; canWrite: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const elevations = plan.elevations ?? []
  const [drafts, setDrafts] = useState<Record<string, ElevationDraft>>(() =>
    Object.fromEntries(elevations.map((elevation) => [elevation.id, toDraft(elevation)])),
  )
  const [newCode, setNewCode] = useState("")
  const [newName, setNewName] = useState("")

  function patch(id: string, elevation: HousePlanElevationDto, patchValue: Partial<ElevationDraft>) {
    setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? toDraft(elevation)), ...patchValue } }))
  }

  function run(operation: () => Promise<unknown>, success: string) {
    startTransition(async () => {
      try {
        await operation()
        toast.success(success)
        router.refresh()
      } catch (error) {
        toast.error("Unable to save elevation", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function saveRow(elevation: HousePlanElevationDto) {
    const draft = drafts[elevation.id] ?? toDraft(elevation)
    run(
      async () =>
        unwrapAction(
          await upsertElevationAction(plan.id, {
            id: elevation.id,
            code: elevation.code,
            name: draft.name.trim() || null,
            swingApplicable: draft.swingApplicable,
            heatedSqftDelta: Math.round(Number(draft.heatedSqftDelta) || 0),
            isActive: draft.isActive,
            coverFileId: elevation.cover_file_id,
            sortOrder: elevation.sort_order,
          }),
        ),
      `Elevation ${elevation.code} saved`,
    )
  }

  function isDirty(elevation: HousePlanElevationDto): boolean {
    const draft = drafts[elevation.id]
    if (!draft) return false
    const original = toDraft(elevation)
    return (
      draft.name !== original.name ||
      draft.swingApplicable !== original.swingApplicable ||
      draft.isActive !== original.isActive ||
      (Number(draft.heatedSqftDelta) || 0) !== elevation.heated_sqft_delta
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Elevations are the exterior variants a buyer chooses. Takeoff deltas, community pricing, and lot pins all key off them — deactivate an elevation instead of deleting it.
      </p>
      <div className="overflow-x-auto border">
        <Table>
          <TableHeader>
            <TableRow className="text-[11px] uppercase tracking-wide">
              <TableHead className="w-20">Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-28">Swing</TableHead>
              <TableHead className="w-36 text-right">Heated sqft delta</TableHead>
              <TableHead className="w-24">Active</TableHead>
              {canWrite ? <TableHead className="w-24" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {elevations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={canWrite ? 6 : 5} className="h-28 text-center text-xs text-muted-foreground">
                  No elevations yet. Most production plans carry two to four (A, B, C…).
                </TableCell>
              </TableRow>
            ) : (
              elevations.map((elevation) => {
                const draft = drafts[elevation.id] ?? toDraft(elevation)
                return (
                  <TableRow key={elevation.id} className="text-xs">
                    <TableCell className="font-mono font-medium">{elevation.code}</TableCell>
                    <TableCell>
                      <Input
                        disabled={!canWrite}
                        className="h-8 rounded-none text-xs"
                        value={draft.name}
                        onChange={(event) => patch(elevation.id, elevation, { name: event.target.value })}
                        placeholder="Craftsman"
                      />
                    </TableCell>
                    <TableCell>
                      <label className="flex items-center gap-2">
                        <Checkbox
                          disabled={!canWrite}
                          checked={draft.swingApplicable}
                          onCheckedChange={(checked) => patch(elevation.id, elevation, { swingApplicable: checked === true })}
                        />
                        <span className="text-muted-foreground">{draft.swingApplicable ? "Left / right" : "Fixed"}</span>
                      </label>
                    </TableCell>
                    <TableCell>
                      <Input
                        disabled={!canWrite}
                        inputMode="numeric"
                        className="h-8 rounded-none text-right text-xs tabular-nums"
                        value={draft.heatedSqftDelta}
                        onChange={(event) => patch(elevation.id, elevation, { heatedSqftDelta: event.target.value })}
                      />
                    </TableCell>
                    <TableCell>
                      <Checkbox
                        disabled={!canWrite}
                        checked={draft.isActive}
                        onCheckedChange={(checked) => patch(elevation.id, elevation, { isActive: checked === true })}
                      />
                    </TableCell>
                    {canWrite ? (
                      <TableCell>
                        <Button size="sm" variant="outline" className="h-7 rounded-none text-xs" onClick={() => saveRow(elevation)} disabled={pending || !isDirty(elevation)}>
                          <Save className="mr-1 h-3.5 w-3.5" />
                          Save
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
      {canWrite ? (
        <form
          className="flex max-w-xl items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!newCode.trim() || pending) return
            run(
              async () =>
                unwrapAction(
                  await upsertElevationAction(plan.id, {
                    code: newCode,
                    name: newName.trim() || null,
                    swingApplicable: true,
                    heatedSqftDelta: 0,
                    isActive: true,
                    sortOrder: elevations.length,
                  }),
                ),
              "Elevation added",
            )
            setNewCode("")
            setNewName("")
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="elevation-code" className="text-xs">Code</Label>
            <Input id="elevation-code" className="h-8 w-20 rounded-none text-xs" value={newCode} onChange={(event) => setNewCode(event.target.value.toUpperCase())} placeholder="A" maxLength={2} />
          </div>
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="elevation-name" className="text-xs">Name <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input id="elevation-name" className="h-8 rounded-none text-xs" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Farmhouse" />
          </div>
          <Button type="submit" size="sm" className="rounded-none" disabled={pending || !newCode.trim()}>
            <Plus className="mr-1 h-4 w-4" />
            Add elevation
          </Button>
        </form>
      ) : null}
    </div>
  )
}
