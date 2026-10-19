"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Check, ChevronsUpDown, Plus, Search, UserPlus } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SearchPickerItem } from "@/components/ui/search-picker";
import { Textarea } from "@/components/ui/textarea";
import { createDealAction, searchDealClientsAction } from "@/app/(app)/pipeline/[dealId]/actions";
import { unwrapAction } from "@/lib/action-result";
import { TIMEFRAMES } from "@/lib/sales/registration-options";
import { cn } from "@/lib/utils";
import { DEAL_BUDGETS, DEAL_SOURCES, type DealClientChoice, type NewDealInput } from "@/lib/validation/deals";

export type DealMember = { id: string; name: string };

/** Radix selects cannot hold an empty value; these stand for "not set" and the two open-ended choices. */
const UNSET = "unset";
const EXACT_AMOUNT = "exact-amount";
const START_DATE = "start-date";

type NewClient = Extract<DealClientChoice, { kind: "new" }>;
const EMPTY_CLIENT: NewClient = { kind: "new", full_name: "", email: "", phone: "", company_name: "" };

const EMPTY_FORM = {
  name: "",
  client: null as DealClientChoice | null,
  street: "",
  city: "",
  state: "",
  postal_code: "",
  notes: "",
  source: UNSET,
  sourceDetail: "",
  budget: UNSET,
  budgetAmount: "",
  timeframe: UNSET,
  startDate: "",
  owner: UNSET,
};
type DealForm = typeof EMPTY_FORM;

const isOneOf = <T extends string>(options: readonly T[], value: string): value is T =>
  (options as readonly string[]).includes(value);

/** The form's loose state, shaped into exactly what `newDealInputSchema` accepts. */
function toInput(form: DealForm): NewDealInput {
  const dollars = Number(form.budgetAmount.replace(/[^\d.]/g, ""));
  return {
    name: form.name,
    client: form.client,
    street: form.street,
    city: form.city,
    state: form.state,
    postal_code: form.postal_code,
    notes: form.notes,
    source: isOneOf(DEAL_SOURCES, form.source) ? form.source : null,
    source_detail: form.source === "Other" ? form.sourceDetail : "",
    budget: isOneOf(DEAL_BUDGETS, form.budget)
      ? { kind: "band", band: form.budget }
      : form.budget === EXACT_AMOUNT && dollars > 0
        ? { kind: "amount", cents: Math.round(dollars * 100) }
        : null,
    timeframe: isOneOf(TIMEFRAMES, form.timeframe)
      ? { kind: "band", band: form.timeframe }
      : form.timeframe === START_DATE && form.startDate
        ? { kind: "date", date: form.startDate }
        : null,
    owner_user_id: form.owner === UNSET ? null : form.owner,
  };
}

/**
 * The first phone call, on one screen. The client comes from the directory so
 * the same person is never typed in twice; someone new is described on a
 * second pane of this same dialog and comes back as the deal's client, and the
 * deal adds them to the directory when it is created.
 */
export function NewDealDialog({
  open,
  onOpenChange,
  members,
  currentUserId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: DealMember[];
  currentUserId: string | null;
}) {
  const router = useRouter();
  const [form, setForm] = useState<DealForm>(EMPTY_FORM);
  const [pane, setPane] = useState<"deal" | "client">("deal");
  const [draftClient, setDraftClient] = useState<NewClient>(EMPTY_CLIENT);
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof DealForm>(key: K, value: DealForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const others = members.filter((member) => member.id !== currentUserId);

  const reset = () => {
    setForm(EMPTY_FORM);
    setDraftClient(EMPTY_CLIENT);
    setPane("deal");
  };
  const startNewClient = (name: string) => {
    setDraftClient(form.client?.kind === "new" ? form.client : { ...EMPTY_CLIENT, full_name: name });
    setPane("client");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        {pane === "client" ? (
          <NewClientPane
            client={draftClient}
            onChange={setDraftClient}
            onBack={() => setPane("deal")}
            onUse={() => {
              setForm((current) => ({
                ...current,
                client: draftClient,
                // A deal with no name yet is named for its client.
                name: current.name.trim() ? current.name : draftClient.full_name.trim(),
              }));
              setPane("deal");
            }}
          />
        ) : (
          <form
            className="animate-in fade-in-0 slide-in-from-left-2 space-y-5 duration-200"
            onSubmit={(event) => {
              event.preventDefault();
              startTransition(async () => {
                try {
                  const created = unwrapAction(await createDealAction(toInput(form)));
                  onOpenChange(false);
                  reset();
                  router.push(`/pipeline/${created.id}`);
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Unable to add the deal");
                }
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>New deal</DialogTitle>
              <DialogDescription>Only the name is required. Whatever you know from the first call saves a step later.</DialogDescription>
            </DialogHeader>

            <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
              <DealField label="Client" htmlFor="new-deal-client">
                <ClientPicker
                  value={form.client}
                  disabled={pending}
                  onPick={(client) =>
                    setForm((current) => ({
                      ...current,
                      client,
                      name: current.name.trim() || !client ? current.name : client.kind === "existing" ? client.name : client.full_name,
                    }))
                  }
                  onCreate={startNewClient}
                />
              </DealField>
              <DealField label="Deal name" htmlFor="new-deal-name">
                <Input
                  id="new-deal-name"
                  autoComplete="off"
                  placeholder="e.g. Hendricks residence"
                  value={form.name}
                  disabled={pending}
                  onChange={(event) => set("name", event.target.value)}
                />
              </DealField>
            </div>

            <div className="space-y-3">
              <p className="microlabel">Site</p>
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-6">
                <DealField label="Street" htmlFor="new-deal-street" className="sm:col-span-6">
                  <Input
                    id="new-deal-street"
                    autoComplete="off"
                    placeholder="Lot or street address"
                    value={form.street}
                    disabled={pending}
                    onChange={(event) => set("street", event.target.value)}
                  />
                </DealField>
                <DealField label="City" htmlFor="new-deal-city" className="sm:col-span-3">
                  <Input id="new-deal-city" autoComplete="off" value={form.city} disabled={pending} onChange={(event) => set("city", event.target.value)} />
                </DealField>
                <DealField label="State" htmlFor="new-deal-state" className="sm:col-span-1">
                  <Input id="new-deal-state" autoComplete="off" value={form.state} disabled={pending} onChange={(event) => set("state", event.target.value)} />
                </DealField>
                <DealField label="ZIP" htmlFor="new-deal-zip" className="sm:col-span-2">
                  <Input
                    id="new-deal-zip"
                    autoComplete="off"
                    inputMode="numeric"
                    value={form.postal_code}
                    disabled={pending}
                    onChange={(event) => set("postal_code", event.target.value)}
                  />
                </DealField>
              </div>
            </div>

            <div className="space-y-3">
              <p className="microlabel">The job</p>
              <DealField label="Notes" htmlFor="new-deal-notes">
                <Textarea
                  id="new-deal-notes"
                  rows={3}
                  value={form.notes}
                  disabled={pending}
                  onChange={(event) => set("notes", event.target.value)}
                  placeholder="What they want to build, and anything else from the first conversation"
                />
              </DealField>
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <ChoiceSelect
                    id="new-deal-budget"
                    label="Budget"
                    value={form.budget}
                    options={DEAL_BUDGETS}
                    open={{ value: EXACT_AMOUNT, label: "Exact amount…" }}
                    disabled={pending}
                    onChange={(value) => set("budget", value)}
                  />
                  {form.budget === EXACT_AMOUNT && (
                    <div className="relative animate-in fade-in-0 slide-in-from-top-1 duration-150">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                      <Input
                        aria-label="Budget amount"
                        autoFocus
                        inputMode="decimal"
                        className="pl-7 tabular-nums"
                        placeholder="850,000"
                        value={form.budgetAmount}
                        disabled={pending}
                        onChange={(event) => set("budgetAmount", groupThousands(event.target.value))}
                      />
                    </div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <ChoiceSelect
                    id="new-deal-timeframe"
                    label="Timeframe"
                    value={form.timeframe}
                    options={TIMEFRAMES}
                    open={{ value: START_DATE, label: "Start by a date…" }}
                    disabled={pending}
                    onChange={(value) => set("timeframe", value)}
                  />
                  {form.timeframe === START_DATE && (
                    <Input
                      aria-label="Start by"
                      type="date"
                      autoFocus
                      className="animate-in fade-in-0 slide-in-from-top-1 duration-150"
                      value={form.startDate}
                      disabled={pending}
                      onChange={(event) => set("startDate", event.target.value)}
                    />
                  )}
                </div>
                <div className="space-y-1.5">
                  <ChoiceSelect
                    id="new-deal-source"
                    label="How they found you"
                    value={form.source}
                    options={DEAL_SOURCES}
                    disabled={pending}
                    onChange={(value) => set("source", value)}
                  />
                  {form.source === "Other" && (
                    <Input
                      aria-label="Where they heard about you"
                      autoFocus
                      autoComplete="off"
                      maxLength={120}
                      className="animate-in fade-in-0 slide-in-from-top-1 duration-150"
                      placeholder="Where did they hear about you?"
                      value={form.sourceDetail}
                      disabled={pending}
                      onChange={(event) => set("sourceDetail", event.target.value)}
                    />
                  )}
                </div>
                <DealField label="Assigned to" htmlFor="new-deal-owner">
                  <Select value={form.owner} disabled={pending} onValueChange={(value) => set("owner", value)}>
                    <SelectTrigger id="new-deal-owner" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNSET}>You</SelectItem>
                      {others.map((member) => (
                        <SelectItem key={member.id} value={member.id}>
                          {member.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </DealField>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || form.name.trim().length < 2}>
                {pending ? "Adding…" : "Add deal"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** "850000" → "850,000" as it is typed; the cents are worked out on submit. */
function groupThousands(raw: string) {
  const [whole, fraction] = raw.replace(/[^\d.]/g, "").split(".");
  const grouped = whole.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction.slice(0, 2)}`;
}

/**
 * The directory, searched as you type, a page at a time; the last row always
 * offers to add someone new, carrying what was typed as their name.
 */
function ClientPicker({
  value,
  disabled,
  onPick,
  onCreate,
}: {
  value: DealClientChoice | null;
  disabled: boolean;
  onPick: (client: DealClientChoice | null) => void;
  onCreate: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SearchPickerItem[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const load = async (search: string, page: number) => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const result = await searchDealClientsAction({ search, page });
      if (id !== request.current) return;
      if (!result.success) {
        setError(result.error);
        return;
      }
      setItems((current) => (page === 1 ? result.data.items : [...current, ...result.data.items]));
      setNextPage(result.data.nextPage);
    } catch {
      if (id === request.current) setError("Unable to search the directory.");
    } finally {
      if (id === request.current) setLoading(false);
    }
  };
  const latestLoad = useRef(load);
  latestLoad.current = load;

  useEffect(() => {
    if (!open) return;
    // Show the search as under way at once, not "nobody matches" while the debounce runs.
    setLoading(true);
    const timer = setTimeout(() => void latestLoad.current(query.trim(), 1), 200);
    return () => clearTimeout(timer);
  }, [open, query]);

  const label = !value ? null : value.kind === "existing" ? value.name : value.full_name;
  const typed = query.trim();

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id="new-deal-client"
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between gap-2 px-3 font-normal"
        >
          {label ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium">{label}</span>
              {value?.kind === "new" && (
                <span className="shrink-0 border border-primary/30 bg-primary/10 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                  New
                </span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground">Search the directory…</span>
          )}
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(26rem,calc(100vw-3rem))] p-0">
        <Command shouldFilter={false}>
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, email or phone"
              aria-label="Search the directory"
              className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <CommandList className="max-h-72">
            {value && (
              <>
                <CommandGroup>
                  <CommandItem
                    value="__clear"
                    onSelect={() => {
                      onPick(null);
                      setOpen(false);
                    }}
                    className="text-muted-foreground"
                  >
                    No client yet
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            <CommandGroup heading="Directory">
              {items.map((item) => {
                const selected = value?.kind === "existing" && value.contact_id === item.id;
                return (
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    onSelect={() => {
                      onPick({ kind: "existing", contact_id: item.id, name: item.name });
                      setOpen(false);
                    }}
                    className="flex items-start gap-2.5 py-2"
                  >
                    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                      {initials(item.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.name}</span>
                      {item.detail && <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>}
                    </span>
                    {selected && <Check className="mt-1 h-4 w-4 shrink-0 text-primary" />}
                  </CommandItem>
                );
              })}
              {loading && (
                <div role="status" aria-label="Searching" className="space-y-1.5 p-2">
                  {[0, 1, 2].map((row) => (
                    <div key={row} className="h-9 animate-pulse bg-muted" />
                  ))}
                </div>
              )}
              {!loading && !error && items.length === 0 && (
                <p className="px-2 py-3 text-sm text-muted-foreground">
                  {typed ? `Nobody in the directory matches “${typed}”.` : "Nobody in the directory yet."}
                </p>
              )}
              {error && (
                <div className="flex items-center justify-between gap-2 px-2 py-2">
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                  <Button type="button" variant="outline" size="sm" onClick={() => void load(typed, 1)}>
                    Retry
                  </Button>
                </div>
              )}
              {!loading && nextPage && (
                <CommandItem value="__more" onSelect={() => void load(typed, nextPage)} className="justify-center text-xs text-muted-foreground">
                  Show more
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
          <div className="border-t p-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onCreate(typed);
              }}
              className="flex w-full items-center gap-2.5 px-2 py-2 text-left text-sm font-medium text-primary transition-colors duration-150 hover:bg-primary/10 focus-visible:bg-primary/10 focus-visible:outline-none"
            >
              <span className="flex size-6 items-center justify-center rounded-full border border-dashed border-primary/50">
                <Plus className="h-3.5 w-3.5" />
              </span>
              {typed ? (
                <span className="truncate">
                  Add “{typed}” as a new client
                </span>
              ) : (
                "Add a new client"
              )}
            </button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The second pane: someone new, described once, then carried back to the deal. */
function NewClientPane({
  client,
  onChange,
  onBack,
  onUse,
}: {
  client: NewClient;
  onChange: (client: NewClient) => void;
  onBack: () => void;
  onUse: () => void;
}) {
  const set = (key: "full_name" | "email" | "phone" | "company_name", value: string) => onChange({ ...client, [key]: value });
  const validEmail = !client.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(client.email);
  const ready = client.full_name.trim().length >= 2 && validEmail;
  return (
    <form
      className="animate-in fade-in-0 slide-in-from-right-2 space-y-5 duration-200"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onUse();
      }}
    >
      <DialogHeader>
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 mb-1 inline-flex w-fit items-center gap-1 px-1 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          New deal
        </button>
        <DialogTitle className="flex items-center gap-2">
          <UserPlus className="h-4 w-4 text-primary" />
          New client
        </DialogTitle>
        <DialogDescription>
          They join your directory when you add the deal, so the next deal finds them instead of typing them again.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <DealField label="Full name" htmlFor="new-client-name" className="sm:col-span-2">
          <Input
            id="new-client-name"
            autoFocus
            autoComplete="off"
            placeholder="Who you spoke with"
            value={client.full_name}
            onChange={(event) => set("full_name", event.target.value)}
          />
        </DealField>
        <DealField label="Phone" htmlFor="new-client-phone">
          <Input
            id="new-client-phone"
            type="tel"
            autoComplete="off"
            placeholder="(555) 555-0100"
            value={client.phone ?? ""}
            onChange={(event) => set("phone", event.target.value)}
          />
        </DealField>
        <DealField label="Email" htmlFor="new-client-email">
          <Input
            id="new-client-email"
            type="email"
            autoComplete="off"
            placeholder="name@example.com"
            aria-invalid={!validEmail}
            value={client.email ?? ""}
            onChange={(event) => set("email", event.target.value)}
          />
        </DealField>
        <DealField label="Company" htmlFor="new-client-company" className="sm:col-span-2">
          <Input
            id="new-client-company"
            autoComplete="off"
            placeholder="Only if they are buying through one"
            value={client.company_name ?? ""}
            onChange={(event) => set("company_name", event.target.value)}
          />
        </DealField>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" disabled={!ready}>
          Use this client
        </Button>
      </DialogFooter>
    </form>
  );
}

function initials(name: string) {
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

function DealField({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

/** A closed list, "not known yet", and optionally one open-ended choice that reveals its own field. */
function ChoiceSelect({
  id,
  label,
  value,
  options,
  open,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  open?: { value: string; label: string };
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>
            <span className="text-muted-foreground">Not known yet</span>
          </SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
          {open && (
            <>
              <SelectSeparator />
              <SelectItem value={open.value}>{open.label}</SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
