"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { archiveCommunityAction, updateCommunityAction } from "@/app/(app)/communities/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
  const [address, setAddress] = useState(community.address ?? "")
  const [city, setCity] = useState(community.city ?? "")
  const [state, setState] = useState(community.state ?? "")
  const [postalCode, setPostalCode] = useState(community.postalCode ?? "")
  const [description, setDescription] = useState(community.description ?? "")

  function save() {
    startTransition(async () => {
      try { unwrapAction(await updateCommunityAction(community.id, { name, code: code || null, status, divisionId: divisionId === "none" ? null : divisionId, address: address || null, city: city || null, state: state || null, postalCode: postalCode || null, description: description || null })); toast.success("Community saved"); router.refresh() }
      catch (error) { toast.error("Unable to save community", { description: (error as Error).message }) }
    })
  }

  function archive() {
    if (!window.confirm("Archive this community? Existing lots and projects remain intact.")) return
    startTransition(async () => {
      try { unwrapAction(await archiveCommunityAction(community.id)); toast.success("Community archived"); router.push("/communities") }
      catch (error) { toast.error("Unable to archive community", { description: (error as Error).message }) }
    })
  }

  return <div className="max-w-3xl space-y-6 p-4"><div className="grid gap-4 sm:grid-cols-2"><div className="grid gap-1.5"><Label>Name</Label><Input disabled={!canWrite} value={name} onChange={(event) => setName(event.target.value)} /></div><div className="grid gap-1.5"><Label>Code</Label><Input disabled={!canWrite} value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} maxLength={12} /></div><div className="grid gap-1.5"><Label>Status</Label><Select disabled={!canWrite} value={status} onValueChange={(value) => setStatus(value as CommunityDetailDTO["status"])}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="planning">Planning</SelectItem><SelectItem value="active">Active</SelectItem><SelectItem value="sold_out">Sold out</SelectItem><SelectItem value="closed">Closed</SelectItem></SelectContent></Select></div>{divisions.length > 0 ? <div className="grid gap-1.5"><Label>Division</Label><Select disabled={!canWrite} value={divisionId} onValueChange={setDivisionId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Main</SelectItem>{divisions.filter((division) => !division.archived).map((division) => <SelectItem key={division.id} value={division.id}>{division.name}</SelectItem>)}</SelectContent></Select></div> : null}<div className="sm:col-span-2 grid gap-1.5"><Label>Address</Label><Input disabled={!canWrite} value={address} onChange={(event) => setAddress(event.target.value)} /></div><div className="grid gap-1.5"><Label>City</Label><Input disabled={!canWrite} value={city} onChange={(event) => setCity(event.target.value)} /></div><div className="grid grid-cols-2 gap-3"><div className="grid gap-1.5"><Label>State</Label><Input disabled={!canWrite} value={state} onChange={(event) => setState(event.target.value)} /></div><div className="grid gap-1.5"><Label>Postal code</Label><Input disabled={!canWrite} value={postalCode} onChange={(event) => setPostalCode(event.target.value)} /></div></div><div className="sm:col-span-2 grid gap-1.5"><Label>Description</Label><Textarea disabled={!canWrite} value={description} onChange={(event) => setDescription(event.target.value)} rows={4} /></div></div>{canWrite ? <div className="flex justify-between border-t pt-4"><Button variant="destructive" disabled={isPending} onClick={archive}>Archive community</Button><Button disabled={isPending || !name.trim()} onClick={save}>{isPending ? "Saving…" : "Save changes"}</Button></div> : null}</div>
}
