"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateBooksFiscalSettingsAction } from "@/app/(app)/settings/accounting-actions";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SettingsGroup,
  SettingsField,
  SettingsError,
} from "@/components/settings/settings-section";
import type { BooksModuleRow } from "@/lib/services/books/module";
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function AccountingFiscalSettings({
  settings,
  canManage,
}: {
  settings: BooksModuleRow | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [fiscalMonth, setFiscalMonth] = useState(
    String(settings?.fiscal_year_start_month ?? 1),
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const saveFiscalMonth = () => {
    setError(null);
    startTransition(async () => {
      const result = await updateBooksFiscalSettingsAction(Number(fiscalMonth));
      if (!result.success) {
        setError(result.error ?? "Unable to update fiscal settings");
        return;
      }
      toast.success("Accounting calendar updated");
      router.refresh();
    });
  };

  return (
    <div>
      {" "}
      <SettingsGroup
        title="Accounting calendar"
        description="Organization-wide accounting calendar and immutable reporting basis."
      >
        <SettingsField
          label="Fiscal year starts"
          htmlFor="fiscal-year-start"
          hint="Used to organize periods and year-end close controls."
        >
          <div className="flex max-w-sm items-center gap-2">
            <Select
              value={fiscalMonth}
              onValueChange={setFiscalMonth}
              disabled={!canManage || pending}
            >
              <SelectTrigger id="fiscal-year-start">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTHS.map((month, index) => (
                  <SelectItem key={month} value={String(index + 1)}>
                    {month}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              onClick={saveFiscalMonth}
              disabled={
                !canManage ||
                pending ||
                Number(fiscalMonth) === settings?.fiscal_year_start_month
              }
            >
              Save
            </Button>
          </div>
        </SettingsField>
        <SettingsField
          label="Reporting basis"
          hint="Arc Books currently posts accrual-basis construction accounting."
        >
          <p className="pt-2 text-sm font-medium">Accrual</p>
        </SettingsField>
        <SettingsField
          label="Functional currency"
          hint="The ledger currency cannot be changed after transactions are posted."
        >
          <p className="pt-2 text-sm font-medium uppercase">
            {settings?.functional_currency ?? "USD"}
          </p>
        </SettingsField>
      </SettingsGroup>
      {error ? <SettingsError>{error}</SettingsError> : null}
    </div>
  );
}
