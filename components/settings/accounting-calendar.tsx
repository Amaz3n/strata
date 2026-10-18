"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createAccountingPeriodAction } from "@/app/(app)/books/actions";
import { AccountingFiscalSettings } from "@/components/settings/accounting-fiscal-settings";
import { SettingsGroup } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { BooksModuleRow } from "@/lib/services/books/module";
import type { getBooksWorkspace } from "@/lib/services/books/workspace";

type Periods = Awaited<ReturnType<typeof getBooksWorkspace>>["periods"];
export function AccountingCalendar({
  periods,
  settings,
  canCreate,
  canManageFiscal,
}: {
  periods: Periods;
  settings: BooksModuleRow | null;
  canCreate: boolean;
  canManageFiscal: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mx-auto max-w-4xl space-y-10 px-5 py-8 lg:px-8">
      <AccountingFiscalSettings
        settings={settings}
        canManage={canManageFiscal}
      />
      <SettingsGroup
        title="Accounting periods"
        description="Define the dates used for reporting and period close. Review and close periods in Books."
        action={
          canCreate ? (
            <Button
              size="sm"
              onClick={() => {
                setError(null);
                setOpen(true);
              }}
            >
              New period
            </Button>
          ) : undefined
        }
      >
        {periods.length ? (
          periods.map((period) => (
            <div
              key={period.id}
              className="flex flex-wrap items-center justify-between gap-3 py-4"
            >
              <div>
                <p className="text-sm font-medium">
                  FY {period.fiscal_year} · Period {period.fiscal_period}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {period.period_start} – {period.period_end}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant="outline" className="capitalize">
                  {period.status.replaceAll("_", " ")}
                </Badge>
                <Button asChild size="sm" variant="ghost">
                  <Link href={`/books/close/${period.id}`}>Review close</Link>
                </Button>
              </div>
            </div>
          ))
        ) : (
          <p className="py-8 text-sm text-muted-foreground">
            No accounting periods yet. Create your first period to get started.
          </p>
        )}
      </SettingsGroup>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New accounting period</DialogTitle>
            <DialogDescription>
              Set the reporting dates and fiscal period number.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            action={(formData) => {
              setError(null);
              startTransition(async () => {
                try {
                  const result = await createAccountingPeriodAction(formData);
                  if (!result.success) {
                    setError(result.error);
                    return;
                  }
                  toast.success("Accounting period created");
                  setOpen(false);
                  router.refresh();
                } catch {
                  setError("Unable to create the period. Please try again.");
                }
              });
            }}
          >
            <fieldset disabled={pending} className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="period-start">Starts</Label>
                <Input
                  id="period-start"
                  name="periodStart"
                  type="date"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="period-end">Ends</Label>
                <Input id="period-end" name="periodEnd" type="date" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="period-year">Fiscal year</Label>
                <Input
                  id="period-year"
                  name="fiscalYear"
                  type="number"
                  min={1900}
                  max={9999}
                  defaultValue={new Date().getFullYear()}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="period-number">Period number</Label>
                <Input
                  id="period-number"
                  name="fiscalPeriod"
                  type="number"
                  min={1}
                  max={13}
                  required
                />
              </div>
            </fieldset>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Creating…" : "Create period"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
