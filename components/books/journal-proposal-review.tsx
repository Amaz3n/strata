"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listJournalProposalsAction } from "@/app/(app)/books/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  formatProposalCents,
  proposalReviewTotals,
  type JournalProposalCursor,
} from "@/lib/services/books/journal-proposal-review";
import type { listJournalProposals } from "@/lib/services/books/bookkeeping";

type ReviewPage = Awaited<ReturnType<typeof listJournalProposals>>;
import { executeJournalRecovery } from "@/lib/services/books/journal-recovery-client";

type ReviewIntent = {
  proposalId: string;
  decision: "approve" | "reject";
  note: string;
};

export function JournalProposalReview({
  onReviewed,
}: {
  onReviewed: () => void;
}) {
  const [page, setPage] = useState<ReviewPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const request = useRef(0);
  const load = useCallback(async (cursor?: JournalProposalCursor) => {
    const current = ++request.current;
    setLoading(true);
    setError(null);
    setPage(null);
    try {
      const result = await listJournalProposalsAction(cursor);
      if (current !== request.current) return;
      if (!result.success) {
        setError(result.error ?? "Journal approvals could not be loaded.");
        return;
      }
      setPage(result.data);
    } catch {
      if (current === request.current)
        setError("Journal approvals could not be loaded.");
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, []);
  const invalidate = useCallback(() => {
    request.current++;
  }, []);
  useEffect(() => {
    void load();
    return invalidate;
  }, [load, invalidate]);
  return (
    <section className="space-y-5" aria-label="Independent journal approvals">
      <p className="text-sm text-muted-foreground">
        Inspect the complete entry and its workflow allocations. Approval posts
        the adjustment and any scheduled reversal together.
      </p>
      {loading && (
        <p role="status" className="text-sm">
          Loading pending approvals…
        </p>
      )}
      {error && (
        <div role="alert" className="space-y-3">
          <p>{error}</p>
          <Button variant="outline" onClick={() => void load()}>
            Reload approvals
          </Button>
        </div>
      )}
      {page && (
        <>
          {!page.proposals.length && (
            <p className="py-8 text-sm text-muted-foreground">
              No pending approvals on this page.
            </p>
          )}
          {page.proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              page={page}
              onReviewed={() => {
                onReviewed();
                void load();
              }}
            />
          ))}
          <div className="flex items-center justify-between border-t pt-4">
            <Button
              variant="ghost"
              disabled={loading}
              onClick={() => void load()}
            >
              Newest pending entries
            </Button>
            {page.nextCursor && (
              <Button
                variant="outline"
                disabled={loading}
                onClick={() => void load(page.nextCursor!)}
              >
                Older pending entries
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function ProposalCard({
  proposal,
  page,
  onReviewed,
}: {
  proposal: ReviewPage["proposals"][number];
  page: ReviewPage;
  onReviewed: () => void;
}) {
  const [note, setNote] = useState("");
  const [intent, setIntent] = useState<ReviewIntent | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspected, setInspected] = useState(false);
  const inflight = useRef(false);
  const proposer = Array.isArray(proposal.proposer)
    ? proposal.proposer[0]
    : proposal.proposer;
  const own = proposal.proposed_by === page.currentUserId;
  const totals = proposalReviewTotals(proposal.lines);
  const submit = async (decision: ReviewIntent["decision"]) => {
    if (
      inflight.current ||
      own ||
      !inspected ||
      (decision === "approve" && !totals.balanced)
    )
      return;
    const submitted = intent ?? {
      proposalId: proposal.id,
      decision,
      note: note.trim(),
    };
    if (submitted.decision === "reject" && submitted.note.length < 4) {
      setError("Explain the rejection in at least four characters.");
      return;
    }
    inflight.current = true;
    setPending(true);
    setError(null);
    setIntent(submitted);
    try {
      await executeJournalRecovery(
        { orgId: page.orgId, actorId: page.currentUserId },
        {
          version: 1,
          kind: "review",
          request: {
            ...submitted,
            expectedOrgId: page.orgId,
            expectedActorId: page.currentUserId,
          },
        },
      );
      onReviewed();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Review result could not be confirmed. Retry the original review or reload approvals.",
      );
    } finally {
      inflight.current = false;
      setPending(false);
    }
  };
  return (
    <article
      className="overflow-hidden rounded-lg border"
      aria-label={`Review ${proposal.memo}`}
    >
      <header className="space-y-2 bg-muted/20 px-5 py-4">
        <h3 className="font-medium">{proposal.memo}</h3>
        <p className="text-xs text-muted-foreground">
          {proposal.entry_date} ·{" "}
          {proposer?.full_name ?? proposer?.email ?? proposal.proposed_by}
        </p>
        <p className="text-xs">
          {proposal.reversing_on
            ? `Automatic reversal on ${proposal.reversing_on}`
            : "No automatic reversal"}{" "}
          · Policy version {proposal.policy_version}
        </p>
        <p className="break-all font-mono text-[10px] text-muted-foreground">
          Proposal {proposal.id} · Submitted {proposal.proposed_at}
        </p>
      </header>
      <details
        onToggle={(event) => {
          if (event.currentTarget.open) setInspected(true);
        }}
      >
        <summary className="cursor-pointer px-5 py-4 text-sm font-medium">
          Inspect {proposal.lines.length} journal lines and allocations
        </summary>
        <div className="overflow-x-auto px-5 pb-5">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">
              Complete proposed journal lines
            </caption>
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="py-2">Account and allocation</th>
                <th className="py-2">Description and dimensions</th>
                <th className="py-2 text-right">Debit</th>
                <th className="py-2 text-right">Credit</th>
              </tr>
            </thead>
            <tbody>
              {[...proposal.lines]
                .sort((a, b) => a.line_no - b.line_no)
                .map((line, index) => {
                  const account = page.accounts.find(
                      (a) => a.id === line.account_id,
                    ),
                    project = page.projects.find(
                      (p) => p.id === line.project_id,
                    ),
                    company = page.companies.find(
                      (c) => c.id === line.company_id,
                    );
                  return (
                    <tr
                      key={`${line.line_no}:${index}`}
                      className="border-b align-top"
                    >
                      <td className="min-w-48 py-3 pr-4">
                        <p>
                          {account
                            ? `${account.code} · ${account.name}${account.active ? "" : " (inactive)"}`
                            : `Unresolved account ${line.account_id}`}
                        </p>
                        <p className="break-all font-mono text-[10px] text-muted-foreground">
                          {line.account_id}
                        </p>
                        {line.account_code && (
                          <p className="text-[10px] text-muted-foreground">
                            Submitted account code: {line.account_code}
                          </p>
                        )}
                        {line.project_id && (
                          <p className="mt-1">
                            Project: {project?.name ?? line.project_id}
                          </p>
                        )}
                        {line.company_id && (
                          <p>Company: {company?.name ?? line.company_id}</p>
                        )}
                      </td>
                      <td className="min-w-48 py-3 pr-4">
                        <p>{line.description || "No line description"}</p>
                        {line.dimensions &&
                          Object.keys(line.dimensions).length > 0 && (
                            <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground">
                              {JSON.stringify(line.dimensions, null, 2)}
                            </pre>
                          )}
                      </td>
                      <td className="whitespace-nowrap py-3 pl-3 text-right font-mono">
                        {formatProposalCents(line.debit_cents)}
                      </td>
                      <td className="whitespace-nowrap py-3 pl-3 text-right font-mono">
                        {formatProposalCents(line.credit_cents)}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={2} className="pt-3">
                  {totals.balanced
                    ? "Balanced"
                    : "Unbalanced — approval unavailable"}
                </th>
                <td className="pt-3 text-right font-mono">
                  {formatProposalCents(totals.debit)}
                </td>
                <td className="pt-3 text-right font-mono">
                  {formatProposalCents(totals.credit)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </details>
      <footer className="space-y-3 border-t px-5 py-4">
        {own ? (
          <p className="text-sm text-muted-foreground">
            Awaiting another reviewer. You cannot review your own entry.
          </p>
        ) : (
          <>
            <label className="block space-y-2">
              <span className="text-xs font-medium">
                Review note · required for rejection
              </span>
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={1000}
                disabled={pending || intent !== null}
                placeholder="Describe the evidence checked or explain the correction needed."
              />
            </label>
            {!inspected && (
              <p className="text-xs text-muted-foreground">
                Open the journal lines before making a review decision.
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              {intent ? (
                <Button
                  disabled={pending}
                  onClick={() => void submit(intent.decision)}
                >
                  {pending ? "Confirming review…" : "Retry original review"}
                </Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    disabled={pending || !inspected}
                    onClick={() => void submit("reject")}
                  >
                    Reject with note
                  </Button>
                  <Button
                    disabled={pending || !inspected || !totals.balanced}
                    onClick={() => void submit("approve")}
                  >
                    Approve & post
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </footer>
    </article>
  );
}
