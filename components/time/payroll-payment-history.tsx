"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  loadProjectPayrollPaymentWorkspaceAction,
  reviewProjectPayrollPaymentAttributionAction,
  withdrawProjectPayrollPaymentAttributionAction,
} from "@/app/(app)/projects/[id]/time/payroll/actions";
import type { readProjectPayrollPaymentWorkspace } from "@/lib/services/books/payroll-payment-workspace";
import { formatPayrollReviewCents as money } from "@/lib/services/books/payroll-review-format";
type Page = Awaited<ReturnType<typeof readProjectPayrollPaymentWorkspace>>;
type Review = Page["reviews"][number];
export function PayrollPaymentHistory({
  projectId,
  importId,
  reloadIdentity,
  onAvailability,
}: {
  projectId: string;
  importId: string;
  reloadIdentity: string | null;
  onAvailability: (activeId: string | null) => void;
}) {
  const [page, setPage] = useState<Page | null>(null),
    [selected, setSelected] = useState<Review | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [notes, setNotes] = useState(""),
    [reason, setReason] = useState("");
  const flight = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const selectedId =
      reloadIdentity ??
      new URLSearchParams(window.location.search).get("attribution");
    void (async () => {
      try {
        const r = await loadProjectPayrollPaymentWorkspaceAction({
          projectId,
          importId,
        });
        if (!r.success) throw Error(r.error);
        let row = selectedId
          ? r.data.reviews.find((x) => x.id === selectedId)
          : r.data.reviews.find((x) => x.id === r.data.activeReviewId);
        if (selectedId && !row) {
          const d = await loadProjectPayrollPaymentWorkspaceAction({
            projectId,
            importId,
            reviewId: selectedId,
          });
          if (!d.success) throw Error(d.error);
          row = d.data.reviews[0];
        }
        if (!cancelled) {
          setPage(r.data);
          setSelected(row ?? null);
          setError(null);
          onAvailability(r.data.activeReviewId);
        }
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error
              ? e.message
              : "Payroll attribution history failed",
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, importId, reloadIdentity, onAvailability]);
  async function run(work: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Payroll attribution action failed",
      );
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  async function open(id: string) {
    const r = await loadProjectPayrollPaymentWorkspaceAction({
      projectId,
      importId,
      reviewId: id,
    });
    if (!r.success) throw Error(r.error);
    setSelected(r.data.reviews[0]);
    setNotes("");
    setReason("");
    onAvailability(r.data.activeReviewId);
  }
  async function refresh(more = false) {
    const r = await loadProjectPayrollPaymentWorkspaceAction({
      projectId,
      importId,
      ...(more ? { cursor: page?.nextCursor } : {}),
    });
    if (!r.success) throw Error(r.error);
    setPage((p) =>
      more && p
        ? {
            ...r.data,
            reviews: [
              ...p.reviews,
              ...r.data.reviews.filter(
                (row) => !p.reviews.some((old) => old.id === row.id),
              ),
            ],
          }
        : r.data,
    );
    onAvailability(r.data.activeReviewId);
    if (selected) {
      const d = await loadProjectPayrollPaymentWorkspaceAction({
        projectId,
        importId,
        reviewId: selected.id,
      });
      if (!d.success) throw Error(d.error);
      setSelected(d.data.reviews[0]);
    }
  }
  async function transition(kind: "review" | "withdraw") {
    if (!selected) throw Error("Select retained attribution first");
    const r = await (
      kind === "review"
        ? reviewProjectPayrollPaymentAttributionAction
        : withdrawProjectPayrollPaymentAttributionAction
    )({
      projectId,
      importId,
      reviewId: selected.id,
      notes: kind === "review" ? notes : reason,
    });
    if (!r.success) throw Error(r.error);
    await refresh();
  }
  return (
    <section
      aria-label="Saved payroll attribution"
      className="space-y-3 border-t pt-4"
    >
      <h4 className="font-semibold">Saved payroll attribution</h4>
      <p className="text-sm text-muted-foreground">
        Retained decisions survive refresh. Historical review is separate from
        current posting readiness; a new review rechecks source evidence and
        original document bytes.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!page && !error && <p role="status">Loading retained attribution…</p>}
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => run(() => refresh())}
      >
        Refresh saved attribution
      </Button>
      {page?.reviews.length === 0 && (
        <p className="text-sm">No saved attribution for this register.</p>
      )}
      {page?.reviews.map((row) => (
        <div key={row.id} className="space-y-2 border p-3 text-sm">
          <p className="break-all">
            Attribution {row.id} · {row.status} · {row.preparedAt}
          </p>
          <Button
            variant="outline"
            className="h-auto max-w-full whitespace-normal break-all text-left"
            disabled={busy}
            onClick={() => run(() => open(row.id))}
          >
            Open attribution {row.id}
          </Button>
        </div>
      ))}
      {page?.nextCursor && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => run(() => refresh(true))}
        >
          Load older attribution
        </Button>
      )}
      {selected && (
        <article
          aria-label="Saved attribution detail"
          className="space-y-3 border p-3 text-sm"
        >
          <p className="break-all font-semibold">
            Attribution {selected.id} · Status: {selected.status}.
          </p>
          <Link
            className="underline"
            href={`/projects/${projectId}/time/payroll?draft=${importId}&attribution=${selected.id}`}
          >
            Permanent attribution link
          </Link>
          <p className="break-all">
            Prepared by {selected.preparedBy} · {selected.preparedAt}
          </p>
          <p>Preparation: {selected.preparationNotes}</p>
          {selected.reviewedBy && (
            <>
              <p className="break-all">
                Reviewed by {selected.reviewedBy} · {selected.reviewedAt}
              </p>
              <p>Review: {selected.reviewNotes}</p>
            </>
          )}
          {selected.withdrawnBy && (
            <>
              <p className="break-all">
                Withdrawn by {selected.withdrawnBy} · {selected.withdrawnAt}
              </p>
              <p>Withdrawal: {selected.withdrawalReason}</p>
            </>
          )}
          <p className="break-all">
            Original evidence SHA-256: {selected.evidenceDigest}
          </p>
          {selected.decisions.map((d) => (
            <div key={d.journal_id} className="space-y-2 border p-3">
              <p className="break-all">
                Journal {d.journal_id} ·{" "}
                {d.disposition === "unrelated"
                  ? "Excluded as unrelated"
                  : "Allocated"}
              </p>
              <p>{d.explanation}</p>
              {d.claims.map((c) => (
                <p key={c.id} className="break-all">
                  {c.component.replaceAll("_", " ")} · {money(c.signed_cents)} ·
                  Worker {c.worker_id} · Allocation {c.allocation_id} ·
                  Liability line {c.liability_line_id} · Counterpart line{" "}
                  {c.counterpart_line_id}
                </p>
              ))}
            </div>
          ))}
          {selected.components.map((c) => (
            <p key={`${c.allocation_id}:${c.component}`} className="break-all">
              {c.component.replaceAll("_", " ")} · {money(c.signed_cents)} of
              provider limit {money(c.limit_cents)} · Allocation{" "}
              {c.allocation_id}
            </p>
          ))}
          {selected.sourceLines.map((l) => (
            <p key={l.line_id} className="break-all">
              Original line {l.line_id} · Claimed {money(l.claimed_cents)} of{" "}
              {money(l.available_cents)}
            </p>
          ))}
          {selected.documents.map((d) => (
            <div key={d.versionId} className="space-y-1">
              <a
                className="underline"
                href={`/api/books/payroll/documents/${d.fileId}/versions/${d.versionId}`}
              >
                Download retained {d.name}
              </a>
              <p className="break-all">
                Version {d.versionId} · {d.sizeBytes} bytes · SHA-256{" "}
                {d.checksum}
              </p>
            </div>
          ))}
          {selected.canReview ? (
            <>
              <label className="block">
                Independent attribution review notes
                <Textarea
                  aria-label="Independent attribution review notes"
                  value={notes}
                  maxLength={4000}
                  disabled={busy}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>
              <Button
                disabled={busy || notes.trim().length < 10}
                onClick={() => run(() => transition("review"))}
              >
                Review saved payroll attribution
              </Button>
            </>
          ) : (
            selected.status === "draft" && (
              <p>
                A different accountant from both preparers must review this
                attribution.
              </p>
            )
          )}
          {selected.canWithdraw && (
            <>
              <label className="block">
                Attribution withdrawal reason
                <Textarea
                  aria-label="Attribution withdrawal reason"
                  value={reason}
                  maxLength={4000}
                  disabled={busy}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <Button
                variant="outline"
                disabled={busy || reason.trim().length < 10}
                onClick={() => run(() => transition("withdraw"))}
              >
                Withdraw saved payroll attribution
              </Button>
            </>
          )}
        </article>
      )}
    </section>
  );
}
