"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { BusinessProfile } from "@/lib/business-profile";
import { saveTimePolicyAction, saveTradeProfileAction } from "@/app/(app)/trade/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { timePolicySchema, type TimePolicy } from "@/lib/time/policy";

function hoursText(value: number | null) {
  return value === null ? "" : String(value);
}

function parseHours(value: string) {
  return value.trim() === "" ? null : Number(value);
}

function PaySchedule({ initial }: { initial: TimePolicy }) {
  const router = useRouter();
  const [frequency, setFrequency] = useState(initial.pay_frequency);
  const [anchor, setAnchor] = useState(initial.pay_anchor_date);
  const [automatic, setAutomatic] = useState(initial.automatic_overtime);
  const [weekly, setWeekly] = useState(hoursText(initial.weekly_overtime_hours));
  const [daily, setDaily] = useState(hoursText(initial.daily_overtime_hours));
  const [doubleTime, setDoubleTime] = useState(
    hoursText(initial.daily_double_time_hours),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const weeklyHours = Number(weekly) || initial.weekly_overtime_hours;

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setMessage(null);
        const parsed = timePolicySchema.safeParse({
          pay_frequency: frequency,
          pay_anchor_date: anchor,
          automatic_overtime: automatic,
          weekly_overtime_hours: parseHours(weekly),
          daily_overtime_hours: parseHours(daily),
          daily_double_time_hours: parseHours(doubleTime),
        });
        if (!parsed.success) {
          const next: Record<string, string> = {};
          for (const issue of parsed.error.issues) {
            const key = String(issue.path[0] ?? "form");
            if (!next[key]) next[key] = issue.message;
          }
          setFieldErrors(next);
          return;
        }
        setFieldErrors({});
        startTransition(async () => {
          const result = await saveTimePolicyAction(parsed.data);
          if (!result.success) {
            setError(result.error);
            return;
          }
          setMessage("Pay schedule saved.");
          router.refresh();
        });
      }}
    >
      <div>
        <h2 className="text-sm font-semibold">Pay schedule and overtime</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Sets the pay periods on the crew timesheet and when hours count as
          overtime.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="pay-frequency">Paid</Label>
          <select
            id="pay-frequency"
            value={frequency}
            onChange={(e) =>
              setFrequency(e.target.value === "biweekly" ? "biweekly" : "weekly")
            }
            className="h-10 w-full border border-input bg-background px-3 text-sm"
          >
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every two weeks</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="pay-anchor">A pay period starts on</Label>
          <Input
            id="pay-anchor"
            type="date"
            value={anchor}
            onChange={(e) => setAnchor(e.target.value)}
            className="tabular-nums"
            aria-invalid={fieldErrors.pay_anchor_date ? true : undefined}
          />
          {fieldErrors.pay_anchor_date && (
            <p role="alert" className="text-xs text-destructive">
              {fieldErrors.pay_anchor_date}
            </p>
          )}
        </div>
      </div>
      <label className="flex items-center gap-3 text-sm">
        <Switch checked={automatic} onCheckedChange={setAutomatic} />
        <span>Calculate overtime automatically</span>
      </label>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="weekly-ot">Weekly overtime after (hrs)</Label>
          <Input
            id="weekly-ot"
            inputMode="decimal"
            value={weekly}
            disabled={!automatic}
            onChange={(e) => setWeekly(e.target.value.replace(/[^\d.]/g, ""))}
            className="tabular-nums"
            aria-invalid={fieldErrors.weekly_overtime_hours ? true : undefined}
          />
          {fieldErrors.weekly_overtime_hours && (
            <p role="alert" className="text-xs text-destructive">
              {fieldErrors.weekly_overtime_hours}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="daily-ot">Daily overtime after (hrs)</Label>
          <Input
            id="daily-ot"
            inputMode="decimal"
            value={daily}
            disabled={!automatic}
            placeholder="Optional"
            onChange={(e) => setDaily(e.target.value.replace(/[^\d.]/g, ""))}
            className="tabular-nums"
            aria-invalid={fieldErrors.daily_overtime_hours ? true : undefined}
          />
          {fieldErrors.daily_overtime_hours && (
            <p role="alert" className="text-xs text-destructive">
              {fieldErrors.daily_overtime_hours}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="daily-dt">Double time after (hrs)</Label>
          <Input
            id="daily-dt"
            inputMode="decimal"
            value={doubleTime}
            disabled={!automatic}
            placeholder="Optional"
            onChange={(e) => setDoubleTime(e.target.value.replace(/[^\d.]/g, ""))}
            className="tabular-nums"
            aria-invalid={fieldErrors.daily_double_time_hours ? true : undefined}
          />
          {fieldErrors.daily_double_time_hours && (
            <p role="alert" className="text-xs text-destructive">
              {fieldErrors.daily_double_time_hours}
            </p>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {automatic
          ? `Hours past ${weeklyHours} in a week are paid as overtime.`
          : "Overtime is not calculated; flag it by hand on each time entry."}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-success">
          {message}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save pay schedule"}
      </Button>
    </form>
  );
}

export function TradeCompanySetup({
  profile,
  timePolicy,
}: {
  profile: BusinessProfile;
  timePolicy: TimePolicy;
}) {
  const router = useRouter();
  const [kind, setKind] = useState(profile.kind);
  const [specialty, setSpecialty] = useState(profile.specialty);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="max-w-2xl space-y-10 desk-rise">
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setMessage(null);
          startTransition(async () => {
            const result = await saveTradeProfileAction({ kind, specialty });
            if (!result.success) {
              setError(result.error);
              return;
            }
            setMessage("Company workspace saved.");
            router.refresh();
          });
        }}
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Your company on Arc
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Arc Trade brings your jobs, crew, opportunities, and billing into
            one workspace.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="workspace-kind">Workspace</Label>
          <select
            id="workspace-kind"
            value={kind}
            onChange={(e) =>
              setKind(e.target.value === "trade" ? "trade" : "builder")
            }
            className="h-10 w-full border border-input bg-background px-3 text-sm"
          >
            <option value="trade">Arc Trade — specialty contractors</option>
            <option value="builder">Builder workspace</option>
          </select>
        </div>
        {kind === "trade" && (
          <div className="space-y-2">
            <Label htmlFor="trade-specialty">Your trade</Label>
            <Input
              id="trade-specialty"
              value={specialty}
              maxLength={80}
              required
              onChange={(e) => setSpecialty(e.target.value)}
              placeholder="Electrical"
            />
            <p className="text-xs text-muted-foreground">
              Your jobs can be residential or commercial, regardless of your
              trade.
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm text-success">
            {message}
          </p>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save workspace"}
        </Button>
      </form>
      <PaySchedule initial={timePolicy} />
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Get ready for your first job</h2>
        <div className="divide-y border-y">
          {[
            [
              "Company details & logo",
              "Set the identity customers see on your documents.",
              "/settings?tab=organization",
            ],
            [
              "Crew & permissions",
              "Invite your office team and field crew; set access and labor rates.",
              "/settings?tab=team",
            ],
            [
              "Invoice settings",
              "Set your remittance details, payment terms, and invoice note.",
              "/settings?tab=invoicing",
            ],
            [
              "Get paid online",
              "Connect your Stripe payout account so customers can pay invoices by card or bank transfer.",
              "/settings?tab=integrations",
            ],
            [
              "Customers & suppliers",
              "Keep the people and companies you work with in your directory.",
              "/directory",
            ],
            [
              "Builder connections",
              "Open the projects and bids builders have shared with you.",
              "/trade/connections",
            ],
          ].map(([title, description, href]) => (
            <Link
              key={href}
              href={href}
              className="block py-4 hover:bg-muted/40 focus-visible:outline focus-visible:outline-ring"
            >
              <span className="text-sm font-medium">{title} →</span>
              <p className="mt-1 text-xs text-muted-foreground">
                {description}
              </p>
            </Link>
          ))}
        </div>
        <Button asChild variant="outline">
          <Link href="/">Open your workspace</Link>
        </Button>
      </section>
    </div>
  );
}
