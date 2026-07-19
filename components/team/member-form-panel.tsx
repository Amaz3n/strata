"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import {
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import {
  Briefcase,
  HardHat,
  Search,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Users,
  Wallet,
} from "@/components/icons"
import { cn } from "@/lib/utils"
import { useToast } from "@/hooks/use-toast"
import {
  inviteTeamMemberAction,
  updateMemberLaborSettingsAction,
  updateMemberProfileAction,
  updateMemberRoleAction,
} from "@/app/(app)/team/actions"
import type {
  MemberPermissionOverride,
  OrgRole,
  OrgRoleOption,
  PermissionOption,
  TeamMember,
} from "@/lib/types"
import type { DivisionDTO } from "@/lib/services/divisions"

import { unwrapAction } from "@/lib/action-result"

type PermissionPreset = "standard" | "project_manager" | "field" | "office_finance" | "custom"

const PRESET_GRANTS: Record<Exclude<PermissionPreset, "custom">, string[]> = {
  standard: [],
  project_manager: [
    "project.settings.update",
    "docs.share",
    "portal.access.manage",
    "schedule.publish",
    "rfi.close",
    "submittal.review",
    "bid.read",
    "bid.write",
    "proposal.read",
    "proposal.write",
    "signature.read",
    "signature.send",
    "budget.read",
    "commitment.read",
    "change_order.approve",
    "invoice.read",
    "report.read",
  ],
  field: ["schedule.publish", "daily_log.approve", "rfi.close", "submittal.review", "punch.close"],
  office_finance: [
    "budget.read",
    "budget.write",
    "commitment.read",
    "commitment.write",
    "commitment.approve",
    "change_order.approve",
    "invoice.read",
    "invoice.write",
    "invoice.approve",
    "invoice.send",
    "bill.read",
    "bill.write",
    "bill.approve",
    "payment.release",
    "draw.approve",
    "retainage.manage",
    "bid.read",
    "proposal.read",
    "signature.read",
    "report.read",
  ],
}

const PRESET_META: Array<{
  value: Exclude<PermissionPreset, "custom">
  label: string
  description: string
  icon: typeof Sparkles
}> = [
  {
    value: "standard",
    label: "Standard",
    description: "Project work on assigned projects only. No financial or admin access.",
    icon: Sparkles,
  },
  {
    value: "project_manager",
    label: "Project Manager",
    description: "Run projects end-to-end: schedule, RFIs, submittals, bids, change orders.",
    icon: Briefcase,
  },
  {
    value: "field",
    label: "Field",
    description: "Daily logs, schedule updates, RFIs, submittals, punch list close-out.",
    icon: HardHat,
  },
  {
    value: "office_finance",
    label: "Office / Finance",
    description: "Budgets, commitments, invoices, bills, payments, draws, retainage.",
    icon: Wallet,
  },
]

const PRESET_LABEL: Record<PermissionPreset, string> = {
  standard: "Standard",
  project_manager: "Project Manager",
  field: "Field",
  office_finance: "Office / Finance",
  custom: "Custom",
}

const ROLE_META: Record<string, { description: string; capabilities: string[]; icon: typeof Shield }> = {
  org_admin: {
    description: "Full access. Can manage settings, billing, team, and every project.",
    capabilities: [
      "Workspace settings, billing & integrations",
      "Manage team members and roles",
      "Access every project and approval",
    ],
    icon: ShieldCheck,
  },
  org_user: {
    description: "Scoped access by project. Add or restrict capabilities with permissions below.",
    capabilities: [
      "Access only assigned projects by default",
      "Field & collaboration tools out of the box",
      "Add financial / admin powers via presets or matrix",
    ],
    icon: Shield,
  },
}

function toRoleLabel(roleKey: string) {
  return roleKey
    .replace(/^org_/, "")
    .split("_")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
}

function normalizeRoleLabel(label: string | undefined, roleKey: string) {
  const candidate = (label ?? "").replace(/^org[\s_-]+/i, "").trim()
  return candidate || toRoleLabel(roleKey)
}

function buildGrantOverrides(keys: Iterable<string>): MemberPermissionOverride[] {
  return Array.from(new Set(keys)).map((permission_key) => ({ permission_key, effect: "grant" as const }))
}

function detectPreset(overrides: MemberPermissionOverride[]): PermissionPreset {
  const keys = overrides
    .filter((override) => override.effect === "grant")
    .map((override) => override.permission_key)
    .sort()
  for (const [preset, presetKeys] of Object.entries(PRESET_GRANTS)) {
    const sortedPresetKeys = [...presetKeys].sort()
    if (keys.length === sortedPresetKeys.length && keys.every((key, index) => key === sortedPresetKeys[index])) {
      return preset as PermissionPreset
    }
  }
  return keys.length === 0 ? "standard" : "custom"
}

function diffFromPreset(selected: Set<string>, preset: PermissionPreset): { added: number; removed: number } {
  if (preset === "custom") return { added: 0, removed: 0 }
  const presetSet = new Set(PRESET_GRANTS[preset])
  let added = 0
  let removed = 0
  selected.forEach((key) => {
    if (!presetSet.has(key)) added += 1
  })
  presetSet.forEach((key) => {
    if (!selected.has(key)) removed += 1
  })
  return { added, removed }
}

function centsToDollars(cents?: number | null) {
  if (!cents) return ""
  return (cents / 100).toFixed(2)
}

function dollarsToCents(value: string) {
  const parsed = Number(value.replaceAll(",", "").trim())
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return Math.round(parsed * 100)
}

interface MemberFormPanelProps {
  mode: "invite" | "edit"
  member?: TeamMember
  roleOptions?: OrgRoleOption[]
  permissionOptions?: PermissionOption[]
  divisions?: DivisionDTO[]
  canManageMembers?: boolean
  canEditRoles?: boolean
  onCancel: () => void
  onSuccess?: () => void
  className?: string
}

export function MemberFormPanel({
  mode,
  member,
  roleOptions = [],
  permissionOptions = [],
  divisions = [],
  canManageMembers = false,
  canEditRoles = false,
  onCancel,
  onSuccess,
  className,
}: MemberFormPanelProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()

  const baseRoleOptions = roleOptions.length
    ? roleOptions
    : [
        { key: "org_admin", label: "Admin" },
        { key: "org_user", label: "Member" },
      ]
  const normalizedRoleOptions =
    mode === "edit" && member && !baseRoleOptions.some((option) => option.key === member.role)
      ? [{ key: member.role, label: member.role_label ?? toRoleLabel(member.role) }, ...baseRoleOptions]
      : baseRoleOptions

  const defaultRole =
    mode === "edit" && member
      ? member.role
      : (normalizedRoleOptions.find((option) => option.key === "org_user")?.key ??
          normalizedRoleOptions[0]?.key ??
          "org_user")

  const initialOverrides = mode === "edit" ? member?.permission_overrides ?? [] : []

  const [email, setEmail] = useState("")
  const [fullName, setFullName] = useState(member?.user.full_name ?? "")
  const [role, setRole] = useState<OrgRole>(defaultRole as OrgRole)
  const [projectScope, setProjectScope] = useState<"all" | "assigned">(member?.project_scope ?? "all")
  const [divisionScope, setDivisionScope] = useState<"all" | "assigned">(member?.division_scope ?? "all")
  const [divisionIds, setDivisionIds] = useState<string[]>(member?.division_ids ?? [])
  const [overrides, setOverrides] = useState<MemberPermissionOverride[]>(initialOverrides)
  const [preset, setPreset] = useState<PermissionPreset>(detectPreset(initialOverrides))
  const [search, setSearch] = useState("")
  const [laborCostRate, setLaborCostRate] = useState(centsToDollars(member?.labor_cost_rate_cents))
  const [laborBillRate, setLaborBillRate] = useState(centsToDollars(member?.labor_bill_rate_cents))
  const [laborBurdenMultiplier, setLaborBurdenMultiplier] = useState(String(member?.labor_burden_multiplier ?? 1))
  const [laborIsBillableDefault, setLaborIsBillableDefault] = useState(member?.labor_is_billable_default ?? true)

  const isEdit = mode === "edit"
  const canEditProfile = isEdit ? canManageMembers : canManageMembers
  const canEditRoleField = isEdit ? canEditRoles : true

  const selected = useMemo(
    () => new Set(overrides.filter((o) => o.effect === "grant").map((o) => o.permission_key)),
    [overrides],
  )

  const grouped = useMemo(() => {
    return permissionOptions.reduce<Record<string, PermissionOption[]>>((acc, option) => {
      acc[option.category] = acc[option.category] ?? []
      acc[option.category].push(option)
      return acc
    }, {})
  }, [permissionOptions])

  const filteredGrouped = useMemo(() => {
    if (!search.trim()) return grouped
    const query = search.toLowerCase()
    return Object.entries(grouped).reduce<Record<string, PermissionOption[]>>((acc, [category, options]) => {
      const matches = options.filter((option) =>
        [option.label, option.description, option.key].some((value) => value?.toLowerCase().includes(query)),
      )
      if (matches.length > 0) acc[category] = matches
      return acc
    }, {})
  }, [grouped, search])

  const totalCount = permissionOptions.length
  const selectedCount = selected.size
  const diff = useMemo(() => diffFromPreset(selected, preset), [selected, preset])
  const isDirty = preset !== "custom" && (diff.added > 0 || diff.removed > 0)

  const applyPreset = (next: PermissionPreset) => {
    setPreset(next)
    if (next !== "custom") setOverrides(buildGrantOverrides(PRESET_GRANTS[next]))
  }

  const togglePermission = (key: string, checked: boolean) => {
    const next = new Set(selected)
    if (checked) next.add(key)
    else next.delete(key)
    const nextOverrides = buildGrantOverrides(next)
    setOverrides(nextOverrides)
    setPreset(detectPreset(nextOverrides))
  }

  const resetToPreset = () => {
    if (preset === "custom") return
    setOverrides(buildGrantOverrides(PRESET_GRANTS[preset]))
  }

  const selectedRoleOption = normalizedRoleOptions.find((option) => option.key === role)
  const roleMeta = ROLE_META[role]

  // Roles that carry org.admin see every project regardless of scope, so the
  // Assigned-only toggle is meaningless (and hidden) for them.
  const ADMIN_ROLE_KEYS = new Set(["org_owner", "org_admin", "org_office_admin"])
  const scopeApplies = !ADMIN_ROLE_KEYS.has(role)
  const effectiveScope: "all" | "assigned" = scopeApplies ? projectScope : "all"
  const effectiveDivisionScope: "all" | "assigned" = scopeApplies ? divisionScope : "all"

  const hasNameChange = isEdit && fullName.trim() !== (member?.user.full_name ?? "")
  const hasRoleChange = isEdit && role !== member?.role
  const hasScopeChange = isEdit && effectiveScope !== (member?.project_scope ?? "all")
  const hasDivisionScopeChange =
    isEdit &&
    (effectiveDivisionScope !== (member?.division_scope ?? "all") ||
      [...divisionIds].sort().join(",") !== [...(member?.division_ids ?? [])].sort().join(","))
  const hasPermissionChange =
    isEdit &&
    JSON.stringify(role === "org_user" ? overrides : []) !==
      JSON.stringify(member?.role === "org_user" ? member?.permission_overrides ?? [] : [])
  const nextLaborCostRateCents = dollarsToCents(laborCostRate)
  const nextLaborBillRateCents = dollarsToCents(laborBillRate)
  const nextLaborBurdenMultiplier = Math.max(1, Number(laborBurdenMultiplier) || 1)
  const hasLaborChange =
    isEdit &&
    (nextLaborCostRateCents !== (member?.labor_cost_rate_cents ?? 0) ||
      nextLaborBillRateCents !== (member?.labor_bill_rate_cents ?? 0) ||
      nextLaborBurdenMultiplier !== Number(member?.labor_burden_multiplier ?? 1) ||
      laborIsBillableDefault !== (member?.labor_is_billable_default ?? true))

  const hasChanges = isEdit
    ? (canEditProfile && hasNameChange) || (canEditRoleField && (hasRoleChange || hasScopeChange || hasDivisionScopeChange || hasPermissionChange)) || (canManageMembers && hasLaborChange)
    : Boolean(email.trim())

  const submit = () => {
    if (mode === "invite") {
      if (!canManageMembers) {
        toast({ title: "Permission required", description: "You need member management access to invite teammates." })
        return
      }
      startTransition(async () => {
        try {
          const result = unwrapAction(await inviteTeamMemberAction({
            email,
            role,
            projectScope: effectiveScope,
            divisionScope: effectiveDivisionScope,
            divisionIds: effectiveDivisionScope === "assigned" ? divisionIds : [],
            permissionOverrides: role === "org_user" ? overrides : [],
          }))
          if (result?.tempPassword) {
            toast({ title: "Invite created (dev)", description: `Temp password: ${result.tempPassword}` })
          } else {
            toast({ title: "Invite sent" })
          }
          if (onSuccess) onSuccess()
          else router.refresh()
          onCancel()
        } catch (error) {
          toast({ title: "Invite failed", description: (error as Error).message })
        }
      })
      return
    }

    if (!member) return
    if (!hasChanges) {
      onCancel()
      return
    }
    startTransition(async () => {
      try {
        if (canEditProfile && hasNameChange) {
          unwrapAction(await updateMemberProfileAction(member.user.id, { full_name: fullName.trim() }))
        }
        if (canEditRoleField && (hasRoleChange || hasScopeChange || hasDivisionScopeChange || hasPermissionChange)) {
          unwrapAction(await updateMemberRoleAction(member.id, {
            role,
            projectScope: effectiveScope,
            divisionScope: effectiveDivisionScope,
            divisionIds: effectiveDivisionScope === "assigned" ? divisionIds : [],
            permissionOverrides: role === "org_user" ? overrides : [],
          }))
        }
        if (canManageMembers && hasLaborChange) {
          unwrapAction(await updateMemberLaborSettingsAction(member.id, {
            labor_cost_rate_cents: nextLaborCostRateCents,
            labor_bill_rate_cents: nextLaborBillRateCents,
            labor_burden_multiplier: nextLaborBurdenMultiplier,
            labor_is_billable_default: laborIsBillableDefault,
          }))
        }
        toast({ title: "Member updated" })
        if (onSuccess) onSuccess()
        else router.refresh()
        onCancel()
      } catch (error) {
        toast({ title: "Unable to update member", description: (error as Error).message })
      }
    })
  }

  const submitDisabled =
    isPending ||
    (mode === "invite" ? !email.trim() : !hasChanges) ||
    (mode === "edit" && canEditProfile && !fullName.trim())

  const RoleIcon = roleMeta?.icon ?? Shield

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
      <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
        <SheetTitle className="flex items-center gap-2">
          <Users className="h-4 w-4 text-primary" />
          {isEdit ? "Edit team member" : "Invite team member"}
        </SheetTitle>
        <SheetDescription className="text-sm text-muted-foreground text-left">
          {isEdit
            ? `${member?.user.full_name ?? member?.user.email ?? "Member"} · ${member?.user.email ?? ""}`
            : "Send an invite, set their role, and pick a permission preset."}
        </SheetDescription>
      </SheetHeader>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-6 py-4 space-y-6">
          <section className="space-y-4">
            <SectionHeader title="Profile" description="Basic account details for this teammate." />
            <div className="grid gap-4 sm:grid-cols-2">
              {isEdit ? (
                <>
                  <FieldBlock label="Full name">
                    <Input
                      value={fullName}
                      onChange={(event) => setFullName(event.target.value)}
                      disabled={!canEditProfile}
                      placeholder="Full name"
                    />
                  </FieldBlock>
                  <FieldBlock label="Email">
                    <Input value={member?.user.email ?? ""} disabled />
                  </FieldBlock>
                </>
              ) : (
                <FieldBlock label="Email" className="sm:col-span-2">
                  <Input
                    type="email"
                    placeholder="person@company.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoFocus
                  />
                </FieldBlock>
              )}
            </div>
          </section>

          {isEdit ? (
            <>
              <Separator />
              <section className="space-y-4">
                <SectionHeader
                  title="Labor rates"
                  description="Defaults used when this employee logs time or is added to a crew time entry."
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <FieldBlock label="Cost rate / hr">
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
                      <Input
                        value={laborCostRate}
                        onChange={(event) => setLaborCostRate(event.target.value.replace(/[^\d.]/g, ""))}
                        disabled={!canManageMembers}
                        inputMode="decimal"
                        className="pl-7"
                        placeholder="0.00"
                      />
                    </div>
                  </FieldBlock>
                  <FieldBlock label="Bill rate / hr">
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
                      <Input
                        value={laborBillRate}
                        onChange={(event) => setLaborBillRate(event.target.value.replace(/[^\d.]/g, ""))}
                        disabled={!canManageMembers}
                        inputMode="decimal"
                        className="pl-7"
                        placeholder="0.00"
                      />
                    </div>
                  </FieldBlock>
                  <FieldBlock label="Burden multiplier">
                    <Input
                      value={laborBurdenMultiplier}
                      onChange={(event) => setLaborBurdenMultiplier(event.target.value.replace(/[^\d.]/g, ""))}
                      disabled={!canManageMembers}
                      inputMode="decimal"
                      placeholder="1.00"
                    />
                  </FieldBlock>
                  <FieldBlock label="Default billing">
                    <label className="flex h-10 items-center gap-2 rounded-md border px-3 text-sm">
                      <Checkbox
                        checked={laborIsBillableDefault}
                        onCheckedChange={(checked) => setLaborIsBillableDefault(Boolean(checked))}
                        disabled={!canManageMembers}
                      />
                      Billable by default
                    </label>
                  </FieldBlock>
                </div>
              </section>
            </>
          ) : null}

          <Separator />

          <section className="space-y-4">
            <SectionHeader
              title="Role"
              description="Admins get full access. Members are scoped — use permissions below to expand or restrict their access."
            />
            <div className="grid gap-3 sm:grid-cols-2">
              {normalizedRoleOptions.map((option) => {
                const meta = ROLE_META[option.key]
                const Icon = meta?.icon ?? Shield
                const active = role === option.key
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => canEditRoleField && setRole(option.key as OrgRole)}
                    disabled={!canEditRoleField}
                    className={cn(
                      "group flex h-full flex-col gap-2 rounded-lg border p-4 text-left transition-colors",
                      active
                        ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                        : "border-border/70 bg-background hover:border-border hover:bg-muted/40",
                      !canEditRoleField && "cursor-not-allowed opacity-70",
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div
                        className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-md border",
                          active ? "border-primary/40 bg-primary/10 text-primary" : "border-border/70 bg-muted/50 text-muted-foreground",
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <div
                        className={cn(
                          "h-4 w-4 rounded-full border-2",
                          active ? "border-primary bg-primary" : "border-muted-foreground/40",
                        )}
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-semibold">{normalizeRoleLabel(option.label, option.key)}</p>
                      <p className="text-xs text-muted-foreground">
                        {option.description ?? meta?.description ?? ""}
                      </p>
                    </div>
                    {meta?.capabilities ? (
                      <ul className="mt-auto space-y-1 pt-2 text-[11px] text-muted-foreground">
                        {meta.capabilities.map((item) => (
                          <li key={item} className="flex gap-1.5">
                            <span aria-hidden="true">•</span>
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </section>

          {scopeApplies ? (
            <>
              <Separator />
              <section className="space-y-4">
                <SectionHeader
                  title="Project access"
                  description="Limit this member to the projects they're explicitly assigned to, or give them the whole portfolio."
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  {(
                    [
                      {
                        value: "all" as const,
                        label: "All projects",
                        description: "Sees and works across every project in the company.",
                      },
                      {
                        value: "assigned" as const,
                        label: "Assigned only",
                        description: "Only sees projects they're added to as a project member.",
                      },
                    ]
                  ).map((option) => {
                    const active = projectScope === option.value
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => canEditRoleField && setProjectScope(option.value)}
                        disabled={!canEditRoleField}
                        className={cn(
                          "flex h-full flex-col gap-1 rounded-lg border p-4 text-left transition-colors",
                          active
                            ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                            : "border-border/70 bg-background hover:border-border hover:bg-muted/40",
                          !canEditRoleField && "cursor-not-allowed opacity-70",
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-semibold">{option.label}</p>
                          <div
                            className={cn(
                              "h-4 w-4 rounded-full border-2",
                              active ? "border-primary bg-primary" : "border-muted-foreground/40",
                            )}
                          />
                        </div>
                        <p className="text-xs text-muted-foreground">{option.description}</p>
                      </button>
                    )
                  })}
                </div>
              </section>
            </>
          ) : null}

          {scopeApplies && divisions.length > 0 ? (
            <>
              <Separator />
              <section className="space-y-4">
                <SectionHeader
                  title="Division access"
                  description="Limit community and lot visibility to selected operating divisions."
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  {([
                    { value: "all" as const, label: "All divisions", description: "Sees every division and its communities." },
                    { value: "assigned" as const, label: "Selected divisions", description: "Sees only the divisions selected below." },
                  ]).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      disabled={!canEditRoleField}
                      onClick={() => canEditRoleField && setDivisionScope(option.value)}
                      className={cn(
                        "border p-4 text-left",
                        divisionScope === option.value ? "border-primary bg-primary/5" : "border-border/70",
                      )}
                    >
                      <p className="text-sm font-semibold">{option.label}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{option.description}</p>
                    </button>
                  ))}
                </div>
                {divisionScope === "assigned" ? (
                  <div className="grid gap-2 border p-3 sm:grid-cols-2">
                    {divisions.filter((division) => !division.archived).map((division) => (
                      <label key={division.id} className="flex items-center gap-2 text-xs">
                        <Checkbox
                          checked={divisionIds.includes(division.id)}
                          disabled={!canEditRoleField}
                          onCheckedChange={(checked) => setDivisionIds((current) =>
                            checked ? Array.from(new Set([...current, division.id])) : current.filter((id) => id !== division.id),
                          )}
                        />
                        <span>{division.name}</span>
                      </label>
                    ))}
                  </div>
                ) : null}
              </section>
            </>
          ) : null}

          {role === "org_user" && permissionOptions.length > 0 ? (
            <>
              <Separator />
              <section className="space-y-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  <SectionHeader
                    title="Permissions"
                    description="Pick a preset to grant a bundle of capabilities, or build your own with the matrix."
                  />
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <RoleIcon className="h-3.5 w-3.5" />
                    <span>
                      {selectedCount} of {totalCount} granted
                    </span>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {PRESET_META.map((presetOption) => {
                    const Icon = presetOption.icon
                    const active = preset === presetOption.value
                    const grantCount = PRESET_GRANTS[presetOption.value].length
                    return (
                      <button
                        key={presetOption.value}
                        type="button"
                        onClick={() => canEditRoleField && applyPreset(presetOption.value)}
                        disabled={!canEditRoleField}
                        className={cn(
                          "group flex h-full flex-col gap-2 rounded-lg border p-3 text-left transition-colors",
                          active
                            ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                            : "border-border/70 bg-background hover:border-border hover:bg-muted/40",
                          !canEditRoleField && "cursor-not-allowed opacity-70",
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <div
                            className={cn(
                              "flex h-7 w-7 items-center justify-center rounded-md border",
                              active
                                ? "border-primary/40 bg-primary/10 text-primary"
                                : "border-border/70 bg-muted/50 text-muted-foreground",
                            )}
                          >
                            <Icon className="h-3.5 w-3.5" />
                          </div>
                          {active ? (
                            <Badge variant="outline" className="border-primary/30 bg-primary/10 text-[10px] text-primary">
                              Selected
                            </Badge>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">{grantCount} perms</span>
                          )}
                        </div>
                        <p className="text-sm font-semibold">{presetOption.label}</p>
                        <p className="text-xs text-muted-foreground">{presetOption.description}</p>
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    onClick={() => canEditRoleField && setPreset("custom")}
                    disabled={!canEditRoleField}
                    className={cn(
                      "group flex h-full flex-col gap-2 rounded-lg border border-dashed p-3 text-left transition-colors",
                      preset === "custom"
                        ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                        : "border-border/70 bg-background hover:border-border hover:bg-muted/40",
                      !canEditRoleField && "cursor-not-allowed opacity-70",
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div
                        className={cn(
                          "flex h-7 w-7 items-center justify-center rounded-md border",
                          preset === "custom"
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-border/70 bg-muted/50 text-muted-foreground",
                        )}
                      >
                        <SlidersHorizontal className="h-3.5 w-3.5" />
                      </div>
                      {preset === "custom" ? (
                        <Badge variant="outline" className="border-primary/30 bg-primary/10 text-[10px] text-primary">
                          Selected
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-sm font-semibold">Custom</p>
                    <p className="text-xs text-muted-foreground">Hand-pick exactly which permissions to grant.</p>
                  </button>
                </div>

                {isDirty ? (
                  <div className="flex flex-col gap-2 rounded-md border border-amber-300/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200 sm:flex-row sm:items-center sm:justify-between">
                    <span>
                      Modified from <strong>{PRESET_LABEL[preset]}</strong>: +{diff.added} added · −{diff.removed} removed
                    </span>
                    <div className="flex gap-2">
                      <Button type="button" size="sm" variant="ghost" onClick={() => setPreset("custom")}>
                        Keep as Custom
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={resetToPreset}>
                        Reset to {PRESET_LABEL[preset]}
                      </Button>
                    </div>
                  </div>
                ) : null}

                <PermissionMatrix
                  grouped={filteredGrouped}
                  totalGrouped={grouped}
                  selected={selected}
                  onToggle={togglePermission}
                  search={search}
                  onSearchChange={setSearch}
                  disabled={!canEditRoleField}
                />
              </section>
            </>
          ) : null}
        </div>
      </ScrollArea>

      <SheetFooter className="border-t bg-background/80 px-6 py-4 flex flex-row gap-2">
        <Button variant="outline" className="flex-1" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button className="flex-1" onClick={submit} disabled={submitDisabled}>
          {isPending ? (isEdit ? "Saving..." : "Sending...") : isEdit ? "Save changes" : "Send invite"}
        </Button>
      </SheetFooter>
    </div>
  )
}

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="space-y-1 text-left">
      <h3 className="text-sm font-semibold">{title}</h3>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  )
}

function FieldBlock({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("space-y-1.5 text-left", className)}>
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

function PermissionMatrix({
  grouped,
  totalGrouped,
  selected,
  onToggle,
  search,
  onSearchChange,
  disabled,
}: {
  grouped: Record<string, PermissionOption[]>
  totalGrouped: Record<string, PermissionOption[]>
  selected: Set<string>
  onToggle: (key: string, checked: boolean) => void
  search: string
  onSearchChange: (next: string) => void
  disabled?: boolean
}) {
  const categories = Object.keys(totalGrouped)
  const lastSearchRef = useRef(search)
  const [openCategories, setOpenCategories] = useState<string[]>([])

  // Auto-expand categories that have search matches.
  useEffect(() => {
    if (search === lastSearchRef.current) return
    lastSearchRef.current = search
    if (search.trim()) {
      setOpenCategories(Object.keys(grouped))
    } else {
      setOpenCategories([])
    }
  }, [search, grouped])

  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search permissions..."
          className="h-8 pl-8 text-xs"
        />
      </div>

      {Object.keys(grouped).length === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">
          No permissions match "{search}".
        </p>
      ) : (
        <Accordion
          type="multiple"
          value={openCategories}
          onValueChange={setOpenCategories}
          className="space-y-1"
        >
          {categories.map((category) => {
            const options = grouped[category]
            if (!options) return null
            const totalOptions = totalGrouped[category]?.length ?? 0
            const selectedInCategory = (totalGrouped[category] ?? []).filter((option) =>
              selected.has(option.key),
            ).length
            const allSelected = selectedInCategory === totalOptions && totalOptions > 0
            const someSelected = selectedInCategory > 0 && !allSelected

            return (
              <AccordionItem
                key={category}
                value={category}
                className="overflow-hidden rounded-md border border-border/60 bg-background"
              >
                <div className="flex items-center gap-2 px-3 py-1.5">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={(checked) => {
                      const next = checked === true
                      ;(totalGrouped[category] ?? []).forEach((option) => {
                        if (selected.has(option.key) !== next) onToggle(option.key, next)
                      })
                    }}
                    disabled={disabled}
                    aria-label={`Toggle all ${category}`}
                  />
                  <AccordionTrigger className="flex-1 px-0 py-2 text-xs font-medium hover:no-underline [&>svg]:ml-auto">
                    <span className="flex items-center gap-2 text-left">
                      {category}
                      <Badge variant="outline" className="text-[10px]">
                        {selectedInCategory}/{totalOptions}
                      </Badge>
                    </span>
                  </AccordionTrigger>
                </div>
                <AccordionContent className="border-t border-border/60 bg-muted/10 px-3 py-2">
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {options.map((option) => (
                      <label
                        key={option.key}
                        className={cn(
                          "flex items-start gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/40",
                          disabled && "cursor-not-allowed opacity-60",
                        )}
                      >
                        <Checkbox
                          checked={selected.has(option.key)}
                          onCheckedChange={(checked) => onToggle(option.key, checked === true)}
                          disabled={disabled}
                          className="mt-0.5"
                        />
                        <span className="flex-1 text-left">
                          <span className="block font-medium leading-snug">{option.label}</span>
                          {option.description ? (
                            <span className="block text-[11px] text-muted-foreground">{option.description}</span>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            )
          })}
        </Accordion>
      )}
    </div>
  )
}
