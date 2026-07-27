"use client"

import { useEffect, useMemo, useState, useTransition } from "react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ArrowUp, ArrowDown, KeyRound, Search, ShieldCheck } from "@/components/icons"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { unwrapAction } from "@/lib/action-result"
import {
  updateMemberLaborSettingsAction,
  updateMemberProfileAction,
  updateMemberRoleAction,
} from "@/app/(app)/team/actions"
import type { DivisionDTO } from "@/lib/services/divisions"
import type { OrgRole, OrgRoleOption, PermissionOption, TeamMember } from "@/lib/types"
import {
  activityDescriptor,
  displayName,
  effectivePermissions,
  groupPermissions,
  initials,
  isAdminRole,
  overridesFromMap,
  overridesToMap,
  relativeTime,
  type RolePermissionMap,
} from "@/components/team/roster-utils"

export type InspectorTab = "access" | "permissions" | "rates" | "activity"

const ADMIN_NOTE = "Admins already hold every permission. Choose a scoped role to grant specific access."

interface MemberInspectorProps {
  member: TeamMember
  tab: InspectorTab
  onTabChange: (tab: InspectorTab) => void
  index: number
  total: number
  onPrev: () => void
  onNext: () => void
  roleOptions: OrgRoleOption[]
  permissionOptions: PermissionOption[]
  rolePermissions: RolePermissionMap
  divisions: DivisionDTO[]
  canManageMembers: boolean
  canEditRoles: boolean
  onSaved: (next: TeamMember) => void
  onRequestClose: () => void
  onDirtyChange: (dirty: boolean) => void
  onResetMfa: (member: TeamMember) => void
}

function dollars(cents?: number | null) {
  if (!cents) return ""
  return (cents / 100).toFixed(2)
}

function toCents(value: string): number {
  const parsed = Number(value.replace(/[^\d.]/g, ""))
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return Math.round(parsed * 100)
}

export function MemberInspector({
  member,
  tab,
  onTabChange,
  index,
  total,
  onPrev,
  onNext,
  roleOptions,
  permissionOptions,
  rolePermissions,
  divisions,
  canManageMembers,
  canEditRoles,
  onSaved,
  onRequestClose,
  onDirtyChange,
  onResetMfa,
}: MemberInspectorProps) {
  const [isPending, startTransition] = useTransition()

  const availableRoles = useMemo(() => {
    if (roleOptions.some((option) => option.key === member.role)) return roleOptions
    return [{ key: member.role, label: member.role_label ?? member.role }, ...roleOptions]
  }, [roleOptions, member.role, member.role_label])

  const [fullName, setFullName] = useState(member.user.full_name ?? "")
  const [role, setRole] = useState<OrgRole>(member.role)
  const [projectScope, setProjectScope] = useState<"all" | "assigned">(member.project_scope ?? "all")
  const [divisionScope, setDivisionScope] = useState<"all" | "assigned">(member.division_scope ?? "all")
  const [divisionIds, setDivisionIds] = useState<string[]>(member.division_ids ?? [])
  const [overrides, setOverrides] = useState(() => overridesToMap(member.permission_overrides))
  const [permSearch, setPermSearch] = useState("")

  const [cost, setCost] = useState(dollars(member.labor_cost_rate_cents))
  const [bill, setBill] = useState(dollars(member.labor_bill_rate_cents))
  const [burden, setBurden] = useState(String(member.labor_burden_multiplier ?? 1))
  const [billable, setBillable] = useState(member.labor_is_billable_default ?? true)

  const roleIsAdmin = isAdminRole(role, rolePermissions)
  const scopeApplies = !roleIsAdmin

  const roleGrants = useMemo(() => new Set(rolePermissions[role] ?? []), [rolePermissions, role])

  const isChecked = (key: string): boolean => {
    const override = overrides.get(key)
    if (override) return override === "grant"
    return roleGrants.has(key)
  }

  const setChecked = (map: Map<string, "grant" | "deny">, key: string, want: boolean) => {
    if (roleGrants.has(key)) {
      if (want) map.delete(key)
      else map.set(key, "deny")
    } else {
      if (want) map.set(key, "grant")
      else map.delete(key)
    }
  }

  const togglePermission = (key: string, want: boolean) => {
    setOverrides((prev) => {
      const next = new Map(prev)
      setChecked(next, key, want)
      return next
    })
  }

  const toggleCategory = (options: PermissionOption[], want: boolean) => {
    setOverrides((prev) => {
      const next = new Map(prev)
      for (const option of options) setChecked(next, option.key, want)
      return next
    })
  }

  const resetToRole = () => setOverrides(new Map())

  const effective = useMemo(() => {
    // Effective set for the *pending* role + overrides (not the saved member).
    const set = new Set(roleGrants)
    for (const [key, effect] of overrides) {
      if (effect === "grant") set.add(key)
      else set.delete(key)
    }
    return set
  }, [roleGrants, overrides])

  // Minimal override array: only send what actually differs from the role.
  const saveOverrides = useMemo(() => {
    const map = new Map<string, "grant" | "deny">()
    for (const [key, effect] of overrides) {
      const roleHas = roleGrants.has(key)
      if (effect === "grant" && !roleHas) map.set(key, "grant")
      if (effect === "deny" && roleHas) map.set(key, "deny")
    }
    return overridesFromMap(map)
  }, [overrides, roleGrants])

  const savedOverrides = member.permission_overrides ?? []
  const nameDirty = fullName.trim() !== (member.user.full_name ?? "")
  const roleDirty =
    role !== member.role ||
    projectScope !== (member.project_scope ?? "all") ||
    divisionScope !== (member.division_scope ?? "all") ||
    [...divisionIds].sort().join(",") !== [...(member.division_ids ?? [])].sort().join(",") ||
    JSON.stringify([...saveOverrides].sort(sortOverride)) !== JSON.stringify([...savedOverrides].sort(sortOverride))
  const laborDirty =
    toCents(cost) !== (member.labor_cost_rate_cents ?? 0) ||
    toCents(bill) !== (member.labor_bill_rate_cents ?? 0) ||
    Number(burden || 1) !== Number(member.labor_burden_multiplier ?? 1) ||
    billable !== (member.labor_is_billable_default ?? true)

  const dirtyCount = (nameDirty ? 1 : 0) + (roleDirty ? 1 : 0) + (laborDirty ? 1 : 0)
  const dirty = dirtyCount > 0

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  const burdenValue = Number(burden)
  const burdenInvalid = burden.trim() !== "" && (!Number.isFinite(burdenValue) || burdenValue < 1)

  const save = () => {
    if (!dirty || burdenInvalid) return
    const effectiveScope: "all" | "assigned" = scopeApplies ? projectScope : "all"
    const effectiveDivisionScope: "all" | "assigned" = scopeApplies ? divisionScope : "all"

    // Patch the local member from the fields we changed rather than trusting the
    // granular actions' varied return shapes (profile → user, labor → partial row).
    let next: TeamMember = member
    startTransition(async () => {
      try {
        if (canManageMembers && nameDirty) {
          unwrapAction(await updateMemberProfileAction(member.user.id, { full_name: fullName.trim() }))
          next = { ...next, user: { ...next.user, full_name: fullName.trim() } }
        }
        if (canEditRoles && roleDirty) {
          unwrapAction(
            await updateMemberRoleAction(member.id, {
              role,
              projectScope: effectiveScope,
              divisionScope: effectiveDivisionScope,
              divisionIds: effectiveDivisionScope === "assigned" ? divisionIds : [],
              permissionOverrides: saveOverrides,
            }),
          )
          next = {
            ...next,
            role,
            role_label: availableRoles.find((option) => option.key === role)?.label ?? next.role_label,
            project_scope: effectiveScope,
            division_scope: effectiveDivisionScope,
            division_ids: effectiveDivisionScope === "assigned" ? divisionIds : [],
            permission_overrides: saveOverrides,
          }
        }
        if (canManageMembers && laborDirty) {
          unwrapAction(
            await updateMemberLaborSettingsAction(member.id, {
              labor_cost_rate_cents: toCents(cost),
              labor_bill_rate_cents: toCents(bill),
              labor_burden_multiplier: Math.max(1, Number(burden) || 1),
              labor_is_billable_default: billable,
            }),
          )
          next = {
            ...next,
            labor_cost_rate_cents: toCents(cost),
            labor_bill_rate_cents: toCents(bill),
            labor_burden_multiplier: Math.max(1, Number(burden) || 1),
            labor_is_billable_default: billable,
          }
        }
        toast.success(`${displayName(next).label} updated`)
        onSaved(next)
      } catch (error) {
        toast.error("Couldn't save changes", { description: (error as Error).message })
      }
    })
  }

  const now = Date.now()
  const activity = activityDescriptor(member, now)
  const name = displayName(member)
  const readOnlyAccess = !canEditRoles

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <SheetHeader className="shrink-0 gap-0 border-b border-border p-0">
        <div className="flex items-center gap-3 px-5 py-4">
          <Avatar className="size-9 shrink-0 rounded-none">
            <AvatarImage src={member.user.avatar_url || undefined} alt="" />
            <AvatarFallback className="rounded-none bg-muted text-xs font-medium">
              {initials(member.user.full_name, member.user.email)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <SheetTitle className={cn("truncate text-sm font-medium", name.muted && "text-muted-foreground italic")}>
              {name.label}
            </SheetTitle>
            <p className="truncate text-xs text-muted-foreground">{member.user.email}</p>
          </div>
          {total > 1 ? (
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="outline" size="icon" className="size-7" onClick={onPrev} aria-label="Previous member">
                <ArrowUp className="size-3.5" />
              </Button>
              <span className="microlabel tabular-nums px-1">
                {index + 1} / {total}
              </span>
              <Button variant="outline" size="icon" className="size-7" onClick={onNext} aria-label="Next member">
                <ArrowDown className="size-3.5" />
              </Button>
            </div>
          ) : null}
        </div>
        <Tabs value={tab} onValueChange={(value) => onTabChange(value as InspectorTab)} className="gap-0">
          <TabsList className="h-9 w-full justify-start gap-0 rounded-none border-t border-border bg-transparent p-0">
            {(["access", "permissions", "rates", "activity"] as const).map((value) => (
              <TabsTrigger
                key={value}
                value={value}
                className="h-9 rounded-none border-b-2 border-transparent px-4 text-xs capitalize data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:shadow-none"
              >
                {value}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </SheetHeader>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="min-h-0">
        <div className="px-5 py-5">
          {tab === "access" ? (
            <div className="space-y-6">
              <section className="space-y-2">
                <p className="microlabel">Name</p>
                <Input
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  disabled={!canManageMembers}
                  placeholder={member.status === "invited" ? "Set once they accept" : "Full name"}
                />
              </section>

              <section className="space-y-2">
                <p className="microlabel">Role</p>
                <Select value={role} onValueChange={(value) => setRole(value as OrgRole)} disabled={readOnlyAccess}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableRoles.map((option) => (
                      <SelectItem key={option.key} value={option.key}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {availableRoles.find((option) => option.key === role)?.description ??
                    (roleIsAdmin ? "Full access to every project, setting, and approval." : "Access is scoped — refine it with permissions.")}
                </p>
              </section>

              <section className="space-y-2">
                <p className="microlabel">Project access</p>
                {roleIsAdmin ? (
                  <p className="text-sm text-muted-foreground">Admin roles always see every project.</p>
                ) : (
                  <>
                    <ToggleGroup
                      type="single"
                      value={projectScope}
                      onValueChange={(value) => value && setProjectScope(value as "all" | "assigned")}
                      variant="outline"
                      disabled={readOnlyAccess}
                      className="justify-start"
                    >
                      <ToggleGroupItem value="all" className="px-3 text-xs">
                        All projects
                      </ToggleGroupItem>
                      <ToggleGroupItem value="assigned" className="px-3 text-xs">
                        Assigned only
                      </ToggleGroupItem>
                    </ToggleGroup>
                    {projectScope === "assigned" ? (
                      <p className="text-xs text-muted-foreground">
                        Add this person to specific jobs from each project&rsquo;s Team panel.
                      </p>
                    ) : null}
                  </>
                )}
              </section>

              {scopeApplies && divisions.length > 0 ? (
                <section className="space-y-2">
                  <p className="microlabel">Division access</p>
                  <ToggleGroup
                    type="single"
                    value={divisionScope}
                    onValueChange={(value) => value && setDivisionScope(value as "all" | "assigned")}
                    variant="outline"
                    disabled={readOnlyAccess}
                    className="justify-start"
                  >
                    <ToggleGroupItem value="all" className="px-3 text-xs">
                      All divisions
                    </ToggleGroupItem>
                    <ToggleGroupItem value="assigned" className="px-3 text-xs">
                      Selected
                    </ToggleGroupItem>
                  </ToggleGroup>
                  {divisionScope === "assigned" ? (
                    <div className="mt-1 divide-y divide-border border-t border-border">
                      {divisions
                        .filter((division) => !division.archived)
                        .map((division) => (
                          <label key={division.id} className="flex items-center gap-2 py-2 text-sm">
                            <Checkbox
                              id={`division-${division.id}`}
                              checked={divisionIds.includes(division.id)}
                              disabled={readOnlyAccess}
                              onCheckedChange={(checked) =>
                                setDivisionIds((current) =>
                                  checked ? Array.from(new Set([...current, division.id])) : current.filter((id) => id !== division.id),
                                )
                              }
                            />
                            <span>{division.name}</span>
                          </label>
                        ))}
                    </div>
                  ) : null}
                </section>
              ) : null}

              {readOnlyAccess ? (
                <p className="microlabel">Role and access are managed by an administrator.</p>
              ) : null}
            </div>
          ) : null}

          {tab === "permissions" ? (
            <PermissionsTab
              roleIsAdmin={roleIsAdmin}
              roleLabel={availableRoles.find((option) => option.key === role)?.label ?? role}
              permissionOptions={permissionOptions}
              roleGrants={roleGrants}
              effective={effective}
              overrides={overrides}
              isChecked={isChecked}
              onToggle={togglePermission}
              onToggleCategory={toggleCategory}
              onReset={resetToRole}
              search={permSearch}
              onSearchChange={setPermSearch}
              readOnly={readOnlyAccess}
            />
          ) : null}

          {tab === "rates" ? (
            <div className="space-y-6">
              <p className="text-xs text-muted-foreground">
                Default rates for this person&rsquo;s time entries. A project&rsquo;s rate schedule overrides the bill rate when one applies.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <section className="space-y-2">
                  <p className="microlabel">Cost / hr</p>
                  <InputGroup>
                    <InputGroupAddon align="inline-start">
                      <InputGroupText>$</InputGroupText>
                    </InputGroupAddon>
                    <InputGroupInput
                      inputMode="decimal"
                      value={cost}
                      onChange={(event) => setCost(event.target.value.replace(/[^\d.]/g, ""))}
                      disabled={!canManageMembers}
                      placeholder="Not set"
                      className="text-right tabular-nums"
                    />
                  </InputGroup>
                </section>
                <section className="space-y-2">
                  <p className="microlabel">Bill / hr</p>
                  <InputGroup>
                    <InputGroupAddon align="inline-start">
                      <InputGroupText>$</InputGroupText>
                    </InputGroupAddon>
                    <InputGroupInput
                      inputMode="decimal"
                      value={bill}
                      onChange={(event) => setBill(event.target.value.replace(/[^\d.]/g, ""))}
                      disabled={!canManageMembers}
                      placeholder="Not set"
                      className="text-right tabular-nums"
                    />
                  </InputGroup>
                </section>
                <section className="space-y-2">
                  <Label htmlFor="labor-burden" className="microlabel">
                    Burden multiplier
                  </Label>
                  <Input
                    id="labor-burden"
                    inputMode="decimal"
                    value={burden}
                    onChange={(event) => setBurden(event.target.value.replace(/[^\d.]/g, ""))}
                    disabled={!canManageMembers}
                    placeholder="1.00"
                    className="tabular-nums"
                    aria-invalid={burdenInvalid || undefined}
                  />
                  {burdenInvalid ? (
                    <p role="alert" className="text-xs text-destructive">
                      Burden multiplier must be at least 1.00.
                    </p>
                  ) : null}
                </section>
                <section className="space-y-2">
                  <p className="microlabel">Billable by default</p>
                  <label className="flex h-9 items-center gap-2 border border-input px-3 text-sm">
                    <Switch checked={billable} onCheckedChange={setBillable} disabled={!canManageMembers} />
                    <span className="text-muted-foreground">{billable ? "Billable" : "Non-billable"}</span>
                  </label>
                </section>
              </div>
              {toCents(cost) > 0 ? (
                (() => {
                  const burdenMult = Math.max(1, Number(burden) || 1)
                  const loadedCents = toCents(cost) * burdenMult
                  const billCents = toCents(bill)
                  const margin = billCents > 0 ? ((billCents - loadedCents) / billCents) * 100 : null
                  return (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      Loaded cost ${(loadedCents / 100).toFixed(2)}/hr
                      {margin !== null ? ` · Margin ${margin.toFixed(0)}%` : ""}
                    </p>
                  )
                })()
              ) : null}
              {!canManageMembers ? <p className="microlabel">Rates are managed by an administrator.</p> : null}
            </div>
          ) : null}

          {tab === "activity" ? (
            <dl className="grid grid-cols-[132px_1fr] gap-y-3 text-sm">
              <ActivityRow label="Status" value={activity.detail ? `${activity.word} · ${activity.detail}` : activity.word} />
              <ActivityRow
                label="Member since"
                value={member.created_at ? new Date(member.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—"}
              />
              <ActivityRow label="Invited by" value={member.invited_by?.full_name ?? "—"} />
              <ActivityRow
                label="Last active"
                value={member.last_active_at ? (relativeTime(member.last_active_at, now) ?? "—") : "Never signed in"}
              />
              <dt className="text-muted-foreground">Two-factor</dt>
              <dd className="flex items-center gap-2">
                {member.mfa_enabled ? (
                  <span className="inline-flex items-center gap-1.5 text-sm">
                    <ShieldCheck className="size-3.5 text-muted-foreground" />
                    Enabled
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">Not enabled</span>
                )}
                {canManageMembers && member.mfa_enabled && member.status !== "invited" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => onResetMfa(member)}
                  >
                    <KeyRound className="mr-1 size-3" />
                    Reset
                  </Button>
                ) : null}
              </dd>
            </dl>
          ) : null}
        </div>
      </ScrollArea>

      <SheetFooter className="flex-row items-center gap-2 border-t border-border bg-background px-5 py-3">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {dirty ? `${dirtyCount} unsaved ${dirtyCount === 1 ? "change" : "changes"}` : "No changes"}
        </span>
        <Button variant="outline" size="sm" onClick={onRequestClose} disabled={isPending}>
          {dirty ? "Cancel" : "Close"}
        </Button>
        <Button size="sm" onClick={save} disabled={!dirty || isPending || burdenInvalid}>
          {isPending ? "Saving…" : "Save changes"}
        </Button>
      </SheetFooter>
    </div>
  )
}

function sortOverride(a: { permission_key: string }, b: { permission_key: string }) {
  return a.permission_key.localeCompare(b.permission_key)
}

function ActivityRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </>
  )
}

function PermissionsTab({
  roleIsAdmin,
  roleLabel,
  permissionOptions,
  roleGrants,
  effective,
  overrides,
  isChecked,
  onToggle,
  onToggleCategory,
  onReset,
  search,
  onSearchChange,
  readOnly,
}: {
  roleIsAdmin: boolean
  roleLabel: string
  permissionOptions: PermissionOption[]
  roleGrants: Set<string>
  effective: Set<string>
  overrides: Map<string, "grant" | "deny">
  isChecked: (key: string) => boolean
  onToggle: (key: string, want: boolean) => void
  onToggleCategory: (options: PermissionOption[], want: boolean) => void
  onReset: () => void
  search: string
  onSearchChange: (value: string) => void
  readOnly: boolean
}) {
  const query = search.trim().toLowerCase()
  const groups = useMemo(() => groupPermissions(permissionOptions), [permissionOptions])
  const filtered = useMemo(() => {
    if (!query) return groups
    return groups
      .map((group) => ({
        category: group.category,
        options: group.options.filter((option) =>
          [option.label, option.description, option.key].some((value) => value?.toLowerCase().includes(query)),
        ),
      }))
      .filter((group) => group.options.length > 0)
  }, [groups, query])

  const openByDefault = query ? filtered.map((group) => group.category) : []

  if (roleIsAdmin) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <ShieldCheck className="size-8 text-muted-foreground/50" />
        <p className="max-w-xs text-sm text-muted-foreground">{ADMIN_NOTE}</p>
      </div>
    )
  }

  const added = overrides.size ? [...overrides.values()].filter((effect) => effect === "grant").length : 0
  const removed = overrides.size ? [...overrides.values()].filter((effect) => effect === "deny").length : 0

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm">
          <span className="font-medium tabular-nums">{effective.size}</span> of {permissionOptions.length} permissions
        </p>
        <p className="text-xs text-muted-foreground">
          {roleGrants.size} from the {roleLabel} role
          {added > 0 ? ` · ${added} added` : ""}
          {removed > 0 ? ` · ${removed} removed` : ""}
        </p>
        {!readOnly && overrides.size > 0 ? (
          <Button variant="ghost" size="sm" className="-ml-2 h-7 px-2 text-xs" onClick={onReset}>
            Reset to role defaults
          </Button>
        ) : null}
      </div>

      <InputGroup>
        <InputGroupAddon align="inline-start">
          <Search className="size-3.5" />
        </InputGroupAddon>
        <InputGroupInput
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search permissions"
          aria-label="Search permissions"
        />
      </InputGroup>

      {filtered.length === 0 ? (
        <p className="px-1 py-6 text-center text-xs text-muted-foreground">No permissions match &ldquo;{search}&rdquo;.</p>
      ) : (
        <Accordion type="multiple" defaultValue={openByDefault} className="divide-y divide-border border-t border-border">
          {filtered.map((group) => {
            const total = group.options.length
            const selected = group.options.filter((option) => isChecked(option.key)).length
            const allOn = selected === total && total > 0
            const someOn = selected > 0 && !allOn
            return (
              <AccordionItem key={group.category} value={group.category} className="border-b-0">
                <div className="flex items-center gap-2 py-1">
                  <Checkbox
                    checked={allOn ? true : someOn ? "indeterminate" : false}
                    disabled={readOnly}
                    onCheckedChange={(checked) => onToggleCategory(group.options, checked === true)}
                    aria-label={`Toggle all ${group.category}`}
                  />
                  <AccordionTrigger className="flex-1 py-2 text-xs font-medium hover:no-underline">
                    <span className="flex items-center gap-2">
                      {group.category}
                      <span className="microlabel tabular-nums">
                        {selected}/{total}
                      </span>
                    </span>
                  </AccordionTrigger>
                </div>
                <AccordionContent className="pb-2">
                  <div className="space-y-0.5">
                    {group.options.map((option) => {
                      const checked = isChecked(option.key)
                      const roleHas = roleGrants.has(option.key)
                      const source = checked === roleHas ? "ROLE" : checked ? "ADDED" : "REMOVED"
                      return (
                        <label
                          key={option.key}
                          htmlFor={`perm-${option.key}`}
                          className={cn(
                            "flex items-start gap-2.5 px-1 py-1.5 text-sm",
                            readOnly ? "cursor-default" : "cursor-pointer hover:bg-muted/40",
                          )}
                        >
                          <Checkbox
                            id={`perm-${option.key}`}
                            className="mt-0.5"
                            checked={checked}
                            disabled={readOnly}
                            onCheckedChange={(value) => onToggle(option.key, value === true)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block leading-snug">{option.label}</span>
                            {option.description ? (
                              <span className="block text-xs text-muted-foreground">{option.description}</span>
                            ) : null}
                          </span>
                          <span
                            className={cn(
                              "microlabel shrink-0",
                              source === "ADDED" && "text-primary",
                              source === "REMOVED" && "text-warning",
                            )}
                          >
                            {source === "ROLE" ? "" : source}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </AccordionContent>
              </AccordionItem>
            )
          })}
        </Accordion>
      )}
      {readOnly ? <p className="microlabel">Permissions are managed by an administrator.</p> : null}
    </div>
  )
}
