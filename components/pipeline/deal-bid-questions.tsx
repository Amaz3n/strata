"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { DealBidRequest } from "@/lib/services/precon-deals";
import { useDealRoom } from "./deal-room";
import type { BidActions } from "./use-bid-actions";

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");

/** Questions bidders asked on their bid page. One answer goes to every bidder, so they all price the same thing. */
export function DealBidQuestions({ request, actions }: { request: DealBidRequest; actions: BidActions }) {
  const room = useDealRoom();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const companies = new Map(request.invites.map((invite) => [invite.company_id, invite.company?.name ?? null]));
  if (!request.questions.length)
    return (
      <div className="grid justify-items-center gap-1 border border-dashed px-6 py-10 text-center">
        <p className="text-sm font-medium">No questions</p>
        <p className="max-w-sm text-xs text-muted-foreground">Questions bidders ask on their bid page land here. Your answer goes to every bidder as an addendum.</p>
      </div>
    );
  const questions = [...request.questions].sort((a, b) => Number(a.answers.length > 0) - Number(b.answers.length > 0));
  return (
    <ul className="grid max-w-3xl gap-3">
      {questions.map(({ rfi, answers }) => {
        const draft = drafts[rfi.id] ?? "";
        const from = (rfi.submitted_by_company_id && companies.get(rfi.submitted_by_company_id)) || "A bidder";
        return (
          <li key={rfi.id} className="grid gap-2 border bg-background p-4">
            <span className="text-xs text-muted-foreground">
              {from} · {when(rfi.submitted_at ?? rfi.created_at)}
            </span>
            <p className="text-[13px] font-medium">{rfi.question || rfi.subject}</p>
            {answers.length ? (
              answers.map((answer) => (
                <p key={answer.id} className="whitespace-pre-wrap bg-success/5 px-3 py-2 text-[13px]">
                  {answer.body}
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    {answer.responder_name ?? "You"} · {when(answer.created_at)}
                  </span>
                </p>
              ))
            ) : room.editable ? (
              <form
                className="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!draft.trim()) return;
                  actions.answer(request.pkg.id, rfi.id, draft.trim());
                  setDrafts((current) => ({ ...current, [rfi.id]: "" }));
                }}
              >
                <Textarea
                  aria-label={`Answer to ${from}`}
                  value={draft}
                  onChange={(event) => setDrafts((current) => ({ ...current, [rfi.id]: event.target.value }))}
                  placeholder="Answer once. Every bidder gets it."
                  className="min-h-16 text-[13px]"
                />
                <Button size="sm" className="justify-self-start" disabled={actions.pending || !draft.trim()}>
                  Answer all {request.invites.length} bidders
                </Button>
              </form>
            ) : (
              <p className="text-xs text-muted-foreground">Not answered yet.</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
