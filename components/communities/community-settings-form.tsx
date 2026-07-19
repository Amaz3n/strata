"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { archiveCommunityAction, updateCommunityAction } from "@/app/(app)/communities/actions"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import type { CommunityDetailDTO } from "@/lib/services/communities"
import type { DivisionDTO } from "@/lib/services/divisions"

export function CommunitySettingsForm({ community, divisions, canWrite }: { community: CommunityDetailDTO; divisions: DivisionDTO[]; canWrite: boolean }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState(community.name)
  const [code, setCode] = useState(community.code ?? "")
  const [status, setStatus] = useState(community.status)
  const [divisionId, setDivisionId] = useState(community.divisionId ?? "none")
  const [plannedLotCount, setPlannedLotCount] = useState(community.plannedLotCount != null ? String(community.plannedLotCount) : "")
  const [address, setAddress] = useState(community.address ?? "")
  const [city, setCity] = useState(community.city ?? "")
  const [state, setState] = useState(community.state ?? "")
  const [postalCode, setPostalCode] = useState(community.postalCode ?? "")
  const [description, setDescription] = useState(community.description ?? "")

  function save() {
    startTransition(async () => {
      try {
        unwrapAction(await updateCommunityAction(community.id, {
          name,
          code: code || null,
          status,
          divisionId: divisionId === "none" ? null : divisionId,
          plannedLotCount: plannedLotCount ? Number(plannedLotCount) : null,
          address: address || null,
          city: city || null,
          state: state || null,
          postalCode: postalCode || null,
          description: description || null,
        }))
        toast.success("Community saved")
        router.refresh()
      } catch (error) {
        toast.error("Unable to save community", { description: (error as Error).message })
      }
    })
  }

  function archive() {
    startTransition(async () => {
      try {
        unwrapAction(await archiveCommunityAction(community.id))
        toast.success("Community archived")
        router.push("/communities")
      } catch (error) {
        toast.error("Unable to archive community", { description: (error as Error).message })
      }
    })
  }

  const activeDivisions = divisions.filter((division) => !division.archived)

  return (
    <div className="max-w-3xl space-y-8 p-4">
      <form
        id="community-settings"
        className="space-y-8"
        onSubmit={(event) => {
          event.preventDefault()
          if (name.trim() && !isPending && canWrite) save()
        }}
      >
        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold">Identity</h2>
            <p className="text-xs text-muted-foreground">How this community appears across Arc and on client documents.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5"><Label htmlFor="settings-name">Name</Label><Input id="settings-name" disabled={!canWrite} value={name} onChange={(event) => setName(event.target.value)} /></div>
            <div className="grid gap-1.5"><Label htmlFor="settings-code">Code</Label><Input id="settings-code" disabled={!canWrite} value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} maxLength={12} /></div>
            <div className="grid gap-1.5">
              <Label>Status</Label>
              <Select disabled={!canWrite} value={status} onValueChange={(value) => setStatus(value as CommunityDetailDTO["status"])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="planning">Planning</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="sold_out">Sold out</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {activeDivisions.length > 0 ? (
              <div className="grid gap-1.5">
                <Label>Division</Label>
                <Select disabled={!canWrite} value={divisionId} onValueChange={setDivisionId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Main</SelectItem>
                    {activeDivisions.map((division) => <SelectItem key={division.id} value={division.id}>{division.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="settings-planned">Planned lots</Label>
              <Input id="settings-planned" disabled={!canWrite} type="number" min={0} value={plannedLotCount} onChange={(event) => setPlannedLotCount(event.target.value)} />
              <p className="text-xs text-muted-foreground">Target buildout used for absorption tracking. Leave empty if unknown.</p>
            </div>
          </div>
        </section>

        <Separator />

        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold">Location</h2>
            <p className="text-xs text-muted-foreground">The community entrance or sales office address.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5 sm:col-span-2"><Label htmlFor="settings-address">Address</Label><Input id="settings-address" disabled={!canWrite} value={address} onChange={(event) => setAddress(event.target.value)} /></div>
            <div className="grid gap-1.5"><Label htmlFor="settings-city">City</Label><Input id="settings-city" disabled={!canWrite} value={city} onChange={(event) => setCity(event.target.value)} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label htmlFor="settings-state">State</Label><Input id="settings-state" disabled={!canWrite} value={state} onChange={(event) => setState(event.target.value)} /></div>
              <div className="grid gap-1.5"><Label htmlFor="settings-postal">Postal code</Label><Input id="settings-postal" disabled={!canWrite} value={postalCode} onChange={(event) => setPostalCode(event.target.value)} /></div>
            </div>
            <div className="grid gap-1.5 sm:col-span-2"><Label htmlFor="settings-description">Description</Label><Textarea id="settings-description" disabled={!canWrite} value={description} onChange={(event) => setDescription(event.target.value)} rows={4} /></div>
          </div>
        </section>
      </form>

      {canWrite ? (
        <>
          <div className="flex justify-end border-t pt-4">
            <Button form="community-settings" type="submit" disabled={isPending || !name.trim()}>{isPending ? "Saving…" : "Save changes"}</Button>
          </div>

          <section className="border border-destructive/30">
            <div className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <h2 className="text-sm font-semibold">Archive community</h2>
                <p className="text-xs text-muted-foreground">Removes the community from active lists. Existing lots and projects remain intact.</p>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" disabled={isPending}>Archive community</Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="rounded-none">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Archive {community.name}?</AlertDialogTitle>
                    <AlertDialogDescription>The community disappears from active lists and pipelines. Existing lots and projects remain intact.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction disabled={isPending} onClick={archive}>Archive</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </section>
        </>
      ) : null}
    </div>
  )
}
