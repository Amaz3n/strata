"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { loadDealActivityAction, logDealActivityAction } from "@/app/(app)/pipeline/[dealId]/actions";
import { unwrapAction } from "@/lib/action-result";
import type { ProspectActivity } from "@/lib/services/prospects";
import { DealActivityTimeline } from "./deal-activity-timeline";
import { cn } from "@/lib/utils";

const KINDS = [
  ["call", "Call"],
  ["visit", "Visit"],
  ["text", "Text"],
  ["email", "Email"],
  ["note", "Note"],
] as const;

/** Everything that happened on the deal, and a place to note a conversation. */
export function DealActivitySheet({
  open,
  onOpenChange,
  dealId,
  canLog,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dealId: string;
  canLog: boolean;
}) {
  const [activity, setActivity] = useState<ProspectActivity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<(typeof KINDS)[number][0]>("call");
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const load = () =>
    loadDealActivityAction(dealId).then((result) => {
      if (result.success) {
        setActivity(result.data);
        setError(null);
      } else setError(result.error ?? "Unable to load activity");
    });
  useEffect(() => {
    if (open) void load();
    // Reload each time the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dealId]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Activity</SheetTitle>
          <SheetDescription>Conversations you note here stay with the deal and follow it into the job.</SheetDescription>
        </SheetHeader>
        {canLog && (
          <form
            className="space-y-2 border-b px-4 pb-4"
            onSubmit={(event) => {
              event.preventDefault();
              startTransition(async () => {
                try {
                  unwrapAction(await logDealActivityAction(dealId, { kind, note }));
                  setNote("");
                  await load();
                } catch (cause) {
                  toast.error(cause instanceof Error ? cause.message : "Unable to save");
                }
              });
            }}
          >
            <div className="inline-flex border" role="group" aria-label="What happened">
              {KINDS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={kind === value}
                  onClick={() => setKind(value)}
                  className={cn(
                    "h-8 border-r px-3 text-xs transition-colors duration-150 last:border-r-0",
                    kind === value ? "bg-foreground text-background" : "bg-background hover:bg-muted",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <Textarea
              aria-label="What was said"
              rows={3}
              placeholder="What was said or decided?"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={pending || (kind === "note" && !note.trim())}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </form>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error ? (
            <p role="alert" className="text-sm text-destructive">{error}</p>
          ) : activity ? (
            <DealActivityTimeline activity={activity} />
          ) : (
            <div className="space-y-4" aria-busy="true">
              {[0, 1, 2].map((key) => (
                <Skeleton key={key} className="h-10 w-full" />
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
