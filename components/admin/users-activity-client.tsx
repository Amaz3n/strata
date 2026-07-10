"use client"

import { useMemo, useState } from "react"
import { format, formatDistanceToNow } from "date-fns"

import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Search, X } from "@/components/icons"
import { cn } from "@/lib/utils"
import type { PlatformUsersResult } from "@/lib/services/admin"

type ActivityBucket = "today" | "week" | "month" | "stale" | "never"

function bucketFor(lastActiveAt: string | null): ActivityBucket {
  if (!lastActiveAt) return "never"
  const ageMs = Date.now() - new Date(lastActiveAt).getTime()
  const day = 24 * 60 * 60 * 1000
  if (ageMs <= day) return "today"
  if (ageMs <= 7 * day) return "week"
  if (ageMs <= 30 * day) return "month"
  return "stale"
}

const BUCKET_LABEL: Record<ActivityBucket, string> = {
  today: "Active today",
  week: "This week",
  month: "This month",
  stale: "Inactive 30d+",
  never: "Never active",
}

export function UsersActivityClient({ data }: { data: PlatformUsersResult }) {
  const [search, setSearch] = useState("")

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return data.users
    return data.users.filter(
      (user) =>
        user.fullName?.toLowerCase().includes(query) ||
        user.email?.toLowerCase().includes(query) ||
        user.memberships.some((m) => m.orgName.toLowerCase().includes(query)),
    )
  }, [data.users, search])

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      <div className="relative z-20 shrink-0 border-b bg-background/95 px-4 py-3 backdrop-blur-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm font-semibold">User activity</span>
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search name, email, or org…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-8 w-full pl-8 text-xs"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="relative z-10 min-h-0 flex-1 overflow-auto">
        <div className="grid grid-cols-2 gap-px border-b bg-border sm:grid-cols-4">
          <Stat label="Active today" value={data.activeToday} hint="last 24 hours" />
          <Stat label="Active 7d" value={data.active7d} hint="last 7 days" />
          <Stat label="Active 30d" value={data.active30d} hint="last 30 days" />
          <Stat label="Total users" value={data.totalCount} hint="all accounts" />
        </div>

        {filtered.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {data.users.length === 0 ? "No users yet." : "No users match your search."}
          </p>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-muted/40">
              <TableRow>
                <TableHead className="pl-4">User</TableHead>
                <TableHead>Organizations</TableHead>
                <TableHead>Last active</TableHead>
                <TableHead>Activity</TableHead>
                <TableHead className="pr-4">Joined</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((user) => {
                const bucket = bucketFor(user.lastActiveAt)
                return (
                  <TableRow key={user.id}>
                    <TableCell className="pl-4 py-2.5">
                      <div className="text-sm font-medium">{user.fullName ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">{user.email ?? "—"}</div>
                    </TableCell>
                    <TableCell className="py-2.5">
                      <div className="flex max-w-md flex-wrap gap-1">
                        {user.memberships.length === 0 ? (
                          <span className="text-xs text-muted-foreground">No memberships</span>
                        ) : (
                          user.memberships.map((membership) => (
                            <Badge
                              key={`${user.id}-${membership.orgId}`}
                              variant="outline"
                              className={cn(
                                "rounded-none text-[11px] font-normal",
                                membership.status !== "active" && "text-muted-foreground line-through",
                              )}
                              title={membership.roleKey ?? undefined}
                            >
                              {membership.orgName}
                              {membership.roleKey ? (
                                <span className="ml-1 text-muted-foreground">· {membership.roleKey}</span>
                              ) : null}
                            </Badge>
                          ))
                        )}
                      </div>
                    </TableCell>
                    <TableCell
                      className="py-2.5 text-xs"
                      title={user.lastActiveAt ? format(new Date(user.lastActiveAt), "MMM d, yyyy HH:mm") : undefined}
                    >
                      {user.lastActiveAt
                        ? formatDistanceToNow(new Date(user.lastActiveAt), { addSuffix: true })
                        : "—"}
                    </TableCell>
                    <TableCell className="py-2.5">
                      <Badge
                        variant={bucket === "today" ? "secondary" : "outline"}
                        className={cn(
                          "rounded-none text-[11px]",
                          (bucket === "stale" || bucket === "never") && "text-muted-foreground",
                        )}
                      >
                        <span
                          className={cn(
                            "mr-1.5 inline-block h-1.5 w-1.5",
                            bucket === "today" && "bg-success",
                            (bucket === "week" || bucket === "month") && "bg-muted-foreground",
                            (bucket === "stale" || bucket === "never") && "bg-destructive",
                          )}
                        />
                        {BUCKET_LABEL[bucket]}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className="py-2.5 pr-4 text-xs text-muted-foreground"
                      title={format(new Date(user.createdAt), "MMM d, yyyy")}
                    >
                      {formatDistanceToNow(new Date(user.createdAt), { addSuffix: true })}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
        {data.totalCount > data.users.length ? (
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            Showing the first {data.users.length} of {data.totalCount} users.
          </p>
        ) : null}
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="bg-card px-4 py-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}
