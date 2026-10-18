"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { saveDealNotesAction } from "@/app/(app)/pipeline/[dealId]/actions";

/**
 * Before there is a price there is a conversation. Write it the way the client
 * said it, one idea per line; Start pricing turns each line into work to price.
 */
export function DealNotes({
  dealId,
  notes,
  onNotesChange,
  editable,
  clientName,
}: {
  dealId: string;
  notes: string;
  onNotesChange: (notes: string) => void;
  editable: boolean;
  clientName: string;
}) {
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saved = useRef(notes);
  useEffect(() => {
    if (!editable || notes === saved.current) return;
    const timer = setTimeout(() => {
      setStatus("saving");
      void saveDealNotesAction(dealId, notes).then((result) => {
        if (result.success) {
          saved.current = notes;
          setStatus("saved");
        } else setStatus("error");
      });
    }, 1000);
    return () => clearTimeout(timer);
  }, [notes, dealId, editable]);
  const who = clientName.split(" ")[0] || "the client";
  return (
    <section aria-labelledby="deal-notes-label" className="max-w-3xl">
      <div className="flex items-baseline gap-3">
        <label id="deal-notes-label" htmlFor="deal-notes" className="text-base font-semibold">
          What are they building?
        </label>
        <span role="status" aria-live="polite" className="flex items-center gap-1 text-xs text-muted-foreground">
          {status === "saving" && (
            <>
              <Loader2 className="size-3 animate-spin" />
              Saving
            </>
          )}
          {status === "saved" && (
            <>
              <Check className="size-3" />
              Saved
            </>
          )}
          {status === "error" && <span className="text-destructive">Not saved. Keep typing to retry.</span>}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Write it the way {who} said it, one idea per line. Each line becomes a piece of work to price.
      </p>
      <Textarea
        id="deal-notes"
        className="mt-3 min-h-64 font-mono text-sm leading-6"
        disabled={!editable}
        placeholder={"Gut the upstairs bathroom\nNew tub and tile surround\nDouble vanity\nHeated floor"}
        value={notes}
        onChange={(event) => {
          setStatus("idle");
          onNotesChange(event.target.value);
        }}
      />
    </section>
  );
}
