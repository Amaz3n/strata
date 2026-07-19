"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState, useTransition } from "react"
import { Building2, Plus, Search } from "@/components/icons"
import { toast } from "sonner"

import { createCommunityAction } from "@/app/(app)/communities/actions"
import { CommunityStatusBadge } from "@/components/communities/community-status-badge"
import { LotMixBar } from "@/components/communities/lot-mix-bar"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import { LOT_STATUSES, LOT_STATUS_META, type LotStatus } from "@/lib/land/lot-lifecycle"
import type { CommunityListItemDTO } from "@/lib/services/communities"
import type { DivisionDTO } from "@/lib/services/divisions"
import { cn } from "@/lib/utils"

function Num({ value, strong }: { value: number; strong?: boolean }) {
  return <span className={cn("tabular-nums", strong ? "font-medium" : undefined, value === 0 ? "text-muted-foreground/40" : undefined)}>{value}</span>
}

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
  const [search, setSearch] = useState("")

  const activeDivisions = useMemo(() => divisions.filter((division) => !division.archived), [divisions])
  const hasServerFilters = Boolean(status || divisionId)

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return communities
    return communities.filter((community) =>
      [community.name, community.code, community.city, community.state, community.divisionName]
        .some((field) => field?.toLowerCase().includes(query)),
    )
  }, [communities, search])

  const totals = useMemo(() => {
    const byStatus = Object.fromEntries(LOT_STATUSES.map((lotStatus) => [lotStatus, 0])) as Record<LotStatus, number>
    let planned = 0
    let hasPlanned = false
    for (const community of visible) {
      for (const lotStatus of LOT_STATUSES) byStatus[lotStatus] += community.lotCounts[lotStatus]
      if (community.plannedLotCount != null) {
        planned += community.plannedLotCount
        hasPlanned = true
      }
    }
    const total = LOT_STATUSES.reduce((sum, lotStatus) => sum + byStatus[lotStatus], 0)
    return { byStatus, total, planned: hasPlanned ? planned : null }
  }, [visible])

  function updateFilter(key: "status" | "division", value: string) {
    const params = new URLSearchParams()
    const nextStatus = key === "status" ? value : status
    if (nextStatus && nextStatus !== "all") params.set("status", nextStatus)
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

  const createDialog = canWrite ? (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" className="rounded-none"><Plus className="mr-1.5 h-4 w-4" />New community</Button></DialogTrigger>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader><DialogTitle>New community</DialogTitle><DialogDescription>Create the land container before adding phases and lots.</DialogDescription></DialogHeader>
        <form
          id="create-community"
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim() && !isPending) submit()
          }}
          className="grid gap-4 py-2"
        >
          <div className="grid gap-1.5"><Label htmlFor="community-name">Name</Label><Input id="community-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Cypress Creek" /></div>
          <div className="grid gap-1.5"><Label htmlFor="community-code">Code <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="community-code" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} maxLength={12} placeholder="CYP" /></div>
          {activeDivisions.length > 0 ? <div className="grid gap-1.5"><Label>Division</Label><Select value={selectedDivision} onValueChange={setSelectedDivision}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Main</SelectItem>{activeDivisions.map((division) => <SelectItem key={division.id} value={division.id}>{division.name}</SelectItem>)}</SelectContent></Select></div> : null}
        </form>
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button form="create-community" type="submit" disabled={!name.trim() || isPending}>{isPending ? "Creating…" : "Create"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null

  if (communities.length === 0 && !hasServerFilters) {
    return (
      <div className="flex min-h-full flex-col p-4">
        <Empty className="flex-1 rounded-none border">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="rounded-none"><Building2 /></EmptyMedia>
            <EmptyTitle className="text-sm">No communities yet</EmptyTitle>
            <EmptyDescription className="text-xs">A community holds your phases, takedowns, and the lots that become production starts. Create one to begin tracking land through closing.</EmptyDescription>
          </EmptyHeader>
          {canWrite ? <EmptyContent>{createDialog}</EmptyContent> : null}
        </Empty>
      </div>
    )
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
            <Input className="h-8 w-52 rounded-none pl-8 text-xs" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search communities" aria-label="Search communities" />
          </div>
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
          {activeDivisions.length > 0 ? (
            <Select value={divisionId ?? "all"} onValueChange={(value) => updateFilter("division", value)}>
              <SelectTrigger className="h-8 w-44 rounded-none text-xs"><SelectValue placeholder="All divisions" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All divisions</SelectItem>
                {activeDivisions.map((division) => <SelectItem key={division.id} value={division.id}>{division.name}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : null}
          <span className="text-xs tabular-nums text-muted-foreground">{visible.length === 1 ? "1 community" : `${visible.length} communities`} · {totals.total} lots{totals.planned != null ? ` of ${totals.planned} planned` : ""}</span>
        </div>
        {createDialog}
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-20 text-center">
          <p className="text-sm font-medium">No matching communities</p>
          <p className="max-w-md text-xs text-muted-foreground">Nothing matches the current search and filters.</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 rounded-none"
            onClick={() => {
              setSearch("")
              router.push("/communities")
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : (
        <div className="p-4">
          <div className="overflow-x-auto border">
            <Table>
              <TableHeader>
                <TableRow className="text-[11px] uppercase tracking-wide">
                  <TableHead>Community</TableHead>
                  {activeDivisions.length > 0 ? <TableHead>Division</TableHead> : null}
                  <TableHead>Status</TableHead>
                  <TableHead>Market</TableHead>
                  <TableHead className="w-40">Lot mix</TableHead>
                  {LOT_STATUSES.map((lotStatus) => <TableHead key={lotStatus} className="text-right">{LOT_STATUS_META[lotStatus].label}</TableHead>)}
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Planned</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((community) => {
                  const total = LOT_STATUSES.reduce((sum, lotStatus) => sum + community.lotCounts[lotStatus], 0)
                  return (
                    <TableRow key={community.id} className="cursor-pointer text-xs" onClick={() => router.push(`/communities/${community.id}`)}>
                      <TableCell className="font-medium">
                        <Link className="hover:underline" href={`/communities/${community.id}`} onClick={(event) => event.stopPropagation()}>{community.name}</Link>
                        {community.code ? <span className="ml-2 font-normal text-muted-foreground">{community.code}</span> : null}
                      </TableCell>
                      {activeDivisions.length > 0 ? <TableCell className="text-muted-foreground">{community.divisionName ?? "Main"}</TableCell> : null}
                      <TableCell><CommunityStatusBadge status={community.status} /></TableCell>
                      <TableCell className="text-muted-foreground">{[community.city, community.state].filter(Boolean).join(", ") || "—"}</TableCell>
                      <TableCell onClick={(event) => event.stopPropagation()}><LotMixBar counts={community.lotCounts} plannedLotCount={community.plannedLotCount} className="w-36" /></TableCell>
                      {LOT_STATUSES.map((lotStatus) => <TableCell key={lotStatus} className="text-right"><Num value={community.lotCounts[lotStatus]} /></TableCell>)}
                      <TableCell className="text-right"><Num value={total} strong /></TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{community.plannedLotCount ?? "—"}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
              {visible.length > 1 ? (
                <TableFooter>
                  <TableRow className="text-xs">
                    <TableCell colSpan={activeDivisions.length > 0 ? 5 : 4} className="font-medium">All communities</TableCell>
                    {LOT_STATUSES.map((lotStatus) => <TableCell key={lotStatus} className="text-right"><Num value={totals.byStatus[lotStatus]} /></TableCell>)}
                    <TableCell className="text-right"><Num value={totals.total} strong /></TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{totals.planned ?? "—"}</TableCell>
                  </TableRow>
                </TableFooter>
              ) : null}
            </Table>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
            {LOT_STATUSES.map((lotStatus) => (
              <span key={lotStatus} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className={cn("h-2 w-2", LOT_STATUS_META[lotStatus].barClass)} />
                {LOT_STATUS_META[lotStatus].label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
