"use client";
import { useCallback, useRef, useState } from "react";
import { PayrollPaymentHistory } from "./payroll-payment-history";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  loadProjectPayrollSupportVersionsAction,
  previewProjectPayrollPaymentReviewAction,
  prepareProjectPayrollPaymentReviewAction,
} from "@/app/(app)/projects/[id]/time/payroll/actions";
import type { getProjectPayrollDraftDetail } from "@/lib/services/books/payroll-draft-workspace";
import type { readProjectPayrollSupportVersions } from "@/lib/services/books/payroll-support-versions";
import type { previewProjectPayrollPaymentReview } from "@/lib/services/books/payroll-project-payment-review";
import { payrollPaymentComponents } from "@/lib/services/books/payroll-payment-fields";
import { payrollClaimInputCents } from "@/lib/services/books/payroll-allocation-input";
import { formatPayrollReviewCents as money } from "@/lib/services/books/payroll-review-format";
type Detail = Awaited<ReturnType<typeof getProjectPayrollDraftDetail>>;
type Versions = Awaited<ReturnType<typeof readProjectPayrollSupportVersions>>;
type Preview = Awaited<ReturnType<typeof previewProjectPayrollPaymentReview>>;
type Claim = {
  id: string;
  allocationId: string;
  component: (typeof payrollPaymentComponents)[number] | "";
  liabilityLine: string;
  counterpartLine: string;
  amount: string;
};
type Decision = {
  disposition: "allocated" | "unrelated" | "";
  explanation: string;
  documentVersion: string;
  claims: Claim[];
};
export function PayrollPaymentAttribution({ detail }: { detail: Detail }) {
  const [activeId, setActiveId] = useState<string | null>(null),
    [ready, setReady] = useState(false),
    [savedId, setSavedId] = useState<string | null>(null);
  const availability = useCallback((id: string | null) => {
    setActiveId(id);
    setReady(true);
  }, []);
  return (
    <div className="space-y-4">
      <PayrollPaymentHistory
        projectId={detail.projectId}
        importId={detail.id}
        reloadIdentity={savedId}
        onAvailability={availability}
      />
      {activeId && (
        <p className="text-sm">
          An active attribution is retained. Review it or withdraw it before
          preparing a replacement.
        </p>
      )}
      {ready && !activeId && detail.status !== "withdrawn" && (
        <PayrollPaymentAttributionForm
          detail={detail}
          onPrepared={setSavedId}
        />
      )}
    </div>
  );
}
function PayrollPaymentAttributionForm({
  detail,
  onPrepared,
}: {
  detail: Detail;
  onPrepared: (id: string) => void;
}) {
  const [reviewId] = useState(() => crypto.randomUUID()),
    [decisions, setDecisions] = useState<Record<string, Decision>>({}),
    [search, setSearch] = useState(""),
    [versions, setVersions] = useState<Versions | null>(null),
    [cache, setCache] = useState<Record<string, Versions["versions"][number]>>(
      {},
    ),
    [preview, setPreview] = useState<Preview | null>(null),
    [notes, setNotes] = useState(""),
    [prepared, setPrepared] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const flight = useRef(false),
    key = useRef<string | null>(null),
    movements = detail.liabilities?.movements ?? [];
  const allocations = detail.employees.flatMap((worker) =>
    worker.allocations.map((a) => ({ worker, allocation: a })),
  );
  function decision(journal: string): Decision {
    return (
      decisions[journal] ?? {
        disposition: "",
        explanation: "",
        documentVersion: "",
        claims: [],
      }
    );
  }
  function change(journal: string, patch: Partial<Decision>) {
    setDecisions((d) => ({
      ...d,
      [journal]: { ...decision(journal), ...patch },
    }));
    setPreview(null);
  }
  function claim(journal: string, id: string, patch: Partial<Claim>) {
    change(journal, {
      claims: decision(journal).claims.map((c) =>
        c.id === id ? { ...c, ...patch } : c,
      ),
    });
  }
  async function run(work: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payroll attribution failed");
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  async function load(more = false) {
    const r = await loadProjectPayrollSupportVersionsAction({
      projectId: detail.projectId,
      importId: detail.id,
      search,
      after: more ? versions?.nextCursor : null,
    });
    if (!r.success) throw Error(r.error);
    setVersions(
      more && versions
        ? {
            ...r.data,
            versions: [
              ...versions.versions,
              ...r.data.versions.filter(
                (row) => !versions.versions.some((old) => old.id === row.id),
              ),
            ],
          }
        : r.data,
    );
    setCache((c) => ({
      ...c,
      ...Object.fromEntries(r.data.versions.map((row) => [row.id, row])),
    }));
  }
  function request() {
    return {
      projectId: detail.projectId,
      request: {
        id: reviewId,
        payroll_import_id: detail.id,
        decisions: movements.map((m) => {
          const d = decision(m.journal.id);
          if (!d.disposition)
            throw Error(
              "Choose allocation or exclusion for every retained journal",
            );
          return {
            journal_id: m.journal.id,
            disposition: d.disposition,
            explanation: d.explanation,
            document_version_id: d.documentVersion,
            claims: d.claims.map((c) => {
              const a = allocations.find(
                (row) => row.allocation.id === c.allocationId,
              );
              if (!a)
                throw Error(
                  "Choose a native worker allocation for every claim",
                );
              if (!c.component)
                throw Error("Choose the prior payroll event for every claim");
              return {
                id: c.id,
                worker_id: a.worker.worker_id,
                allocation_id: c.allocationId,
                component: c.component,
                liability_line_id: c.liabilityLine,
                counterpart_line_id: c.counterpartLine,
                signed_cents: payrollClaimInputCents(c.amount),
              };
            }),
          };
        }),
      },
    };
  }
  async function verify() {
    const r = await previewProjectPayrollPaymentReviewAction(request());
    if (!r.success) throw Error(r.error);
    setPreview(r.data);
  }
  async function prepare() {
    if (!preview)
      throw Error("Verify the current claims and supporting evidence first");
    key.current ??= crypto.randomUUID();
    const r = await prepareProjectPayrollPaymentReviewAction({
      ...request(),
      notes,
      idempotencyKey: key.current,
      expectedEvidenceDigest: preview.evidenceDigest,
    });
    if (!r.success) throw Error(r.error);
    setPrepared(r.data);
    onPrepared(r.data);
  }
  if (!movements.length)
    return (
      <p className="text-sm text-muted-foreground">
        No retained liability movements require prior-event attribution for this
        frozen register. Posting still requires its construction and calendar
        checks.
      </p>
    );
  return (
    <section
      aria-label="Prior payroll attribution"
      className="space-y-4 border-t pt-4"
    >
      <h4 className="font-semibold">Attribute prior payroll events</h4>
      <p className="text-sm text-muted-foreground">
        Review every retained movement. Allocated claims require original
        supporting evidence separate from this intended payroll register.
        Positive amounts describe the normal event; negative amounts describe
        its refund or reversal.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <fieldset disabled={busy || Boolean(prepared)} className="space-y-4">
        <div className="space-y-2">
          <label className="block text-sm">
            Find private supporting versions
            <Input
              aria-label="Find private supporting versions"
              value={search}
              maxLength={200}
              onChange={(e) => {
                setSearch(e.target.value);
                setVersions(null);
              }}
            />
          </label>
          <Button variant="outline" onClick={() => run(() => load())}>
            Load private supporting versions
          </Button>
          {versions?.nextCursor && (
            <Button variant="outline" onClick={() => run(() => load(true))}>
              Load older supporting versions
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            Retained version metadata is listed here. Attribution preview
            verifies the original bytes before accepting the evidence.
          </p>
        </div>
        {movements.map((m, j) => {
          const d = decision(m.journal.id),
            docs = [...(versions?.versions ?? [])];
          if (
            d.documentVersion &&
            cache[d.documentVersion] &&
            !docs.some((row) => row.id === d.documentVersion)
          )
            docs.push(cache[d.documentVersion]);
          return (
            <div key={m.journal.id} className="space-y-3 rounded-md border p-3">
              <p className="break-all text-sm font-medium">
                {m.journal.entry_date} · Journal {m.journal.id}
              </p>
              <label className="block text-sm">
                Disposition for journal {j + 1}
                <select
                  className="mt-1 h-9 w-full min-w-0 rounded-md border bg-background px-2"
                  aria-label={`Disposition for journal ${j + 1}`}
                  value={d.disposition}
                  onChange={(e) =>
                    change(m.journal.id, {
                      disposition: e.target.value as Decision["disposition"],
                      claims: e.target.value === "unrelated" ? [] : d.claims,
                    })
                  }
                >
                  <option value="">Choose allocation or exclusion</option>
                  <option value="allocated">
                    Allocate original prior events to this register
                  </option>
                  <option value="unrelated">
                    Exclude as unrelated to this register
                  </option>
                </select>
              </label>
              <label className="block text-sm">
                Explanation for journal {j + 1}
                <Textarea
                  aria-label={`Explanation for journal ${j + 1}`}
                  value={d.explanation}
                  maxLength={4000}
                  onChange={(e) =>
                    change(m.journal.id, { explanation: e.target.value })
                  }
                />
              </label>
              <label className="block text-sm">
                Supporting version for journal {j + 1}
                <select
                  className="mt-1 h-9 w-full min-w-0 rounded-md border bg-background px-2"
                  aria-label={`Supporting version for journal ${j + 1}`}
                  value={d.documentVersion}
                  onChange={(e) =>
                    change(m.journal.id, { documentVersion: e.target.value })
                  }
                >
                  <option value="">Choose retained private evidence</option>
                  {docs.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.file_name} · Version {v.id}
                    </option>
                  ))}
                </select>
              </label>
              {d.documentVersion && cache[d.documentVersion] && (
                <a
                  className="text-xs underline"
                  href={`/api/books/payroll/documents/${cache[d.documentVersion].file_id}/versions/${d.documentVersion}`}
                >
                  Download original supporting version for journal {j + 1}
                </a>
              )}
              {d.disposition === "allocated" && (
                <div className="space-y-3">
                  {d.claims.map((c, i) => (
                    <div key={c.id} className="space-y-2 border-t pt-3">
                      <label className="block text-sm">
                        Worker allocation for claim {i + 1} of journal {j + 1}
                        <select
                          className="mt-1 h-9 w-full min-w-0 rounded-md border bg-background px-2"
                          aria-label={`Worker allocation for claim ${i + 1} of journal ${j + 1}`}
                          value={c.allocationId}
                          onChange={(e) =>
                            claim(m.journal.id, c.id, {
                              allocationId: e.target.value,
                            })
                          }
                        >
                          <option value="">Choose worker and allocation</option>
                          {allocations.map((a) => (
                            <option
                              key={a.allocation.id}
                              value={a.allocation.id}
                            >
                              {a.worker.employee_reference} ·{" "}
                              {a.allocation.project_id
                                ? (detail.projects.find(
                                    (p) => p.id === a.allocation.project_id,
                                  )?.name ?? a.allocation.project_id)
                                : "Overhead"}{" "}
                              · Account {a.allocation.cost_account_code}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block text-sm">
                        Prior event for claim {i + 1} of journal {j + 1}
                        <select
                          className="mt-1 h-9 w-full min-w-0 rounded-md border bg-background px-2"
                          aria-label={`Prior event for claim ${i + 1} of journal ${j + 1}`}
                          value={c.component}
                          onChange={(e) =>
                            claim(m.journal.id, c.id, {
                              component: e.target.value as Claim["component"],
                            })
                          }
                        >
                          <option value="">Choose original event</option>
                          {payrollPaymentComponents.map((component) => (
                            <option key={component} value={component}>
                              {component.replaceAll("_", " ")}
                            </option>
                          ))}
                        </select>
                      </label>
                      {(["liabilityLine", "counterpartLine"] as const).map(
                        (field) => (
                          <label key={field} className="block text-sm">
                            {field === "liabilityLine"
                              ? "Liability"
                              : "Counterpart"}{" "}
                            line for claim {i + 1} of journal {j + 1}
                            <select
                              className="mt-1 h-9 w-full min-w-0 rounded-md border bg-background px-2"
                              aria-label={`${field === "liabilityLine" ? "Liability" : "Counterpart"} line for claim ${i + 1} of journal ${j + 1}`}
                              value={c[field]}
                              onChange={(e) =>
                                claim(m.journal.id, c.id, {
                                  [field]: e.target.value,
                                })
                              }
                            >
                              <option value="">Choose original line</option>
                              {m.lines.map((line) => (
                                <option key={line.id} value={line.id}>
                                  {line.accountCode} · Debit{" "}
                                  {money(line.debit_cents)} · Credit{" "}
                                  {money(line.credit_cents)} · {line.id}
                                </option>
                              ))}
                            </select>
                          </label>
                        ),
                      )}
                      <label className="block text-sm">
                        Signed dollars for claim {i + 1} of journal {j + 1}
                        <Input
                          inputMode="decimal"
                          aria-label={`Signed dollars for claim ${i + 1} of journal ${j + 1}`}
                          value={c.amount}
                          onChange={(e) =>
                            claim(m.journal.id, c.id, {
                              amount: e.target.value,
                            })
                          }
                        />
                      </label>
                      <Button
                        variant="outline"
                        onClick={() =>
                          change(m.journal.id, {
                            claims: d.claims.filter((row) => row.id !== c.id),
                          })
                        }
                      >
                        Remove claim {i + 1} of journal {j + 1}
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    onClick={() =>
                      change(m.journal.id, {
                        claims: [
                          ...d.claims,
                          {
                            id: crypto.randomUUID(),
                            allocationId: "",
                            component: "",
                            liabilityLine: "",
                            counterpartLine: "",
                            amount: "",
                          },
                        ],
                      })
                    }
                  >
                    Add claim for journal {j + 1}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
        <Button onClick={() => run(verify)}>
          Preview prior payroll attribution
        </Button>
        {preview && (
          <div
            aria-label="Verified prior payroll attribution"
            className="space-y-2 rounded-md border p-3"
          >
            <p className="text-sm">
              Original supporting bytes and all retained journal decisions
              verified. This is an unapproved attribution preview.
            </p>
            {preview.evidence.allocation_components.map((row) => (
              <p
                key={`${row.allocation_id}:${row.component}`}
                className="text-sm"
              >
                {row.component.replaceAll("_", " ")} · {money(row.signed_cents)}{" "}
                of provider limit {money(row.limit_cents)}
              </p>
            ))}
            <p className="text-xs text-muted-foreground">
              {preview.evidence.source_line_claims.length} original source lines
              claimed. Preparation rechecks source capacity.
            </p>
            <label className="block text-sm">
              Payment attribution preparation notes
              <Textarea
                aria-label="Payment attribution preparation notes"
                value={notes}
                maxLength={4000}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
            <Button
              disabled={notes.trim().length < 10}
              onClick={() => run(prepare)}
            >
              Prepare unapproved payment attribution
            </Button>
          </div>
        )}
      </fieldset>
      {prepared && (
        <p role="status" className="break-all text-sm">
          Payment attribution {prepared} prepared. Separate review is required
          before monetary posting.
        </p>
      )}
    </section>
  );
}
