"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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
  createTaxJurisdictionAction,
  loadTaxRegisterAction,
  recordTaxFilingAction,
  replaceCompanyTaxIdentityAction,
  storeCompanyTaxIdentityAction,
} from "@/app/(app)/books/actions";

type Register = Awaited<
  ReturnType<typeof import("@/lib/services/books/tax-register").getTaxRegister>
>;

export function TaxRegister() {
  const [register, setRegister] = useState<Register | null>(null);
  const [pending, startTransition] = useTransition();
  const identityForm = useRef<HTMLFormElement>(null);
  const replacementForm = useRef<HTMLFormElement>(null);
  const load = () =>
    startTransition(async () => {
      const result = await loadTaxRegisterAction();
      if (!result.success) toast.error(result.error);
      else setRegister(result.data);
    });
  useEffect(load, []);
  if (!register)
    return (
      <section className="border bg-background p-5 text-sm text-muted-foreground">
        Loading tax jurisdictions and filing register…
      </section>
    );
  return (
    <section className="border bg-background">
      <div className="border-b px-5 py-4">
        <p className="text-sm font-semibold">
          Tax jurisdictions & filing record
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Jurisdiction drives invoice tax coding. Filing confirmations preserve
          proof without treating Arc as tax counsel.
        </p>
      </div>
      <div className="grid divide-y xl:grid-cols-2 xl:divide-x xl:divide-y-0">
        <div className="p-5">
          <p className="text-xs font-semibold uppercase tracking-wide">
            Jurisdictions
          </p>
          <div className="my-4 divide-y border">
            {register.jurisdictions.map((item) => (
              <div
                key={item.id}
                className="flex justify-between px-3 py-2 text-xs"
              >
                <span>{item.name}</span>
                <span className="font-mono text-muted-foreground">
                  sales {(item.sales_tax_rate_micros / 10000).toFixed(3)}% · use{" "}
                  {(item.use_tax_rate_micros / 10000).toFixed(3)}%
                </span>
              </div>
            ))}
            {register.jurisdictions.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                No jurisdictions configured.
              </p>
            ) : null}
          </div>
          <form
            className="grid gap-2 sm:grid-cols-2"
            action={(formData) =>
              startTransition(async () => {
                const result = await createTaxJurisdictionAction({
                  name: String(formData.get("name")),
                  stateCode: String(formData.get("stateCode")) || null,
                  localCode: String(formData.get("localCode")) || null,
                  salesTaxPercent: Number(formData.get("salesRate")),
                  useTaxPercent: Number(formData.get("useRate")),
                  effectiveFrom: String(formData.get("effectiveFrom")),
                  filingFrequency: String(formData.get("frequency")),
                });
                if (!result.success) toast.error(result.error);
                else {
                  toast.success("Tax jurisdiction created");
                  load();
                }
              })
            }
          >
            <Input name="name" required placeholder="Jurisdiction name" />
            <Input name="stateCode" maxLength={2} placeholder="State code" />
            <Input name="localCode" placeholder="Local code" />
            <Input name="effectiveFrom" type="date" required />
            <Input
              name="salesRate"
              type="number"
              min="0"
              max="100"
              step="0.0001"
              required
              placeholder="Sales tax %"
            />
            <Input
              name="useRate"
              type="number"
              min="0"
              max="100"
              step="0.0001"
              required
              placeholder="Use tax %"
            />
            <Select name="frequency" required defaultValue="quarterly">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["monthly", "quarterly", "annual", "none"].map((value) => (
                  <SelectItem value={value} key={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button disabled={pending}>Add jurisdiction</Button>
          </form>
        </div>
        <div className="p-5">
          <p className="text-xs font-semibold uppercase tracking-wide">
            Filing evidence
          </p>
          <div className="my-4 divide-y border">
            {register.filings.map((item) => (
              <div
                key={item.id}
                className="flex justify-between px-3 py-2 text-xs"
              >
                <span>
                  {item.filing_type.replaceAll("_", " ")} · {item.period_end}
                </span>
                <span className="font-mono text-muted-foreground">
                  {item.status}
                  {item.confirmation_number
                    ? ` · ${item.confirmation_number}`
                    : ""}
                </span>
              </div>
            ))}
            {register.filings.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                No filing records.
              </p>
            ) : null}
          </div>
          <form
            className="grid gap-2 sm:grid-cols-2"
            action={(formData) =>
              startTransition(async () => {
                const result = await recordTaxFilingAction({
                  jurisdictionId:
                    String(formData.get("jurisdictionId")) === "none"
                      ? null
                      : String(formData.get("jurisdictionId")),
                  filingType: String(formData.get("filingType")),
                  periodStart: String(formData.get("periodStart")),
                  periodEnd: String(formData.get("periodEnd")),
                  dueOn: String(formData.get("dueOn")) || null,
                  status: String(formData.get("status")),
                  amountDueCents: formData.get("amountDue")
                    ? Math.round(Number(formData.get("amountDue")) * 100)
                    : null,
                  confirmationNumber:
                    String(formData.get("confirmation")) || null,
                });
                if (!result.success) toast.error(result.error);
                else {
                  toast.success("Filing record saved");
                  load();
                }
              })
            }
          >
            <Select name="filingType" required defaultValue="sales_use_tax">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  "sales_use_tax",
                  "form_1099",
                  "income_tax_package",
                  "payroll_tax",
                  "other",
                ].map((value) => (
                  <SelectItem key={value} value={value}>
                    {value.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select name="jurisdictionId" defaultValue="none">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No jurisdiction</SelectItem>
                {register.jurisdictions.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input name="periodStart" type="date" required />
            <Input name="periodEnd" type="date" required />
            <Input name="dueOn" type="date" />
            <Select name="status" required defaultValue="filed">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  "draft",
                  "ready",
                  "filed",
                  "accepted",
                  "rejected",
                  "amended",
                ].map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              name="amountDue"
              type="number"
              step="0.01"
              placeholder="Amount due"
            />
            <Input name="confirmation" placeholder="Confirmation number" />
            <Button className="sm:col-span-2" disabled={pending}>
              Record filing
            </Button>
          </form>
        </div>
      </div>
      <div className="border-t p-5">
        <p className="text-xs font-semibold uppercase tracking-wide">
          1099 vendor identity control
        </p>
        <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
          Complete taxpayer IDs are sent directly to encrypted Vault storage.
          Arc screens, reports, exports, and audit records retain only the last
          four digits and verification status.
        </p>
        <div className="my-4 divide-y border">
          {register.vendors.map((vendor) => (
            <div
              key={vendor.id}
              className="grid gap-1 px-3 py-2 text-xs sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-4"
            >
              <span className="font-medium">{vendor.name}</span>
              <span className="font-mono text-muted-foreground">
                {vendor.w9_file_id || vendor.w9_received_at
                  ? "W-9 on file"
                  : "W-9 missing"}
              </span>
              <span className="font-mono text-muted-foreground">
                {vendor.taxIdentity
                  ? `vaulted ••••${vendor.taxIdentity.tin_last4 ?? vendor.tax_id_last4 ?? "????"} · ${vendor.taxIdentity.verification_status}`
                  : vendor.tax_id_last4
                    ? `legacy ••••${vendor.tax_id_last4} · vault required`
                    : "tax identity missing"}
              </span>
            </div>
          ))}
          {register.vendors.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              No vendors are marked 1099 eligible.
            </p>
          ) : null}
        </div>
        {register.vendors.some((vendor) => !vendor.taxIdentity) ? (
          <form
            ref={identityForm}
            className="grid max-w-3xl gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
            action={(formData) =>
              startTransition(async () => {
                const result = await storeCompanyTaxIdentityAction({
                  companyId: String(formData.get("companyId")),
                  tin: String(formData.get("tin")),
                });
                identityForm.current?.reset();
                if (!result.success) toast.error(result.error);
                else {
                  toast.success("Taxpayer identity secured in Vault");
                  load();
                }
              })
            }
          >
            <Select name="companyId" required>
              <SelectTrigger>
                <SelectValue placeholder="Select 1099 vendor" />
              </SelectTrigger>
              <SelectContent>
                {register.vendors
                  .filter((vendor) => !vendor.taxIdentity)
                  .map((vendor) => (
                    <SelectItem key={vendor.id} value={vendor.id}>
                      {vendor.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Input
              name="tin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              pattern="[0-9 -]{9,11}"
              required
              placeholder="9-digit EIN or SSN"
              aria-label="Complete taxpayer ID"
            />
            <Button disabled={pending}>Secure identity</Button>
          </form>
        ) : null}
        {register.vendors.some((vendor) => vendor.taxIdentity) ? (
          <details className="mt-4 max-w-3xl border p-3 text-xs">
            <summary className="cursor-pointer font-medium">
              Replace an identity after a corrected W-9
            </summary>
            <p className="mt-2 text-muted-foreground">
              This rotates the encrypted Vault secret, resets verification to
              pending, and preserves an audit event. The prior complete ID is
              never returned to the application.
            </p>
            <form
              ref={replacementForm}
              className="mt-3 grid gap-2 sm:grid-cols-2"
              action={(formData) =>
                startTransition(async () => {
                  const result = await replaceCompanyTaxIdentityAction({
                    companyId: String(formData.get("companyId")),
                    tin: String(formData.get("tin")),
                    confirmation: String(formData.get("confirmation")),
                  });
                  replacementForm.current?.reset();
                  if (!result.success) toast.error(result.error);
                  else {
                    toast.success("Taxpayer identity rotated in Vault");
                    load();
                  }
                })
              }
            >
              <Select name="companyId" required>
                <SelectTrigger>
                  <SelectValue placeholder="Select vaulted vendor" />
                </SelectTrigger>
                <SelectContent>
                  {register.vendors
                    .filter((vendor) => vendor.taxIdentity)
                    .map((vendor) => (
                      <SelectItem key={vendor.id} value={vendor.id}>
                        {vendor.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Input
                name="tin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                pattern="[0-9 -]{9,11}"
                required
                placeholder="Corrected 9-digit EIN or SSN"
              />
              <Input
                name="confirmation"
                required
                pattern="REPLACE"
                autoComplete="off"
                placeholder="Type REPLACE"
              />
              <Button disabled={pending} variant="destructive">
                Rotate Vault identity
              </Button>
            </form>
          </details>
        ) : null}
      </div>
    </section>
  );
}
