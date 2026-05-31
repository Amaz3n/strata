"use client"

import { useMemo, useState } from "react"
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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Settings, CalendarDays } from "@/components/icons"
import { GooglePlacesAutocomplete } from "@/components/ui/google-places-autocomplete"
import { Switch } from "@/components/ui/switch"
import { resolveProjectBillingModel, type ProjectBillingModel } from "@/lib/financials/billing-model"

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
}

export function ProjectSettingsSheet({ project, contract, contacts = [], open, onOpenChange, onSave }: ProjectSettingsSheetProps) {
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
  const [projectType, setProjectType] = useState<Project["project_type"] | undefined>(project.project_type)
  const [clientId, setClientId] = useState<string | null | undefined>(project.client_id)
  const [retainagePercent, setRetainagePercent] = useState<string>(String(project.retainage_percent ?? "0"))
  const billingContract = contract ?? project.billing_contract ?? null
  const [billingModel, setBillingModel] = useState<ProjectBillingModel>(resolveProjectBillingModel(project, billingContract))
  const [totalContractValue, setTotalContractValue] = useState<string>(
    billingContract?.total_cents ? (billingContract.total_cents / 100).toString() : project.total_contract_value_cents ? (project.total_contract_value_cents / 100).toString() : ""
  )
  const [markupPercent, setMarkupPercent] = useState<string>(billingContract?.markup_percent != null ? String(billingContract.markup_percent) : "")
  const [gmpValue, setGmpValue] = useState<string>(billingContract?.gmp_cents ? (billingContract.gmp_cents / 100).toString() : "")
  const [ownerSavingsPct, setOwnerSavingsPct] = useState<string>(billingContract?.savings_split_owner_pct != null ? String(billingContract.savings_split_owner_pct) : "")
  const [builderSavingsPct, setBuilderSavingsPct] = useState<string>(billingContract?.savings_split_builder_pct != null ? String(billingContract.savings_split_builder_pct) : "")
  const [laborBurdenMultiplier, setLaborBurdenMultiplier] = useState<string>(billingContract?.labor_burden_multiplier != null ? String(billingContract.labor_burden_multiplier) : "1")
  const [openBook, setOpenBook] = useState<boolean>(billingContract?.open_book ?? true)
  const [requiresClientCostApproval, setRequiresClientCostApproval] = useState<boolean>(billingContract?.requires_client_cost_approval ?? false)
  const [saving, setSaving] = useState(false)
  const isCostBilling = billingModel !== "fixed_price"
  const isGmpBilling = billingModel === "cost_plus_gmp"
  const usesMarkup = billingModel === "cost_plus_percent" || billingModel === "cost_plus_gmp" || billingModel === "time_and_materials"
  const contractType = billingModel === "time_and_materials" ? "time_materials" : isCostBilling ? "cost_plus" : "fixed"

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error("Project name is required")
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
      retainage_percent: Number.parseFloat(retainagePercent) || 0,
      total_contract_value_cents: totalContractValue ? Math.round(Number.parseFloat(totalContractValue) * 100) : null,
      contract_type: contractType,
      billing_model: billingModel,
      markup_percent: usesMarkup && markupPercent ? Number.parseFloat(markupPercent) : null,
      gmp_cents: isGmpBilling && gmpValue ? Math.round(Number.parseFloat(gmpValue) * 100) : null,
      savings_split_owner_pct: isGmpBilling && ownerSavingsPct ? Number.parseFloat(ownerSavingsPct) : 0,
      savings_split_builder_pct: isGmpBilling && builderSavingsPct ? Number.parseFloat(builderSavingsPct) : 0,
      labor_burden_multiplier: isCostBilling && laborBurdenMultiplier ? Number.parseFloat(laborBurdenMultiplier) : 1,
      open_book: openBook,
      requires_client_cost_approval: requiresClientCostApproval,
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
            Update client, location, and timeline details.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 flex flex-col overflow-hidden">
          <ScrollArea className="flex-1 min-h-0">
            <div className="px-6 py-4 space-y-6">
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
                    onValueChange={(value) =>
                      setPropertyType(value === "none" ? undefined : (value as Project["property_type"]))
                    }
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
              <div className="space-y-2">
                <Label>Primary client contact</Label>
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
                <p className="text-sm text-muted-foreground">
                  Used as the default client for portal invites and signatures. This does not grant portal access.
                </p>
              </div>

              <div className="pt-4 border-t">
                <h4 className="text-sm font-semibold mb-4 uppercase tracking-wider text-muted-foreground">Financial Terms</h4>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2 sm:col-span-2">
                    <Label>Billing mode</Label>
                    <Select value={billingModel} onValueChange={(value) => setBillingModel(value as ProjectBillingModel)}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="fixed_price">Fixed price</SelectItem>
                        <SelectItem value="cost_plus_percent">Cost plus %</SelectItem>
                        <SelectItem value="cost_plus_fixed_fee">Cost plus fixed fee</SelectItem>
                        <SelectItem value="cost_plus_gmp">Cost plus GMP</SelectItem>
                        <SelectItem value="time_and_materials">Time & materials</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>{isCostBilling ? "Contract cap / value" : "Total Contract Value"}</Label>
                    <div className="relative">
                      <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                        <span className="text-muted-foreground sm:text-sm">$</span>
                      </div>
                      <Input
                        className="pl-7"
                        placeholder="0.00"
                        value={totalContractValue}
                        onChange={(e) => setTotalContractValue(e.target.value.replace(/[^\d.]/g, ""))}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Default Retainage %</Label>
                    <div className="relative">
                      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
                        <span className="text-muted-foreground sm:text-sm">%</span>
                      </div>
                      <Input
                        className="pr-7"
                        placeholder="0"
                        value={retainagePercent}
                        onChange={(e) => setRetainagePercent(e.target.value.replace(/[^\d.]/g, ""))}
                      />
                    </div>
                  </div>
                </div>
                {isCostBilling ? (
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    {usesMarkup ? <FinancialNumber label="Default markup %" value={markupPercent} onChange={setMarkupPercent} suffix="%" /> : null}
                    <FinancialNumber label="Labor burden multiplier" value={laborBurdenMultiplier} onChange={setLaborBurdenMultiplier} />
                    {isGmpBilling ? <FinancialMoney label="GMP" value={gmpValue} onChange={setGmpValue} /> : null}
                    {isGmpBilling ? <FinancialNumber label="Owner savings %" value={ownerSavingsPct} onChange={setOwnerSavingsPct} suffix="%" /> : null}
                    {isGmpBilling ? <FinancialNumber label="Builder savings %" value={builderSavingsPct} onChange={setBuilderSavingsPct} suffix="%" /> : null}
                    <div className="space-y-3 rounded-md border p-3">
                      <div className="flex items-center justify-between gap-3">
                        <Label className="text-sm font-normal">Open-book client detail</Label>
                        <Switch checked={openBook} onCheckedChange={setOpenBook} />
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <Label className="text-sm font-normal">Client cost approval</Label>
                        <Switch checked={requiresClientCostApproval} onCheckedChange={setRequiresClientCostApproval} />
                      </div>
                    </div>
                  </div>
                ) : null}
                <p className="text-xs text-muted-foreground mt-3">
                  These terms update the active project contract Arc uses for financial workflows.
                </p>
              </div>
            </div>
          </ScrollArea>

          {/* Footer */}
          <div className="flex-shrink-0 border-t bg-muted/30 p-4">
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="flex-1"
                disabled={saving}
              >
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving} className="flex-1">
                {saving ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function FinancialNumber({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  suffix?: string
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="relative">
        <Input
          className={suffix ? "pr-7" : undefined}
          placeholder="0"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
        />
        {suffix ? (
          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
            <span className="text-muted-foreground sm:text-sm">{suffix}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function FinancialMoney({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
          <span className="text-muted-foreground sm:text-sm">$</span>
        </div>
        <Input
          className="pl-7"
          placeholder="0.00"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
        />
      </div>
    </div>
  )
}
