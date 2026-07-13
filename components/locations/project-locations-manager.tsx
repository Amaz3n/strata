"use client"

import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"
import { unwrapAction } from "@/lib/action-result"
import {
  bulkCreateLocationsAction,
  createLocationAction,
  setLocationActiveAction,
  updateLocationAction,
} from "@/app/(app)/projects/[id]/locations/actions"
import type { ProjectLocation } from "@/lib/services/locations"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

export function ProjectLocationsManager({ projectId, initialLocations }: { projectId: string; initialLocations: ProjectLocation[] }) {
  const [locations, setLocations] = useState(initialLocations)
  const [name, setName] = useState("")
  const [parentId, setParentId] = useState("__root__")
  const [bulkText, setBulkText] = useState("")
  const [pending, startTransition] = useTransition()
  useEffect(() => setLocations(initialLocations), [initialLocations])

  const reload = () => window.dispatchEvent(new Event("arc-org-change"))
  const run = (work: () => Promise<void>) => startTransition(() => void work().catch((error) => toast.error(error instanceof Error ? error.message : "Could not update locations")))

  return (
    <div className="space-y-3 border-t pt-5">
      <div>
        <Label className="text-sm">Locations</Label>
        <p className="mt-1 text-xs text-muted-foreground">Build the job hierarchy used by punch, inspections, safety, and daily logs.</p>
      </div>
      {locations.length === 0 ? <p className="border px-3 py-4 text-sm text-muted-foreground">No locations yet — paste your building/floor list</p> : (
        <div className="divide-y border">
          {locations.map((location) => (
            <div key={location.id} className="flex items-center gap-2 px-3 py-2" style={{ paddingLeft: `${12 + location.depth * 16}px` }}>
              <Input
                className="h-8 flex-1"
                defaultValue={location.name}
                disabled={pending}
                onBlur={(event) => {
                  const next = event.currentTarget.value.trim()
                  if (!next || next === location.name) return
                  run(async () => {
                    const updated = unwrapAction(await updateLocationAction(projectId, location.id, { name: next }))
                    const oldPrefix = location.full_path
                    setLocations((current) => current.map((row) => row.id === updated.id ? updated : row.full_path.startsWith(`${oldPrefix} > `) ? { ...row, full_path: `${updated.full_path}${row.full_path.slice(oldPrefix.length)}` } : row))
                    toast.success("Location renamed")
                    reload()
                  })
                }}
              />
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => run(async () => {
                await unwrapAction(await setLocationActiveAction(projectId, location.id, !location.is_active))
                setLocations((current) => current.map((row) => row.id === location.id ? { ...row, is_active: !row.is_active } : row))
                toast.success(location.is_active ? "Location deactivated" : "Location activated")
                reload()
              })}>{location.is_active ? "Deactivate" : "Activate"}</Button>
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-[1fr_180px_auto]">
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Add location" disabled={pending} />
        <Select value={parentId} onValueChange={setParentId} disabled={pending}>
          <SelectTrigger><SelectValue placeholder="Parent" /></SelectTrigger>
          <SelectContent><SelectItem value="__root__">Top level</SelectItem>{locations.filter((location) => location.is_active).map((location) => <SelectItem key={location.id} value={location.id}>{location.full_path}</SelectItem>)}</SelectContent>
        </Select>
        <Button type="button" disabled={pending || !name.trim()} onClick={() => run(async () => {
          const created = unwrapAction(await createLocationAction(projectId, { name, parent_id: parentId === "__root__" ? null : parentId }))
          setLocations((current) => [...current, created])
          setName("")
          toast.success("Location added")
          reload()
        })}>Add</Button>
      </div>
      <div className="space-y-2">
        <Label className="text-xs">Bulk paste (two spaces per level)</Label>
        <Textarea value={bulkText} onChange={(event) => setBulkText(event.target.value)} rows={5} placeholder={"Building A\n  Level 1\n    Corridor\n  Level 2"} disabled={pending} />
        <Button type="button" variant="outline" disabled={pending || !bulkText.trim()} onClick={() => run(async () => {
          const created = unwrapAction(await bulkCreateLocationsAction(projectId, bulkText))
          setLocations((current) => [...current, ...created])
          setBulkText("")
          toast.success(`${created.length} locations added`)
          reload()
        })}>Add pasted locations</Button>
      </div>
    </div>
  )
}

