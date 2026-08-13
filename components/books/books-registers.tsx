"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

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
  createDebtInstrumentAction,
  createFixedAssetAction,
  disposeFixedAssetAction,
  loadBooksRegistersAction,
  postFixedAssetDepreciationAction,
  recordDebtEventAction,
} from "@/app/(app)/books/actions";

type Workspace = Awaited<
  ReturnType<typeof import("@/lib/services/books/registers").getBooksRegisters>
>;
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const cents = (value: FormDataEntryValue | null) =>
  Math.round(Number(value ?? 0) * 100);

function AccountSelect({
  name,
  accounts,
  subtypes,
  placeholder,
}: {
  name: string;
  accounts: Workspace["accounts"];
  subtypes: string[];
  placeholder: string;
}) {
  return (
    <Select name={name} required>
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {accounts
          .filter((account) => subtypes.includes(account.subtype))
          .map((account) => (
            <SelectItem key={account.id} value={account.id}>
              {account.code} · {account.name}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

export function BooksRegisters() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const load = () =>
    startTransition(async () => {
      const result = await loadBooksRegistersAction();
      if (!result.success) setError(result.error);
      else {
        setWorkspace(result.data);
        setError(null);
      }
    });
  useEffect(load, []);
  if (error)
    return (
      <section className="border bg-background p-5 text-sm text-destructive">
        {error}{" "}
        <Button size="sm" variant="outline" onClick={load}>
          Retry
        </Button>
      </section>
    );
  if (!workspace)
    return (
      <section className="border bg-background p-5 text-sm text-muted-foreground">
        Loading debt and asset registers…
      </section>
    );
  const accounts = workspace.accounts;
  return (
    <section className="border bg-background">
      <div className="border-b px-5 py-4">
        <p className="text-sm font-semibold">Debt & fixed-asset registers</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Every draw, payment, acquisition, and depreciation event posts an
          inseparable journal entry.
        </p>
      </div>
      <div className="grid divide-y xl:grid-cols-2 xl:divide-x xl:divide-y-0">
        <div>
          <div className="border-b px-5 py-3 text-xs font-semibold uppercase tracking-wide">
            Debt
          </div>
          <div className="divide-y">
            {workspace.debts.map((debt) => (
              <div key={debt.id} className="p-5">
                <div className="flex justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">{debt.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {debt.annual_interest_bps / 100}% ·{" "}
                      {debt.payment_frequency}
                    </p>
                  </div>
                  <p className="font-mono text-sm">
                    {money.format(debt.balanceCents / 100)}
                  </p>
                </div>
                <form
                  className="mt-4 grid gap-2 sm:grid-cols-3"
                  action={(formData) =>
                    startTransition(async () => {
                      const result = await recordDebtEventAction({
                        instrumentId: debt.id,
                        eventType: String(formData.get("eventType")) as
                          | "opening"
                          | "draw"
                          | "payment"
                          | "interest_accrual"
                          | "fee",
                        eventDate: String(formData.get("eventDate")),
                        principalCents: cents(formData.get("principal")),
                        interestCents: cents(formData.get("interest")),
                        feeCents: cents(formData.get("fee")),
                        memo: String(formData.get("memo")),
                      });
                      if (!result.success) toast.error(result.error);
                      else {
                        toast.success("Debt event posted");
                        load();
                      }
                    })
                  }
                >
                  <Select name="eventType" required defaultValue="payment">
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draw">Draw</SelectItem>
                      <SelectItem value="payment">Payment</SelectItem>
                      <SelectItem value="interest_accrual">
                        Interest accrual
                      </SelectItem>
                      <SelectItem value="fee">Fee paid</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input name="eventDate" type="date" required />
                  <Input
                    name="principal"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Principal"
                  />
                  <Input
                    name="interest"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Interest"
                  />
                  <Input
                    name="fee"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Fee"
                  />
                  <Input
                    name="memo"
                    required
                    minLength={4}
                    placeholder="Memo"
                  />
                  <Button disabled={pending} className="sm:col-span-3">
                    Post debt event
                  </Button>
                </form>
              </div>
            ))}
            {workspace.debts.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">
                No debt instruments registered.
              </p>
            ) : null}
          </div>
          <form
            className="grid gap-2 border-t bg-muted/20 p-5 sm:grid-cols-2"
            action={(formData) =>
              startTransition(async () => {
                const result = await createDebtInstrumentAction({
                  name: String(formData.get("name")),
                  openedOn: String(formData.get("openedOn")),
                  maturityOn: String(formData.get("maturityOn")) || null,
                  originalPrincipalCents: cents(
                    formData.get("originalPrincipal"),
                  ),
                  annualInterestBps: Math.round(
                    Number(formData.get("interestRate")) * 100,
                  ),
                  paymentFrequency: String(formData.get("frequency")),
                  liabilityAccountId: String(
                    formData.get("liabilityAccountId"),
                  ),
                  cashAccountId: String(formData.get("cashAccountId")),
                  interestExpenseAccountId: String(
                    formData.get("interestAccountId"),
                  ),
                });
                if (!result.success) toast.error(result.error);
                else {
                  toast.success("Debt instrument created");
                  load();
                }
              })
            }
          >
            <p className="text-xs font-semibold sm:col-span-2">
              Add debt instrument
            </p>
            <Input name="name" required placeholder="Loan or line name" />
            <Input name="openedOn" type="date" required />
            <Input name="maturityOn" type="date" />
            <Input
              name="originalPrincipal"
              type="number"
              min="0"
              step="0.01"
              placeholder="Original principal (reference)"
            />
            <Input
              name="interestRate"
              type="number"
              min="0"
              max="1000"
              step="0.01"
              placeholder="Annual interest %"
            />
            <Select name="frequency" required defaultValue="monthly">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  "weekly",
                  "biweekly",
                  "monthly",
                  "quarterly",
                  "annual",
                  "irregular",
                ].map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <AccountSelect
              name="liabilityAccountId"
              accounts={accounts}
              subtypes={["current_debt", "long_term_debt"]}
              placeholder="Debt GL"
            />
            <AccountSelect
              name="cashAccountId"
              accounts={accounts}
              subtypes={["cash", "undeposited_funds"]}
              placeholder="Cash GL"
            />
            <AccountSelect
              name="interestAccountId"
              accounts={accounts}
              subtypes={["interest"]}
              placeholder="Interest expense GL"
            />
            <Button disabled={pending}>Create instrument</Button>
          </form>
        </div>
        <div>
          <div className="border-b px-5 py-3 text-xs font-semibold uppercase tracking-wide">
            Fixed assets
          </div>
          <div className="divide-y">
            {workspace.assets.map((asset) => (
              <div key={asset.id} className="p-5">
                <div className="flex justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">
                      {asset.asset_number} · {asset.name}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Cost{" "}
                      {money.format(Number(asset.acquisition_cost_cents) / 100)}{" "}
                      · accumulated{" "}
                      {money.format(asset.depreciationCents / 100)}
                    </p>
                  </div>
                  <p className="font-mono text-sm">
                    {money.format(asset.bookValueCents / 100)}
                  </p>
                </div>
                {asset.status !== "disposed" ? (
                  <>
                    <form
                      className="mt-4 flex flex-wrap gap-2"
                      action={(formData) =>
                        startTransition(async () => {
                          const result = await postFixedAssetDepreciationAction(
                            {
                              assetId: asset.id,
                              throughDate: String(formData.get("throughDate")),
                              amountCents: formData.get("amount")
                                ? cents(formData.get("amount"))
                                : undefined,
                            },
                          );
                          if (!result.success) toast.error(result.error);
                          else {
                            toast.success(
                              `Depreciation posted: ${money.format(result.data.amountCents / 100)}`,
                            );
                            load();
                          }
                        })
                      }
                    >
                      <Input
                        className="w-40"
                        name="throughDate"
                        type="date"
                        required
                      />
                      <Input
                        className="w-40"
                        name="amount"
                        type="number"
                        min="0.01"
                        step="0.01"
                        placeholder="Default monthly"
                      />
                      <Button disabled={pending} variant="outline">
                        Post depreciation
                      </Button>
                    </form>
                    <form
                      className="mt-2 grid gap-2 sm:grid-cols-3"
                      action={(formData) =>
                        startTransition(async () => {
                          const result = await disposeFixedAssetAction({
                            assetId: asset.id,
                            disposedOn: String(formData.get("disposedOn")),
                            proceedsCents: cents(formData.get("proceeds")),
                            cashAccountId: String(
                              formData.get("cashAccountId"),
                            ),
                            gainAccountId: String(
                              formData.get("gainAccountId"),
                            ),
                            lossAccountId: String(
                              formData.get("lossAccountId"),
                            ),
                          });
                          if (!result.success) toast.error(result.error);
                          else {
                            toast.success("Asset disposal posted");
                            load();
                          }
                        })
                      }
                    >
                      <Input name="disposedOn" type="date" required />
                      <Input
                        name="proceeds"
                        type="number"
                        min="0"
                        step="0.01"
                        defaultValue="0"
                        placeholder="Disposal proceeds"
                      />
                      <AccountSelect
                        name="cashAccountId"
                        accounts={accounts}
                        subtypes={["cash", "undeposited_funds"]}
                        placeholder="Proceeds cash GL"
                      />
                      <AccountSelect
                        name="gainAccountId"
                        accounts={accounts}
                        subtypes={["other_revenue"]}
                        placeholder="Gain GL"
                      />
                      <AccountSelect
                        name="lossAccountId"
                        accounts={accounts}
                        subtypes={["other_expense"]}
                        placeholder="Loss GL"
                      />
                      <Button disabled={pending} variant="outline">
                        Dispose asset
                      </Button>
                    </form>
                  </>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">Disposed</p>
                )}
              </div>
            ))}
            {workspace.assets.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">
                No fixed assets registered.
              </p>
            ) : null}
          </div>
          <form
            className="grid gap-2 border-t bg-muted/20 p-5 sm:grid-cols-2"
            action={(formData) =>
              startTransition(async () => {
                const result = await createFixedAssetAction({
                  assetNumber: String(formData.get("assetNumber")),
                  name: String(formData.get("name")),
                  placedInServiceOn: String(formData.get("placedInServiceOn")),
                  acquisitionCostCents: cents(formData.get("cost")),
                  salvageValueCents: cents(formData.get("salvage")),
                  usefulLifeMonths: Number(formData.get("lifeMonths")),
                  assetAccountId: String(formData.get("assetAccountId")),
                  accumulatedDepreciationAccountId: String(
                    formData.get("accumulatedAccountId"),
                  ),
                  depreciationExpenseAccountId: String(
                    formData.get("expenseAccountId"),
                  ),
                  fundingAccountId: String(formData.get("fundingAccountId")),
                  postAcquisition: formData.get("postAcquisition") === "yes",
                });
                if (!result.success) toast.error(result.error);
                else {
                  toast.success("Fixed asset registered");
                  load();
                }
              })
            }
          >
            <p className="text-xs font-semibold sm:col-span-2">
              Register fixed asset
            </p>
            <Input name="assetNumber" required placeholder="Asset number" />
            <Input name="name" required placeholder="Asset name" />
            <Input name="placedInServiceOn" type="date" required />
            <Input
              name="cost"
              type="number"
              min="0.01"
              step="0.01"
              required
              placeholder="Acquisition cost"
            />
            <Input
              name="salvage"
              type="number"
              min="0"
              step="0.01"
              defaultValue="0"
              placeholder="Salvage value"
            />
            <Input
              name="lifeMonths"
              type="number"
              min="1"
              max="1200"
              required
              placeholder="Useful life (months)"
            />
            <AccountSelect
              name="assetAccountId"
              accounts={accounts}
              subtypes={["fixed_assets"]}
              placeholder="Fixed asset GL"
            />
            <AccountSelect
              name="accumulatedAccountId"
              accounts={accounts}
              subtypes={["accumulated_depreciation"]}
              placeholder="Accumulated depreciation GL"
            />
            <AccountSelect
              name="expenseAccountId"
              accounts={accounts}
              subtypes={["depreciation"]}
              placeholder="Depreciation expense GL"
            />
            <AccountSelect
              name="fundingAccountId"
              accounts={accounts}
              subtypes={[
                "cash",
                "accounts_payable",
                "current_debt",
                "long_term_debt",
                "owner_contributions",
                "other_liability",
              ]}
              placeholder="Funding / offset GL"
            />
            <Select name="postAcquisition" required defaultValue="yes">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="yes">Post acquisition now</SelectItem>
                <SelectItem value="no">Already in opening balances</SelectItem>
              </SelectContent>
            </Select>
            <Button disabled={pending}>Register asset</Button>
          </form>
        </div>
      </div>
    </section>
  );
}
