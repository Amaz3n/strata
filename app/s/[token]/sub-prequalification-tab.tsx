"use client";

import { useState, useTransition } from "react";

import type { Prequalification } from "@/lib/services/prequalification";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const cents = (value: string) =>
  value.trim() ? Math.round(Number(value.replaceAll(",", "")) * 100) : null;

export function SubPrequalificationTab({
  token,
  initial,
}: {
  token: string;
  initial: Prequalification | null;
}) {
  const [prequalification, setPrequalification] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    years: "",
    revenue: "",
    largest: "",
    emr: "",
    bondingSingle: "",
    bondingAggregate: "",
    trades: "",
    questionnaire: "",
  });
  if (!prequalification)
    return (
      <div className="border p-6 text-sm text-muted-foreground">
        No prequalification package has been requested.
      </div>
    );
  if (!["requested", "submitted"].includes(prequalification.status))
    return (
      <div className="space-y-2 border p-6">
        <div className="text-sm font-medium">
          Prequalification {prequalification.status.replaceAll("_", " ")}
        </div>
        <p className="text-sm text-muted-foreground">
          Submitted{" "}
          {prequalification.submitted_at
            ? new Date(prequalification.submitted_at).toLocaleDateString()
            : "for review"}
          .
        </p>
      </div>
    );

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const response = await fetch(`/api/portal/s/${token}/prequalification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          years_in_business: form.years ? Number(form.years) : null,
          annual_revenue_cents: cents(form.revenue),
          largest_project_cents: cents(form.largest),
          emr: form.emr ? Number(form.emr) : null,
          bonding_single_cents: cents(form.bondingSingle),
          bonding_aggregate_cents: cents(form.bondingAggregate),
          trades: form.trades
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          questionnaire: form.questionnaire.trim()
            ? { general: form.questionnaire.trim() }
            : {},
          references_data: [],
        }),
      });
      const body = await response.json();
      if (!response.ok) return setError(body.error ?? "Unable to submit");
      setPrequalification(body);
    });

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Prequalification package</h2>
        <p className="text-sm text-muted-foreground">
          Complete the company, safety, bonding, and capacity information below.
          Upload requested W-9, insurance, and financial documents under
          Compliance.
        </p>
      </div>
      <div className="grid gap-4 border p-4 sm:grid-cols-2">
        <div>
          <Label>Years in business</Label>
          <Input
            inputMode="numeric"
            value={form.years}
            onChange={(e) => setForm({ ...form, years: e.target.value })}
          />
        </div>
        <div>
          <Label>EMR</Label>
          <Input
            inputMode="decimal"
            value={form.emr}
            onChange={(e) => setForm({ ...form, emr: e.target.value })}
          />
        </div>
        <div>
          <Label>Annual revenue ($)</Label>
          <Input
            inputMode="decimal"
            value={form.revenue}
            onChange={(e) => setForm({ ...form, revenue: e.target.value })}
          />
        </div>
        <div>
          <Label>Largest project ($)</Label>
          <Input
            inputMode="decimal"
            value={form.largest}
            onChange={(e) => setForm({ ...form, largest: e.target.value })}
          />
        </div>
        <div>
          <Label>Single bond capacity ($)</Label>
          <Input
            inputMode="decimal"
            value={form.bondingSingle}
            onChange={(e) =>
              setForm({ ...form, bondingSingle: e.target.value })
            }
          />
        </div>
        <div>
          <Label>Aggregate bond capacity ($)</Label>
          <Input
            inputMode="decimal"
            value={form.bondingAggregate}
            onChange={(e) =>
              setForm({ ...form, bondingAggregate: e.target.value })
            }
          />
        </div>
        <div className="sm:col-span-2">
          <Label>CSI divisions / trades</Label>
          <Input
            value={form.trades}
            onChange={(e) => setForm({ ...form, trades: e.target.value })}
            placeholder="09 Finishes, 22 Plumbing"
          />
        </div>
        <div className="sm:col-span-2">
          <Label>Questionnaire notes</Label>
          <Textarea
            value={form.questionnaire}
            onChange={(e) =>
              setForm({ ...form, questionnaire: e.target.value })
            }
          />
        </div>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button onClick={submit} disabled={pending}>
        {pending ? "Submitting…" : "Submit for review"}
      </Button>
    </div>
  );
}
