"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronRight,
  LockKeyhole,
  Plus,
  Search,
  BookOpen,
  ArrowUpRight,
} from "lucide-react";
import { toast } from "sonner";
import {
  createGlAccountAction,
  updateGlAccountAction,
  setGlAccountActiveAction,
} from "@/app/(app)/books/actions";
import {
  AccountActivitySheet,
  type ActivityTarget,
} from "@/components/books/account-activity-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  GL_ACCOUNT_SUBTYPES,
  GL_ACCOUNT_SUBTYPE_TYPES,
  normalBalanceForSubtype,
  type GlAccountType,
  type GlAccountSubtype,
} from "@/lib/services/books/types";
import type { getBooksWorkspace } from "@/lib/services/books/workspace";
import { accountHierarchy } from "@/lib/services/books/account-hierarchy";
import { cn } from "@/lib/utils";

type Account = Awaited<
  ReturnType<typeof getBooksWorkspace>
>["accounts"][number];
const GROUPS: {
  key: GlAccountType;
  label: string;
  range: string;
  description: string;
}[] = [
  {
    key: "asset",
    label: "Assets",
    range: "1000",
    description: "What you own and what you’re owed.",
  },
  {
    key: "liability",
    label: "Liabilities",
    range: "2000",
    description: "What your business owes to others.",
  },
  {
    key: "equity",
    label: "Equity",
    range: "3000",
    description: "Ownership and accumulated earnings.",
  },
  {
    key: "income",
    label: "Income",
    range: "4000",
    description: "Revenue earned by your business.",
  },
  {
    key: "cogs",
    label: "Cost of goods sold",
    range: "5000",
    description: "The direct costs of delivering your work.",
  },
  {
    key: "expense",
    label: "Expenses",
    range: "6000",
    description: "The everyday costs of running your business.",
  },
];
const humanize = (value: string) =>
  value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());

export function ChartOfAccounts({
  accounts,
  canManage,
  asOf,
}: {
  accounts: Account[];
  canManage: boolean;
  asOf: string;
}) {
  const [group, setGroup] = useState<GlAccountType | "all">("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("active");
  const [editor, setEditor] = useState<Account | "new" | null>(null);
  const [activity, setActivity] = useState<ActivityTarget | null>(null);
  const matching = accounts
    .filter(
      (account) =>
        (status === "all" || account.active === (status === "active")) &&
        `${account.code} ${account.name} ${account.subtype.replaceAll("_", " ")} ${account.description ?? ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    )
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const visible = matching.filter(
    (account) => group === "all" || account.account_type === group,
  );
  const hierarchy = accountHierarchy(accounts);
  const visibleIds = new Set(visible.map((account) => account.id));

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <nav
          aria-label="Account types"
          className="flex shrink-0 gap-1 overflow-x-auto border-b bg-muted/20 p-3 lg:w-60 lg:shrink-0 lg:flex-col lg:border-b-0 lg:border-r lg:p-4"
        >
          <button
            onClick={() => setGroup("all")}
            aria-pressed={group === "all"}
            className={cn(
              "flex shrink-0 items-center justify-between gap-4 rounded-md px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
              group === "all"
                ? "bg-background font-medium shadow-sm"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            All accounts{" "}
            <span className="font-mono text-xs text-muted-foreground">
              {matching.length}
            </span>
          </button>
          {GROUPS.map((item) => (
            <button
              key={item.key}
              onClick={() => setGroup(item.key)}
              aria-pressed={group === item.key}
              className={cn(
                "flex shrink-0 items-center justify-between gap-4 rounded-md px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                group === item.key
                  ? "bg-background font-medium shadow-sm"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {item.label}
              <span className="font-mono text-xs text-muted-foreground">
                {
                  matching.filter(
                    (account) => account.account_type === item.key,
                  ).length
                }
              </span>
            </button>
          ))}
          <div className="mt-auto hidden px-3 pt-10 text-xs leading-5 text-muted-foreground lg:block">
            <LockKeyhole className="mb-2 size-4" />
            System accounts keep automatic posting consistent. Their definitions
            are protected.
          </div>
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-5 py-3 lg:px-6">
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name or code…"
                aria-label="Search accounts"
                className="pl-9"
              />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-40" aria-label="Account status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active accounts</SelectItem>
                <SelectItem value="inactive">Inactive accounts</SelectItem>
                <SelectItem value="all">All statuses</SelectItem>
              </SelectContent>
            </Select>
            {canManage ? (
              <Button className="ml-auto" onClick={() => setEditor("new")}>
                <Plus className="mr-2 size-4" />
                New account
              </Button>
            ) : null}
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            role="region"
            aria-label="Accounts"
            tabIndex={0}
          >
            <div aria-live="polite" className="sr-only">
              {visible.length} accounts found
            </div>
            {GROUPS.filter((item) => group === "all" || group === item.key).map(
              (item) => {
                const rows = hierarchy.filter(
                  ({ account }) =>
                    visibleIds.has(account.id) &&
                    account.account_type === item.key,
                );
                if (!rows.length) return null;
                return (
                  <section key={item.key} aria-label={item.label}>
                    <div className="flex items-center gap-4 border-b bg-muted/20 px-5 py-4 lg:px-8">
                      <span className="font-mono text-xs text-muted-foreground">
                        {item.range}
                      </span>
                      <div>
                        <h2 className="text-sm font-semibold">
                          {item.label}
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            {rows.length}
                          </span>
                        </h2>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {item.description}
                        </p>
                      </div>
                    </div>
                    <div className="divide-y">
                      {rows.map(({ account, depth, path }) => (
                        <button
                          key={account.id}
                          onClick={() => setEditor(account)}
                          className="group flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring lg:px-8"
                        >
                          <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">
                            {account.code}
                          </span>
                          <div
                            className="min-w-0 flex-1"
                            style={{ paddingLeft: Math.min(depth, 4) * 16 }}
                          >
                            <p className="truncate text-sm font-medium">
                              {depth > 0 ? (
                                <span
                                  aria-hidden="true"
                                  className="mr-2 text-muted-foreground"
                                >
                                  ↳
                                </span>
                              ) : null}
                              {account.name}
                            </p>
                            <p className="mt-1 truncate text-xs text-muted-foreground">
                              {account.parent_id
                                ? path
                                : humanize(account.subtype)}
                            </p>
                          </div>
                          {!account.active ? (
                            <span className="text-xs text-muted-foreground">
                              Inactive
                            </span>
                          ) : null}
                          {account.is_system ? (
                            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <LockKeyhole className="size-3" />
                              <span className="hidden sm:inline">System</span>
                            </span>
                          ) : null}
                          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
                        </button>
                      ))}
                    </div>
                  </section>
                );
              },
            )}
            {visible.length === 0 ? (
              <div className="flex flex-col items-center px-6 py-20 text-center">
                <BookOpen className="mb-4 size-7 text-muted-foreground" />
                <h2 className="text-sm font-medium">No accounts found</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Try another name, account type, or status.
                </p>
                <Button
                  variant="ghost"
                  className="mt-4"
                  onClick={() => {
                    setQuery("");
                    setGroup("all");
                    setStatus("all");
                  }}
                >
                  Clear filters
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          {editor !== null ? (
            <AccountEditor
              key={editor === "new" ? "new" : editor.id}
              account={editor === "new" ? null : editor}
              initialType={group === "all" ? "asset" : group}
              canManage={canManage}
              accounts={accounts}
              onClose={() => setEditor(null)}
              onActivity={(account) => {
                setEditor(null);
                setActivity({
                  accountId: account.id,
                  code: account.code,
                  name: account.name,
                });
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <AccountActivitySheet
        target={activity}
        startDate={`${asOf.slice(0, 4)}-01-01`}
        endDate={asOf}
        onOpenChange={(open) => {
          if (!open) setActivity(null);
        }}
      />
    </div>
  );
}

function AccountEditor({
  account,
  initialType,
  canManage,
  accounts,
  onClose,
  onActivity,
}: {
  account: Account | null;
  initialType: GlAccountType;
  canManage: boolean;
  accounts: Account[];
  onClose: () => void;
  onActivity: (account: Account) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<GlAccountType>(
    (account?.account_type as GlAccountType) ?? initialType,
  );
  const [subtype, setSubtype] = useState<GlAccountSubtype>(
    (account?.subtype as GlAccountSubtype) ??
      GL_ACCOUNT_SUBTYPES.find(
        (value) => GL_ACCOUNT_SUBTYPE_TYPES[value] === initialType,
      )!,
  );
  const [parentId, setParentId] = useState("none");
  const [cashFlowCategory, setCashFlowCategory] = useState(
    account?.cash_flow_category ?? "",
  );
  const parentOptions = accountHierarchy(accounts).filter(
    ({ account: candidate }) =>
      candidate.active && candidate.account_type === type,
  );
  const parent = account?.parent_id
    ? accounts.find((candidate) => candidate.id === account.parent_id)
    : null;
  const editable = canManage && !account?.is_system;
  const save = (formData: FormData) => {
    setError(null);
    startTransition(async () => {
      try {
        const result = account
          ? await updateGlAccountAction(formData)
          : await createGlAccountAction(formData);
        if (!result.success) {
          setError(result.error);
          return;
        }
        toast.success(account ? "Account updated" : "Account created");
        router.refresh();
        onClose();
      } catch {
        setError("Unable to save this account. Please try again.");
      }
    });
  };
  const changeStatus = () => {
    if (!account) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await setGlAccountActiveAction(
          account.id,
          !account.active,
        );
        if (!result.success) {
          setError(result.error);
          return;
        }
        toast.success(
          account.active ? "Account deactivated" : "Account activated",
        );
        router.refresh();
        onClose();
      } catch {
        setError("Unable to change account status. Please try again.");
      }
    });
  };
  return (
    <>
      <DialogHeader className="text-left">
        <DialogTitle className="text-xl">
          {account?.name ?? "New account"}
        </DialogTitle>
        <DialogDescription>
          {account?.is_system
            ? "This system account is used by Arc’s automatic posting rules and is protected."
            : account
              ? "Keep this account’s name and reporting details up to date."
              : "Add an account or organize it under a parent account."}
        </DialogDescription>
      </DialogHeader>
      <form action={save} className="flex flex-col gap-4">
        {account ? (
          <input type="hidden" name="accountId" value={account.id} />
        ) : null}
        <fieldset
          disabled={pending || !editable}
          className="grid grid-cols-2 gap-4"
        >
          <div className="col-span-2 space-y-2">
            <Label htmlFor="account-name">Account name</Label>
            <Input
              id="account-name"
              name="name"
              defaultValue={account?.name}
              required
              minLength={2}
              maxLength={160}
              placeholder="e.g. Office supplies"
              autoFocus={!account}
            />
          </div>
          {!account ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="account-code">Account code</Label>
                <Input
                  id="account-code"
                  name="code"
                  required
                  maxLength={32}
                  placeholder="e.g. 6100"
                  className="font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="account-type">Account type</Label>
                <Select
                  name="accountType"
                  value={type}
                  onValueChange={(value: GlAccountType) => {
                    setType(value);
                    setParentId("none");
                    setSubtype(
                      GL_ACCOUNT_SUBTYPES.find(
                        (entry) => GL_ACCOUNT_SUBTYPE_TYPES[entry] === value,
                      )!,
                    );
                  }}
                  disabled={pending || !editable}
                >
                  <SelectTrigger id="account-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GROUPS.map((item) => (
                      <SelectItem key={item.key} value={item.key}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="account-subtype">Account category</Label>
                <Select
                  name="subtype"
                  value={subtype}
                  onValueChange={(value: GlAccountSubtype) => setSubtype(value)}
                  disabled={pending || !editable}
                >
                  <SelectTrigger id="account-subtype" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GL_ACCOUNT_SUBTYPES.filter(
                      (value) => GL_ACCOUNT_SUBTYPE_TYPES[value] === type,
                    ).map((value) => (
                      <SelectItem key={value} value={value}>
                        {humanize(value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <input
                type="hidden"
                name="normalBalance"
                value={normalBalanceForSubtype(subtype)}
              />
            </>
          ) : (
            <>
              <div className="col-span-2 grid grid-cols-2 gap-4 rounded-md bg-muted/40 p-4 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Category</p>
                  <p className="mt-1">{humanize(account.subtype)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    Normal balance
                  </p>
                  <p className="mt-1">{humanize(account.normal_balance)}</p>
                </div>
              </div>
              <div className="col-span-2 space-y-2">
                <Label htmlFor="account-description">Description</Label>
                <Textarea
                  id="account-description"
                  name="description"
                  defaultValue={account.description ?? ""}
                  maxLength={500}
                  placeholder="When should this account be used?"
                />
              </div>
            </>
          )}
          <div className={cn("space-y-2", account && "col-span-2")}>
            <Label htmlFor="account-cash-flow">Cash-flow category</Label>
            <select
              id="account-cash-flow"
              name="cashFlowCategory"
              value={cashFlowCategory}
              onChange={(event) => setCashFlowCategory(event.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">No category</option>
              <option value="operating">Operating</option>
              <option value="investing">Investing</option>
              <option value="financing">Financing</option>
              <option value="cash">Cash</option>
            </select>
          </div>
          {!account ? (
            <div className="col-span-2 space-y-2">
              <Label htmlFor="account-parent">
                Parent account{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <input
                type="hidden"
                name="parentId"
                value={parentId === "none" ? "" : parentId}
              />
              <Select
                value={parentId}
                onValueChange={(value) => {
                  setParentId(value);
                  const selectedParent = accounts.find(
                    (candidate) => candidate.id === value,
                  );
                  if (selectedParent) {
                    setSubtype(selectedParent.subtype as GlAccountSubtype);
                    setCashFlowCategory(
                      selectedParent.cash_flow_category ?? "",
                    );
                  }
                }}
                disabled={pending || !editable}
              >
                <SelectTrigger id="account-parent" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    None — standalone account
                  </SelectItem>
                  {parentOptions.map(({ account: candidate, path }) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.code} · {path}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs leading-5 text-muted-foreground">
                Choose a parent to create a subaccount. Code, category, and
                parent are fixed after creation.
              </p>
            </div>
          ) : parent ? (
            <div className="col-span-2 text-sm">
              <p className="text-xs text-muted-foreground">Subaccount of</p>
              <p className="mt-1">
                {parent.code} · {parent.name}
              </p>
            </div>
          ) : null}
        </fieldset>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {editable ? (
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending
                ? "Saving…"
                : account
                  ? "Save changes"
                  : "Create account"}
            </Button>
          </div>
        ) : null}
        {account ? (
          <div className="mt-auto space-y-4 border-t pt-5">
            <Button
              type="button"
              variant="outline"
              className="w-full justify-between"
              disabled={pending}
              onClick={() => onActivity(account)}
            >
              View account activity
              <ArrowUpRight className="size-4" />
            </Button>
            {editable ? (
              <div className="flex items-center justify-between gap-4">
                <p className="text-xs leading-5 text-muted-foreground">
                  {account.active
                    ? "Deactivate accounts you no longer use. Existing entries stay in your books."
                    : "Activate this account to make it available for new entries."}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={changeStatus}
                >
                  {account.active ? "Deactivate" : "Activate"}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </form>
    </>
  );
}
