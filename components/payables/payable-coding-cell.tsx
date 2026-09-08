"use client";

import { useState } from "react";
import { toast } from "sonner";
import { updateProjectVendorBillStatusAction } from "@/app/(app)/projects/[id]/payables/actions";
import { unwrapAction } from "@/lib/action-result";
import type { VendorBillSummary } from "@/lib/services/vendor-bills";
import type { CostCode } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CodingCombobox } from "@/components/financials/workspace/coding-combobox";

/** Quick coding preserves split allocations and uses the existing approval rules. */
export function PayableCodingCell({
  bill,
  nativeBooks,
  accountingEnabled,
  accounts,
  costCodes,
  costCodesEnabled,
  locked,
  expectedUpdatedAt,
  onOpen,
  onSaved,
}: {
  bill: VendorBillSummary;
  nativeBooks: boolean;
  accountingEnabled: boolean;
  accounts: Array<{ id: string; name: string }>;
  costCodes: CostCode[];
  costCodesEnabled: boolean;
  locked: boolean;
  expectedUpdatedAt?: string;
  onOpen: () => void;
  onSaved: (updatedAt?: string) => void;
}) {
  const line = bill.actual_lines?.[0];
  const savedAccountId = nativeBooks
    ? line?.arc_books_gl_account_id
    : (line?.qbo_expense_account_id ?? bill.qbo_expense_account_id);
  const savedAccountName = nativeBooks
    ? line?.arc_books_gl_account_name
    : (line?.qbo_expense_account_name ?? bill.qbo_expense_account_name);
  const [open, setOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [costOpen, setCostOpen] = useState(false);
  const [accountId, setAccountId] = useState(savedAccountId ?? "");
  const [costCodeId, setCostCodeId] = useState(line?.cost_code_id ?? "");
  const [saving, setSaving] = useState(false);
  const split = (bill.actual_lines?.length ?? 0) > 1;
  const canEdit =
    !locked &&
    !bill.is_draft &&
    bill.status === "pending" &&
    !split &&
    Boolean(line) &&
    Boolean(bill.project_id) &&
    Boolean(expectedUpdatedAt) &&
    bill.payable_type !== "vendor_credit";
  const accountName =
    accounts.find((account) => account.id === savedAccountId)?.name ??
    savedAccountName;
  const label = split
    ? `${bill.actual_lines?.length} allocations`
    : accountingEnabled
      ? (accountName ?? "Choose account")
      : (line?.cost_code_name ?? "Code payable");
  const costLabel = costCodes.find((code) => code.id === line?.cost_code_id);
  const trigger = (
    <Button
      variant="ghost"
      className="h-auto min-h-11 w-full justify-start px-3 py-2 text-left"
      onClick={!canEdit ? onOpen : undefined}
    >
      <span className="min-w-0">
        <span className="block truncate text-xs">{label}</span>
        {costCodesEnabled ? (
          <span className="block truncate text-[11px] font-normal text-muted-foreground">
            {costLabel
              ? `${costLabel.code} · ${costLabel.name}`
              : "Cost code needed"}
          </span>
        ) : null}
      </span>
    </Button>
  );
  if (!canEdit) return trigger;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        if (next) {
          setAccountId(savedAccountId ?? "");
          setCostCodeId(line?.cost_code_id ?? "");
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-3">
        <p className="text-sm font-medium">
          Code {bill.bill_number ?? "payable"}
        </p>
        {accountingEnabled ? (
          <CodingCombobox
            open={accountOpen}
            onOpenChange={setAccountOpen}
            disabled={saving}
            triggerLabel={
              accounts.find((account) => account.id === accountId)?.name ??
              "Choose account"
            }
            searchPlaceholder="Search accounts"
            groupHeading={
              nativeBooks ? "Arc Books accounts" : "Accounting accounts"
            }
            emptyLabel="No accounts available"
            options={accounts.map((account) => ({
              id: account.id,
              label: account.name,
            }))}
            selectedId={accountId || null}
            onSelect={(id) => {
              setAccountId(id ?? "");
              setAccountOpen(false);
            }}
          />
        ) : null}
        {costCodesEnabled ? (
          <CodingCombobox
            open={costOpen}
            onOpenChange={setCostOpen}
            disabled={saving}
            triggerLabel={
              costCodes.find((code) => code.id === costCodeId)?.name ??
              "Choose cost code"
            }
            searchPlaceholder="Search cost codes"
            groupHeading="Cost codes"
            emptyLabel="No cost codes available"
            options={costCodes.map((code) => ({
              id: code.id,
              label: `${code.code} · ${code.name}`,
            }))}
            selectedId={costCodeId || null}
            onSelect={(id) => {
              setCostCodeId(id ?? "");
              setCostOpen(false);
            }}
          />
        ) : null}
        <div className="flex justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={onOpen}>
            Split / more details
          </Button>
          <Button
            size="sm"
            disabled={
              saving ||
              (accountingEnabled && !accountId) ||
              (costCodesEnabled && !costCodeId)
            }
            onClick={async () => {
              if (!line || !bill.project_id) return;
              setSaving(true);
              try {
                const account = accounts.find(
                  (entry) => entry.id === accountId,
                );
                const result = unwrapAction(
                  await updateProjectVendorBillStatusAction(
                    bill.project_id,
                    bill.id,
                    {
                      status: "pending",
                      expected_updated_at: expectedUpdatedAt,
                      actual_lines: [
                        {
                          ...line,
                          arc_books_gl_account_id: nativeBooks
                            ? accountId || undefined
                            : undefined,
                          cost_code_id: costCodesEnabled
                            ? costCodeId
                            : line.cost_code_id,
                          ...(accountingEnabled && !nativeBooks
                            ? {
                                qbo_expense_account_id: accountId,
                                qbo_expense_account_name: account?.name,
                              }
                            : {}),
                        },
                      ],
                    },
                  ),
                );
                if (!result.success) throw new Error(result.error);
                toast.success("Coding saved");
                setOpen(false);
                onSaved(result.data.updated_at);
              } catch (error) {
                toast.error(
                  error instanceof Error
                    ? error.message
                    : "Could not save coding",
                );
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "Saving…" : "Save coding"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
