"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createTradeJobAction } from "@/app/(app)/trade/actions";
import type { TradeWorkspace } from "@/lib/services/trade-workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
                  billing_model: data.get("billing_model"),
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
                <Label htmlFor="trade-job-type">Project type</Label>
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
                <Label htmlFor="trade-job-billing">Billing</Label>
                <select
                  id="trade-job-billing"
                  name="billing_model"
                  className="h-10 w-full border border-input bg-background px-3 text-sm"
                >
                  <option value="fixed_price">Fixed price</option>
                  <option value="time_and_materials">Time & materials</option>
                </select>
              </div>
            </div>
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
