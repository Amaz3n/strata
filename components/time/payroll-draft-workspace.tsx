"use client";
import { PayrollPaymentAttribution } from "./payroll-payment-attribution";
import { useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  loadProjectPayrollDraftsAction,
  loadProjectPayrollDraftAction,
  reviewProjectPayrollDraftAction,
  withdrawProjectPayrollDraftAction,
} from "@/app/(app)/projects/[id]/time/payroll/actions";
import type {
  getProjectPayrollDrafts,
  getProjectPayrollDraftDetail,
} from "@/lib/services/books/payroll-draft-workspace";
import { formatPayrollReviewCents as money } from "@/lib/services/books/payroll-review-format";
type Page = Awaited<ReturnType<typeof getProjectPayrollDrafts>>;
type Detail = Awaited<ReturnType<typeof getProjectPayrollDraftDetail>>;
export function PayrollDraftWorkspace({
  initial,
  initialDetail = null,
  initialError = null,
}: {
  initial: Page;
  initialDetail?: Detail | null;
  initialError?: string | null;
}) {
  const [page, setPage] = useState(initial),
    [detail, setDetail] = useState(initialDetail),
    [error, setError] = useState(initialError),
    [busy, setBusy] = useState(false),
    [notes, setNotes] = useState(""),
    [reason, setReason] = useState("");
  const flight = useRef(false);
  async function act(work: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payroll action failed");
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  async function load(id: string) {
    await act(async () => {
      setDetail(null);
      setNotes("");
      setReason("");
      const r = await loadProjectPayrollDraftAction({
        projectId: page.projectId,
        importId: id,
      });
      if (!r.success) throw Error(r.error);
      setDetail(r.data);
      setNotes("");
      setReason("");
    });
  }
  async function refresh(more = false) {
    await act(async () => {
      const r = await loadProjectPayrollDraftsAction(
        page.projectId,
        more ? page.nextCursor : undefined,
      );
      if (!r.success) throw Error(r.error);
      setPage(
        more
          ? {
              ...r.data,
              drafts: [
                ...page.drafts,
                ...r.data.drafts.filter(
                  (x) => !page.drafts.some((y) => y.id === x.id),
                ),
              ],
            }
          : r.data,
      );
      if (!more && detail) {
        const current = await loadProjectPayrollDraftAction({
          projectId: page.projectId,
          importId: detail.id,
        });
        if (!current.success) {
          setDetail(null);
          throw Error(current.error);
        }
        setDetail(current.data);
      }
    });
  }
  async function transition(kind: "review" | "withdraw") {
    if (!detail) return;
    await act(async () => {
      const input = { projectId: page.projectId, importId: detail.id },
        r =
          kind === "review"
            ? await reviewProjectPayrollDraftAction({ ...input, notes })
            : await withdrawProjectPayrollDraftAction({ ...input, reason });
      if (!r.success) throw Error(r.error);
      const current = await loadProjectPayrollDraftAction(input);
      if (!current.success)
        throw Error(
          `Action completed; reload draft to see current status: ${current.error}`,
        );
      setDetail(current.data);
      setPage((p) => ({
        ...p,
        drafts: p.drafts.map((row) =>
          row.id === detail.id ? { ...row, status: current.data.status } : row,
        ),
      }));
    });
  }
  return (
    <section
      aria-label="Payroll drafts"
      className="space-y-4 rounded-lg border p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Payroll drafts</h2>
          <p className="text-sm text-muted-foreground">
            Unposted registers affecting this project, plus shared organization
            overhead. Review preserves the original source and allocation;
            posting requires further checks.
          </p>
        </div>
        <Button variant="outline" disabled={busy} onClick={() => refresh()}>
          Refresh drafts
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!page.drafts.length && (
        <p className="text-sm text-muted-foreground">
          No unposted payroll drafts in this scope.
        </p>
      )}
      <div className="space-y-2">
        {page.drafts.map((row) => (
          <div
            key={row.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
          >
            <div>
              <p className="font-medium">
                {row.provider} · {row.runReference}
              </p>
              <p className="text-sm text-muted-foreground">
                {row.periodStart} to {row.periodEnd} ·{" "}
                {row.overheadOnly
                  ? "Organization overhead"
                  : "Project allocations"}{" "}
                · {row.status} · Gross {money(row.grossCents)}
              </p>
            </div>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => load(row.id)}
            >
              Open {row.runReference}
            </Button>
          </div>
        ))}
      </div>
      {page.nextCursor && (
        <Button variant="outline" disabled={busy} onClick={() => refresh(true)}>
          Load older drafts
        </Button>
      )}
      {detail && (
        <article
          aria-label="Payroll draft detail"
          className="space-y-4 border-t pt-4"
        >
          <div>
            <h3 className="font-semibold">
              {detail.provider} · {detail.runReference}
            </h3>
            <p className="text-sm">
              Status: {detail.status}. Funding control{" "}
              {money(detail.fundingCents)}.
            </p>
            <Link
              className="text-sm underline"
              href={`/projects/${page.projectId}/time/payroll?draft=${detail.id}`}
            >
              Permanent draft link
            </Link>
          </div>
          <a
            className="break-all text-sm underline"
            href={`/api/books/payroll/documents/${detail.source.fileId}/versions/${detail.source.documentVersionId}`}
          >
            {detail.source.fileName}
          </a>
          <p className="break-all text-xs text-muted-foreground">
            Original SHA-256: {detail.source.checksum}
          </p>
          <p className="text-sm">Preparation: {detail.preparationNotes}</p>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            {Object.entries(detail.reconciliation).map(([key, value]) => (
              <div key={key}>
                <dt className="text-muted-foreground">
                  {
                    {
                      recognizedGrossCents: "Original recognized wages",
                      estimatedBurdenCents: "Original estimated burden",
                      wageVarianceCents: "Wage adjustment",
                      burdenVarianceCents: "Burden adjustment",
                      costVarianceCents: "Total cost adjustment",
                    }[key]
                  }
                </dt>
                <dd className="font-mono">{money(value)}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-muted-foreground">
            {detail.workflowPresent
              ? "Construction placement, billing and liability attribution require separate posting review."
              : "This retained register lacks current construction/payment workflow evidence; it must not be treated as ready for posting."}
          </p>
          {detail.labor.length > 0 && (
            <details className="text-sm">
              <summary>
                Original labor proof ({detail.labor.length} entries)
              </summary>
              {detail.labor.map((row) => (
                <p key={row.id} className="break-all">
                  {row.date} · Wages {money(row.grossCents)} · Estimated burden{" "}
                  {money(row.burdenCents)} · Cost {row.id} · Journal{" "}
                  {row.journalId}
                </p>
              ))}
            </details>
          )}
          {detail.employees.map((worker) => (
            <div
              key={worker.worker_id}
              className="space-y-2 rounded-md border p-3"
            >
              <p className="font-medium">
                {worker.employee_reference} · Gross {money(worker.gross_cents)}{" "}
                · Net {money(worker.net_cents)}
              </p>
              <p className="text-sm">
                Employee taxes {money(worker.employee_taxes_cents)} · Deductions{" "}
                {money(worker.employee_deductions_cents)} · Employer taxes{" "}
                {money(worker.employer_taxes_cents)} · Benefits{" "}
                {money(worker.employer_benefits_cents)}
              </p>
              {worker.allocations.map((a) => (
                <div key={a.id} className="break-words text-sm">
                  <p>
                    {a.project_id
                      ? `Project ${detail.projects.find((p) => p.id === a.project_id)?.name ?? a.project_id}`
                      : "Organization overhead"}{" "}
                    · Cost code{" "}
                    {detail.costCodes.find((c) => c.id === a.cost_code_id)
                      ?.name ??
                      a.cost_code_id ??
                      "None"}{" "}
                    · Account {a.cost_account_code}
                  </p>
                  <p>
                    Gross {money(a.gross_cents)} · Employer taxes{" "}
                    {money(a.employer_taxes_cents)} · Benefits{" "}
                    {money(a.employer_benefits_cents)} ·{" "}
                    {a.labor_evidence_ids.length} original labor entries
                  </p>
                </div>
              ))}
            </div>
          ))}
          {detail.liabilities && (
            <details className="space-y-3 rounded-md border p-3 text-sm">
              <summary className="cursor-pointer font-medium">
                Original liability movements (
                {detail.liabilities.movements.length})
              </summary>
              <p className="text-muted-foreground">
                These are retained organization movements, not this register's
                unpaid balance. Every movement requires explicit allocation or
                exclusion with supporting evidence before posting.
              </p>
              {detail.liabilities.movements.map((movement) => (
                <div
                  key={String(movement.journal.id)}
                  className="space-y-2 border-t pt-3"
                >
                  <p className="break-all font-medium">
                    {movement.journal.entry_date} · {movement.journal.status} ·{" "}
                    {String(movement.journal.id)}
                  </p>
                  <p>
                    Wages movement {money(movement.wagesMovementCents)} ·
                    Deductions movement{" "}
                    {money(movement.deductionsMovementCents)}
                  </p>
                  {movement.lines.map((line) => (
                    <div key={line.id} className="break-all text-xs">
                      <p>
                        Account {line.accountCode} · Debit{" "}
                        {money(line.debit_cents)} · Credit{" "}
                        {money(line.credit_cents)} ·{" "}
                        {line.project_id
                          ? `Project ${line.project_id}`
                          : "No project dimension"}
                      </p>
                      <p>
                        Original line {line.id} · Classification{" "}
                        {line.classificationSource === "original_journal"
                          ? "frozen in original journal"
                          : "chart captured at preparation (original classification unavailable)"}
                      </p>
                    </div>
                  ))}
                </div>
              ))}
            </details>
          )}
          {detail.workflowPresent && (
            <PayrollPaymentAttribution key={detail.id} detail={detail} />
          )}
          {detail.reviewNotes && (
            <p className="text-sm">Independent review: {detail.reviewNotes}</p>
          )}
          {detail.withdrawalReason && (
            <p className="text-sm">Withdrawal: {detail.withdrawalReason}</p>
          )}
          {detail.status === "draft" && !detail.canReview && (
            <p className="text-sm text-muted-foreground">
              A different accountant must review this register.
            </p>
          )}
          {detail.canReview && (
            <div className="space-y-2">
              <label className="text-sm" htmlFor="payroll-draft-review-notes">
                Independent source and allocation review notes
              </label>
              <Textarea
                id="payroll-draft-review-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={busy}
                maxLength={4000}
              />
              <Button
                disabled={busy || notes.trim().length < 10}
                onClick={() => transition("review")}
              >
                Review original payroll draft
              </Button>
              <p className="text-xs text-muted-foreground">
                The server verifies current original source, labor and workflow
                evidence before recording separate review. This does not post
                money or resolve construction and payment decisions.
              </p>
            </div>
          )}
          {detail.canWithdraw && (
            <div className="space-y-2">
              <label
                htmlFor="payroll-draft-withdrawal-reason"
                className="text-sm"
              >
                Withdrawal reason
              </label>
              <Textarea
                id="payroll-draft-withdrawal-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={busy}
                maxLength={4000}
              />
              <Button
                variant="outline"
                disabled={busy || reason.trim().length < 10}
                onClick={() => transition("withdraw")}
              >
                Withdraw payroll draft
              </Button>
            </div>
          )}
        </article>
      )}
    </section>
  );
}
