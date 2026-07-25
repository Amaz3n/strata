"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Archive, DollarSign, MoreHorizontal, Plus, Search, Trash2, XCircle } from "@/components/icons"
import { cn } from "@/lib/utils"
import { unwrapAction } from "@/lib/action-result"
import type {
  BillingRate,
  BillingRateKind,
  BillingRateOverride,
  BillingRateSchedule,
  BillingRateUnit,
} from "@/lib/services/billing-rate-schedules"
import {
  archiveBillingRateScheduleFormAction,
  assignBillingRateScheduleFormAction,
  createBillingRateFormAction,
  createBillingRateOverrideFormAction,
  createBillingRateScheduleFormAction,
  deleteBillingRateFormAction,
  deleteBillingRateOverrideFormAction,
  listBillingRateOptionsAction,
  listBillingRateOverridesAction,
  listBillingRateSchedulesAction,
} from "@/app/(app)/settings/cost-coding/billing-rates-actions"

type BillingRatesOptions = Awaited<ReturnType<typeof listBillingRateOptionsAction>>
type BillingRateContract = BillingRatesOptions["contracts"][number]
/** Schedule rates and project overrides share every field these helpers read. */
type AnyRate = Omit<BillingRate, "schedule_id">

type View = "schedules" | "overrides"

type ScheduleStatus = BillingRateSchedule["status"]

type Confirm =
  | { kind: "archive-schedule"; schedule: BillingRateSchedule }
  | { kind: "delete-rate"; rate: BillingRate; scheduleName: string }
  | { kind: "delete-override"; override: BillingRateOverride }

type RateFormState = {
  kind: BillingRateKind
  role_name: string
  user_id: string
  equipment_name: string
  cost_code_id: string
  rate_amount: string
  markup_percent: string
  unit: BillingRateUnit
  ot_multiplier: string
  dt_multiplier: string
  effective_from: string
  effective_to: string
}

const NONE = "__none__"

const TH = "microlabel sticky top-0 z-10 border-b border-border bg-background px-3 py-2 text-left whitespace-nowrap"
const TD = "px-3 py-2 align-middle"

const STATUS_VARIANT: Record<ScheduleStatus, "default" | "outline" | "secondary"> = {
  active: "default",
  draft: "outline",
  archived: "secondary",
}

const EMPTY_RATE: RateFormState = {
  kind: "labor_role",
  role_name: "",
  user_id: "",
  equipment_name: "",
  cost_code_id: "",
  rate_amount: "",
  markup_percent: "",
  unit: "hour",
  ot_multiplier: "1.5",
  dt_multiplier: "2",
  effective_from: "",
  effective_to: "",
}

function appendRateFields(fd: FormData, rate: RateFormState) {
  fd.set("kind", rate.kind)
  fd.set("role_name", rate.role_name)
  fd.set("user_id", rate.user_id || NONE)
  fd.set("equipment_name", rate.equipment_name)
  fd.set("cost_code_id", rate.cost_code_id || NONE)
  fd.set("rate_amount", rate.rate_amount)
  fd.set("markup_percent", rate.markup_percent)
  fd.set("unit", rate.unit)
  fd.set("ot_multiplier", rate.ot_multiplier)
  fd.set("dt_multiplier", rate.dt_multiplier)
  fd.set("effective_from", rate.effective_from)
  fd.set("effective_to", rate.effective_to)
}

interface BillingRatesRosterProps {
  schedules: BillingRateSchedule[]
  overrides: BillingRateOverride[]
  options: BillingRatesOptions
  canManage: boolean
}

export function BillingRatesRoster({
  schedules: initialSchedules,
  overrides: initialOverrides,
  options: initialOptions,
  canManage,
}: BillingRatesRosterProps) {
  const router = useRouter()
  const [schedules, setSchedules] = useState(initialSchedules)
  const [overrides, setOverrides] = useState(initialOverrides)
  const [options, setOptions] = useState(initialOptions)
  const [view, setView] = useState<View>("schedules")
  const [query, setQuery] = useState("")
  const [detailId, setDetailId] = useState<string | null>(null)
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false)
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [pending, setPending] = useState(false)

  // Reconcile local state whenever the server re-renders with fresh data.
  useEffect(() => setSchedules(initialSchedules), [initialSchedules])
  useEffect(() => setOverrides(initialOverrides), [initialOverrides])
  useEffect(() => setOptions(initialOptions), [initialOptions])

  const assignableSchedules = useMemo(() => schedules.filter((schedule) => schedule.status !== "archived"), [schedules])

  const assignedCountBySchedule = useMemo(() => {
    const map = new Map<string, number>()
    for (const contract of options.contracts) {
      if (contract.rate_schedule_id) map.set(contract.rate_schedule_id, (map.get(contract.rate_schedule_id) ?? 0) + 1)
    }
    return map
  }, [options.contracts])

  const activeCount = useMemo(() => schedules.filter((schedule) => schedule.status === "active").length, [schedules])
  const assignedProjects = useMemo(
    () => options.contracts.filter((contract) => !!contract.rate_schedule_id).length,
    [options.contracts],
  )

  const visibleSchedules = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return schedules
    return schedules.filter(
      (schedule) =>
        schedule.name.toLowerCase().includes(q) || (schedule.description?.toLowerCase().includes(q) ?? false),
    )
  }, [schedules, query])

  const visibleOverrides = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return overrides
    return overrides.filter((override) =>
      [override.project_name, override.contract_label, rateTarget(override)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    )
  }, [overrides, query])

  const detail = useMemo(() => schedules.find((schedule) => schedule.id === detailId) ?? null, [schedules, detailId])
  const detailAssigned = useMemo(
    () => (detail ? options.contracts.filter((contract) => contract.rate_schedule_id === detail.id) : []),
    [detail, options.contracts],
  )
  const detailAvailable = useMemo(
    () => (detail ? options.contracts.filter((contract) => contract.rate_schedule_id !== detail.id) : []),
    [detail, options.contracts],
  )

  // Drop the detail sheet if its schedule disappears from the roster.
  useEffect(() => {
    if (detailId && !schedules.some((schedule) => schedule.id === detailId)) setDetailId(null)
  }, [schedules, detailId])

  // ---- data + mutations ----------------------------------------------------
  const refetch = async () => {
    const [nextSchedules, nextOverrides, nextOptions] = await Promise.all([
      listBillingRateSchedulesAction(),
      listBillingRateOverridesAction(),
      listBillingRateOptionsAction(),
    ])
    setSchedules(nextSchedules)
    setOverrides(nextOverrides)
    setOptions(nextOptions)
    router.refresh()
  }

  const handleCreateSchedule = async (values: { name: string; description: string; status: "active" | "draft" }) => {
    setPending(true)
    try {
      const fd = new FormData()
      fd.set("name", values.name)
      fd.set("description", values.description)
      fd.set("status", values.status)
      unwrapAction(await createBillingRateScheduleFormAction(fd))
      await refetch()
      toast.success("Rate schedule created")
      setScheduleDialogOpen(false)
    } catch (error) {
      toast.error("Couldn't create schedule", { description: (error as Error).message })
    } finally {
      setPending(false)
    }
  }

  const handleCreateOverride = async (values: { projectContract: string; scheduleId: string; rate: RateFormState }) => {
    setPending(true)
    try {
      const fd = new FormData()
      fd.set("project_contract", values.projectContract)
      fd.set("schedule_id", values.scheduleId || NONE)
      appendRateFields(fd, values.rate)
      unwrapAction(await createBillingRateOverrideFormAction(fd))
      await refetch()
      toast.success("Project override added")
      setOverrideDialogOpen(false)
    } catch (error) {
      toast.error("Couldn't add override", { description: (error as Error).message })
    } finally {
      setPending(false)
    }
  }

  const handleAddRate = async (scheduleId: string, rate: RateFormState): Promise<boolean> => {
    setPending(true)
    try {
      const fd = new FormData()
      fd.set("schedule_id", scheduleId)
      appendRateFields(fd, rate)
      unwrapAction(await createBillingRateFormAction(fd))
      await refetch()
      toast.success("Rate added")
      return true
    } catch (error) {
      toast.error("Couldn't add rate", { description: (error as Error).message })
      return false
    } finally {
      setPending(false)
    }
  }

  const handleAssign = async (projectId: string, scheduleId: string | null): Promise<boolean> => {
    setPending(true)
    try {
      const fd = new FormData()
      fd.set("project_id", projectId)
      fd.set("rate_schedule_id", scheduleId ?? NONE)
      unwrapAction(await assignBillingRateScheduleFormAction(fd))
      await refetch()
      toast.success(scheduleId ? "Schedule assigned" : "Schedule unassigned")
      return true
    } catch (error) {
      toast.error("Couldn't update assignment", { description: (error as Error).message })
      return false
    } finally {
      setPending(false)
    }
  }

  const runConfirm = async () => {
    if (!confirm) return
    setPending(true)
    try {
      if (confirm.kind === "archive-schedule") {
        unwrapAction(await archiveBillingRateScheduleFormAction(confirm.schedule.id))
        toast.success("Schedule archived")
      } else if (confirm.kind === "delete-rate") {
        unwrapAction(await deleteBillingRateFormAction(confirm.rate.id))
        toast.success("Rate removed")
      } else {
        unwrapAction(await deleteBillingRateOverrideFormAction(confirm.override.id))
        toast.success("Override removed")
      }
      await refetch()
    } catch (error) {
      toast.error("Something went wrong", { description: (error as Error).message })
    } finally {
      setPending(false)
      setConfirm(null)
    }
  }

  // ---- render --------------------------------------------------------------
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* Toolbar */}
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <InputGroup className="h-8 w-full sm:w-64">
          <InputGroupAddon align="inline-start">
            <Search className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={view === "schedules" ? "Search schedules" : "Search overrides"}
            aria-label="Search billing rates"
          />
          {query ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={() => setQuery("")} aria-label="Clear search">
                <XCircle className="size-3.5" />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>

        <ToggleGroup
          type="single"
          value={view}
          onValueChange={(value) => value && setView(value as View)}
          variant="outline"
          size="sm"
          aria-label="Switch between schedules and overrides"
          className="h-8"
        >
          <ToggleGroupItem value="schedules" className="h-8 flex-none gap-1.5 px-3 text-xs">
            Schedules
            <span className="tabular-nums text-muted-foreground">{schedules.length}</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="overrides" className="h-8 flex-none gap-1.5 px-3 text-xs">
            Overrides
            <span className="tabular-nums text-muted-foreground">{overrides.length}</span>
          </ToggleGroupItem>
        </ToggleGroup>

        <div className="flex-1" />

        {view === "schedules" ? (
          <Button size="sm" className="h-8 gap-1.5" onClick={() => setScheduleDialogOpen(true)} disabled={!canManage}>
            <Plus className="size-3.5" />
            New schedule
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => setOverrideDialogOpen(true)}
            disabled={!canManage || options.contracts.length === 0}
          >
            <Plus className="size-3.5" />
            New override
          </Button>
        )}
      </div>

      {!canManage ? (
        <div className="shrink-0 border-b border-border bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
          You can view billing rates, but only organization admins can edit them.
        </div>
      ) : null}

      {/* Table */}
      <div className="relative min-h-0 flex-1 overflow-auto">
        {view === "schedules" ? (
          visibleSchedules.length === 0 ? (
            <SchedulesEmpty
              hasSchedules={schedules.length > 0}
              filtered={query.trim() !== ""}
              canManage={canManage}
              onCreate={() => setScheduleDialogOpen(true)}
              onClear={() => setQuery("")}
            />
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={cn(TH, "min-w-[240px] pl-4")}>Schedule</th>
                  <th className={cn(TH, "w-[110px]")}>Status</th>
                  <th className={cn(TH, "hidden w-[90px] text-right sm:table-cell")}>Rates</th>
                  <th className={cn(TH, "hidden w-[120px] text-right md:table-cell")}>Assigned</th>
                  <th className={cn(TH, "w-11 pr-4")}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleSchedules.map((schedule) => {
                  const assigned = assignedCountBySchedule.get(schedule.id) ?? 0
                  const archived = schedule.status === "archived"
                  return (
                    <tr
                      key={schedule.id}
                      onClick={() => setDetailId(schedule.id)}
                      className={cn(
                        "group cursor-pointer border-b border-border transition-colors duration-150 hover:bg-muted/40",
                        archived && "text-muted-foreground",
                      )}
                    >
                      <td className={cn(TD, "pl-4")}>
                        <div className="min-w-0">
                          <span className="block truncate font-medium text-foreground">{schedule.name}</span>
                          {schedule.description ? (
                            <span className="block truncate text-xs text-muted-foreground">{schedule.description}</span>
                          ) : null}
                        </div>
                      </td>
                      <td className={TD}>
                        <Badge
                          variant={STATUS_VARIANT[schedule.status]}
                          className="h-5 px-1.5 text-[10px] font-normal capitalize"
                        >
                          {schedule.status}
                        </Badge>
                      </td>
                      <td className={cn(TD, "hidden text-right tabular-nums sm:table-cell")}>
                        {schedule.rates.length > 0 ? (
                          schedule.rates.length
                        ) : (
                          <span className="text-muted-foreground/70">—</span>
                        )}
                      </td>
                      <td className={cn(TD, "hidden text-right tabular-nums md:table-cell")}>
                        {assigned > 0 ? assigned : <span className="text-muted-foreground/70">—</span>}
                      </td>
                      <td className={cn(TD, "pr-4 text-right")} onClick={(event) => event.stopPropagation()}>
                        <ScheduleRowMenu
                          schedule={schedule}
                          canManage={canManage}
                          onOpen={() => setDetailId(schedule.id)}
                          onArchive={() => setConfirm({ kind: "archive-schedule", schedule })}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )
        ) : visibleOverrides.length === 0 ? (
          <OverridesEmpty
            hasOverrides={overrides.length > 0}
            filtered={query.trim() !== ""}
            canManage={canManage}
            canCreate={options.contracts.length > 0}
            onCreate={() => setOverrideDialogOpen(true)}
            onClear={() => setQuery("")}
          />
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className={cn(TH, "min-w-[200px] pl-4")}>Project</th>
                <th className={cn(TH, "min-w-[160px]")}>Target</th>
                <th className={cn(TH, "w-[150px]")}>Rate</th>
                <th className={cn(TH, "hidden w-[180px] md:table-cell")}>Effective</th>
                <th className={cn(TH, "w-11 pr-4")}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleOverrides.map((override) => (
                <tr
                  key={override.id}
                  className="group border-b border-border transition-colors duration-150 hover:bg-muted/40"
                >
                  <td className={cn(TD, "pl-4")}>
                    <span className="block truncate font-medium text-foreground">
                      {override.project_name ?? "Project override"}
                    </span>
                    {override.contract_label ? (
                      <span className="block truncate text-xs text-muted-foreground">{override.contract_label}</span>
                    ) : null}
                  </td>
                  <td className={TD}>
                    <span className="text-foreground">{rateTarget(override)}</span>
                    <span className="block text-xs capitalize text-muted-foreground">
                      {override.kind.replace("_", " ")}
                    </span>
                  </td>
                  <td className={cn(TD, "tabular-nums")}>{rateDisplay(override)}</td>
                  <td className={cn(TD, "hidden text-xs tabular-nums text-muted-foreground md:table-cell")}>
                    {formatRange(override.effective_from, override.effective_to)}
                  </td>
                  <td className={cn(TD, "pr-4 text-right")}>
                    {canManage ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                        onClick={() => setConfirm({ kind: "delete-override", override })}
                        aria-label="Delete project override"
                        disabled={pending}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-border bg-muted/20 px-4">
        <span className="microlabel truncate">
          {view === "schedules"
            ? `${visibleSchedules.length} of ${schedules.length} schedules · ${activeCount} active · ${assignedProjects} assigned`
            : `${visibleOverrides.length} of ${overrides.length} project overrides`}
        </span>
      </div>

      {/* Schedule detail */}
      <Sheet open={detail !== null} onOpenChange={(open) => !open && setDetailId(null)}>
        <SheetContent side="right" mobileFullscreen className="flex flex-col gap-0 p-0 sm:max-w-xl">
          {detail ? (
            <ScheduleDetail
              key={detail.id}
              schedule={detail}
              options={options}
              canManage={canManage}
              pending={pending}
              assignedContracts={detailAssigned}
              availableContracts={detailAvailable}
              onAddRate={handleAddRate}
              onDeleteRate={(rate) => setConfirm({ kind: "delete-rate", rate, scheduleName: detail.name })}
              onArchive={(schedule) => setConfirm({ kind: "archive-schedule", schedule })}
              onAssign={handleAssign}
              onClose={() => setDetailId(null)}
            />
          ) : (
            <SheetHeader className="sr-only">
              <SheetTitle>Rate schedule</SheetTitle>
            </SheetHeader>
          )}
        </SheetContent>
      </Sheet>

      <NewScheduleDialog
        open={scheduleDialogOpen}
        pending={pending}
        onOpenChange={setScheduleDialogOpen}
        onSubmit={handleCreateSchedule}
      />

      <NewOverrideDialog
        open={overrideDialogOpen}
        pending={pending}
        contracts={options.contracts}
        schedules={assignableSchedules}
        options={options}
        onOpenChange={setOverrideDialogOpen}
        onSubmit={handleCreateOverride}
      />

      <ConfirmDialog confirm={confirm} pending={pending} onCancel={() => setConfirm(null)} onConfirm={runConfirm} />
    </div>
  )
}

// ---------------------------------------------------------------------------

function ScheduleRowMenu({
  schedule,
  canManage,
  onOpen,
  onArchive,
}: {
  schedule: BillingRateSchedule
  canManage: boolean
  onOpen: () => void
  onArchive: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="size-4" />
          <span className="sr-only">Actions for {schedule.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onOpen}>Open details</DropdownMenuItem>
        {canManage && schedule.status !== "archived" ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onSelect={onArchive}>
              Archive schedule
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ScheduleDetail({
  schedule,
  options,
  canManage,
  pending,
  assignedContracts,
  availableContracts,
  onAddRate,
  onDeleteRate,
  onArchive,
  onAssign,
  onClose,
}: {
  schedule: BillingRateSchedule
  options: BillingRatesOptions
  canManage: boolean
  pending: boolean
  assignedContracts: BillingRateContract[]
  availableContracts: BillingRateContract[]
  onAddRate: (scheduleId: string, rate: RateFormState) => Promise<boolean>
  onDeleteRate: (rate: BillingRate) => void
  onArchive: (schedule: BillingRateSchedule) => void
  onAssign: (projectId: string, scheduleId: string | null) => Promise<boolean>
  onClose: () => void
}) {
  const [rate, setRate] = useState<RateFormState>(EMPTY_RATE)
  const [assignTarget, setAssignTarget] = useState("")
  const archived = schedule.status === "archived"

  const submitRate = async () => {
    const ok = await onAddRate(schedule.id, rate)
    if (ok) setRate(EMPTY_RATE)
  }

  const submitAssign = async () => {
    if (!assignTarget) return
    const ok = await onAssign(assignTarget, schedule.id)
    if (ok) setAssignTarget("")
  }

  return (
    <>
      <SheetHeader className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <SheetTitle className="text-sm font-medium">{schedule.name}</SheetTitle>
          <Badge variant={STATUS_VARIANT[schedule.status]} className="h-5 px-1.5 text-[10px] font-normal capitalize">
            {schedule.status}
          </Badge>
        </div>
        <SheetDescription className="text-xs">
          {schedule.description ||
            "Time-and-materials labor, equipment, and material rates for the projects assigned to this schedule."}
        </SheetDescription>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="flex flex-col gap-6">
          {/* Rates */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="microlabel">Rates</h3>
              <span className="text-xs tabular-nums text-muted-foreground">{schedule.rates.length}</span>
            </div>
            {schedule.rates.length === 0 ? (
              <p className="border border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
                No rates on this schedule yet.
              </p>
            ) : (
              <div className="overflow-hidden border border-border">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr>
                      <th className={cn(TH, "pl-3")}>Target</th>
                      <th className={TH}>Rate</th>
                      <th className={cn(TH, "hidden text-right sm:table-cell")}>Multipliers</th>
                      <th className={cn(TH, "hidden sm:table-cell")}>Effective</th>
                      <th className={cn(TH, "w-10 pr-3")}>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.rates.map((entry) => (
                      <tr key={entry.id} className="border-t border-border">
                        <td className={cn(TD, "pl-3")}>
                          <span className="font-medium text-foreground">{rateTarget(entry)}</span>
                          <span className="block text-xs capitalize text-muted-foreground">
                            {entry.kind.replace("_", " ")}
                          </span>
                        </td>
                        <td className={cn(TD, "tabular-nums")}>{rateDisplay(entry)}</td>
                        <td className={cn(TD, "hidden text-right text-xs tabular-nums text-muted-foreground sm:table-cell")}>
                          OT {entry.ot_multiplier}× · DT {entry.dt_multiplier}×
                        </td>
                        <td className={cn(TD, "hidden text-xs tabular-nums text-muted-foreground sm:table-cell")}>
                          {formatRange(entry.effective_from, entry.effective_to)}
                        </td>
                        <td className={cn(TD, "pr-3 text-right")}>
                          {canManage ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              onClick={() => onDeleteRate(entry)}
                              aria-label="Delete rate"
                              disabled={pending}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Add rate */}
          {canManage && !archived ? (
            <section className="border border-border bg-muted/20 p-4">
              <div className="flex flex-col gap-4">
                <div>
                  <h3 className="text-sm font-medium">Add a rate</h3>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Person and role rates match logged labor; equipment and material rates cover pass-through cost.
                  </p>
                </div>
                <RateFieldsForm value={rate} onChange={setRate} options={options} disabled={pending} />
                <div className="flex justify-end">
                  <Button size="sm" className="gap-1.5" onClick={submitRate} disabled={pending}>
                    <Plus className="size-3.5" />
                    Add rate
                  </Button>
                </div>
              </div>
            </section>
          ) : null}

          {/* Assigned projects */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="microlabel">Assigned projects</h3>
              <span className="text-xs tabular-nums text-muted-foreground">{assignedContracts.length}</span>
            </div>
            {assignedContracts.length === 0 ? (
              <p className="text-xs text-muted-foreground">No projects use this schedule yet.</p>
            ) : (
              <div className="overflow-hidden border border-border">
                <table className="w-full border-collapse text-sm">
                  <tbody>
                    {assignedContracts.map((contract) => (
                      <tr key={contract.id} className="border-t border-border first:border-t-0">
                        <td className={cn(TD, "pl-3")}>
                          <span className="font-medium text-foreground">{projectLabel(contract)}</span>
                          <span className="block text-xs text-muted-foreground">{contractLabel(contract)}</span>
                        </td>
                        <td className={cn(TD, "pr-3 text-right")}>
                          {canManage ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7"
                              onClick={() => onAssign(projectIdFromContract(contract), null)}
                              disabled={pending}
                            >
                              Unassign
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {canManage && !archived ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Select
                  value={assignTarget}
                  onValueChange={setAssignTarget}
                  disabled={pending || availableContracts.length === 0}
                >
                  <SelectTrigger className="h-8 w-full sm:flex-1">
                    <SelectValue
                      placeholder={availableContracts.length === 0 ? "No projects available" : "Assign a T&M project"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {availableContracts.map((contract) => (
                      <SelectItem key={contract.id} value={projectIdFromContract(contract)}>
                        {projectLabel(contract)} · {contractLabel(contract)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" className="h-8 shrink-0" onClick={submitAssign} disabled={pending || !assignTarget}>
                  Assign
                </Button>
              </div>
            ) : null}
          </section>
        </div>
      </div>

      <SheetFooter className="flex flex-row items-center gap-2 border-t border-border px-6 py-4">
        {canManage && !archived ? (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => onArchive(schedule)} disabled={pending}>
            <Archive className="size-3.5" />
            Archive
          </Button>
        ) : null}
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </SheetFooter>
    </>
  )
}

function RateFieldsForm({
  value,
  onChange,
  options,
  disabled,
}: {
  value: RateFormState
  onChange: (next: RateFormState) => void
  options: BillingRatesOptions
  disabled?: boolean
}) {
  const set = (patch: Partial<RateFormState>) => onChange({ ...value, ...patch })
  const isLabor = value.kind === "labor_role" || value.kind === "person"

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-2">
        <Label className="microlabel">Kind</Label>
        <Select value={value.kind} onValueChange={(next) => set({ kind: next as BillingRateKind })} disabled={disabled}>
          <SelectTrigger className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="labor_role">Labor role</SelectItem>
            <SelectItem value="person">Person</SelectItem>
            <SelectItem value="equipment">Equipment</SelectItem>
            <SelectItem value="material">Material</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {value.kind === "labor_role" ? (
        <div className="flex flex-col gap-2">
          <Label className="microlabel">Role</Label>
          <Input
            value={value.role_name}
            onChange={(event) => set({ role_name: event.target.value })}
            placeholder="Carpenter"
            className="h-8"
            disabled={disabled}
          />
        </div>
      ) : null}

      {value.kind === "person" ? (
        <div className="flex flex-col gap-2">
          <Label className="microlabel">Person</Label>
          <Select
            value={value.user_id || NONE}
            onValueChange={(next) => set({ user_id: next === NONE ? "" : next })}
            disabled={disabled}
          >
            <SelectTrigger className="h-8 w-full">
              <SelectValue placeholder="Choose person" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {options.teamMembers.map((member) => (
                <SelectItem key={member.user.id} value={member.user.id}>
                  {member.user.full_name || member.user.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {value.kind === "equipment" ? (
        <div className="flex flex-col gap-2">
          <Label className="microlabel">Equipment</Label>
          <Input
            value={value.equipment_name}
            onChange={(event) => set({ equipment_name: event.target.value })}
            placeholder="Mini excavator"
            className="h-8"
            disabled={disabled}
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label className="microlabel">Cost code</Label>
        <Select
          value={value.cost_code_id || NONE}
          onValueChange={(next) => set({ cost_code_id: next === NONE ? "" : next })}
          disabled={disabled}
        >
          <SelectTrigger className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{value.kind === "material" ? "Any material" : "Default"}</SelectItem>
            {options.costCodes.map((code) => (
              <SelectItem key={code.id} value={code.id}>
                {code.code} {code.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label className="microlabel">{value.kind === "material" ? "Rate (optional)" : "Rate"}</Label>
        <Input
          value={value.rate_amount}
          onChange={(event) => set({ rate_amount: event.target.value })}
          type="number"
          min="0"
          step="0.01"
          placeholder="95"
          className="h-8 tabular-nums"
          disabled={disabled}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label className="microlabel">Markup %</Label>
        <Input
          value={value.markup_percent}
          onChange={(event) => set({ markup_percent: event.target.value })}
          type="number"
          min="0"
          max="300"
          step="0.01"
          placeholder={value.kind === "material" ? "20" : "Optional"}
          className="h-8 tabular-nums"
          disabled={disabled}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label className="microlabel">Unit</Label>
        <Select value={value.unit} onValueChange={(next) => set({ unit: next as BillingRateUnit })} disabled={disabled}>
          <SelectTrigger className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hour">Hour</SelectItem>
            <SelectItem value="day">Day</SelectItem>
            <SelectItem value="each">Each</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLabor ? (
        <>
          <div className="flex flex-col gap-2">
            <Label className="microlabel">OT multiplier</Label>
            <Input
              value={value.ot_multiplier}
              onChange={(event) => set({ ot_multiplier: event.target.value })}
              type="number"
              min="1"
              max="4"
              step="0.01"
              className="h-8 tabular-nums"
              disabled={disabled}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label className="microlabel">DT multiplier</Label>
            <Input
              value={value.dt_multiplier}
              onChange={(event) => set({ dt_multiplier: event.target.value })}
              type="number"
              min="1"
              max="4"
              step="0.01"
              className="h-8 tabular-nums"
              disabled={disabled}
            />
          </div>
        </>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label className="microlabel">Effective from</Label>
        <Input
          value={value.effective_from}
          onChange={(event) => set({ effective_from: event.target.value })}
          type="date"
          className="h-8"
          disabled={disabled}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label className="microlabel">Effective to</Label>
        <Input
          value={value.effective_to}
          onChange={(event) => set({ effective_to: event.target.value })}
          type="date"
          className="h-8"
          disabled={disabled}
        />
      </div>
    </div>
  )
}

function NewScheduleDialog({
  open,
  pending,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  pending: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (values: { name: string; description: string; status: "active" | "draft" }) => void
}) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [status, setStatus] = useState<"active" | "draft">("active")

  useEffect(() => {
    if (open) {
      setName("")
      setDescription("")
      setStatus("active")
    }
  }, [open])

  const canSave = name.trim().length > 0 && !pending
  const submit = () => {
    if (canSave) onSubmit({ name: name.trim(), description: description.trim(), status })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="text-sm font-medium">New rate schedule</DialogTitle>
          <DialogDescription className="text-xs">
            A reusable set of T&amp;M labor, equipment, and material rates you can assign to projects.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-5 py-5">
          <section className="space-y-2">
            <p className="microlabel">Name</p>
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Standard T&M 2026"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  submit()
                }
              }}
            />
          </section>

          <section className="space-y-2">
            <p className="microlabel">Description</p>
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Default owner-facing bill rates"
            />
          </section>

          <section className="space-y-2">
            <p className="microlabel">Status</p>
            <Select value={status} onValueChange={(value) => setStatus(value as "active" | "draft")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
              </SelectContent>
            </Select>
          </section>
        </div>

        <DialogFooter className="border-t border-border px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSave}>
            {pending ? "Creating…" : "Create schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function NewOverrideDialog({
  open,
  pending,
  contracts,
  schedules,
  options,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  pending: boolean
  contracts: BillingRateContract[]
  schedules: BillingRateSchedule[]
  options: BillingRatesOptions
  onOpenChange: (open: boolean) => void
  onSubmit: (values: { projectContract: string; scheduleId: string; rate: RateFormState }) => void
}) {
  const [projectContract, setProjectContract] = useState("")
  const [scheduleId, setScheduleId] = useState("")
  const [rate, setRate] = useState<RateFormState>(EMPTY_RATE)

  useEffect(() => {
    if (open) {
      setProjectContract("")
      setScheduleId("")
      setRate(EMPTY_RATE)
    }
  }, [open])

  const canSave = projectContract.length > 0 && !pending
  const submit = () => {
    if (canSave) onSubmit({ projectContract, scheduleId, rate })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="text-sm font-medium">New project override</DialogTitle>
          <DialogDescription className="text-xs">
            A one-off rate for a single project, applied above its assigned schedule.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto px-5 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <section className="space-y-2">
              <p className="microlabel">T&amp;M project</p>
              <Select value={projectContract} onValueChange={setProjectContract}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose project" />
                </SelectTrigger>
                <SelectContent>
                  {contracts.map((contract) => (
                    <SelectItem key={contract.id} value={`${projectIdFromContract(contract)}:${contract.id}`}>
                      {projectLabel(contract)} · {contractLabel(contract)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </section>
            <section className="space-y-2">
              <p className="microlabel">Related schedule</p>
              <Select value={scheduleId || NONE} onValueChange={(value) => setScheduleId(value === NONE ? "" : value)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Project-only override</SelectItem>
                  {schedules.map((schedule) => (
                    <SelectItem key={schedule.id} value={schedule.id}>
                      {schedule.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </section>
          </div>

          <div className="border-t border-border pt-5">
            <RateFieldsForm value={rate} onChange={setRate} options={options} disabled={pending} />
          </div>
        </div>

        <DialogFooter className="border-t border-border px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSave}>
            {pending ? "Adding…" : "Add override"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConfirmDialog({
  confirm,
  pending,
  onCancel,
  onConfirm,
}: {
  confirm: Confirm | null
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const copy = confirm ? confirmCopy(confirm) : null
  return (
    <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && onCancel()}>
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
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
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

function confirmCopy(confirm: Confirm): { title: string; description: string; confirm: string } {
  switch (confirm.kind) {
    case "archive-schedule":
      return {
        title: `Archive ${confirm.schedule.name}?`,
        description:
          "It stops appearing in assignment pickers and can no longer be assigned to projects. Its rates and history stay intact.",
        confirm: "Archive",
      }
    case "delete-rate":
      return {
        title: "Delete this rate?",
        description: `This removes the ${rateTarget(confirm.rate).toLowerCase()} rate from ${confirm.scheduleName}. Amounts already billed are unaffected. This cannot be undone.`,
        confirm: "Delete",
      }
    case "delete-override":
      return {
        title: "Delete this override?",
        description: `This removes the project rate override${confirm.override.project_name ? ` for ${confirm.override.project_name}` : ""}. The project falls back to its assigned schedule. This cannot be undone.`,
        confirm: "Delete",
      }
  }
}

// ---------------------------------------------------------------------------

function SchedulesEmpty({
  hasSchedules,
  filtered,
  canManage,
  onCreate,
  onClear,
}: {
  hasSchedules: boolean
  filtered: boolean
  canManage: boolean
  onCreate: () => void
  onClear: () => void
}) {
  if (hasSchedules && filtered) {
    return (
      <Empty className="min-h-0 border-0 py-20">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Search />
          </EmptyMedia>
          <EmptyTitle>No schedules match</EmptyTitle>
          <EmptyDescription>Try a different search, or clear it to see every schedule.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onClear}>
            Clear search
          </Button>
        </EmptyContent>
      </Empty>
    )
  }
  return (
    <Empty className="min-h-0 border-0 py-20">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <DollarSign />
        </EmptyMedia>
        <EmptyTitle>No rate schedules yet</EmptyTitle>
        <EmptyDescription>
          Build a reusable set of T&amp;M labor, equipment, and material rates, then assign it to your
          time-and-materials projects.
        </EmptyDescription>
      </EmptyHeader>
      {canManage ? (
        <EmptyContent>
          <Button size="sm" onClick={onCreate}>
            <Plus className="mr-1.5 size-3.5" />
            New schedule
          </Button>
        </EmptyContent>
      ) : (
        <EmptyContent>
          <p className="text-xs text-muted-foreground">Ask an organization admin to add rate schedules.</p>
        </EmptyContent>
      )}
    </Empty>
  )
}

function OverridesEmpty({
  hasOverrides,
  filtered,
  canManage,
  canCreate,
  onCreate,
  onClear,
}: {
  hasOverrides: boolean
  filtered: boolean
  canManage: boolean
  canCreate: boolean
  onCreate: () => void
  onClear: () => void
}) {
  if (hasOverrides && filtered) {
    return (
      <Empty className="min-h-0 border-0 py-20">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Search />
          </EmptyMedia>
          <EmptyTitle>No overrides match</EmptyTitle>
          <EmptyDescription>Try a different search, or clear it to see every override.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onClear}>
            Clear search
          </Button>
        </EmptyContent>
      </Empty>
    )
  }
  return (
    <Empty className="min-h-0 border-0 py-20">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <DollarSign />
        </EmptyMedia>
        <EmptyTitle>No project overrides yet</EmptyTitle>
        <EmptyDescription>
          An override is a one-off rate for a single project, applied above its assigned schedule. Add one when a job
          needs a rate its schedule doesn&apos;t cover.
        </EmptyDescription>
      </EmptyHeader>
      {canManage ? (
        canCreate ? (
          <EmptyContent>
            <Button size="sm" onClick={onCreate}>
              <Plus className="mr-1.5 size-3.5" />
              New override
            </Button>
          </EmptyContent>
        ) : (
          <EmptyContent>
            <p className="text-xs text-muted-foreground">
              You need an active time-and-materials project before you can add an override.
            </p>
          </EmptyContent>
        )
      ) : (
        <EmptyContent>
          <p className="text-xs text-muted-foreground">Ask an organization admin to add project overrides.</p>
        </EmptyContent>
      )}
    </Empty>
  )
}

// ---------------------------------------------------------------------------

function projectFromContract(contract: BillingRateContract) {
  return Array.isArray(contract.project) ? contract.project[0] : contract.project
}

function projectIdFromContract(contract: BillingRateContract) {
  return String(projectFromContract(contract)?.id ?? contract.project_id ?? contract.id)
}

function projectLabel(contract: BillingRateContract) {
  return projectFromContract(contract)?.name ?? "Unnamed project"
}

function contractLabel(contract: BillingRateContract) {
  return [contract.number, contract.title].filter(Boolean).join(" ") || "T&M contract"
}

function rateTarget(rate: AnyRate) {
  if (rate.kind === "person") return rate.user_name ?? "Person"
  if (rate.kind === "equipment") return rate.equipment_name ?? "Equipment"
  if (rate.kind === "material") {
    return [rate.cost_code_code, rate.cost_code_name].filter(Boolean).join(" ") || "Material default"
  }
  return rate.role_name ?? "Labor role"
}

function rateDisplay(rate: AnyRate) {
  if (rate.kind === "material" && rate.markup_percent != null) return `${rate.markup_percent}% markup`
  if (rate.rate_cents != null) return `${formatMoney(rate.rate_cents)} / ${rate.unit ?? "hour"}`
  return "No rate"
}

function formatMoney(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
    cents / 100,
  )
}

function formatRange(from?: string | null, to?: string | null) {
  if (!from && !to) return "Always"
  return `${from ?? "Start"} to ${to ?? "Open"}`
}
