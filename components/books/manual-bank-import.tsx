"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  createManualBankAccountAction,
  importBankStatementAction,
} from "@/app/(app)/books/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type GlAccount = {
  id: string;
  code: string;
  name: string;
  account_type: string;
  subtype: string;
  active: boolean;
};

type BankAccount = {
  id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  gl_account_id: string | null;
};

type AccountType = "depository" | "credit" | "loan" | "investment" | "other";

function eligibleControlAccount(account: GlAccount, type: AccountType) {
  if (!account.active) return false;
  if (type === "credit") {
    return account.account_type === "liability" && account.subtype === "credit_card";
  }
  if (type === "loan") {
    return (
      account.account_type === "liability" &&
      ["current_debt", "long_term_debt"].includes(account.subtype)
    );
  }
  return (
    account.account_type === "asset" &&
    ["cash", "undeposited_funds", "other_asset"].includes(account.subtype)
  );
}

export function ManualBankImport({
  accounts,
  bankAccounts,
  onChanged,
}: {
  accounts: GlAccount[];
  bankAccounts: BankAccount[];
  onChanged(): void;
}) {
  const [accountType, setAccountType] = useState<AccountType>("depository");
  const [selectedBankAccount, setSelectedBankAccount] = useState("");
  const [positiveDirection, setPositiveDirection] = useState<"inflow" | "outflow">("inflow");
  const [file, setFile] = useState<File | null>(null);
  const [creating, startCreate] = useTransition();
  const [importing, startImport] = useTransition();
  const controls = useMemo(
    () => accounts.filter((account) => eligibleControlAccount(account, accountType)),
    [accountType, accounts],
  );

  return (
    <section className="border bg-background">
      <div className="border-b px-5 py-4">
        <p className="text-sm font-semibold">Statement import fallback</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Keep every institution reconcilable even when Plaid is unavailable. Create a
          manual control account once, then import CSV, TSV, OFX, or QFX statements.
        </p>
      </div>
      <div className="grid divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        <form
          className="space-y-3 p-5"
          action={(formData) => {
            startCreate(async () => {
              const result = await createManualBankAccountAction(formData);
              if (!result.success) {
                toast.error(result.error);
                return;
              }
              toast.success("Manual bank account created");
              onChanged();
            });
          }}
        >
          <div>
            <p className="text-xs font-medium">1. Add an account</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Use the statement’s account name and map it to the matching GL control.
            </p>
          </div>
          <Input name="name" required placeholder="Operating checking" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              name="accountType"
              value={accountType}
              onValueChange={(value: AccountType) => setAccountType(value)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="depository">Bank account</SelectItem>
                <SelectItem value="credit">Credit card</SelectItem>
                <SelectItem value="loan">Loan account</SelectItem>
                <SelectItem value="investment">Investment account</SelectItem>
                <SelectItem value="other">Other asset account</SelectItem>
              </SelectContent>
            </Select>
            <Input name="lastFour" inputMode="numeric" maxLength={4} pattern="\d{4}" placeholder="Last 4 (optional)" />
          </div>
          <Select name="glAccountId" required>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Ledger control account" />
            </SelectTrigger>
            <SelectContent>
              {controls.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.code} · {account.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button disabled={creating} className="w-full">
            {creating ? "Creating…" : "Create manual account"}
          </Button>
        </form>

        <form
          className="space-y-3 p-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!file || !selectedBankAccount) {
              toast.error("Choose an account and statement file");
              return;
            }
            startImport(async () => {
              const contents = await file.text();
              const result = await importBankStatementAction({
                bankAccountId: selectedBankAccount,
                contents,
                positiveDirection,
                fileName: file.name,
              });
              if (!result.success) {
                toast.error(result.error);
                return;
              }
              toast.success(
                `${result.data.imported} imported · ${result.data.duplicates} duplicate${result.data.duplicates === 1 ? "" : "s"} skipped`,
              );
              setFile(null);
              onChanged();
            });
          }}
        >
          <div>
            <p className="text-xs font-medium">2. Import a statement</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Duplicate rows are detected and skipped. Nothing is posted until the review tray is categorized.
            </p>
          </div>
          <Select value={selectedBankAccount} onValueChange={setSelectedBankAccount}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Bank or card account" />
            </SelectTrigger>
            <SelectContent>
              {bankAccounts.filter((account) => account.gl_account_id).map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.official_name || account.name}{account.mask ? ` · •••• ${account.mask}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="file"
            accept=".csv,.tsv,.txt,.ofx,.qfx,application/x-ofx,text/csv,text/tab-separated-values"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <Select
            value={positiveDirection}
            onValueChange={(value: "inflow" | "outflow") => setPositiveDirection(value)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inflow">Positive amounts are money in</SelectItem>
              <SelectItem value="outflow">Positive amounts are money out</SelectItem>
            </SelectContent>
          </Select>
          <Button disabled={importing || !file || !selectedBankAccount} className="w-full">
            {importing ? "Importing…" : "Import statement"}
          </Button>
        </form>
      </div>
    </section>
  );
}
