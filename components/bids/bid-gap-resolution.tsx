"use client";

import { useId } from "react";
import type { BidPricingGap } from "@/lib/bids/pricing";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { money } from "./bid-workbench-helpers";

const choices = [
  {
    value: "allowance",
    title: "Set aside a budget",
    description: "Carry an allowance until this work is priced.",
    owner: "Who will arrange this work?",
    placeholder: "Team or person responsible",
    cost: "Allowance to add",
  },
  {
    value: "self_perform",
    title: "Our team will do it",
    description: "Add your team's labor and material cost.",
    owner: "Team or person responsible",
    placeholder: "e.g. In-house crew",
    cost: "Estimated cost to add",
  },
  {
    value: "other_package",
    title: "Another trade will do it",
    description: "Assign it to another company or scope line.",
    owner: "Company or scope line",
    placeholder: "e.g. Sitework — excavation",
    cost: "Additional cost to carry here",
  },
  {
    value: "owner_exclusion",
    title: "Leave it to the client",
    description: "Exclude this work and its cost from your estimate.",
    owner: "Who will arrange this work?",
    placeholder: "e.g. Client or their contractor",
    cost: "",
  },
] as const;

export function BidGapResolution({
  gap,
  source,
  attempted,
  disabled,
  onChange,
}: {
  gap: BidPricingGap;
  source: string;
  attempted: boolean;
  disabled: boolean;
  onChange: (patch: Partial<BidPricingGap>) => void;
}) {
  const id = useId();
  const choice = choices.find((item) => item.value === gap.disposition);
  const needsChoice = gap.disposition === "unresolved";
  const needsOwner = !gap.owner.trim();
  const needsCost =
    !Number.isSafeInteger(gap.amount_cents) || gap.amount_cents < 0;
  const needsNote = gap.disposition === "owner_exclusion" && !gap.note.trim();
  const invalid = needsChoice || needsOwner || needsCost || needsNote;
  return (
    <section
      aria-label={gap.description}
      className={`space-y-4 border p-3 ${attempted && invalid ? "border-destructive" : "border-border"}`}
    >
      <div className="space-y-1">
        <p className="text-[11px] text-muted-foreground">{source}</p>
        <p className="whitespace-pre-wrap text-sm font-medium leading-relaxed">
          {gap.description}
        </p>
      </div>
      <div className="space-y-2">
        <p id={`${id}-decision`} className="text-xs font-medium">
          How will you handle this work?
        </p>
        <RadioGroup
          aria-labelledby={`${id}-decision`}
          aria-describedby={
            attempted && needsChoice ? `${id}-choice-error` : undefined
          }
          value={needsChoice ? "" : gap.disposition}
          disabled={disabled}
          className="gap-2"
          onValueChange={(value) =>
            onChange({
              disposition: value as BidPricingGap["disposition"],
              ...(value === "owner_exclusion"
                ? { amount_cents: 0 }
                : needsChoice && gap.amount_cents === 0
                  ? { amount_cents: NaN }
                  : {}),
            })
          }
        >
          {choices.map((item) => (
            <label
              key={item.value}
              className={`flex cursor-pointer items-start gap-2.5 border px-3 py-2.5 ${gap.disposition === item.value ? "border-primary bg-primary/5" : "border-border hover:bg-muted/30"} ${disabled ? "pointer-events-none opacity-50" : ""}`}
            >
              <RadioGroupItem
                value={item.value}
                className="mt-0.5"
                aria-invalid={attempted && needsChoice}
              />
              <span>
                <span className="block text-xs font-medium">{item.title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                  {item.description}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
        {attempted && needsChoice && (
          <p id={`${id}-choice-error`} className="text-xs text-destructive">
            Choose how this work will be handled.
          </p>
        )}
      </div>
      {choice && (
        <div className="space-y-4 border-t pt-4">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-owner`} className="text-xs">
              {choice.owner}
            </Label>
            <Input
              id={`${id}-owner`}
              disabled={disabled}
              value={gap.owner}
              placeholder={choice.placeholder}
              aria-invalid={attempted && needsOwner}
              aria-describedby={
                attempted && needsOwner ? `${id}-owner-error` : undefined
              }
              onChange={(event) => onChange({ owner: event.target.value })}
            />
            {attempted && needsOwner && (
              <p id={`${id}-owner-error`} className="text-xs text-destructive">
                Name the person, team, or company responsible.
              </p>
            )}
          </div>
          {gap.disposition !== "owner_exclusion" && (
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-cost`} className="text-xs">
                {choice.cost}
              </Label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  id={`${id}-cost`}
                  className="pl-7 tabular-nums"
                  disabled={disabled}
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={
                    Number.isFinite(gap.amount_cents)
                      ? gap.amount_cents / 100
                      : ""
                  }
                  aria-invalid={attempted && needsCost}
                  aria-describedby={`${id}-cost-help`}
                  onChange={(event) =>
                    onChange({
                      amount_cents:
                        event.target.value === ""
                          ? NaN
                          : Math.round(Number(event.target.value) * 100),
                    })
                  }
                />
              </div>
              <p
                id={`${id}-cost-help`}
                className={`text-xs ${attempted && needsCost ? "text-destructive" : "text-muted-foreground"}`}
              >
                {attempted && needsCost
                  ? "Enter a cost of zero or more."
                  : gap.disposition === "other_package"
                    ? "Already budgeted on another line? Enter $0 here to avoid counting it twice. This does not link or update that line."
                    : "This amount is added to the quote when you use it."}
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-note`} className="text-xs">
              {gap.disposition === "owner_exclusion"
                ? "What should the client know?"
                : "Note (optional)"}
            </Label>
            <Textarea
              id={`${id}-note`}
              disabled={disabled}
              rows={2}
              value={gap.note}
              placeholder={
                gap.disposition === "owner_exclusion"
                  ? "Describe what the client must arrange and pay for."
                  : "Add any assumptions or context."
              }
              aria-invalid={attempted && needsNote}
              aria-describedby={
                attempted && needsNote ? `${id}-note-error` : undefined
              }
              onChange={(event) => onChange({ note: event.target.value })}
            />
            {attempted && needsNote && (
              <p id={`${id}-note-error`} className="text-xs text-destructive">
                Explain what is excluded and left to the client.
              </p>
            )}
          </div>
          <p className="border-t pt-3 text-xs font-medium">
            {gap.disposition === "owner_exclusion"
              ? "Excluded from your carried cost. Review the client-facing estimate before sending."
              : !needsCost
                ? `${money(gap.amount_cents)} added to this quote's carried cost`
                : "Enter a cost to complete this decision."}
          </p>
        </div>
      )}
    </section>
  );
}
