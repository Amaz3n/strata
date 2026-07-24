"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"

import { Search } from "@/components/icons"
import { StartStatusBadge } from "@/components/starts/start-badges"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { StartPackageListItemDTO, StartPackageStatus } from "@/lib/services/starts"
import { cn } from "@/lib/utils"

const STATUSES: StartPackageStatus[] = ["open", "ready", "releasing", "attention", "released", "cancelled"]

export function StartPipelineClient({ packages, total }: { packages: StartPackageListItemDTO[]; total: number }) {
  const router = useRouter()
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("active")
  const [communityId, setCommunityId] = useState("all")

  const communities = useMemo(() => {
    const map = new Map(packages.map((pkg) => [pkg.communityId, pkg.communityName]))
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [packages])

  const filtered = useMemo(
    () =>
      packages.filter((pkg) => {
        const haystack = `${pkg.communityName} ${pkg.lotLabel} ${pkg.planCode ?? ""} ${pkg.planName ?? ""} ${pkg.superintendentName ?? ""}`.toLowerCase()
        return (
          haystack.includes(query.trim().toLowerCase()) &&
          (status === "all" || (status === "active" ? !["released", "cancelled"].includes(pkg.status) : pkg.status === status)) &&
          (communityId === "all" || pkg.communityId === communityId)
        )
      }),
    [packages, query, status, communityId],
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
          <Input
            className="h-8 w-56 rounded-none pl-8 text-xs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search lot, plan, superintendent"
            aria-label="Search start packages"
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-8 w-36 rounded-none text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="active">In pipeline</SelectItem>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map((value) => <SelectItem key={value} value={value} className="capitalize">{value}</SelectItem>)}
          </SelectContent>
        </Select>
        {communities.length > 1 ? (
          <Select value={communityId} onValueChange={setCommunityId}>
            <SelectTrigger className="h-8 w-44 rounded-none text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All communities</SelectItem>
              {communities.map((community) => <SelectItem key={community.id} value={community.id}>{community.name}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : null}
        <span className="text-xs tabular-nums text-muted-foreground">
          {filtered.length === 1 ? "1 package" : `${filtered.length} packages`}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 border px-6 py-16 text-center">
          <p className="text-sm font-medium">{packages.length === 0 ? "No start packages" : "No matching packages"}</p>
          <p className="max-w-md text-xs text-muted-foreground">
            {packages.length === 0
              ? "Open a start package from the release board to put a lot into the precon pipeline."
              : "Nothing matches the current search and filters."}
          </p>
          {packages.length === 0 ? (
            <Button asChild variant="outline" size="sm" className="mt-2 rounded-none"><Link href="/starts">Release board</Link></Button>
          ) : (
            <Button variant="outline" size="sm" className="mt-2 rounded-none" onClick={() => { setQuery(""); setStatus("all"); setCommunityId("all") }}>
              Clear filters
            </Button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto border">
          <Table>
            <TableHeader>
              <TableRow className="text-[11px] uppercase tracking-wide">
                <TableHead>Community / lot</TableHead>
                <TableHead>Plan / Elev.</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Gates</TableHead>
                <TableHead>Target week</TableHead>
                <TableHead>Scheduled</TableHead>
                <TableHead className="text-right">Precon age</TableHead>
                <TableHead>Financing</TableHead>
                <TableHead>Superintendent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((pkg) => (
                <TableRow key={pkg.id} className="cursor-pointer text-xs" onClick={() => router.push(`/starts/pipeline/${pkg.id}`)}>
                  <TableCell className="font-medium">
                    <Link className="hover:underline" href={`/starts/pipeline/${pkg.id}`} onClick={(event) => event.stopPropagation()}>
                      {pkg.communityName} · {pkg.lotLabel}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {[pkg.planCode ?? pkg.planName, pkg.elevationCode].filter(Boolean).join(" / ") || "Unpinned"}
                  </TableCell>
                  <TableCell><StartStatusBadge status={pkg.status} /></TableCell>
                  <TableCell className="text-right tabular-nums">{pkg.gatesPassed}/{pkg.gatesTotal}</TableCell>
                  <TableCell className="tabular-nums">{pkg.targetWeek ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{pkg.scheduledStartDate ?? "—"}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", pkg.status !== "released" && pkg.preconAgeDays > 45 && "text-warning")}>
                    {pkg.preconAgeDays}d
                  </TableCell>
                  <TableCell className="text-muted-foreground">{pkg.isFinanced ? "Financed" : "Cash"}</TableCell>
                  <TableCell className={cn(!pkg.superintendentName && "text-muted-foreground")}>{pkg.superintendentName ?? "Unassigned"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {total > packages.length ? (
        <p className="text-xs text-muted-foreground">
          Showing the first {packages.length} of {total} packages — use the filters to narrow.
        </p>
      ) : null}
    </div>
  )
}
