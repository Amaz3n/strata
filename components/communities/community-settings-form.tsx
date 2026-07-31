"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { archiveCommunityAction, updateCommunityAction } from "@/app/(app)/communities/actions"
import { RowControl, SettingsGroup, SettingsField } from "@/components/settings/settings-section"
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import type { CommunityDetailDTO } from "@/lib/services/communities"
import type { DivisionDTO } from "@/lib/services/divisions"

const STATUS_LABEL: Record<CommunityDetailDTO["status"], string> = {
  planning: "Planning",
  active: "Active",
  sold_out: "Sold out",
  closed: "Closed",
}

type EditKey = "identity" | "targets" | "location"

/**
 * Community settings in the same language as `/settings`: microlabel groups,
 * read-only rows, and editing in a dialog. It used to be one long form with a
 * single Save at the bottom, which meant a typo in the postcode and a change of
 * status were the same commit.
 */
export function CommunitySettingsForm({
  community,
  divisions,
  canWrite,
}: {
  community: CommunityDetailDTO
  divisions: DivisionDTO[]
  canWrite: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [editing, setEditing] = useState<EditKey | null>(null)

  const [name, setName] = useState(community.name)
  const [code, setCode] = useState(community.code ?? "")
  const [status, setStatus] = useState(community.status)
  const [divisionId, setDivisionId] = useState(community.divisionId ?? "none")
  const [plannedLotCount, setPlannedLotCount] = useState(
    community.plannedLotCount != null ? String(community.plannedLotCount) : "",
  )
  const [targetAbsorption, setTargetAbsorption] = useState(
    community.targetAbsorptionPerMonth != null ? String(community.targetAbsorptionPerMonth) : "",
  )
  const [address, setAddress] = useState(community.address ?? "")
  const [city, setCity] = useState(community.city ?? "")
  const [state, setState] = useState(community.state ?? "")
  const [postalCode, setPostalCode] = useState(community.postalCode ?? "")
  const [description, setDescription] = useState(community.description ?? "")

  const activeDivisions = divisions.filter((division) => !division.archived)
  const divisionName =
    community.divisionId == null
      ? "Main"
      : (activeDivisions.find((division) => division.id === community.divisionId)?.name ?? "Main")

  /** The update action overwrites every key, so a one-group edit sends the whole set. */
  function save(onDone: () => void) {
    startTransition(async () => {
      try {
        unwrapAction(
          await updateCommunityAction(community.id, {
            name,
            code: code || null,
            status,
            divisionId: divisionId === "none" ? null : divisionId,
            plannedLotCount: plannedLotCount ? Number(plannedLotCount) : null,
            targetAbsorptionPerMonth: targetAbsorption ? Number(targetAbsorption) : null,
            address: address || null,
            city: city || null,
            state: state || null,
            postalCode: postalCode || null,
            description: description || null,
          }),
        )
        toast.success("Community saved")
        onDone()
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

  const location = [community.address, community.city, [community.state, community.postalCode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ")

  return (
    <div className="space-y-10">
      <SettingsGroup title="Identity" description="How this community appears across Arc and on buyer documents.">
        <SettingsField label="Community" hint="Name, code, status, and division.">
          <RowControl canManage={canWrite} onEdit={() => setEditing("identity")} align="start">
            <p className="text-sm">
              {community.name}
              {community.code ? <span className="text-muted-foreground"> · {community.code}</span> : null}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {STATUS_LABEL[community.status]} · {divisionName}
            </p>
          </RowControl>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup
        title="Underwriting"
        description="The two numbers the runway and the pace stat are measured against."
      >
        <SettingsField
          label="Planned lots"
          hint="Target buildout. The header reads sellable lots against this number."
        >
          <RowControl canManage={canWrite} onEdit={() => setEditing("targets")}>
            <p className="text-sm tabular-nums">{community.plannedLotCount ?? "Not set"}</p>
          </RowControl>
        </SettingsField>
        <SettingsField
          label="Target pace"
          hint="Net sales per month this community is underwritten to. Drives pace vs required in the header and the runway verdict on Land."
        >
          <RowControl canManage={canWrite} onEdit={() => setEditing("targets")}>
            <p className="text-sm tabular-nums">
              {community.targetAbsorptionPerMonth != null ? `${community.targetAbsorptionPerMonth} / month` : "Not set"}
            </p>
          </RowControl>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Location" description="The community entrance or sales office address.">
        <SettingsField label="Address" hint="Shown on buyer-facing documents.">
          <RowControl canManage={canWrite} onEdit={() => setEditing("location")} align="start">
            <p className="text-sm">{location || "Not set"}</p>
            {community.description ? (
              <p className="mt-1 max-w-xl text-xs text-muted-foreground">{community.description}</p>
            ) : null}
          </RowControl>
        </SettingsField>
      </SettingsGroup>

      {canWrite ? (
        <SettingsGroup
          title="Archive"
          description="Removes the community from active lists. Existing lots and projects remain intact."
        >
          <div className="flex items-center justify-between gap-3 py-4">
            <p className="text-sm text-muted-foreground">This cannot be undone from here.</p>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm" disabled={isPending}>
                  Archive community
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="rounded-none">
                <AlertDialogHeader>
                  <AlertDialogTitle>Archive {community.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The community disappears from active lists and pipelines. Existing lots and projects remain intact.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction disabled={isPending} onClick={archive}>
                    Archive
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </SettingsGroup>
      ) : null}

      <Dialog open={editing === "identity"} onOpenChange={(open) => { if (!open) setEditing(null) }}>
        <DialogContent className="rounded-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Community identity</DialogTitle>
            <DialogDescription>The name buyers and documents see, and where it sits in the org.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <label htmlFor="settings-name" className="text-sm font-medium">Name</label>
              <Input id="settings-name" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <label htmlFor="settings-code" className="text-sm font-medium">Code</label>
                <Input
                  id="settings-code"
                  value={code}
                  maxLength={12}
                  onChange={(event) => setCode(event.target.value.toUpperCase())}
                />
              </div>
              <div className="grid gap-1.5">
                <label className="text-sm font-medium">Status</label>
                <Select value={status} onValueChange={(value) => setStatus(value as CommunityDetailDTO["status"])}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(STATUS_LABEL) as Array<CommunityDetailDTO["status"]>).map((value) => (
                      <SelectItem key={value} value={value}>{STATUS_LABEL[value]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {activeDivisions.length > 0 ? (
              <div className="grid gap-1.5">
                <label className="text-sm font-medium">Division</label>
                <Select value={divisionId} onValueChange={setDivisionId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Main</SelectItem>
                    {activeDivisions.map((division) => (
                      <SelectItem key={division.id} value={division.id}>{division.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button disabled={!name.trim() || isPending} onClick={() => save(() => setEditing(null))}>
              {isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editing === "targets"} onOpenChange={(open) => { if (!open) setEditing(null) }}>
        <DialogContent className="rounded-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Underwriting targets</DialogTitle>
            <DialogDescription>
              Target pace is the denominator of the pace stat in the header and decides whether the runway reads on,
              behind, or dry.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <label htmlFor="settings-planned" className="text-sm font-medium">Planned lots</label>
              <Input
                id="settings-planned"
                type="number"
                min={0}
                value={plannedLotCount}
                onChange={(event) => setPlannedLotCount(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="settings-absorption" className="text-sm font-medium">Target pace / month</label>
              <Input
                id="settings-absorption"
                type="number"
                min={0}
                step="0.5"
                value={targetAbsorption}
                onChange={(event) => setTargetAbsorption(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button disabled={isPending} onClick={() => save(() => setEditing(null))}>
              {isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editing === "location"} onOpenChange={(open) => { if (!open) setEditing(null) }}>
        <DialogContent className="rounded-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Location</DialogTitle>
            <DialogDescription>The community entrance or sales office address.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <label htmlFor="settings-address" className="text-sm font-medium">Address</label>
              <Input id="settings-address" value={address} onChange={(event) => setAddress(event.target.value)} />
            </div>
            <div className="grid grid-cols-[1fr_6rem_7rem] gap-3">
              <div className="grid gap-1.5">
                <label htmlFor="settings-city" className="text-sm font-medium">City</label>
                <Input id="settings-city" value={city} onChange={(event) => setCity(event.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="settings-state" className="text-sm font-medium">State</label>
                <Input id="settings-state" value={state} onChange={(event) => setState(event.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="settings-postal" className="text-sm font-medium">Postal code</label>
                <Input id="settings-postal" value={postalCode} onChange={(event) => setPostalCode(event.target.value)} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="settings-description" className="text-sm font-medium">Description</label>
              <Textarea
                id="settings-description"
                rows={4}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button disabled={isPending} onClick={() => save(() => setEditing(null))}>
              {isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
