"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createTradeJobAction } from "@/app/(app)/trade/actions";
import type { TradeWorkspace } from "@/lib/services/trade-workspace";
import {
  isTradeBillingBasis,
  tradeJobBillingDefaults,
} from "@/lib/trade/workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

export function NewTradeJob({
  contacts,
  contactsTotal,
  defaultJobType = "residential",
}: Pick<TradeWorkspace, "contacts" | "contactsTotal"> & {
  defaultJobType?: "residential" | "commercial";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [customerKind, setCustomerKind] = useState<"company" | "homeowner">(
    "homeowner",
  );
  const [billing, setBilling] = useState(() =>
    tradeJobBillingDefaults("homeowner"),
  );
  const [reviewBeforeSend, setReviewBeforeSend] = useState(false);
  const chooseCustomer = (kind: "company" | "homeowner") => {
    setCustomerKind(kind);
    setBilling(tradeJobBillingDefaults(kind));
  };
  const customerNoun = customerKind === "company" ? "builder" : "customer";
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        New job
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          aria-labelledby="trade-new-job-title"
          className="overflow-y-auto p-6 sm:max-w-lg"
          mobileFullscreen
        >
          <SheetHeader>
            <SheetTitle id="trade-new-job-title">New job</SheetTitle>
            <SheetDescription>
              Manage your scope, crew, and billing for any customer.
            </SheetDescription>
          </SheetHeader>
          <form
            className="mt-6 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              setError(null);
              startTransition(async () => {
                const result = await createTradeJobAction({
                  name: data.get("name"),
                  client_id: data.get("client_id") || undefined,
                  address: data.get("address"),
                  description: data.get("description"),
                  property_type: data.get("property_type"),
                  customer_kind: customerKind,
                  billing_basis: billing.billing_basis,
                  retainage_percent: billing.retainage_percent,
                  payment_terms_days: billing.payment_terms_days,
                  review_before_send: reviewBeforeSend,
                  customer_certifies: billing.customer_certifies,
                  total_contract_value_cents: data.get("value")
                    ? Math.round(Number(data.get("value")) * 100)
                    : undefined,
                  start_date: data.get("start_date") || undefined,
                  end_date: data.get("end_date") || undefined,
                });
                if (!result.success) {
                  setError(result.error);
                  return;
                }
                setOpen(false);
                router.push(`/projects/${result.data.id}`);
                router.refresh();
              });
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="trade-job-name">Job name</Label>
              <Input
                id="trade-job-name"
                name="name"
                required
                maxLength={200}
                placeholder="Oak Street — electrical installation"
              />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Who pays you</legend>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["company", "A builder or GC"],
                    ["homeowner", "The homeowner"],
                  ] as const
                ).map(([kind, label]) => (
                  <Button
                    key={kind}
                    type="button"
                    variant={customerKind === kind ? "default" : "outline"}
                    aria-pressed={customerKind === kind}
                    onClick={() => chooseCustomer(kind)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </fieldset>
            <div className="space-y-2">
              <Label htmlFor="trade-job-client">Customer contact</Label>
              <select
                id="trade-job-client"
                name="client_id"
                className="h-10 w-full border border-input bg-background px-3 text-sm"
              >
                <option value="">Add later</option>
                {contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.full_name}
                    {contact.email ? ` · ${contact.email}` : ""}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                <Link href="/directory?kind=contact" className="underline">
                  Add a customer in Directory
                </Link>
                . You can assign them later in job settings.
              </p>
              {contactsTotal > contacts.length && (
                <p className="text-xs text-warning">
                  Showing the first {contacts.length} contacts. Use job settings
                  to choose another customer.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="trade-job-address">Job address</Label>
              <Input id="trade-job-address" name="address" maxLength={500} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="trade-job-scope">Your scope</Label>
              <Textarea
                id="trade-job-scope"
                name="description"
                maxLength={4000}
                placeholder="Panel, rough-in, fixtures, testing…"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="trade-job-type">Job type</Label>
                <select
                  id="trade-job-type"
                  name="property_type"
                  defaultValue={defaultJobType}
                  className="h-10 w-full border border-input bg-background px-3 text-sm"
                >
                  <option value="residential">Residential</option>
                  <option value="commercial">Commercial</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="trade-job-billing">How you bill</Label>
                <select
                  id="trade-job-billing"
                  value={billing.billing_basis}
                  onChange={(e) => {
                    const basis = e.target.value;
                    if (!isTradeBillingBasis(basis)) return;
                    setBilling((current) => ({
                      ...current,
                      billing_basis: basis,
                    }));
                  }}
                  className="h-10 w-full border border-input bg-background px-3 text-sm"
                >
                  <option value="progress">Pay applications (SOV)</option>
                  <option value="invoices">Fixed price invoices</option>
                  <option value="time_and_materials">Time & materials</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="trade-job-retainage">
                  Retainage the {customerNoun} holds (%)
                </Label>
                <Input
                  id="trade-job-retainage"
                  type="number"
                  min="0"
                  max="50"
                  step="0.5"
                  value={billing.retainage_percent}
                  onChange={(e) =>
                    setBilling((current) => ({
                      ...current,
                      retainage_percent: Number(e.target.value) || 0,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="trade-job-terms">Payment terms</Label>
                <select
                  id="trade-job-terms"
                  value={billing.payment_terms_days}
                  onChange={(e) =>
                    setBilling((current) => ({
                      ...current,
                      payment_terms_days: Number(e.target.value),
                    }))
                  }
                  className="h-10 w-full border border-input bg-background px-3 text-sm"
                >
                  <option value={0}>Due on receipt</option>
                  <option value={15}>Net 15</option>
                  <option value={30}>Net 30</option>
                  <option value={45}>Net 45</option>
                  <option value={60}>Net 60</option>
                </select>
              </div>
            </div>
            {billing.billing_basis === "progress" && (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={billing.customer_certifies}
                  onCheckedChange={(checked) =>
                    setBilling((current) => ({
                      ...current,
                      customer_certifies: checked === true,
                    }))
                  }
                />
                <span>
                  The {customerNoun} certifies each pay application before it
                  is invoiced
                </span>
              </label>
            )}
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={reviewBeforeSend}
                onCheckedChange={(checked) =>
                  setReviewBeforeSend(checked === true)
                }
              />
              <span>Approve each invoice in the office before it goes out</span>
            </label>
            <div className="space-y-2">
              <Label htmlFor="trade-job-value">
                Contract amount ($, optional)
              </Label>
              <Input
                id="trade-job-value"
                name="value"
                type="number"
                min="0"
                max="21474836.47"
                step="0.01"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="trade-job-start">Start</Label>
                <Input id="trade-job-start" name="start_date" type="date" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="trade-job-end">Finish</Label>
                <Input id="trade-job-end" name="end_date" type="date" />
              </div>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create job"}
            </Button>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
