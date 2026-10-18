"use client";

import type { EstimateCommercial } from "@/lib/financials/estimate-commercial";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function EstimateCommercialFields({
  value,
  onChange,
  pricingOnly = false,
  purposeLocked = false,
}: {
  pricingOnly?: boolean;
  purposeLocked?: boolean;
  value: EstimateCommercial;
  onChange: (value: EstimateCommercial) => void;
}) {
  function field<K extends keyof EstimateCommercial>(
    key: K,
    next: EstimateCommercial[K],
  ) {
    onChange({ ...value, [key]: next });
  }
  return (
    <div className="space-y-4 border-b pb-5">
      <div className={pricingOnly ? "grid gap-4" : "grid gap-4 sm:grid-cols-2"}>
        {!pricingOnly && !purposeLocked && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="estimate-purpose">Client decision</Label>
              <Select
                value={value.purpose}
                onValueChange={(v) =>
                  field("purpose", v as EstimateCommercial["purpose"])
                }
              >
                <SelectTrigger id="estimate-purpose">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="budget">
                    Approve proposal scope and budget
                  </SelectItem>
                  <SelectItem value="preconstruction_agreement">
                    Sign a preconstruction services agreement
                  </SelectItem>
                  <SelectItem value="construction_agreement">
                    Sign a construction agreement
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="estimate-maturity">Scope maturity</Label>
          <Select
            value={value.maturity}
            onValueChange={(v) =>
              field("maturity", v as EstimateCommercial["maturity"])
            }
          >
            <SelectTrigger id="estimate-maturity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="conceptual">Preliminary budget</SelectItem>
              <SelectItem value="design_development">
                Design development
              </SelectItem>
              <SelectItem value="construction_ready">
                Construction ready
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {!pricingOnly && (
        <p className="text-xs text-muted-foreground">
          {value.purpose === "budget"
            ? "Approval aligns the proposal scope and budget. It does not sign a contract or authorize construction. Prepare a separate agreement from the approved proposal when scope and terms are ready."
            : value.purpose === "preconstruction_agreement"
              ? "The client signs the defined preconstruction services and fee. Construction remains subject to a separate agreement."
              : "The client signs this version and its terms. Complete the commercial basis before sending."}
        </p>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="estimate-basis">
          Pricing basis and unresolved assumptions
        </Label>
        <Textarea
          id="estimate-basis"
          value={value.pricing_basis}
          onChange={(e) => field("pricing_basis", e.target.value)}
          placeholder="Drawing set and revisions, site investigation, quote dates, unresolved design decisions…"
          rows={3}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="estimate-billing">Commercial model</Label>
        <Select
          value={value.billing_model}
          onValueChange={(v) =>
            field("billing_model", v as EstimateCommercial["billing_model"])
          }
        >
          <SelectTrigger id="estimate-billing">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fixed_price">Fixed price</SelectItem>
            <SelectItem value="cost_plus_percent">
              Cost plus percentage
            </SelectItem>
            <SelectItem value="cost_plus_fixed_fee">
              Cost plus fixed fee
            </SelectItem>
            <SelectItem value="cost_plus_gmp">Cost plus with GMP</SelectItem>
            <SelectItem value="time_and_materials">
              Time and materials
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className={pricingOnly ? "grid gap-4" : "grid gap-4 sm:grid-cols-2"}>
        {value.billing_model === "cost_plus_fixed_fee" && (
          <div className="space-y-1.5">
            <Label htmlFor="estimate-fee">Fixed builder fee ($)</Label>
            <Input
              id="estimate-fee"
              type="number"
              min="0"
              step="0.01"
              value={value.fixed_fee_cents / 100}
              onChange={(e) =>
                field(
                  "fixed_fee_cents",
                  Math.round(Number(e.target.value) * 100),
                )
              }
            />
          </div>
        )}
        {value.billing_model === "cost_plus_gmp" && (
          <div className="space-y-1.5">
            <Label htmlFor="estimate-gmp">Guaranteed maximum price ($)</Label>
            <Input
              id="estimate-gmp"
              type="number"
              min="0"
              step="0.01"
              value={value.gmp_cents / 100}
              onChange={(e) =>
                field("gmp_cents", Math.round(Number(e.target.value) * 100))
              }
            />
          </div>
        )}
        {!pricingOnly && (
          <div className="space-y-1.5">
            <Label htmlFor="estimate-retainage">Retainage (%)</Label>
            <Input
              id="estimate-retainage"
              type="number"
              min="0"
              max="100"
              value={value.retainage_percent}
              onChange={(e) =>
                field("retainage_percent", Number(e.target.value))
              }
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="estimate-contingency-treatment">
            Contingency ownership
          </Label>
          <Select
            value={value.contingency_treatment}
            onValueChange={(v) =>
              field(
                "contingency_treatment",
                v as EstimateCommercial["contingency_treatment"],
              )
            }
          >
            <SelectTrigger id="estimate-contingency-treatment">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="included_in_price">
                Included in price
              </SelectItem>
              <SelectItem value="builder_reserve">
                Builder risk reserve
              </SelectItem>
              <SelectItem value="owner_reserve">
                Owner-controlled reserve
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {!pricingOnly && (
        <div className="space-y-1.5">
          <Label htmlFor="estimate-payment-terms">Payment terms</Label>
          <Textarea
            id="estimate-payment-terms"
            value={value.payment_terms}
            onChange={(e) => field("payment_terms", e.target.value)}
            placeholder="Deposit, progress billing basis and frequency, due dates, retainage release; fee/rate basis for reimbursable work…"
            rows={3}
          />
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="estimate-allowance-policy">
          Allowance inclusions and reconciliation
        </Label>
        <Textarea
          id="estimate-allowance-policy"
          value={value.allowance_policy}
          onChange={(e) => field("allowance_policy", e.target.value)}
          placeholder="State whether allowances include labor, freight, tax and markup; who selects and by when; treatment of unused balance and overruns."
          rows={3}
        />
      </div>
    </div>
  );
}
