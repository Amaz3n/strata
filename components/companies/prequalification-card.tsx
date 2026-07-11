"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  requestPrequalificationAction,
  reviewPrequalificationAction,
} from "@/app/(app)/companies/actions";
import { unwrapAction } from "@/lib/action-result";
import type { Prequalification } from "@/lib/services/prequalification";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

const money = (cents: number | null) =>
  cents == null
    ? "—"
    : (cents / 100).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      });

export function PrequalificationCard({
  companyId,
  prequalification,
  canEdit,
}: {
  companyId: string;
  prequalification: Prequalification | null;
  canEdit: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [singleLimit, setSingleLimit] = useState("");
  const [aggregateLimit, setAggregateLimit] = useState("");
  const [notes, setNotes] = useState("");
  const router = useRouter();
  const { toast } = useToast();
  const request = () =>
    startTransition(async () => {
      try {
        unwrapAction(await requestPrequalificationAction(companyId));
        toast({ title: "Prequalification requested" });
        router.refresh();
      } catch (error) {
        toast({
          title: "Unable to request prequalification",
          description: (error as Error).message,
        });
      }
    });
  const review = (decision: "approved" | "approved_with_limits" | "declined") =>
    startTransition(async () => {
      if (!prequalification) return;
      try {
        unwrapAction(
          await reviewPrequalificationAction(companyId, prequalification.id, {
            decision,
            single_project_limit_cents: singleLimit
              ? Math.round(Number(singleLimit.replaceAll(",", "")) * 100)
              : null,
            aggregate_limit_cents: aggregateLimit
              ? Math.round(Number(aggregateLimit.replaceAll(",", "")) * 100)
              : null,
            review_notes: notes || null,
          }),
        );
        toast({
          title:
            decision === "declined"
              ? "Prequalification declined"
              : "Prequalification approved",
        });
        router.refresh();
      } catch (error) {
        toast({
          title: "Unable to review prequalification",
          description: (error as Error).message,
        });
      }
    });
  return (
    <div className="space-y-4 border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Prequalification</h3>
          <p className="text-xs text-muted-foreground">
            Capacity, safety, bonding, and annual review.
          </p>
        </div>
        <span className="text-xs font-medium capitalize">
          {prequalification?.status.replaceAll("_", " ") ?? "Not requested"}
        </span>
      </div>
      {prequalification ? (
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div className="text-muted-foreground">Expires</div>
          <div className="text-right">{prequalification.expires_at ?? "—"}</div>
          <div className="text-muted-foreground">Single project limit</div>
          <div className="text-right tabular-nums">
            {money(prequalification.single_project_limit_cents)}
          </div>
          <div className="text-muted-foreground">Aggregate limit</div>
          <div className="text-right tabular-nums">
            {money(prequalification.aggregate_limit_cents)}
          </div>
          <div className="text-muted-foreground">EMR</div>
          <div className="text-right">{prequalification.emr ?? "—"}</div>
        </div>
      ) : null}
      {prequalification && (Object.keys(prequalification.questionnaire ?? {}).length > 0 || (prequalification.references_data ?? []).length > 0 || (prequalification.trades ?? []).length > 0) ? (
        <div className="space-y-2 border-t pt-3 text-sm">
          <h4 className="font-medium">Submitted questionnaire</h4>
          {(prequalification.trades ?? []).length > 0 ? <div><span className="text-muted-foreground">Trades:</span> {prequalification.trades?.join(", ")}</div> : null}
          {Object.entries(prequalification.questionnaire ?? {}).map(([question, answer]) => (
            <div key={question} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
              <div className="text-muted-foreground">{question.replaceAll("_", " ")}</div>
              <div className="break-words text-right">{typeof answer === "string" || typeof answer === "number" || typeof answer === "boolean" ? String(answer) : JSON.stringify(answer)}</div>
            </div>
          ))}
          {(prequalification.references_data ?? []).map((reference, index) => (
            <div key={index} className="border p-2"><span className="text-muted-foreground">Reference {index + 1}:</span> {Object.entries(reference).map(([key, value]) => `${key.replaceAll("_", " ")}: ${String(value)}`).join(" · ")}</div>
          ))}
        </div>
      ) : null}
      {canEdit &&
      prequalification &&
      ["submitted", "under_review"].includes(prequalification.status) ? (
        <div className="space-y-3 border-t pt-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Single project limit ($)</Label>
              <Input
                value={singleLimit}
                onChange={(e) => setSingleLimit(e.target.value)}
              />
            </div>
            <div>
              <Label>Aggregate limit ($)</Label>
              <Input
                value={aggregateLimit}
                onChange={(e) => setAggregateLimit(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label>Review notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={pending}
              onClick={() => review("approved")}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || (!singleLimit && !aggregateLimit)}
              onClick={() => review("approved_with_limits")}
            >
              Approve with limits
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() => review("declined")}
            >
              Decline
            </Button>
          </div>
        </div>
      ) : null}
      {canEdit &&
      (!prequalification ||
        ["declined", "expired", "approved", "approved_with_limits"].includes(
          prequalification.status,
        )) ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={request}
        >
          {prequalification ? "Request renewal" : "Request prequalification"}
        </Button>
      ) : null}
    </div>
  );
}
