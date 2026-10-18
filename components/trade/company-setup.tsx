"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { BusinessProfile } from "@/lib/business-profile";
import { saveTradeProfileAction } from "@/app/(app)/trade/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function TradeCompanySetup({ profile }: { profile: BusinessProfile }) {
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
