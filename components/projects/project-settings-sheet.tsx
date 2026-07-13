"use client"

import { useEffect, useMemo, useState } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { Contact, Contract, Project } from "@/lib/types"
import type { ProjectInput } from "@/lib/validation/projects"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import { Spinner } from "@/components/ui/spinner"
import { Settings, CalendarDays, Plus, Check, ArrowLeft, ArrowRight, Trash2 } from "@/components/icons"
import { GooglePlacesAutocomplete } from "@/components/ui/google-places-autocomplete"
import {
  ProjectFinancialSetupFields,
  financialSetupFromProject,
  financialSetupToProjectInput,
  modelLabel,
  validateFinancialSetup,
  type FinancialSetupValue,
} from "@/components/projects/project-financial-setup-fields"
import { DistributionListManager } from "@/components/projects/distribution-list-manager"
import { ProjectLocationsManager } from "@/components/locations/project-locations-manager"
import { listLocationsAction } from "@/app/(app)/projects/[id]/locations/actions"
import type { ProjectLocation } from "@/lib/services/locations"
import { listProjectQboClassesAction, searchProjectQboCustomersAction, createProjectQboCustomerAction } from "@/app/(app)/projects/actions"
import {
  removeSampleProjectAction,
  setProjectModuleOverrideAction,
} from "@/app/(app)/projects/[id]/actions"
import type { QBOClassOption, QBOCustomerOption } from "@/lib/integrations/accounting/qbo-api"
import {
  PROJECT_MODULES,
  isProjectModuleEnabled,
  type ProjectModuleKey,
} from "@/lib/project-modules"

import { unwrapAction } from "@/lib/action-result"
import { usePageTitle } from "@/components/layout/page-title-context"
import { getProjectPosture } from "@/lib/product-tier"
import { terminology } from "@/lib/terminology"

const STATUS_OPTIONS: { label: string; value: Project["status"] }[] = [
  { label: "Active", value: "active" },
  { label: "On hold", value: "on_hold" },
  { label: "Completed", value: "completed" },
  { label: "Cancelled", value: "cancelled" },
]

const PROPERTY_TYPES: { label: string; value: NonNullable<Project["property_type"]> }[] = [
  { label: "Residential", value: "residential" },
  { label: "Commercial", value: "commercial" },
]

const PROJECT_TYPES: { label: string; value: NonNullable<Project["project_type"]> }[] = [
  { label: "New construction", value: "new_construction" },
  { label: "Remodel", value: "remodel" },
  { label: "Addition", value: "addition" },
  { label: "Renovation", value: "renovation" },
  { label: "Repair", value: "repair" },
]

function toOperationalProjectStatus(status: Project["status"]): Project["status"] {
  return status === "planning" || status === "bidding" ? "active" : status
}

interface ProjectSettingsSheetProps {
  project: Project
  contract?: Contract | null
  contacts?: Contact[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (input: Partial<ProjectInput>) => Promise<void>
  initialStep?: "details" | "financials"
}

export function ProjectSettingsSheet({ project, contract, contacts = [], open, onOpenChange, onSave, initialStep = "details" }: ProjectSettingsSheetProps) {
  const { productTier } = usePageTitle()
  const initialLocation = useMemo(() => {
    const location = (project as any).location as Record<string, any> | undefined
    if (location) {
      return (location.formatted as string) ?? (location.address as string) ?? ""
    }
    return project.address ?? ""
  }, [project])

  const [name, setName] = useState(project.name ?? "")
  const [status, setStatus] = useState<Project["status"] | undefined>(
    project.status ? toOperationalProjectStatus(project.status) : "active"
  )
  const [description, setDescription] = useState(project.description ?? "")
  const [address, setAddress] = useState(initialLocation)
  const [startDate, setStartDate] = useState<Date | undefined>(
    project.start_date ? new Date(project.start_date) : undefined
  )
  const [endDate, setEndDate] = useState<Date | undefined>(
    project.end_date ? new Date(project.end_date) : undefined
  )
  const [propertyType, setPropertyType] = useState<Project["property_type"] | undefined>(project.property_type)
  const posture = getProjectPosture(propertyType, productTier)
  const terms = terminology(posture)
  const [projectType, setProjectType] = useState<Project["project_type"] | undefined>(project.project_type)
  const [clientId, setClientId] = useState<string | null | undefined>(project.client_id)
  const [qboClassId, setQboClassId] = useState<string | null>(project.qbo_class_id ?? null)
  const [qboClassName, setQboClassName] = useState<string | null>(project.qbo_class_name ?? null)
  const [qboClasses, setQboClasses] = useState<QBOClassOption[]>([])
  const [qboClassesLoading, setQboClassesLoading] = useState(false)
  // Default QBO customer for this project — drives payable/expense cost attribution and pre-fills new invoices.
  const [qboCustomerId, setQboCustomerId] = useState<string | null>(project.qbo_customer_id ?? null)
  const [qboCustomerName, setQboCustomerName] = useState<string | null>(project.qbo_customer_name ?? null)
  // null = connection still being probed; true/false once known. Lets us show stored values with a
  // loading state instead of hiding QBO fields (and implying they're unset) during the probe.
  const [qboConnected, setQboConnected] = useState<boolean | null>(null)
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false)
  const [customerQuery, setCustomerQuery] = useState("")
  const [customerResults, setCustomerResults] = useState<QBOCustomerOption[]>([])
  const [customerSearchLoading, setCustomerSearchLoading] = useState(false)
  const [createCustomerOpen, setCreateCustomerOpen] = useState(false)
  const [newCustomer, setNewCustomer] = useState({ name: "", email: "", line1: "", city: "", state: "", postalCode: "" })
  const [creatingCustomer, setCreatingCustomer] = useState(false)
  const [excludedFromReporting, setExcludedFromReporting] = useState<boolean>(project.excluded_from_reporting ?? false)
  const [isPublicWork, setIsPublicWork] = useState<boolean>(project.is_public_work ?? false)
  const [requireSubtierWaivers, setRequireSubtierWaivers] = useState<boolean>(project.require_subtier_waivers ?? false)
  const [moduleOverrides, setModuleOverrides] = useState<Record<string, boolean>>(project.module_overrides ?? {})
  const [projectLocations, setProjectLocations] = useState<ProjectLocation[]>([])
  const [pendingModuleKey, setPendingModuleKey] = useState<ProjectModuleKey | null>(null)
  const [financialSetup, setFinancialSetup] = useState<FinancialSetupValue>(() => financialSetupFromProject(project, contract))
  const [step, setStep] = useState<"details" | "financials">(initialStep)
  const [saving, setSaving] = useState(false)
  const [removingSample, setRemovingSample] = useState(false)
  const isSampleProject = Boolean(project.financial_settings?.metadata?.is_sample)
  const financialMessages = validateFinancialSetup(financialSetup)
  // The contact backing the unified "Client" field — also the auto QBO customer name when none is set explicitly.
  const selectedClientContact = clientId ? contacts.find((contact) => contact.id === clientId) ?? null : null

  // The stored class id may not exist in the freshly-fetched QBO list (e.g. the class was renamed,
  // deleted, or — in sandboxes — ids were reassigned). Surface the saved name regardless, and flag
  // the mismatch so the user can re-select if they want to relink.
  const qboClassInList = qboClassId ? qboClasses.some((qboClass) => qboClass.id === qboClassId) : true
  const qboClassStale = Boolean(qboClassId) && !qboClassesLoading && !qboClassInList
  const qboClassOptions: QBOClassOption[] =
    qboClassId && !qboClassInList
      ? [{ id: qboClassId, name: qboClassName ?? "Saved class", fullyQualifiedName: qboClassName ?? undefined }, ...qboClasses]
      : qboClasses

  // Reset financial setup and starting step whenever the sheet (re)opens.
  useEffect(() => {
    if (!open) return
    setFinancialSetup(financialSetupFromProject(project, contract))
    setModuleOverrides(project.module_overrides ?? {})
    setIsPublicWork(project.is_public_work ?? false)
    setRequireSubtierWaivers(project.require_subtier_waivers ?? false)
    setStep(initialStep)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project.id, contract?.id, initialStep])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    listLocationsAction(project.id, true)
      .then((locations) => { if (!cancelled) setProjectLocations(locations) })
      .catch(() => { if (!cancelled) setProjectLocations([]) })
    return () => { cancelled = true }
  }, [open, project.id])

  useEffect(() => {
    if (!open) return
    setQboClassId(project.qbo_class_id ?? null)
    setQboClassName(project.qbo_class_name ?? null)
    setQboCustomerId(project.qbo_customer_id ?? null)
    setQboCustomerName(project.qbo_customer_name ?? null)
    setCustomerQuery("")
    setCreateCustomerOpen(false)
    setNewCustomer({ name: "", email: "", line1: "", city: "", state: "", postalCode: "" })
  }, [open, project.id, project.qbo_class_id, project.qbo_class_name, project.qbo_customer_id, project.qbo_customer_name])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setQboConnected(null)
    setQboClassesLoading(true)
    listProjectQboClassesAction()
      .then((classes) => {
        if (!cancelled) setQboClasses(classes)
      })
      .catch(() => {
        if (!cancelled) setQboClasses([])
      })
      .finally(() => {
        if (!cancelled) setQboClassesLoading(false)
      })
    // Probe QBO connection (and seed initial customer results) so the customer picker only renders when connected.
    searchProjectQboCustomersAction("")
      .then((result) => {
        if (cancelled) return
        setQboConnected(Boolean(result.connected))
        setCustomerResults(result.customers ?? [])
      })
      .catch(() => {
        if (!cancelled) setQboConnected(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // Live QBO customer typeahead — QBO is the source of truth, so we query it directly while the picker is open.
  useEffect(() => {
    if (!open || !qboConnected || !customerPickerOpen) return
    let cancelled = false
    setCustomerSearchLoading(true)
    const handle = setTimeout(() => {
      searchProjectQboCustomersAction(customerQuery)
        .then((result) => {
          if (!cancelled) setCustomerResults(result.customers ?? [])
        })
        .catch(() => {
          if (!cancelled) setCustomerResults([])
        })
        .finally(() => {
          if (!cancelled) setCustomerSearchLoading(false)
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [open, qboConnected, customerPickerOpen, customerQuery])

  const selectQboCustomer = (customer: QBOCustomerOption) => {
    setQboCustomerId(customer.id)
    setQboCustomerName(customer.name)
    setCustomerPickerOpen(false)
    setCreateCustomerOpen(false)
  }

  const handleCreateQboCustomer = async () => {
    const name = newCustomer.name.trim()
    if (!name || creatingCustomer) return
    setCreatingCustomer(true)
    try {
      const created = unwrapAction(await createProjectQboCustomerAction({
        name,
        email: newCustomer.email.trim() || null,
        line1: newCustomer.line1.trim() || null,
        city: newCustomer.city.trim() || null,
        state: newCustomer.state.trim() || null,
        postalCode: newCustomer.postalCode.trim() || null,
      }))
      selectQboCustomer(created)
      setNewCustomer({ name: "", email: "", line1: "", city: "", state: "", postalCode: "" })
      toast.success(`Created "${created.name}" in QuickBooks`)
    } catch (error: any) {
      toast.error("Couldn't create customer in QuickBooks", { description: error?.message ?? "Try again." })
    } finally {
      setCreatingCustomer(false)
    }
  }

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error("Project name is required")
      setStep("details")
      return
    }

    if (financialMessages.blocking.length > 0) {
      setStep("financials")
      toast.error(financialMessages.blocking[0])
      return
    }

    const payload: Partial<ProjectInput> = {
      name: name.trim(),
      status,
      description: description || undefined,
      start_date: startDate ? format(startDate, "yyyy-MM-dd") : undefined,
      end_date: endDate ? format(endDate, "yyyy-MM-dd") : undefined,
      property_type: propertyType,
      project_type: projectType,
      client_id: clientId ?? null,
      location: address ? { formatted: address, address } : undefined,
      qbo_class_id: qboClassId,
      qbo_class_name: qboClassName,
      qbo_customer_id: qboCustomerId,
      qbo_customer_name: qboCustomerName,
      excluded_from_reporting: excludedFromReporting,
      is_public_work: isPublicWork,
      require_subtier_waivers: requireSubtierWaivers,
      ...financialSetupToProjectInput(financialSetup),
    }

    setSaving(true)
    try {
      await onSave(payload)
      toast.success("Project updated")
      onOpenChange(false)
    } catch (error) {
      console.error("Failed to update project", error)
      toast.error("Could not save changes")
    } finally {
      setSaving(false)
    }
  }

  const handleRemoveSampleProject = async () => {
    if (removingSample) return
    setRemovingSample(true)
    try {
      unwrapAction(await removeSampleProjectAction(project.id))
      toast.success("Sample project removed")
      onOpenChange(false)
    } catch (error: any) {
      toast.error("Could not remove sample project", { description: error?.message ?? "Try again." })
    } finally {
      setRemovingSample(false)
    }
  }

  const handleModuleToggle = async (moduleKey: ProjectModuleKey, enabled: boolean) => {
    setPendingModuleKey(moduleKey)
    try {
      unwrapAction(await setProjectModuleOverrideAction(project.id, moduleKey, enabled))
      setModuleOverrides((current) => ({ ...current, [moduleKey]: enabled }))
      window.dispatchEvent(new Event("arc-org-change"))
    } catch (error) {
      console.error("Failed to update project module", error)
      toast.error("Could not update module visibility")
    } finally {
      setPendingModuleKey(null)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={{
          animationDuration: '150ms',
          transitionDuration: '150ms'
        } as React.CSSProperties}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Project settings
          </SheetTitle>
          <SheetDescription>
            Update {terms.owner.toLowerCase()}, location, and timeline details.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 flex flex-col overflow-hidden">
          <ScrollArea className="flex-1 min-h-0">
            <div className="px-6 py-4">
              <div className="mb-5 flex gap-1.5">
                <span className={cn("h-1 flex-1 rounded-full", step === "details" ? "bg-primary" : "bg-primary/30")} />
                <span className={cn("h-1 flex-1 rounded-full", step === "financials" ? "bg-primary" : "bg-muted")} />
              </div>
              <div className={cn("space-y-6", step === "details" ? "block" : "hidden")}>
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select value={status} onValueChange={(value) => setStatus(value as Project["status"])}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Location</Label>
                  <GooglePlacesAutocomplete
                    value={address}
                    onChange={setAddress}
                    placeholder="123 Main St, City, State"
                    className="w-full"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Scope, notes, or special requirements"
                  rows={4}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Property type</Label>
                  <Select
                    value={propertyType ?? "none"}
                    onValueChange={(value) => {
                      const next = value === "none" ? undefined : (value as Project["property_type"])
                      setPropertyType(next)
                      if (next === "commercial" && (!financialSetup.retainagePercent || financialSetup.retainagePercent === "0")) {
                        setFinancialSetup({ ...financialSetup, retainagePercent: "10" })
                      }
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not set</SelectItem>
                      {PROPERTY_TYPES.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Project type</Label>
                  <Select
                    value={projectType ?? "none"}
                    onValueChange={(value) =>
                      setProjectType(value === "none" ? undefined : (value as Project["project_type"]))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not set</SelectItem>
                      {PROJECT_TYPES.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Start date</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn(
                          "w-full justify-start text-left font-normal",
                          !startDate && "text-muted-foreground"
                        )}
                      >
                        <CalendarDays className="mr-2 h-4 w-4" />
                        {startDate ? format(startDate, "LLL dd, y") : "Pick a date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={startDate}
                        onSelect={setStartDate}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="space-y-2">
                  <Label>End date</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn(
                          "w-full justify-start text-left font-normal",
                          !endDate && "text-muted-foreground"
                        )}
                      >
                        <CalendarDays className="mr-2 h-4 w-4" />
                        {endDate ? format(endDate, "LLL dd, y") : "Pick a date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={endDate}
                        onSelect={setEndDate}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
              <p className={cn("text-sm text-muted-foreground")}>
                Dates drive schedule progress and budget timelines. Leave blank if not yet scheduled.
              </p>
              {/* Client — a single field. The contact drives portal invites & signatures; */}
              {/* the QuickBooks customer (the sync target) is shown beneath as an overridable detail. */}
              <div className="space-y-2">
                <Label>{terms.owner}</Label>
                <Select
                  value={clientId ?? "none"}
                  onValueChange={(value) => setClientId(value === "none" ? null : value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select contact" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not set</SelectItem>
                    {contacts.map((contact) => (
                      <SelectItem key={contact.id} value={contact.id}>
                        {contact.full_name}
                        {contact.role ? ` • ${contact.role}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {qboConnected === null ? (
                  <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    <Spinner className="h-3.5 w-3.5" />
                    {qboCustomerId ? (
                      <span className="truncate">
                        Billed in QuickBooks as{" "}
                        <span className="font-medium text-foreground">{qboCustomerName || "selected customer"}</span>
                      </span>
                    ) : (
                      "Checking QuickBooks…"
                    )}
                  </div>
                ) : qboConnected ? (
                  <Popover
                    open={customerPickerOpen}
                    onOpenChange={(next) => {
                      setCustomerPickerOpen(next)
                      if (!next) setCreateCustomerOpen(false)
                    }}
                    modal
                  >
                    <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
                      {qboCustomerId ? (
                        <>
                          <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                            <span className="truncate">
                              Billed in QuickBooks as{" "}
                              <span className="font-medium text-foreground">{qboCustomerName || "selected customer"}</span>
                            </span>
                          </span>
                          <div className="flex shrink-0 items-center gap-3">
                            <PopoverTrigger asChild>
                              <button
                                type="button"
                                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                              >
                                Change
                              </button>
                            </PopoverTrigger>
                            <button
                              type="button"
                              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                              onClick={() => {
                                setQboCustomerId(null)
                                setQboCustomerName(null)
                              }}
                            >
                              Clear
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <span className="min-w-0 truncate text-xs text-muted-foreground">
                            {selectedClientContact?.full_name ? (
                              <>
                                Will sync to QuickBooks as{" "}
                                <span className="font-medium text-foreground">&ldquo;{selectedClientContact.full_name}&rdquo;</span>
                              </>
                            ) : (
                              "Choose the QuickBooks customer to bill"
                            )}
                          </span>
                          <PopoverTrigger asChild>
                            <button
                              type="button"
                              className="shrink-0 text-xs font-medium text-primary transition-colors hover:text-primary/80"
                            >
                              {selectedClientContact?.full_name ? "Change" : "Set customer"}
                            </button>
                          </PopoverTrigger>
                        </>
                      )}
                    </div>
                    <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[320px] p-0" align="start">
                      {createCustomerOpen ? (
                        <div className="space-y-3 p-3">
                          <div className="space-y-1.5">
                            <Label className="text-xs">Name</Label>
                            <Input
                              value={newCustomer.name}
                              onChange={(e) => setNewCustomer((s) => ({ ...s, name: e.target.value }))}
                              placeholder="Customer name"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs">Email</Label>
                            <Input
                              type="email"
                              value={newCustomer.email}
                              onChange={(e) => setNewCustomer((s) => ({ ...s, email: e.target.value }))}
                              placeholder="email@customer.com"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs">Street</Label>
                            <Input
                              value={newCustomer.line1}
                              onChange={(e) => setNewCustomer((s) => ({ ...s, line1: e.target.value }))}
                              placeholder="123 Main St"
                            />
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            <div className="space-y-1.5">
                              <Label className="text-xs">City</Label>
                              <Input
                                value={newCustomer.city}
                                onChange={(e) => setNewCustomer((s) => ({ ...s, city: e.target.value }))}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">State</Label>
                              <Input
                                value={newCustomer.state}
                                onChange={(e) => setNewCustomer((s) => ({ ...s, state: e.target.value }))}
                                placeholder="FL"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">ZIP</Label>
                              <Input
                                value={newCustomer.postalCode}
                                onChange={(e) => setNewCustomer((s) => ({ ...s, postalCode: e.target.value }))}
                              />
                            </div>
                          </div>
                          <div className="flex gap-2 pt-1">
                            <Button
                              type="button"
                              variant="outline"
                              className="flex-1"
                              onClick={() => setCreateCustomerOpen(false)}
                              disabled={creatingCustomer}
                            >
                              Back
                            </Button>
                            <Button
                              type="button"
                              className="flex-1"
                              onClick={handleCreateQboCustomer}
                              disabled={creatingCustomer || !newCustomer.name.trim()}
                            >
                              {creatingCustomer ? <Spinner className="h-3.5 w-3.5" /> : "Create"}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Command shouldFilter={false}>
                          <CommandInput
                            placeholder="Search QuickBooks customers…"
                            value={customerQuery}
                            onValueChange={setCustomerQuery}
                          />
                          <CommandList>
                            {customerSearchLoading && (
                              <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                                <Spinner className="h-3.5 w-3.5" /> Searching…
                              </div>
                            )}
                            {!customerSearchLoading && customerResults.length === 0 && (
                              <CommandEmpty>No QuickBooks customers found.</CommandEmpty>
                            )}
                            {customerResults.length > 0 && (
                              <CommandGroup>
                                {customerResults.map((customer) => (
                                  <CommandItem key={customer.id} value={customer.id} onSelect={() => selectQboCustomer(customer)}>
                                    <span className="flex min-w-0 flex-col">
                                      <span className="truncate">{customer.name}</span>
                                      {customer.email && <span className="text-xs text-muted-foreground">{customer.email}</span>}
                                    </span>
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            )}
                            <CommandSeparator />
                            <CommandGroup>
                              <CommandItem
                                value="__create_new"
                                onSelect={() => {
                                  setNewCustomer((s) => ({ ...s, name: customerQuery.trim() || selectedClientContact?.full_name?.trim() || "" }))
                                  setCreateCustomerOpen(true)
                                }}
                              >
                                <Plus className="mr-2 h-3.5 w-3.5" /> Create new customer…
                              </CommandItem>
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      )}
                    </PopoverContent>
                  </Popover>
                ) : null}

                <p className="text-sm text-muted-foreground">
                  Used as the default {terms.owner.toLowerCase()} for portal invites and signatures{qboConnected ? ", and as the QuickBooks customer for invoices, payables, and expenses" : ""}. This does not grant portal access.
                </p>
              </div>
              {/* Show the class field whenever QBO is connected (or while still probing if a class is
                  already saved) so a stored value never momentarily reads as "Not set". */}
              {qboConnected || (qboConnected === null && qboClassId) ? (
                <div className="space-y-2">
                  <Label>QuickBooks class</Label>
                  <Select
                    value={qboClassId ?? "none"}
                    onValueChange={(value) => {
                      if (value === "none") {
                        setQboClassId(null)
                        setQboClassName(null)
                        return
                      }
                      const selected = qboClassOptions.find((qboClass) => qboClass.id === value)
                      setQboClassId(value)
                      setQboClassName(selected?.fullyQualifiedName ?? selected?.name ?? null)
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select class" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not set</SelectItem>
                      {qboClassOptions.map((qboClass) => (
                        <SelectItem key={qboClass.id} value={qboClass.id}>
                          {qboClass.fullyQualifiedName ?? qboClass.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {qboClassesLoading ? (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Spinner className="h-3 w-3" /> Loading classes…
                    </p>
                  ) : qboClassStale ? (
                    <p className="text-xs text-amber-600">
                      This class isn&apos;t in your current QuickBooks list. Re-select to update the link.
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="space-y-3 border-t pt-5">
                <div>
                  <Label className="text-sm">Modules</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Choose which tools appear in this project&apos;s navigation. Routes and data remain available.
                  </p>
                </div>
                <div className="divide-y border">
                  {PROJECT_MODULES.map((module) => {
                    const enabled = isProjectModuleEnabled({
                      moduleKey: module.key,
                      posture,
                      overrides: moduleOverrides,
                      postures: "postures" in module ? [...module.postures] : undefined,
                    })
                    return (
                      <div key={module.key} className="flex items-center justify-between gap-4 px-3 py-2.5">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{module.label}</p>
                          <p className="text-xs text-muted-foreground">{module.description}</p>
                        </div>
                        <Switch
                          checked={enabled}
                          disabled={pendingModuleKey === module.key}
                          onCheckedChange={(checked) => void handleModuleToggle(module.key, checked)}
                          aria-label={`${enabled ? "Hide" : "Show"} ${module.label}`}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>

              <ProjectLocationsManager projectId={project.id} initialLocations={projectLocations} />

              <div className="flex items-start justify-between gap-4 rounded-md border bg-muted/30 px-3 py-3">
                <div className="space-y-1">
                  <Label htmlFor="exclude-from-reporting" className="text-sm">
                    Exclude from reports &amp; Control Tower
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Keep this project out of Control Tower metrics and org-wide financial reports (AR/AP aging,
                    draws, change orders, payments). Useful for test jobs or friends-and-family work. The project
                    stays fully usable, and its own reports still include it.
                  </p>
                </div>
                <Switch
                  id="exclude-from-reporting"
                  checked={excludedFromReporting}
                  onCheckedChange={setExcludedFromReporting}
                  className="mt-0.5 shrink-0"
                />
              </div>

              <div className="flex items-start justify-between gap-4 border px-3 py-3">
                <div className="space-y-1">
                  <Label htmlFor="public-work-project" className="text-sm">Public work / prevailing wage</Label>
                  <p className="text-xs text-muted-foreground">Enable wage determinations and certified payroll under this project's Time workbench.</p>
                </div>
                <Switch id="public-work-project" checked={isPublicWork} onCheckedChange={setIsPublicWork} className="mt-0.5 shrink-0" />
              </div>

              <div className="flex items-start justify-between gap-4 border px-3 py-3">
                <div className="space-y-1">
                  <Label htmlFor="require-subtier-waivers" className="text-sm">Require sub-tier lien waivers</Label>
                  <p className="text-xs text-muted-foreground">Block subcontractor payment when declared supplier or sub-subcontractor waivers are missing for the pay period.</p>
                </div>
                <Switch id="require-subtier-waivers" checked={requireSubtierWaivers} onCheckedChange={setRequireSubtierWaivers} className="mt-0.5 shrink-0" />
              </div>

              <div className="border-t pt-5">
                <DistributionListManager projectId={project.id} contacts={contacts} />
              </div>

              </div>

              <div className={cn(step === "financials" ? "block" : "hidden")}>
                <ProjectFinancialSetupFields
                  value={financialSetup}
                  onChange={setFinancialSetup}
                  posture={posture}
                />
                <p className="mt-4 text-xs text-muted-foreground">
                  These terms update the active project contract Arc uses for financial workflows.
                </p>
                {financialMessages.blocking[0] || financialMessages.warnings[0] ? (
                  <p
                    className={cn(
                      "mt-2 text-xs",
                      financialMessages.blocking[0] ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {financialMessages.blocking[0] ?? financialMessages.warnings[0]}
                  </p>
                ) : null}
              </div>
            </div>
          </ScrollArea>

          {/* Footer */}
          <div className="flex-shrink-0 border-t bg-muted/30 p-4">
            {isSampleProject ? (
              <div className="mb-3 border border-destructive/30 bg-destructive/5 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">Sample project</p>
                    <p className="text-xs text-muted-foreground">Remove the seeded onboarding project and related sample data.</p>
                  </div>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="rounded-none"
                    disabled={removingSample}
                    onClick={handleRemoveSampleProject}
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    {removingSample ? "Removing..." : "Remove"}
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="flex gap-2">
              {step === "details" ? (
                <>
                  <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1" disabled={saving}>
                    Cancel
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={() => {
                      if (!name.trim()) {
                        toast.error("Project name is required")
                        return
                      }
                      setStep("financials")
                    }}
                  >
                    Next: {modelLabel(financialSetup.billingModel)}
                    <ArrowRight className="ml-1.5 h-4 w-4" />
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="outline" onClick={() => setStep("details")} className="flex-1" disabled={saving}>
                    <ArrowLeft className="mr-1.5 h-4 w-4" />
                    Back
                  </Button>
                  <Button
                    onClick={handleSave}
                    disabled={saving || financialMessages.blocking.length > 0}
                    className="flex-1"
                  >
                    {saving ? "Saving..." : "Save changes"}
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
