"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
import { Textarea } from "@/components/ui/textarea";
import {
  getGreenfieldReadinessAction,
  launchGreenfieldBooksAction,
} from "@/app/(app)/books/actions";

const GREENFIELD_ATTESTATION =
  "I confirm Arc Books contains the complete opening position and will be the sole accounting ledger.";

type Readiness = Awaited<
  ReturnType<
    typeof import("@/lib/services/books/greenfield").getGreenfieldReadiness
  >
>;

export function GreenfieldLaunch() {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  useEffect(() => {
    startTransition(async () => {
      const result = await getGreenfieldReadinessAction();
      if (!result.success) setError(result.error);
      else setReadiness(result.data);
    });
  }, []);
  if (error)
    return (
      <section className="border border-destructive/30 bg-background p-5 text-sm text-destructive">
        {error}
      </section>
    );
  if (!readiness)
    return (
      <section className="border bg-background p-5 text-sm text-muted-foreground">
        Checking greenfield launch controls…
      </section>
    );
  if (readiness.existingLaunch) return null;
  return (
    <section className="border bg-background p-5">
      <p className="text-sm font-semibold">
        Starting with Arc—no prior accounting system
      </p>
      <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
        This path is only for a genuinely new set of books. If transactions or
        balances existed in another ledger, use parallel close and cutover
        instead.
      </p>
      {readiness.blockers.length ? (
        <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-destructive">
          {readiness.blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      ) : (
        <form
          className="mt-4 grid gap-3 lg:grid-cols-2"
          action={(formData) =>
            startTransition(async () => {
              const result = await launchGreenfieldBooksAction({
                launchedOn: String(formData.get("launchedOn")),
                openingPosition: String(formData.get("openingPosition")) as
                  | "zero"
                  | "posted_opening_balances",
                attestation: String(formData.get("attestation")),
              });
              if (!result.success) toast.error(result.error);
              else {
                toast.success("Arc Books is now the sole official ledger");
                router.refresh();
              }
            })
          }
        >
          <Input name="launchedOn" type="date" required />
          <Select
            name="openingPosition"
            required
            defaultValue={
              readiness.hasPostedOpeningBalances
                ? "posted_opening_balances"
                : "zero"
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zero">
                Brand-new entity · zero opening balances
              </SelectItem>
              <SelectItem value="posted_opening_balances">
                Use posted opening-balance batch
              </SelectItem>
            </SelectContent>
          </Select>
          <div className="lg:col-span-2">
            <p className="mb-2 font-mono text-[10px] text-muted-foreground">
              Type exactly: {GREENFIELD_ATTESTATION}
            </p>
            <Textarea name="attestation" required rows={3} />
          </div>
          <Button className="lg:col-span-2" disabled={pending}>
            {pending ? "Launching…" : "Make Arc Books the sole ledger"}
          </Button>
        </form>
      )}
    </section>
  );
}
