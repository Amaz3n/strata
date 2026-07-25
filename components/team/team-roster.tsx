"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type CSSProperties } from "react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  DollarSign,
  Lock,
  MoreHorizontal,
  RefreshCcw,
  Search,
  ShieldCheck,
  UserPlus,
  Users,
  XCircle,
} from "@/components/icons"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { unwrapAction } from "@/lib/action-result"
import {
  reactivateMemberAction,
  removeMemberAction,
  resendInviteAction,
  resetMemberMfaAction,
  suspendMemberAction,
} from "@/app/(app)/team/actions"
import type { DivisionDTO } from "@/lib/services/divisions"
import type { OrgRoleOption, PermissionOption, TeamMember } from "@/lib/types"
import { MemberInspector, type InspectorTab } from "@/components/team/member-inspector"
import { InviteDialog } from "@/components/team/invite-dialog"
import {
  activityDescriptor,
  canReleaseMoney,
  DEFAULT_FILTERS,
  displayName,
  filterMembers,
  initials,
  isAdminRole,
  membersToCsv,
  overrideCounts,
  rosterCounts,
  sortMembers,
  type RolePermissionMap,
  type RosterFacet,
  type RosterFilters,
  type RosterSortKey,
} from "@/components/team/roster-utils"

const RENDER_CAP = 200

const FACET_LABEL: Record<RosterFacet, string> = {
  active: "Active",
  pending: "Pending",
  archived: "Archived",
  all: "All",
}

const TH = "microlabel sticky top-0 z-10 border-b border-border bg-background px-3 py-2 text-left whitespace-nowrap"
const TD = "px-3 py-2 align-middle"

type ConfirmKind = "archive" | "restore" | "remove" | "revoke" | "reset-mfa" | "discard"
interface ConfirmState {
  kind: ConfirmKind
  member?: TeamMember
}

interface TeamRosterProps {
  members: TeamMember[]
  onMembersChange: (updater: (prev: TeamMember[]) => TeamMember[]) => void
  roleOptions: OrgRoleOption[]
  permissionOptions: PermissionOption[]
  rolePermissions: RolePermissionMap
  divisions: DivisionDTO[]
  currentUserId: string | null
  canManageMembers: boolean
  canEditRoles: boolean
  canManageBilling: boolean
  locked: boolean
  loading: boolean
  error: string | null
  onReload: () => void
  onGoToBilling: () => void
}

export function TeamRoster({
  members,
  onMembersChange,
  roleOptions,
  permissionOptions,
  rolePermissions,
  divisions,
  currentUserId,
  canManageMembers,
  canEditRoles,
  canManageBilling,
  locked,
  loading,
  error,
  onReload,
  onGoToBilling,
}: TeamRosterProps) {
  const [filters, setFilters] = useState<RosterFilters>(DEFAULT_FILTERS)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [cursorId, setCursorId] = useState<string | null>(null)
  const [inspector, setInspector] = useState<{ member: TeamMember; tab: InspectorTab } | null>(null)
  const [inspectorDirty, setInspectorDirty] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [confirmPending, startConfirm] = useTransition()

  const searchRef = useRef<HTMLInputElement>(null)
  const enteredRef = useRef(false)

  const counts = useMemo(() => rosterCounts(members, rolePermissions), [members, rolePermissions])
  const roleFacetOptions = useMemo(() => {
    const present = new Map<string, string>()
    for (const member of members) present.set(member.role, member.role_label ?? member.role)
    return Array.from(present.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [members])

  const visible = useMemo(() => {
    const filtered = filterMembers(members, filters)
    return sortMembers(filtered, filters.sort)
  }, [members, filters])

  const capped = visible.slice(0, RENDER_CAP)
  const truncated = visible.length > RENDER_CAP
  const existingEmails = useMemo(
    () => new Set(members.map((member) => member.user.email?.toLowerCase()).filter(Boolean) as string[]),
    [members],
  )

  const patchMembers = useCallback(
    (id: string, changes: Partial<TeamMember>) =>
      onMembersChange((prev) => prev.map((member) => (member.id === id ? { ...member, ...changes } : member))),
    [onMembersChange],
  )
  const replaceMember = useCallback(
    (next: TeamMember) => onMembersChange((prev) => prev.map((member) => (member.id === next.id ? next : member))),
    [onMembersChange],
  )
  const dropMember = useCallback(
    (id: string) => onMembersChange((prev) => prev.filter((member) => member.id !== id)),
    [onMembersChange],
  )

  const withBusy = useCallback(
    async (ids: string[], task: () => Promise<void>) => {
      setBusyIds((prev) => new Set([...prev, ...ids]))
      try {
        await task()
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev)
          for (const id of ids) next.delete(id)
          return next
        })
      }
    },
    [],
  )

  const openInspector = useCallback((member: TeamMember, tab: InspectorTab = "access") => {
    setInspectorDirty(false)
    setInspector({ member, tab })
    setCursorId(member.id)
  }, [])

  const requestCloseInspector = useCallback(() => {
    if (inspectorDirty) setConfirm({ kind: "discard" })
    else setInspector(null)
  }, [inspectorDirty])

  const stepInspector = useCallback(
    (delta: number) => {
      if (!inspector) return
      const idx = visible.findIndex((member) => member.id === inspector.member.id)
      if (idx === -1) return
      const nextIdx = Math.min(Math.max(idx + delta, 0), visible.length - 1)
      const next = visible[nextIdx]
      if (next && next.id !== inspector.member.id) {
        setInspectorDirty(false)
        setInspector({ member: next, tab: inspector.tab })
        setCursorId(next.id)
      }
    },
    [inspector, visible],
  )

  // Keep the open inspector pointed at the freshest copy of its member.
  useEffect(() => {
    if (!inspector) return
    const fresh = members.find((member) => member.id === inspector.member.id)
    if (!fresh) {
      setInspector(null)
      return
    }
    if (fresh !== inspector.member) {
      setInspector((prev) => (prev ? { ...prev, member: fresh } : prev))
    }
  }, [members, inspector])

  // Selection only ever contains currently-present ids.
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(members.map((member) => member.id))
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (ids.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [members])

  const setFacet = (facet: RosterFacet) => setFilters((prev) => ({ ...prev, facet }))
  const setQuery = (query: string) => setFilters((prev) => ({ ...prev, query }))
  const toggleSort = (key: RosterSortKey) =>
    setFilters((prev) => ({
      ...prev,
      sort:
        prev.sort.key === key
          ? { key, dir: prev.sort.dir === "asc" ? "desc" : "asc" }
          : { key, dir: "asc" },
    }))

  // ---- keyboard ------------------------------------------------------------
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (locked || loading) return
      const target = event.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable ||
          target.getAttribute("role") === "combobox")
      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (event.key === "/" && !typing) {
        event.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (inspector) {
        if (event.key === "ArrowDown" && !typing) {
          event.preventDefault()
          if (!inspectorDirty) stepInspector(1)
        } else if (event.key === "ArrowUp" && !typing) {
          event.preventDefault()
          if (!inspectorDirty) stepInspector(-1)
        }
        return
      }
      if (typing) {
        if (event.key === "Escape") setQueryIfPresent()
        return
      }
      if (event.key === "Escape") {
        if (selected.size > 0) setSelected(new Set())
        else if (filters.query) setQuery("")
        return
      }
      if (event.key === "i" && canManageMembers) {
        event.preventDefault()
        setInviteOpen(true)
        return
      }
      if (capped.length === 0) return
      const currentIdx = cursorId ? capped.findIndex((member) => member.id === cursorId) : -1
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault()
        const nextIdx = Math.min(currentIdx + 1, capped.length - 1)
        setCursorId(capped[Math.max(0, nextIdx)]?.id ?? null)
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault()
        const nextIdx = currentIdx <= 0 ? 0 : currentIdx - 1
        setCursorId(capped[nextIdx]?.id ?? null)
      } else if (event.key === "Enter" && currentIdx >= 0) {
        event.preventDefault()
        openInspector(capped[currentIdx])
      } else if (event.key === "x" && canManageMembers && currentIdx >= 0) {
        event.preventDefault()
        toggleRow(capped[currentIdx].id)
      }
    }
    const setQueryIfPresent = () => {
      if (filters.query) setQuery("")
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, loading, inspector, inspectorDirty, selected, filters.query, capped, cursorId, canManageMembers])

  useEffect(() => {
    if (!enteredRef.current) enteredRef.current = true
  }, [])

  // ---- selection -----------------------------------------------------------
  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const visibleIds = capped.map((member) => member.id)
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))
  const someSelected = visibleIds.some((id) => selected.has(id)) && !allSelected
  const toggleAll = (checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of visibleIds) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })

  const selectedMembers = useMemo(
    () => members.filter((member) => selected.has(member.id)),
    [members, selected],
  )
  const bulkResendCount = selectedMembers.filter((member) => member.status === "invited").length
  const bulkArchiveCount = selectedMembers.filter((member) => member.status === "active").length
  const bulkRestoreCount = selectedMembers.filter((member) => member.status === "suspended").length

  // ---- mutations -----------------------------------------------------------
  const doArchive = (member: TeamMember) =>
    withBusy([member.id], async () => {
      try {
        unwrapAction(await suspendMemberAction(member.id))
        patchMembers(member.id, { status: "suspended" })
        toast.success(`${displayName(member).label} archived`, {
          action: {
            label: "Undo",
            onClick: () => doRestore(member),
          },
        })
      } catch (err) {
        toast.error("Couldn't archive", { description: (err as Error).message })
      }
    })

  const doRestore = (member: TeamMember) =>
    withBusy([member.id], async () => {
      try {
        unwrapAction(await reactivateMemberAction(member.id))
        patchMembers(member.id, { status: "active" })
        toast.success(`${displayName(member).label} restored`)
      } catch (err) {
        toast.error("Couldn't restore", { description: (err as Error).message })
      }
    })

  const doResend = (member: TeamMember) =>
    withBusy([member.id], async () => {
      try {
        unwrapAction(await resendInviteAction(member.id))
        toast.success(`Invite resent to ${member.user.email}`)
      } catch (err) {
        toast.error("Couldn't resend invite", { description: (err as Error).message })
      }
    })

  const doRemove = (member: TeamMember) =>
    withBusy([member.id], async () => {
      try {
        unwrapAction(await removeMemberAction(member.id))
        dropMember(member.id)
        toast.success(`${displayName(member).label} removed`)
      } catch (err) {
        toast.error("Couldn't remove", { description: (err as Error).message })
      }
    })

  const doResetMfa = (member: TeamMember) =>
    withBusy([member.id], async () => {
      try {
        const result = unwrapAction(await resetMemberMfaAction(member.id))
        patchMembers(member.id, { mfa_enabled: false })
        toast.success(result?.reset ? "Two-factor reset — they re-enroll at next sign-in" : "No two-factor to reset")
      } catch (err) {
        toast.error("Couldn't reset two-factor", { description: (err as Error).message })
      }
    })

  const runConfirm = () => {
    if (!confirm) return
    const member = confirm.member
    startConfirm(async () => {
      switch (confirm.kind) {
        case "archive":
          if (member) await doArchive(member)
          break
        case "restore":
          if (member) await doRestore(member)
          break
        case "remove":
        case "revoke":
          if (member) await doRemove(member)
          break
        case "reset-mfa":
          if (member) await doResetMfa(member)
          break
        case "discard":
          setInspector(null)
          setInspectorDirty(false)
          break
      }
      setConfirm(null)
    })
  }

  const bulkArchive = () =>
    startConfirm(async () => {
      const targets = selectedMembers.filter((member) => member.status === "active")
      await withBusy(
        targets.map((member) => member.id),
        async () => {
          let ok = 0
          const failures: string[] = []
          for (const member of targets) {
            try {
              unwrapAction(await suspendMemberAction(member.id))
              patchMembers(member.id, { status: "suspended" })
              ok += 1
            } catch (err) {
              failures.push((err as Error).message)
            }
          }
          if (ok > 0) toast.success(`Archived ${ok}`)
          if (failures.length > 0) toast.error(`${failures.length} could not be archived`, { description: failures[0] })
        },
      )
      setSelected(new Set())
    })

  const bulkRestore = () =>
    startConfirm(async () => {
      const targets = selectedMembers.filter((member) => member.status === "suspended")
      await withBusy(
        targets.map((member) => member.id),
        async () => {
          let ok = 0
          for (const member of targets) {
            try {
              unwrapAction(await reactivateMemberAction(member.id))
              patchMembers(member.id, { status: "active" })
              ok += 1
            } catch {
              /* reported in aggregate below */
            }
          }
          if (ok > 0) toast.success(`Restored ${ok}`)
        },
      )
      setSelected(new Set())
    })

  const bulkResend = () =>
    startConfirm(async () => {
      const targets = selectedMembers.filter((member) => member.status === "invited")
      await withBusy(
        targets.map((member) => member.id),
        async () => {
          let ok = 0
          for (const member of targets) {
            try {
              unwrapAction(await resendInviteAction(member.id))
              ok += 1
            } catch {
              /* reported in aggregate below */
            }
          }
          if (ok > 0) toast.success(`Resent ${ok} ${ok === 1 ? "invite" : "invites"}`)
        },
      )
      setSelected(new Set())
    })

  const exportCsv = () => {
    const csv = membersToCsv(visible, rolePermissions)
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = "team.csv"
    link.click()
    URL.revokeObjectURL(url)
  }

  // ---- render --------------------------------------------------------------
  if (locked) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <FullState
          icon={<Lock />}
          title="Team management is paused"
          description="This organization's subscription is past due. Restore billing to invite teammates or change access."
          action={
            canManageBilling ? (
              <Button variant="outline" size="sm" onClick={onGoToBilling}>
                Go to Billing
              </Button>
            ) : null
          }
        />
      </div>
    )
  }

  const columnCount = 6 + (canManageMembers ? 1 : 0)

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        {/* Toolbar */}
        <div
          className={cn("flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2", !enteredRef.current && "desk-rise")}
          style={{ "--desk-stagger": 0 } as CSSProperties}
        >
          <InputGroup className="h-8 w-full sm:w-64">
            <InputGroupAddon align="inline-start">
              <Search className="size-3.5" />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchRef}
              value={filters.query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, email, role"
              aria-label="Search team members"
            />
            {filters.query ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton onClick={() => setQuery("")} aria-label="Clear search">
                  <XCircle className="size-3.5" />
                </InputGroupButton>
              </InputGroupAddon>
            ) : (
              <InputGroupAddon align="inline-end">
                <Kbd>/</Kbd>
              </InputGroupAddon>
            )}
          </InputGroup>

          <ToggleGroup
            type="single"
            value={filters.facet}
            onValueChange={(value) => value && setFacet(value as RosterFacet)}
            variant="outline"
            size="sm"
            aria-label="Filter by status"
            className="h-8"
          >
            {(["active", "pending", "archived", "all"] as const).map((key) => (
              <ToggleGroupItem key={key} value={key} className="h-8 flex-none gap-1.5 px-3 text-xs">
                {FACET_LABEL[key]}
                <span className="tabular-nums text-muted-foreground">{counts[key]}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          {roleFacetOptions.length > 1 ? (
            <Select value={filters.role} onValueChange={(value) => setFilters((prev) => ({ ...prev, role: value }))}>
              <SelectTrigger size="sm" className="h-8 w-[150px] text-xs">
                <SelectValue placeholder="All roles" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All roles</SelectItem>
                {roleFacetOptions.map(([key, label]) => (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          <Select value={filters.mfa} onValueChange={(value) => setFilters((prev) => ({ ...prev, mfa: value as RosterFilters["mfa"] }))}>
            <SelectTrigger size="sm" className="h-8 w-[140px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any 2FA</SelectItem>
              <SelectItem value="on">2FA enabled</SelectItem>
              <SelectItem value="off">2FA off</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex-1" />

          {canManageMembers ? (
            <Button size="sm" className="h-8 gap-1.5" onClick={() => setInviteOpen(true)}>
              <UserPlus className="size-3.5" />
              Invite member
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button size="sm" className="h-8 gap-1.5" disabled>
                    <UserPlus className="size-3.5" />
                    Invite member
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>You need member management access to invite people.</TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Bulk bar */}
        {canManageMembers && selected.size > 0 ? (
          <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-muted/40 px-4 text-xs">
            <span className="font-medium tabular-nums">{selected.size} selected</span>
            <div className="h-3 w-px bg-border" />
            {bulkResendCount > 0 ? (
              <BulkButton onClick={bulkResend} disabled={confirmPending}>
                Resend invite ({bulkResendCount})
              </BulkButton>
            ) : null}
            {bulkArchiveCount > 0 ? (
              <BulkButton onClick={bulkArchive} disabled={confirmPending}>
                Archive ({bulkArchiveCount})
              </BulkButton>
            ) : null}
            {bulkRestoreCount > 0 ? (
              <BulkButton onClick={bulkRestore} disabled={confirmPending}>
                Restore ({bulkRestoreCount})
              </BulkButton>
            ) : null}
            <div className="flex-1" />
            <BulkButton onClick={() => setSelected(new Set())}>Clear</BulkButton>
          </div>
        ) : null}

        {/* Table */}
        <div
          className={cn("relative flex min-h-0 flex-1 flex-col overflow-auto", !enteredRef.current && "desk-rise")}
          style={{ "--desk-stagger": 1 } as CSSProperties}
        >
          {loading ? (
            <RosterSkeleton canManageMembers={canManageMembers} />
          ) : error ? (
            <FullState
              icon={<AlertTriangle />}
              title="Couldn't load your team"
              description={error}
              action={
                <Button variant="outline" size="sm" onClick={onReload}>
                  <RefreshCcw className="mr-1.5 size-3.5" />
                  Try again
                </Button>
              }
            />
          ) : capped.length === 0 ? (
            <RosterEmpty
              facet={filters.facet}
              filtered={filters.query.trim() !== "" || filters.role !== "all" || filters.mfa !== "any"}
              total={members.length}
              canManageMembers={canManageMembers}
              onInvite={() => setInviteOpen(true)}
              onClearFilters={() => setFilters(DEFAULT_FILTERS)}
            />
          ) : (
            <table className="w-full min-w-[880px] border-collapse text-sm">
              <thead>
                <tr>
                  {canManageMembers ? (
                    <th className={cn(TH, "w-9 pl-4")}>
                      <Checkbox
                        checked={allSelected ? true : someSelected ? "indeterminate" : false}
                        onCheckedChange={(checked) => toggleAll(checked === true)}
                        aria-label="Select all"
                      />
                    </th>
                  ) : null}
                  <SortHeader
                    className={cn("min-w-[220px]", canManageMembers ? "" : "pl-4")}
                    label="Member"
                    sortKey="name"
                    filters={filters}
                    onSort={toggleSort}
                  />
                  <SortHeader className="hidden w-[160px] sm:table-cell" label="Role" sortKey="role" filters={filters} onSort={toggleSort} />
                  <SortHeader className="hidden w-[140px] lg:table-cell" label="Access" sortKey="access" filters={filters} onSort={toggleSort} />
                  <th className={cn(TH, "hidden w-[120px] text-right xl:table-cell")}>Permissions</th>
                  <th className={cn(TH, "hidden w-[128px] text-right lg:table-cell")}>Cost / Bill</th>
                  <th className={cn(TH, "hidden w-[52px] text-center md:table-cell")}>2FA</th>
                  <SortHeader className="w-[150px]" label="Status" sortKey="activity" filters={filters} onSort={toggleSort} />
                  <th className={cn(TH, "w-11 pr-4")}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {capped.map((member) => (
                  <MemberRow
                    key={member.id}
                    member={member}
                    rolePermissions={rolePermissions}
                    selected={selected.has(member.id)}
                    isCursor={cursorId === member.id}
                    busy={busyIds.has(member.id)}
                    canManageMembers={canManageMembers}
                    isYou={member.user.id === currentUserId}
                    onOpen={openInspector}
                    onToggleSelect={toggleRow}
                    onConfirm={setConfirm}
                    onResend={doResend}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        {!loading && !error && members.length > 0 ? (
          <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-border bg-muted/20 px-4">
            <span className="microlabel truncate">
              {visible.length} of {members.length} members{truncated ? ` · showing first ${RENDER_CAP}` : ""} · {counts.admins} admins · {counts.noMfa} without 2FA
            </span>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={exportCsv}>
              <Download className="mr-1 size-3" />
              Export CSV
            </Button>
          </div>
        ) : null}
      </div>

      {/* Inspector */}
      <Sheet open={inspector !== null} onOpenChange={(open) => !open && requestCloseInspector()}>
        <SheetContent
          side="right"
          mobileFullscreen
          className="flex w-full flex-col gap-0 p-0 sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-[560px]"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Member details</SheetTitle>
          </SheetHeader>
          {inspector ? (
            <MemberInspector
              key={inspector.member.id}
              member={inspector.member}
              tab={inspector.tab}
              onTabChange={(tab) => setInspector((prev) => (prev ? { ...prev, tab } : prev))}
              index={visible.findIndex((member) => member.id === inspector.member.id)}
              total={visible.length}
              onPrev={() => stepInspector(-1)}
              onNext={() => stepInspector(1)}
              roleOptions={roleOptions}
              permissionOptions={permissionOptions}
              rolePermissions={rolePermissions}
              divisions={divisions}
              canManageMembers={canManageMembers}
              canEditRoles={canEditRoles}
              onSaved={(next) => {
                replaceMember(next)
                setInspectorDirty(false)
              }}
              onRequestClose={requestCloseInspector}
              onDirtyChange={setInspectorDirty}
              onResetMfa={(member) => setConfirm({ kind: "reset-mfa", member })}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        roleOptions={roleOptions}
        rolePermissions={rolePermissions}
        divisions={divisions}
        existingEmails={existingEmails}
        onInvited={onReload}
      />

      <ConfirmDialog state={confirm} pending={confirmPending} onCancel={() => setConfirm(null)} onConfirm={runConfirm} />
    </TooltipProvider>
  )
}

// ---------------------------------------------------------------------------

function BulkButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-xs text-foreground underline-offset-4 hover:underline disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function SortHeader({
  className,
  label,
  sortKey,
  filters,
  onSort,
}: {
  className?: string
  label: string
  sortKey: RosterSortKey
  filters: RosterFilters
  onSort: (key: RosterSortKey) => void
}) {
  const active = filters.sort.key === sortKey
  return (
    <th
      className={cn(TH, className)}
      aria-sort={active ? (filters.sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 text-inherit hover:text-foreground"
      >
        {label}
        {active ? (
          filters.sort.dir === "asc" ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-40" />
        )}
      </button>
    </th>
  )
}

function MemberRow({
  member,
  rolePermissions,
  selected,
  isCursor,
  busy,
  canManageMembers,
  isYou,
  onOpen,
  onToggleSelect,
  onConfirm,
  onResend,
}: {
  member: TeamMember
  rolePermissions: RolePermissionMap
  selected: boolean
  isCursor: boolean
  busy: boolean
  canManageMembers: boolean
  isYou: boolean
  onOpen: (member: TeamMember, tab?: InspectorTab) => void
  onToggleSelect: (id: string) => void
  onConfirm: (state: ConfirmState) => void
  onResend: (member: TeamMember) => void
}) {
  const now = Date.now()
  const name = displayName(member)
  const activity = activityDescriptor(member, now)
  const money = canReleaseMoney(member, rolePermissions)
  const admin = isAdminRole(member.role, rolePermissions)
  const { added, removed } = overrideCounts(member)
  const cost = member.labor_cost_rate_cents ?? 0
  const bill = member.labor_bill_rate_cents ?? 0

  const permSummary = admin
    ? "All"
    : added === 0 && removed === 0
      ? "Role"
      : [added ? `+${added}` : null, removed ? `−${removed}` : null].filter(Boolean).join(" ")

  return (
    <tr
      data-state={selected ? "selected" : undefined}
      onClick={() => onOpen(member)}
      className={cn(
        "group cursor-pointer border-b border-border transition-colors duration-150 hover:bg-muted/40",
        "data-[state=selected]:bg-muted/60",
        isCursor && "bg-muted/30 outline outline-1 -outline-offset-1 outline-ring/50",
        member.status === "suspended" && "text-muted-foreground",
        busy && "pointer-events-none opacity-60",
      )}
      aria-busy={busy || undefined}
    >
      {canManageMembers ? (
        <td className={cn(TD, "pl-4")} onClick={(event) => event.stopPropagation()}>
          <Checkbox checked={selected} onCheckedChange={() => onToggleSelect(member.id)} aria-label={`Select ${name.label}`} />
        </td>
      ) : null}

      <td className={cn(TD, canManageMembers ? "" : "pl-4")}>
        <div className="flex items-center gap-2.5">
          <Avatar className="size-7 shrink-0 rounded-none">
            <AvatarImage src={member.user.avatar_url || undefined} alt="" />
            <AvatarFallback className="rounded-none bg-muted text-[10px] font-medium">
              {initials(member.user.full_name, member.user.email)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={cn("truncate font-medium text-foreground", name.muted && "font-normal italic text-muted-foreground")}>
                {name.label}
              </span>
              {isYou ? <span className="microlabel shrink-0">You</span> : null}
            </div>
            <span className="block truncate text-xs text-muted-foreground">{member.user.email}</span>
            <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground sm:hidden">
              <span className="truncate">{member.role_label}</span>
              <span aria-hidden>·</span>
              <span>{activity.word}</span>
            </span>
          </div>
        </div>
      </td>

      <td className={cn(TD, "hidden text-sm sm:table-cell")}>
        <span className="truncate">{member.role_label}</span>
      </td>

      <td className={cn(TD, "hidden text-sm lg:table-cell")}>
        {admin ? (
          <span className="text-muted-foreground" title="Admin roles see every project">
            All projects
          </span>
        ) : member.project_scope === "assigned" ? (
          "Assigned only"
        ) : (
          "All projects"
        )}
      </td>

      <td className={cn(TD, "hidden text-right xl:table-cell")}>
        <span className="inline-flex items-center justify-end gap-1.5">
          {money ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-muted-foreground">
                  <DollarSign className="size-3" aria-hidden />
                </span>
              </TooltipTrigger>
              <TooltipContent>Can approve or release money</TooltipContent>
            </Tooltip>
          ) : null}
          <span className={cn("tabular-nums", permSummary === "Role" && "text-muted-foreground")}>{permSummary}</span>
        </span>
      </td>

      <td className={cn(TD, "hidden text-right tabular-nums lg:table-cell")}>
        {cost > 0 || bill > 0 ? (
          <span>
            {(cost / 100).toFixed(0)} <span className="text-muted-foreground">/</span> {(bill / 100).toFixed(0)}
          </span>
        ) : (
          <span className="text-muted-foreground/70">—</span>
        )}
      </td>

      <td className={cn(TD, "hidden text-center md:table-cell")}>
        {member.mfa_enabled ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <ShieldCheck className="size-3.5 text-muted-foreground" />
                <span className="sr-only">Two-factor enabled</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>Two-factor enabled</TooltipContent>
          </Tooltip>
        ) : (
          <>
            <span aria-hidden className="text-muted-foreground/40">
              —
            </span>
            <span className="sr-only">Two-factor not enabled</span>
          </>
        )}
      </td>

      <td className={TD}>
        <div className="flex flex-col">
          <span
            className={cn(
              "text-sm",
              activity.tone === "warning" && "text-warning",
              activity.tone === "muted" && "text-muted-foreground",
            )}
          >
            {activity.word}
          </span>
          {activity.detail ? (
            <span className="text-xs text-muted-foreground" title={member.last_active_at ? new Date(member.last_active_at).toLocaleString() : undefined}>
              {activity.detail}
            </span>
          ) : null}
        </div>
      </td>

      <td className={cn(TD, "pr-4 text-right")} onClick={(event) => event.stopPropagation()}>
        <RowMenu member={member} canManageMembers={canManageMembers} onOpen={onOpen} onConfirm={onConfirm} onResend={onResend} />
      </td>
    </tr>
  )
}

function RowMenu({
  member,
  canManageMembers,
  onOpen,
  onConfirm,
  onResend,
}: {
  member: TeamMember
  canManageMembers: boolean
  onOpen: (member: TeamMember, tab?: InspectorTab) => void
  onConfirm: (state: ConfirmState) => void
  onResend: (member: TeamMember) => void
}) {
  const name = displayName(member).label
  const hasProjects = (member.project_count ?? 0) > 0
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="size-4" />
          <span className="sr-only">Actions for {name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onOpen(member)}>Open details</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigator.clipboard?.writeText(member.user.email ?? "")}>
          Copy email
        </DropdownMenuItem>
        {canManageMembers ? (
          <>
            <DropdownMenuSeparator />
            {member.status === "invited" ? (
              <>
                <DropdownMenuItem onSelect={() => onResend(member)}>Resend invite</DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" onSelect={() => onConfirm({ kind: "revoke", member })}>
                  Revoke invite
                </DropdownMenuItem>
              </>
            ) : member.status === "suspended" ? (
              <>
                <DropdownMenuItem onSelect={() => onConfirm({ kind: "restore", member })}>Restore member</DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" onSelect={() => onConfirm({ kind: "remove", member })}>
                  Remove permanently
                </DropdownMenuItem>
              </>
            ) : (
              <>
                {member.mfa_enabled ? (
                  <DropdownMenuItem onSelect={() => onConfirm({ kind: "reset-mfa", member })}>Reset two-factor</DropdownMenuItem>
                ) : null}
                <DropdownMenuItem className="text-destructive" onSelect={() => onConfirm({ kind: "archive", member })}>
                  Archive member
                </DropdownMenuItem>
              </>
            )}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const CONFIRM_COPY: Record<ConfirmKind, (name: string) => { title: string; description: string; confirm: string; destructive?: boolean }> = {
  archive: (name) => ({
    title: `Archive ${name}?`,
    description: "They lose access immediately. Their logs, photos, and cost entries stay on the projects. You can restore them later.",
    confirm: "Archive",
    destructive: true,
  }),
  restore: (name) => ({
    title: `Restore ${name}?`,
    description: "They regain access with their previous role and permissions.",
    confirm: "Restore",
  }),
  remove: (name) => ({
    title: `Remove ${name} permanently?`,
    description: "This deletes their membership. Their historical records stay, but the person and their rates are gone. This cannot be undone.",
    confirm: "Remove",
    destructive: true,
  }),
  revoke: (name) => ({
    title: `Revoke the invite for ${name}?`,
    description: "The invite link stops working. You can invite them again later.",
    confirm: "Revoke invite",
    destructive: true,
  }),
  "reset-mfa": (name) => ({
    title: `Reset two-factor for ${name}?`,
    description: "Their authenticator is unenrolled. They set up two-factor again the next time they sign in.",
    confirm: "Reset",
  }),
  discard: () => ({
    title: "Discard unsaved changes?",
    description: "You have unsaved changes for this member. Closing now loses them.",
    confirm: "Discard",
    destructive: true,
  }),
}

function ConfirmDialog({
  state,
  pending,
  onCancel,
  onConfirm,
}: {
  state: ConfirmState | null
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const copy = state ? CONFIRM_COPY[state.kind](state.member ? displayName(state.member).label : "") : null
  return (
    <AlertDialog open={state !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        {copy ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{copy.title}</AlertDialogTitle>
              <AlertDialogDescription>{copy.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault()
                  onConfirm()
                }}
                disabled={pending}
                className={copy.destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
              >
                {copy.confirm}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  )
}

function RosterSkeleton({ canManageMembers }: { canManageMembers: boolean }) {
  const widths = ["w-28", "w-36", "w-24", "w-32", "w-40", "w-28"]
  return (
    <table className="w-full min-w-[880px] border-collapse text-sm">
      <tbody>
        {Array.from({ length: 8 }).map((_, index) => (
          <tr key={index} className="border-b border-border">
            {canManageMembers ? (
              <td className={cn(TD, "pl-4")}>
                <Skeleton className="size-4" />
              </td>
            ) : null}
            <td className={cn(TD, canManageMembers ? "" : "pl-4")}>
              <div className="flex items-center gap-2.5">
                <Skeleton className="size-7" />
                <div className="space-y-1.5">
                  <Skeleton className={cn("h-3", widths[index % widths.length])} />
                  <Skeleton className="h-2.5 w-40" />
                </div>
              </div>
            </td>
            <td className={cn(TD, "hidden sm:table-cell")}>
              <Skeleton className="h-3 w-24" />
            </td>
            <td className={cn(TD, "hidden lg:table-cell")}>
              <Skeleton className="h-3 w-20" />
            </td>
            <td className={cn(TD, "hidden xl:table-cell")}>
              <Skeleton className="ml-auto h-3 w-12" />
            </td>
            <td className={cn(TD, "hidden lg:table-cell")}>
              <Skeleton className="ml-auto h-3 w-16" />
            </td>
            <td className={cn(TD, "hidden md:table-cell")}>
              <Skeleton className="mx-auto size-3.5" />
            </td>
            <td className={TD}>
              <Skeleton className="h-3 w-20" />
            </td>
            <td className={cn(TD, "pr-4")} />
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function RosterEmpty({
  facet,
  filtered,
  total,
  canManageMembers,
  onInvite,
  onClearFilters,
}: {
  facet: RosterFacet
  filtered: boolean
  total: number
  canManageMembers: boolean
  onInvite: () => void
  onClearFilters: () => void
}) {
  if (filtered) {
    return (
      <FullState
        icon={<Search />}
        title="No members match these filters"
        description={`Try a different search, or clear the filters to see all ${total} members.`}
        action={
          <Button variant="outline" size="sm" onClick={onClearFilters}>
            Clear filters
          </Button>
        }
      />
    )
  }
  if (total === 0) {
    return (
      <FullState
        icon={<Users />}
        title="No teammates yet"
        description="Invite the people who run your jobs. You choose their role, which projects they see, and their labor rates."
        action={
          canManageMembers ? (
            <Button size="sm" onClick={onInvite}>
              <UserPlus className="mr-1.5 size-3.5" />
              Invite member
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">Ask an administrator to invite people to this organization.</p>
          )
        }
      />
    )
  }
  const copy: Record<RosterFacet, { title: string; description: string }> = {
    active: { title: "No active members", description: "Everyone is pending or archived right now." },
    pending: { title: "No pending invites", description: "Everyone you invited has accepted." },
    archived: { title: "No archived members", description: "Archived teammates keep their history but lose access." },
    all: { title: "No members", description: "Invite your first teammate to get started." },
  }
  return <FullState icon={<Users />} title={copy[facet].title} description={copy[facet].description} />
}

function FullState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <Empty className="min-h-0 flex-1 border-0 py-20">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  )
}
