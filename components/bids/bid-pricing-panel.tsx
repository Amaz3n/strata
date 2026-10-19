"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import type {
  BidPackage,
  BidScopeItem,
  BidSubmission,
} from "@/lib/services/bids";
import {
  bidEligibilityReason,
  calculatePricingBasis,
  type BidPricingGap,
} from "@/lib/bids/pricing";
import { selectBidForPricingAction } from "@/app/(app)/bids/actions";
import { unwrapAction } from "@/lib/action-result";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { BidGapResolution } from "./bid-gap-resolution";
import { money, type BidWorkbenchContext } from "./bid-workbench-helpers";

export function BidPricingPanel({
  bidPackage,
  submission,
  scopeItems,
  context,
  onSelect,
  actionLabel,
  defaultAlternateIds = [],
  disabled = false,
}: {
  bidPackage: BidPackage;
  submission: BidSubmission;
  scopeItems: BidScopeItem[];
  context: BidWorkbenchContext;
  onSelect?: (input: {
    bid_submission_id: string;
    accepted_alternate_ids: string[];
    gaps: BidPricingGap[];
    rationale: string;
  }) => Promise<void>;
  actionLabel?: string;
  /** Alternates to start ticked when no decision exists yet (the leveling grid's choice). */
  defaultAlternateIds?: string[];
  disabled?: boolean;
}) {
  const [rationale, setRationale] = useState(
    submission.pricing_decision?.rationale ?? "",
  );
  const [alternates, setAlternates] = useState<string[]>(
    submission.pricing_decision?.accepted_alternate_ids ?? defaultAlternateIds,
  );
  const [selected, setSelected] = useState(!!submission.pricing_decision);
  const [pending, startTransition] = useTransition();
  const [attempted, setAttempted] = useState(false);
  const [sections, setSections] = useState<string[]>([]);
  const coverageRef = useRef<HTMLDivElement>(null);
  const [gaps, setGaps] = useState<BidPricingGap[]>(() => {
    if (submission.pricing_decision) return submission.pricing_decision.gaps;
    const rows = scopeItems.filter(
      (scope) =>
        scope.item_type !== "alternate" &&
        submission.items?.find((i) => i.bid_scope_item_id === scope.id)
          ?.response !== "priced",
    );
    const result: BidPricingGap[] = rows.map((scope) => ({
      scope_item_id: scope.id,
      description: scope.description,
      amount_cents:
        submission.items?.find((i) => i.bid_scope_item_id === scope.id)
          ?.gc_plug_cents ?? 0,
      disposition: "unresolved",
      owner: "",
      note: "",
    }));
    if (submission.exclusions)
      result.push({
        scope_item_id: "quote-exclusions",
        description: submission.exclusions,
        amount_cents: 0,
        disposition: "unresolved",
        owner: "",
        note: "",
      });
    return result;
  });
  const eligibility =
    bidPackage.pricing_available === false
      ? "Pricing decisions will be available after the preconstruction database update."
      : bidPackage.status === "draft"
        ? "Issue this scope revision before selecting pricing."
        : bidEligibilityReason(submission, bidPackage.scope_revision);
  const patchGap = (index: number, patch: Partial<BidPricingGap>) =>
    setGaps((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  const invalidGap = (gap: BidPricingGap) =>
    gap.disposition === "unresolved" ||
    !gap.owner.trim() ||
    !Number.isSafeInteger(gap.amount_cents) ||
    gap.amount_cents < 0 ||
    (gap.disposition === "owner_exclusion" && !gap.note.trim());
  const outstanding = gaps.filter(invalidGap).length;
  let basis: ReturnType<typeof calculatePricingBasis> | null = null;
  let unresolved: string | null = null;
  try {
    basis = calculatePricingBasis(submission, scopeItems, alternates, gaps);
  } catch (error) {
    unresolved =
      error instanceof Error ? error.message : "Resolve uncovered work";
  }
  const pricedAlternates = scopeItems.filter(
    (scope) =>
      scope.item_type === "alternate" &&
      submission.items?.some(
        (item) =>
          item.bid_scope_item_id === scope.id && item.response === "priced",
      ),
  );

  function useQuote() {
    setAttempted(true);
    if (unresolved) {
      setSections((current) => [
        ...new Set([...current, gaps.length ? "coverage" : "alternates"]),
      ]);
      coverageRef.current?.scrollIntoView({ block: "nearest" });
      coverageRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      return;
    }
    if (!onSelect && !rationale.trim()) {
      setSections((current) => [...new Set([...current, "notes"])]);
      return;
    }
    startTransition(async () => {
      try {
        const input = {
          bid_submission_id: submission.id,
          accepted_alternate_ids: alternates,
          gaps,
          rationale:
            rationale.trim() || "Selected as the working estimate cost.",
        };
        if (onSelect) await onSelect(input);
        else
          unwrapAction(
            await selectBidForPricingAction(
              { ...context, bidPackageId: bidPackage.id },
              input,
            ),
          );
        setSelected(true);
        toast.success(
          onSelect
            ? "Quote applied to the worksheet"
            : "Pricing basis saved for the estimate",
        );
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Unable to select quote",
        );
      }
    });
  }
  return (
    <div className="border-t">
      <fieldset disabled={disabled || pending} className="min-w-0">
        <Accordion
          type="multiple"
          value={sections}
          onValueChange={setSections}
          className="px-4"
        >
          {gaps.length > 0 && (
            <AccordionItem
              value="coverage"
              ref={coverageRef}
              className={`my-3 border px-3 ${attempted && unresolved ? "border-destructive" : "border-border"}`}
            >
              <AccordionTrigger className="rounded-none py-3 text-xs hover:no-underline">
                <span>
                  Uncovered work{" "}
                  <span
                    className={
                      attempted && outstanding
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }
                  >
                    · {outstanding ? `${outstanding} to resolve` : "Resolved"}
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent className="space-y-4 pb-3">
                {gaps.map((gap, index) => (
                  <BidGapResolution
                    key={gap.scope_item_id}
                    gap={gap}
                    source={
                      gap.scope_item_id === "quote-exclusions"
                        ? "Bidder's exclusions"
                        : submission.items?.find(
                              (item) =>
                                item.bid_scope_item_id === gap.scope_item_id,
                            )?.response === "excluded"
                          ? "Excluded scope"
                          : "Scope without a price"
                    }
                    attempted={attempted}
                    disabled={disabled || pending}
                    onChange={(patch) => patchGap(index, patch)}
                  />
                ))}
              </AccordionContent>
            </AccordionItem>
          )}
          {pricedAlternates.length > 0 && (
            <AccordionItem value="alternates">
              <AccordionTrigger className="text-xs">
                Alternates · {alternates.length} selected
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                {pricedAlternates.map((scope) => (
                  <label
                    key={scope.id}
                    className="flex items-center gap-2 text-xs"
                  >
                    <Checkbox
                      disabled={disabled || pending}
                      checked={alternates.includes(scope.id)}
                      onCheckedChange={(checked) =>
                        setAlternates((ids) =>
                          checked
                            ? [...ids, scope.id]
                            : ids.filter((id) => id !== scope.id),
                        )
                      }
                    />
                    {scope.description}
                    <span className="ml-auto tabular-nums">
                      {money(
                        submission.items?.find(
                          (item) => item.bid_scope_item_id === scope.id,
                        )?.amount_cents,
                      )}
                    </span>
                  </label>
                ))}
              </AccordionContent>
            </AccordionItem>
          )}
          <AccordionItem value="notes">
            <AccordionTrigger className="text-xs">
              Decision note{onSelect ? " (optional)" : ""}
            </AccordionTrigger>
            <AccordionContent>
              <Textarea
                aria-label="Decision note"
                value={rationale}
                aria-invalid={attempted && !onSelect && !rationale.trim()}
                onChange={(event) => setRationale(event.target.value)}
                placeholder="Why this quote?"
                rows={2}
              />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        <div className="space-y-3 border-t p-4">
          {basis && (
            <div className="flex items-baseline justify-between text-sm">
              <span>Cost to carry</span>
              <span className="font-medium tabular-nums">
                {money(basis.normalized_total_cents)}
              </span>
            </div>
          )}
          {eligibility ? (
            <p className="text-xs text-warning">{eligibility}</p>
          ) : attempted && unresolved ? (
            <p role="alert" className="text-xs text-destructive">
              {unresolved}
            </p>
          ) : null}
          <Button
            className="w-full"
            disabled={disabled || pending || !!eligibility}
            onClick={useQuote}
          >
            {pending
              ? "Saving…"
              : (actionLabel ??
                (selected ? "Update pricing basis" : "Use quote"))}
          </Button>
        </div>
      </fieldset>
    </div>
  );
}
