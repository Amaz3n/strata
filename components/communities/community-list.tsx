"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { Plus } from "@/components/icons"
import { toast } from "sonner"

import { createCommunityAction } from "@/app/(app)/communities/actions"
import { CommunityStatusBadge } from "@/components/communities/community-status-badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import { LOT_STATUSES } from "@/lib/land/lot-lifecycle"
import type { CommunityListItemDTO } from "@/lib/services/communities"
import type { DivisionDTO } from "@/lib/services/divisions"

export function CommunityList({
  communities,
  divisions,
  canWrite,
  status,
  divisionId,
}: {
  communities: CommunityListItemDTO[]
  divisions: DivisionDTO[]
  canWrite: boolean
  status?: string
  divisionId?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState("")
  const [code, setCode] = useState("")
  const [selectedDivision, setSelectedDivision] = useState<string>("none")

  function updateFilter(key: "status" | "division", value: string) {
    const params = new URLSearchParams()
    if ((key === "status" ? value : status) && (key !== "status" || value !== "all")) params.set("status", key === "status" ? value : status ?? "")
    const nextDivision = key === "division" ? value : divisionId
    if (nextDivision && nextDivision !== "all") params.set("division", nextDivision)
    router.push(params.size ? `/communities?${params}` : "/communities")
  }

  function submit() {
    startTransition(async () => {
      try {
        const created = unwrapAction(await createCommunityAction({
          name,
          code: code || null,
          divisionId: selectedDivision === "none" ? null : selectedDivision,
          status: "active",
        }))
        toast.success("Community created")
        setOpen(false)
        setName("")
        setCode("")
        router.push(`/communities/${created.id}`)
      } catch (error) {
        toast.error("Unable to create community", { description: (error as Error).message })
      }
    })
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Select value={status ?? "all"} onValueChange={(value) => updateFilter("status", value)}>
            <SelectTrigger className="h-8 w-36 rounded-none text-xs"><SelectValue placeholder="All statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="planning">Planning</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="sold_out">Sold out</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
            </SelectContent>
          </Select>
          {divisions.length > 0 ? (
            <Select value={divisionId ?? "all"} onValueChange={(value) => updateFilter("division", value)}>
              <SelectTrigger className="h-8 w-44 rounded-none text-xs"><SelectValue placeholder="All divisions" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All divisions</SelectItem>
                {divisions.filter((division) => !division.archived).map((division) => <SelectItem key={division.id} value={division.id}>{division.name}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : null}
        </div>
        {canWrite ? (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button size="sm" className="rounded-none"><Plus className="mr-1.5 h-4 w-4" />New community</Button></DialogTrigger>
            <DialogContent className="rounded-none sm:max-w-md">
              <DialogHeader><DialogTitle>New community</DialogTitle><DialogDescription>Create the land container before adding phases and lots.</DialogDescription></DialogHeader>
              <div className="grid gap-4 py-2">
                <div className="grid gap-1.5"><Label htmlFor="community-name">Name</Label><Input id="community-name" value={name} onChange={(event) => setName(event.target.value)} /></div>
                <div className="grid gap-1.5"><Label htmlFor="community-code">Code</Label><Input id="community-code" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} maxLength={12} placeholder="CYP" /></div>
                {divisions.length > 0 ? <div className="grid gap-1.5"><Label>Division</Label><Select value={selectedDivision} onValueChange={setSelectedDivision}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Main</SelectItem>{divisions.filter((division) => !division.archived).map((division) => <SelectItem key={division.id} value={division.id}>{division.name}</SelectItem>)}</SelectContent></Select></div> : null}
              </div>
              <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!name.trim() || isPending} onClick={submit}>{isPending ? "Creating…" : "Create"}</Button></DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>

      {communities.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-20 text-center">
          <p className="text-sm font-medium">No communities yet</p>
          <p className="max-w-md text-xs text-muted-foreground">Create a community to organize phases, takedowns, and the lots that will become production houses.</p>
          {canWrite ? <Button variant="outline" size="sm" className="mt-2 rounded-none" onClick={() => setOpen(true)}>Add community</Button> : null}
        </div>
      ) : (
        <Table>
          <TableHeader><TableRow className="text-[11px] uppercase tracking-wide"><TableHead>Community</TableHead>{divisions.length > 0 ? <TableHead>Division</TableHead> : null}<TableHead>Status</TableHead><TableHead>Market</TableHead><TableHead className="text-right">Lots</TableHead>{LOT_STATUSES.map((lotStatus) => <TableHead key={lotStatus} className="text-right">{lotStatus.slice(0, 3)}</TableHead>)}<TableHead className="text-right">Planned</TableHead></TableRow></TableHeader>
          <TableBody>{communities.map((community) => {
            const total = Object.values(community.lotCounts).reduce((sum, count) => sum + count, 0)
            return <TableRow key={community.id} className="text-xs"><TableCell className="font-medium"><Link className="hover:underline" href={`/communities/${community.id}`}>{community.name}</Link>{community.code ? <span className="ml-2 text-muted-foreground">{community.code}</span> : null}</TableCell>{divisions.length > 0 ? <TableCell className="text-muted-foreground">{community.divisionName ?? "Main"}</TableCell> : null}<TableCell><CommunityStatusBadge status={community.status} /></TableCell><TableCell className="text-muted-foreground">{[community.city, community.state].filter(Boolean).join(", ") || "—"}</TableCell><TableCell className="text-right font-medium tabular-nums">{total}</TableCell>{LOT_STATUSES.map((lotStatus) => <TableCell key={lotStatus} className="text-right tabular-nums text-muted-foreground">{community.lotCounts[lotStatus]}</TableCell>)}<TableCell className="text-right tabular-nums">{community.plannedLotCount ?? "—"}</TableCell></TableRow>
          })}</TableBody>
        </Table>
      )}
    </div>
  )
}
