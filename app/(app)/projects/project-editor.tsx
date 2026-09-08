"use client";

import { useState, useEffect, type CSSProperties } from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { DEFAULT_ACCOUNTING_PROVIDER_LABEL } from "@/components/accounting/provider-label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { GooglePlacesAutocomplete } from "@/components/ui/google-places-autocomplete";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Plus, Check, ArrowLeft, ArrowRight } from "@/components/icons";
import type { Contact, Project, ProjectStatus } from "@/lib/types";
import type { DateRange } from "react-day-picker";
import type { AccountingDimensionValue } from "@/lib/integrations/accounting/provider";
import {
  createProjectAction,
  updateProjectAction,
  listProjectQboClassesAction,
  searchProjectQboCustomersAction,
  createProjectQboCustomerAction,
} from "./actions";
import { getCostCodingSettingsAction } from "@/app/(app)/settings/cost-coding/actions";
import {
  projectInputSchema,
  type ProjectInput,
} from "@/lib/validation/projects";
import {
  ProjectFinancialSetupFields,
  emptyFinancialSetup,
  financialSetupFromProject,
  financialSetupToProjectInput,
  modelLabel,
  validateFinancialSetup,
  type FinancialSetupValue,
} from "@/components/projects/project-financial-setup-fields";
import {
  getDefaultProjectPropertyType,
  getProjectPosture,
  type ProductTier,
} from "@/lib/product-tier";
import { terminology } from "@/lib/terminology";
import { cn } from "@/lib/utils";
import { unwrapAction } from "@/lib/action-result";

type QBOClassOption = AccountingDimensionValue;
type QBOCustomerOption = AccountingDimensionValue;

const statusOptions = [
  { value: "active", label: "Active" },
  { value: "on_hold", label: "Paused" },
  { value: "completed", label: "Complete" },
  { value: "cancelled", label: "Canceled" },
];

function toOperationalProjectStatus(status: ProjectStatus): ProjectStatus {
  return status === "planning" || status === "bidding" ? "active" : status;
}

// Step 1 detail fields only; billing/financial setup is captured separately via FinancialSetupValue.
function projectToFormValues(project: Project): ProjectInput {
  return {
    name: project.name,
    status: toOperationalProjectStatus(project.status),
    start_date: project.start_date ?? "",
    end_date: project.end_date ?? "",
    address: project.address ?? "",
    client_id: project.client_id ?? null,
    total_value: project.total_value ?? undefined,
    property_type: project.property_type ?? undefined,
    project_type: project.project_type ?? undefined,
    description: project.description ?? "",
    qbo_class_id: project.qbo_class_id ?? null,
    qbo_class_name: project.qbo_class_name ?? null,
    qbo_customer_id: project.qbo_customer_id ?? null,
    qbo_customer_name: project.qbo_customer_name ?? null,
  };
}

function normalizeProjectInput(values: ProjectInput): ProjectInput {
  const contractValue =
    typeof values.total_contract_value_cents === "number"
      ? values.total_contract_value_cents / 100
      : undefined;

  return {
    ...values,
    start_date: values.start_date || null,
    end_date: values.end_date || null,
    total_value: contractValue,
  };
}

import {
  getProjectDirectoryEditorAction,
  listProjectClientContactsAction,
} from "./actions";
import { format } from "date-fns";

export function ProjectEditor({
  projectId,
  productTier,
  onClose,
  onSaved,
}: {
  projectId: string | null;
  productTier: ProductTier;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [data, setData] = useState<{
    project: Project | null;
    contacts: Contact[];
    classes: QBOClassOption[];
    costCodes: boolean;
  } | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(false);
    Promise.all([
      projectId ? getProjectDirectoryEditorAction(projectId) : null,
      listProjectClientContactsAction(),
      listProjectQboClassesAction(),
      getCostCodingSettingsAction(),
    ])
      .then(([project, contacts, classes, settings]) => {
        if (!cancelled)
          setData({
            project,
            contacts,
            classes,
            costCodes: settings.costCodesEnabled,
          });
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, attempt]);
  if (!data)
    return (
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <SheetContent>
          <SheetTitle>{projectId ? "Edit project" : "New project"}</SheetTitle>
          <SheetDescription>
            {error ? "Could not load the editor." : "Loading project settings…"}
          </SheetDescription>
          {error ? (
            <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
          ) : (
            <Spinner className="mt-6 h-5 w-5" />
          )}
        </SheetContent>
      </Sheet>
    );
  return (
    <LoadedProjectEditor
      {...data}
      productTier={productTier}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function LoadedProjectEditor({
  project,
  contacts,
  classes,
  costCodes,
  productTier,
  onClose,
  onSaved,
}: {
  project: Project | null;
  contacts: Contact[];
  classes: QBOClassOption[];
  costCodes: boolean;
  productTier: ProductTier;
  onClose: () => void;
  onSaved: () => void;
}) {
  const defaultPropertyType = getDefaultProjectPropertyType(productTier);
  const form = useForm<ProjectInput>({
    resolver: zodResolver(projectInputSchema),
    defaultValues: project
      ? projectToFormValues(project)
      : {
          name: "",
          status: "active",
          start_date: "",
          end_date: "",
          address: "",
          client_id: null,
          property_type: defaultPropertyType,
          description: "",
        },
  });
  const [financialSetup, setFinancialSetup] = useState<FinancialSetupValue>(
    () =>
      project
        ? financialSetupFromProject(project)
        : emptyFinancialSetup("fixed_price", defaultPropertyType),
  );
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() =>
    project?.start_date
      ? {
          from: new Date(`${project.start_date}T00:00:00`),
          to: project.end_date
            ? new Date(`${project.end_date}T00:00:00`)
            : undefined,
        }
      : undefined,
  );
  const [saving, setSaving] = useState(false);
  function changeDates(range: DateRange | undefined) {
    setDateRange(range);
    form.setValue(
      "start_date",
      range?.from ? format(range.from, "yyyy-MM-dd") : "",
    );
    form.setValue("end_date", range?.to ? format(range.to, "yyyy-MM-dd") : "");
  }
  async function save(values: ProjectInput) {
    setSaving(true);
    try {
      const input = normalizeProjectInput({
        ...values,
        ...financialSetupToProjectInput(financialSetup),
      });
      unwrapAction(
        await (project
          ? updateProjectAction(project.id, input)
          : createProjectAction(input)),
      );
      toast.success(project ? "Project updated" : "Project created");
      onSaved();
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not save project",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <ProjectFormSheet
      mode={project ? "edit" : "create"}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      form={form}
      dateRange={dateRange}
      onDateRangeChange={changeDates}
      isSubmitting={saving}
      onSubmit={save}
      clientContacts={contacts}
      qboClasses={classes}
      financialSetup={financialSetup}
      onFinancialSetupChange={setFinancialSetup}
      productTier={productTier}
      orgCostCodesDefault={costCodes}
      onClose={onClose}
    />
  );
}
interface ProjectFormSheetProps {
  mode: "create" | "edit";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: UseFormReturn<ProjectInput>;
  dateRange: DateRange | undefined;
  onDateRangeChange: (range: DateRange | undefined) => void;
  isSubmitting: boolean;
  onSubmit: (values: ProjectInput) => Promise<void>;
  clientContacts: Contact[];
  qboClasses: QBOClassOption[];
  financialSetup: FinancialSetupValue;
  onFinancialSetupChange: (value: FinancialSetupValue) => void;
  productTier: ProductTier;
  orgCostCodesDefault: boolean;
  onClose: () => void;
}

function ProjectFormSheet({
  mode,
  open,
  onOpenChange,
  form,
  dateRange,
  onDateRangeChange,
  isSubmitting,
  onSubmit,
  clientContacts,
  qboClasses,
  financialSetup,
  onFinancialSetupChange,
  productTier,
  orgCostCodesDefault,
  onClose,
}: ProjectFormSheetProps) {
  const isEdit = mode === "edit";
  const [step, setStep] = useState<"details" | "financials">("details");
  const financialMessages = validateFinancialSetup(financialSetup);
  const canSubmit = financialMessages.blocking.length === 0 && !isSubmitting;
  const propertyType = form.watch("property_type");
  const posture = getProjectPosture(propertyType, productTier);
  const terms = terminology(posture);

  // Default QBO customer — drives cost attribution and pre-fills new invoices. Stored on the form (qbo_customer_id/name).
  const qboCustomerId = form.watch("qbo_customer_id");
  const qboCustomerName = form.watch("qbo_customer_name");
  const clientId = form.watch("client_id");
  // The contact backing the unified "Client" field — also the auto QBO customer name when none is set explicitly.
  const selectedClientContact = clientId
    ? (clientContacts.find((contact) => contact.id === clientId) ?? null)
    : null;
  const [qboConnected, setQboConnected] = useState(false);
  /** Named by the connection itself; the catalog default covers the in-flight probe. */
  const [providerName, setProviderName] = useState(
    DEFAULT_ACCOUNTING_PROVIDER_LABEL,
  );
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<QBOCustomerOption[]>(
    [],
  );
  const [customerSearchLoading, setCustomerSearchLoading] = useState(false);
  const [createCustomerOpen, setCreateCustomerOpen] = useState(false);
  const [newCustomer, setNewCustomer] = useState({
    name: "",
    email: "",
    line1: "",
    city: "",
    state: "",
    postalCode: "",
  });
  const [creatingCustomer, setCreatingCustomer] = useState(false);

  // Always start at step 1 when the sheet opens.
  useEffect(() => {
    if (open) setStep("details");
  }, [open]);

  // Probe QBO connection (and seed initial customer results) so the customer picker only renders when connected.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCustomerQuery("");
    setCreateCustomerOpen(false);
    setNewCustomer({
      name: "",
      email: "",
      line1: "",
      city: "",
      state: "",
      postalCode: "",
    });
    searchProjectQboCustomersAction("")
      .then((result) => {
        if (cancelled) return;
        setQboConnected(Boolean(result.connected));
        setProviderName(
          result.providerName ?? DEFAULT_ACCOUNTING_PROVIDER_LABEL,
        );
        setCustomerResults(result.customers ?? []);
      })
      .catch(() => {
        if (!cancelled) setQboConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Live QBO customer typeahead — QBO is the source of truth, so we query it directly while the picker is open.
  useEffect(() => {
    if (!open || !qboConnected || !customerPickerOpen) return;
    let cancelled = false;
    setCustomerSearchLoading(true);
    const handle = setTimeout(() => {
      searchProjectQboCustomersAction(customerQuery)
        .then((result) => {
          if (!cancelled) setCustomerResults(result.customers ?? []);
        })
        .catch(() => {
          if (!cancelled) setCustomerResults([]);
        })
        .finally(() => {
          if (!cancelled) setCustomerSearchLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, qboConnected, customerPickerOpen, customerQuery]);

  function selectQboCustomer(customer: QBOCustomerOption) {
    form.setValue("qbo_customer_id", customer.id);
    form.setValue("qbo_customer_name", customer.name);
    setCustomerPickerOpen(false);
    setCreateCustomerOpen(false);
  }

  async function handleCreateQboCustomer() {
    const name = newCustomer.name.trim();
    if (!name || creatingCustomer) return;
    setCreatingCustomer(true);
    try {
      const created = unwrapAction(
        await createProjectQboCustomerAction({
          name,
          email: newCustomer.email.trim() || null,
          line1: newCustomer.line1.trim() || null,
          city: newCustomer.city.trim() || null,
          state: newCustomer.state.trim() || null,
          postalCode: newCustomer.postalCode.trim() || null,
        }),
      );
      selectQboCustomer(created);
      setNewCustomer({
        name: "",
        email: "",
        line1: "",
        city: "",
        state: "",
        postalCode: "",
      });
      toast.success(`Created "${created.name}" in ${providerName}`);
    } catch (error: any) {
      toast.error(`Couldn't create customer in ${providerName}`, {
        description: error?.message ?? "Try again.",
      });
    } finally {
      setCreatingCustomer(false);
    }
  }

  async function goToFinancials() {
    const valid = await form.trigger("name");
    if (valid) setStep("financials");
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col fast-sheet-animation"
        style={
          {
            animationDuration: "150ms",
            transitionDuration: "150ms",
          } as CSSProperties
        }
      >
        <div className="flex-1 overflow-y-auto px-4">
          <div className="pt-6 pb-4">
            <SheetTitle className="text-lg font-semibold leading-none tracking-tight">
              {isEdit
                ? `Edit ${terms.project.toLowerCase()}`
                : `New ${terms.project.toLowerCase()}`}
            </SheetTitle>
            <SheetDescription className="text-sm text-muted-foreground">
              {step === "details"
                ? `Step 1 of 2 · ${terms.project} details`
                : "Step 2 of 2 · Financial setup"}
            </SheetDescription>
            <div className="mt-3 flex gap-1.5">
              <span
                className={cn(
                  "h-1 flex-1 rounded-full",
                  step === "details" ? "bg-primary" : "bg-primary/30",
                )}
              />
              <span
                className={cn(
                  "h-1 flex-1 rounded-full",
                  step === "financials" ? "bg-primary" : "bg-muted",
                )}
              />
            </div>
          </div>

          <Form {...form}>
            <form
              onSubmit={(event) => event.preventDefault()}
              className="space-y-4"
            >
              <div
                className={cn(
                  "space-y-4",
                  step === "details" ? "block" : "hidden",
                )}
              >
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{terms.project} name</FormLabel>
                      <FormControl>
                        <Input placeholder="Oakwood Residence" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="status"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Status</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select stage" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {statusOptions.map((s) => (
                            <SelectItem key={s.value} value={s.value}>
                              {s.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="start_date"
                  render={() => (
                    <FormItem>
                      <FormLabel>Schedule</FormLabel>
                      <FormControl>
                        <div className="flex gap-2">
                          <DateRangePicker
                            dateRange={dateRange}
                            onDateRangeChange={onDateRangeChange}
                            placeholder="Optional start and end dates"
                          />
                          {dateRange?.from || dateRange?.to ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => onDateRangeChange(undefined)}
                            >
                              Clear
                            </Button>
                          ) : null}
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="address"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Address</FormLabel>
                      <FormControl>
                        <GooglePlacesAutocomplete
                          value={field.value}
                          onChange={field.onChange}
                          placeholder="123 Main St, City, State"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {/* Client — one field. The contact drives portal invites & signatures; */}
                {/* the accounting customer (the sync target) is shown beneath as an overridable detail. */}
                <FormField
                  control={form.control}
                  name="client_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{terms.owner}</FormLabel>
                      <Select
                        value={field.value ?? "none"}
                        onValueChange={(value) =>
                          field.onChange(value === "none" ? null : value)
                        }
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select contact" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">Not set</SelectItem>
                          {clientContacts.map((contact) => (
                            <SelectItem key={contact.id} value={contact.id}>
                              {contact.full_name}
                              {contact.email ? ` - ${contact.email}` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {qboConnected ? (
                        <Popover
                          open={customerPickerOpen}
                          onOpenChange={(next) => {
                            setCustomerPickerOpen(next);
                            if (!next) setCreateCustomerOpen(false);
                          }}
                          modal
                        >
                          <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
                            {qboCustomerId ? (
                              <>
                                <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                                  <Check className="h-3.5 w-3.5 shrink-0 text-success" />
                                  <span className="truncate">
                                    Billed in {providerName} as{" "}
                                    <span className="font-medium text-foreground">
                                      {qboCustomerName || "selected customer"}
                                    </span>
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
                                      form.setValue("qbo_customer_id", null);
                                      form.setValue("qbo_customer_name", null);
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
                                      Will sync to {providerName} as{" "}
                                      <span className="font-medium text-foreground">
                                        &ldquo;{selectedClientContact.full_name}
                                        &rdquo;
                                      </span>
                                    </>
                                  ) : (
                                    `Choose the ${providerName} customer to bill`
                                  )}
                                </span>
                                <PopoverTrigger asChild>
                                  <button
                                    type="button"
                                    className="shrink-0 text-xs font-medium text-primary transition-colors hover:text-primary/80"
                                  >
                                    {selectedClientContact?.full_name
                                      ? "Change"
                                      : "Set customer"}
                                  </button>
                                </PopoverTrigger>
                              </>
                            )}
                          </div>
                          <PopoverContent
                            className="w-[var(--radix-popover-trigger-width)] min-w-[320px] p-0"
                            align="start"
                          >
                            {createCustomerOpen ? (
                              <div className="space-y-3 p-3">
                                <div className="space-y-1.5">
                                  <Label className="text-xs">Name</Label>
                                  <Input
                                    value={newCustomer.name}
                                    onChange={(e) =>
                                      setNewCustomer((s) => ({
                                        ...s,
                                        name: e.target.value,
                                      }))
                                    }
                                    placeholder="Customer name"
                                  />
                                </div>
                                <div className="space-y-1.5">
                                  <Label className="text-xs">Email</Label>
                                  <Input
                                    type="email"
                                    value={newCustomer.email}
                                    onChange={(e) =>
                                      setNewCustomer((s) => ({
                                        ...s,
                                        email: e.target.value,
                                      }))
                                    }
                                    placeholder="email@customer.com"
                                  />
                                </div>
                                <div className="space-y-1.5">
                                  <Label className="text-xs">Street</Label>
                                  <Input
                                    value={newCustomer.line1}
                                    onChange={(e) =>
                                      setNewCustomer((s) => ({
                                        ...s,
                                        line1: e.target.value,
                                      }))
                                    }
                                    placeholder="123 Main St"
                                  />
                                </div>
                                <div className="grid grid-cols-3 gap-2">
                                  <div className="space-y-1.5">
                                    <Label className="text-xs">City</Label>
                                    <Input
                                      value={newCustomer.city}
                                      onChange={(e) =>
                                        setNewCustomer((s) => ({
                                          ...s,
                                          city: e.target.value,
                                        }))
                                      }
                                    />
                                  </div>
                                  <div className="space-y-1.5">
                                    <Label className="text-xs">State</Label>
                                    <Input
                                      value={newCustomer.state}
                                      onChange={(e) =>
                                        setNewCustomer((s) => ({
                                          ...s,
                                          state: e.target.value,
                                        }))
                                      }
                                      placeholder="FL"
                                    />
                                  </div>
                                  <div className="space-y-1.5">
                                    <Label className="text-xs">ZIP</Label>
                                    <Input
                                      value={newCustomer.postalCode}
                                      onChange={(e) =>
                                        setNewCustomer((s) => ({
                                          ...s,
                                          postalCode: e.target.value,
                                        }))
                                      }
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
                                    disabled={
                                      creatingCustomer ||
                                      !newCustomer.name.trim()
                                    }
                                  >
                                    {creatingCustomer ? (
                                      <Spinner className="h-3.5 w-3.5" />
                                    ) : (
                                      "Create"
                                    )}
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <Command shouldFilter={false}>
                                <CommandInput
                                  placeholder={`Search ${providerName} customers…`}
                                  value={customerQuery}
                                  onValueChange={setCustomerQuery}
                                />
                                <CommandList>
                                  {customerSearchLoading && (
                                    <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                                      <Spinner className="h-3.5 w-3.5" />{" "}
                                      Searching…
                                    </div>
                                  )}
                                  {!customerSearchLoading &&
                                    customerResults.length === 0 && (
                                      <CommandEmpty>
                                        No {providerName} customers found.
                                      </CommandEmpty>
                                    )}
                                  {customerResults.length > 0 && (
                                    <CommandGroup>
                                      {customerResults.map((customer) => (
                                        <CommandItem
                                          key={customer.id}
                                          value={customer.id}
                                          onSelect={() =>
                                            selectQboCustomer(customer)
                                          }
                                        >
                                          <span className="flex min-w-0 flex-col">
                                            <span className="truncate">
                                              {customer.name}
                                            </span>
                                            {customer.email && (
                                              <span className="text-xs text-muted-foreground">
                                                {customer.email}
                                              </span>
                                            )}
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
                                        setNewCustomer((s) => ({
                                          ...s,
                                          name:
                                            customerQuery.trim() ||
                                            selectedClientContact?.full_name?.trim() ||
                                            "",
                                        }));
                                        setCreateCustomerOpen(true);
                                      }}
                                    >
                                      <Plus className="mr-2 h-3.5 w-3.5" />{" "}
                                      Create new customer…
                                    </CommandItem>
                                  </CommandGroup>
                                </CommandList>
                              </Command>
                            )}
                          </PopoverContent>
                        </Popover>
                      ) : null}

                      <p className="text-sm text-muted-foreground">
                        Used as the default {terms.owner.toLowerCase()} for
                        portal invites and signatures
                        {qboConnected
                          ? `, and as the ${providerName} customer for invoices, payables, and expenses`
                          : ""}
                        . This does not grant portal access.
                      </p>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {qboClasses.length > 0 ? (
                  <FormField
                    control={form.control}
                    name="qbo_class_id"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{providerName} class</FormLabel>
                        <Select
                          value={field.value ?? "none"}
                          onValueChange={(value) => {
                            if (value === "none") {
                              field.onChange(null);
                              form.setValue("qbo_class_name", null);
                              return;
                            }
                            const selected = qboClasses.find(
                              (qboClass) => qboClass.id === value,
                            );
                            field.onChange(value);
                            form.setValue(
                              "qbo_class_name",
                              selected?.fullyQualifiedName ??
                                selected?.name ??
                                null,
                            );
                          }}
                        >
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select class" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="none">Not set</SelectItem>
                            {qboClasses.map((qboClass) => (
                              <SelectItem key={qboClass.id} value={qboClass.id}>
                                {qboClass.fullyQualifiedName ?? qboClass.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                ) : null}
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="property_type"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Property Type</FormLabel>
                        <Select
                          onValueChange={(value) => {
                            field.onChange(value);
                            if (mode === "create") {
                              onFinancialSetupChange({
                                ...financialSetup,
                                fixedPriceBillingBasis:
                                  value === "commercial" ? "progress" : "draws",
                                retainagePercent:
                                  value === "commercial" ? "10" : "0",
                              });
                            }
                          }}
                          value={field.value ?? ""}
                        >
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select type" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="residential">
                              Residential
                            </SelectItem>
                            <SelectItem value="commercial">
                              Commercial
                            </SelectItem>
                            <SelectItem value="production">
                              Production
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="project_type"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Project Type</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value ?? ""}
                        >
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select type" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="new_construction">
                              New Construction
                            </SelectItem>
                            <SelectItem value="remodel">Remodel</SelectItem>
                            <SelectItem value="addition">Addition</SelectItem>
                            <SelectItem value="renovation">
                              Renovation
                            </SelectItem>
                            <SelectItem value="repair">Repair</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Project description..."
                          className="resize-none"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className={cn(step === "financials" ? "block" : "hidden")}>
                <ProjectFinancialSetupFields
                  value={financialSetup}
                  onChange={onFinancialSetupChange}
                  posture={posture}
                  costCodes={
                    isEdit ? { orgDefault: orgCostCodesDefault } : undefined
                  }
                />
                {financialMessages.blocking[0] ||
                financialMessages.warnings[0] ? (
                  <p
                    className={cn(
                      "mt-4 text-xs",
                      financialMessages.blocking[0]
                        ? "text-destructive"
                        : "text-muted-foreground",
                    )}
                  >
                    {financialMessages.blocking[0] ??
                      financialMessages.warnings[0]}
                  </p>
                ) : null}
              </div>
            </form>
          </Form>
        </div>

        <div className="flex-shrink-0 border-t bg-background p-4">
          <div className="flex gap-2">
            {step === "details" ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={onClose}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  className="flex-1"
                  onClick={goToFinancials}
                >
                  Next: {modelLabel(financialSetup.billingModel)}
                  <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep("details")}
                  className="flex-1"
                >
                  <ArrowLeft className="mr-1.5 h-4 w-4" />
                  Back
                </Button>
                <Button
                  type="button"
                  disabled={!canSubmit}
                  className="flex-1"
                  onClick={form.handleSubmit(onSubmit)}
                >
                  {isSubmitting
                    ? isEdit
                      ? "Saving..."
                      : "Creating..."
                    : isEdit
                      ? "Save changes"
                      : "Create project"}
                </Button>
              </>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
