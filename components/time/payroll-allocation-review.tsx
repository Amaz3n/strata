"use client";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  payrollAllocationInputCents,
  payrollAllocationInputText,
} from "@/lib/services/books/payroll-allocation-input";
import { formatPayrollReviewCents } from "@/lib/services/books/payroll-review-format";
import {
  previewProjectPayrollWorkerLaborAction,
  previewProjectPayrollAllocationAction,
  prepareProjectPayrollAllocationAction,
} from "@/app/(app)/projects/[id]/time/payroll/actions";
import type { payrollCsvMappingSchema } from "@/lib/services/books/payroll-register-csv";
import type { z } from "zod";
type Native = Extract<
  Awaited<ReturnType<typeof previewProjectPayrollWorkerLaborAction>>,
  { success: true }
>["data"];
type Preview = Extract<
  Awaited<ReturnType<typeof previewProjectPayrollAllocationAction>>,
  { success: true }
>["data"];
type Row = {
  id: string;
  projectId: string;
  costCodeId: string;
  accountCode: string;
  gross: string;
  taxes: string;
  benefits: string;
  laborIds: string[];
};
export function PayrollAllocationReview({
  projectId,
  native,
  mapping,
}: {
  projectId: string;
  native: Native;
  mapping: z.infer<typeof payrollCsvMappingSchema>;
}) {
  const [runId] = useState(() => crypto.randomUUID()),
    [rows, setRows] = useState<Record<string, Row[]>>({}),
    [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notes, setNotes] = useState(""),
    [prepared, setPrepared] = useState<string | null>(null);
  const preparationKey = useRef<string | null>(null),
    inFlight = useRef(false);
  async function run(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Payroll allocation could not be reconciled",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function update(reference: string, id: string, change: Partial<Row>) {
    setRows((previous) => ({
      ...previous,
      [reference]: (previous[reference] ?? []).map((row) =>
        row.id === id ? { ...row, ...change } : row,
      ),
    }));
    setPreview(null);
  }
  function request() {
    if (
      Object.values(rows)
        .flat()
        .some((row) => !row.projectId)
    )
      throw new Error(
        "Choose a construction project or overhead for every allocation",
      );
    return {
      projectId,
      register: {
        runId,
        fileId: native.document.fileId,
        documentVersionId: native.document.documentVersionId,
        mapping,
        workers: native.workers.map((worker) => ({
          ...worker,
          allocations: (rows[worker.employee_reference] ?? []).map((row) => ({
            id: row.id,
            project_id: row.projectId === "overhead" ? null : row.projectId,
            cost_code_id: row.costCodeId || null,
            cost_account_code: row.accountCode,
            gross_cents: payrollAllocationInputCents(row.gross),
            employer_taxes_cents: payrollAllocationInputCents(row.taxes),
            employer_benefits_cents: payrollAllocationInputCents(row.benefits),
            labor_evidence_ids: row.laborIds,
          })),
        })),
      },
    };
  }
  async function reconcile() {
    const result = await previewProjectPayrollAllocationAction(request());
    if (!result.success) throw new Error(result.error);
    setPreview(result.data);
  }
  async function prepare() {
    if (!preview) throw new Error("Reconcile the current allocations first");
    preparationKey.current ??= crypto.randomUUID();
    const result = await prepareProjectPayrollAllocationAction({
      ...request(),
      notes,
      idempotencyKey: preparationKey.current,
      expectedEvidenceDigest: preview.evidenceDigest,
    });
    if (!result.success) throw new Error(result.error);
    setPrepared(result.data);
  }
  const draftProjectId =
    Object.values(rows)
      .flat()
      .find((row) => row.projectId && row.projectId !== "overhead")
      ?.projectId ?? projectId;
  return (
    <section
      aria-label="Payroll allocation and reconciliation"
      className="space-y-4 border-t pt-4"
    >
      <h3 className="font-semibold">Allocate provider payroll</h3>
      <p className="text-sm text-muted-foreground">
        Assign each employee's full gross pay, employer taxes and benefits, and
        every verified native labor entry. Amounts below are dollars.
      </p>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm"
        >
          {error}
        </p>
      )}
      <fieldset disabled={busy || Boolean(prepared)} className="space-y-5">
        {native.register.employees.map((employee) => (
          <div
            key={employee.employee_reference}
            className="space-y-3 rounded-md border p-4"
          >
            <h4 className="font-semibold">{employee.employee_reference}</h4>
            <p className="text-sm">
              Provider gross {formatPayrollReviewCents(employee.gross_cents)} ·
              Employer taxes{" "}
              {formatPayrollReviewCents(employee.employer_taxes_cents)} ·
              Benefits{" "}
              {formatPayrollReviewCents(employee.employer_benefits_cents)}
            </p>
            {(rows[employee.employee_reference] ?? []).map((row, index) => (
              <div
                key={row.id}
                className="space-y-3 border-t pt-3"
                aria-label={`Allocation ${index + 1} for ${employee.employee_reference}`}
              >
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="grid min-w-0 gap-1 text-sm">
                    Project
                    <select
                      aria-label={`Project for allocation ${index + 1} of ${employee.employee_reference}`}
                      className="min-w-0 rounded-md border bg-background p-2"
                      value={row.projectId}
                      onChange={(event) =>
                        update(employee.employee_reference, row.id, {
                          projectId: event.target.value,
                          laborIds: [],
                        })
                      }
                    >
                      <option value="">Choose project or overhead</option>
                      <option value="overhead">Overhead (no project)</option>
                      {native.projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid min-w-0 gap-1 text-sm">
                    Cost code
                    <select
                      aria-label={`Cost code for allocation ${index + 1} of ${employee.employee_reference}`}
                      className="min-w-0 rounded-md border bg-background p-2"
                      value={row.costCodeId}
                      onChange={(event) =>
                        update(employee.employee_reference, row.id, {
                          costCodeId: event.target.value,
                          laborIds: [],
                        })
                      }
                    >
                      <option value="">No cost code</option>
                      {native.costCodes.map((code) => (
                        <option key={code.id} value={code.id}>
                          {code.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid min-w-0 gap-1 text-sm">
                    Cost account
                    <select
                      aria-label={`Account for allocation ${index + 1} of ${employee.employee_reference}`}
                      className="min-w-0 rounded-md border bg-background p-2"
                      value={row.accountCode}
                      onChange={(event) =>
                        update(employee.employee_reference, row.id, {
                          accountCode: event.target.value,
                          laborIds: [],
                        })
                      }
                    >
                      <option value="">Choose an account</option>
                      {native.accounts.map((account) => (
                        <option key={account.id} value={account.code}>
                          {account.code} ·{" "}
                          {account.subtype.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  {(
                    [
                      ["gross", "Gross pay"],
                      ["taxes", "Employer taxes"],
                      ["benefits", "Employer benefits"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="grid gap-1 text-sm">
                      {label}
                      <input
                        aria-label={`${label} for allocation ${index + 1} of ${employee.employee_reference}`}
                        inputMode="decimal"
                        className="min-w-0 rounded-md border bg-background p-2"
                        value={row[key]}
                        onChange={(event) =>
                          update(employee.employee_reference, row.id, {
                            [key]: event.target.value,
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Original labor for this worker and allocation
                  </p>
                  {native.labor
                    .filter(
                      (labor) =>
                        native.workers.find(
                          (worker) =>
                            worker.employee_reference ===
                            employee.employee_reference,
                        )?.worker_id === labor.worker_id &&
                        labor.project_id ===
                          (row.projectId === "overhead"
                            ? null
                            : row.projectId || null) &&
                        labor.cost_code_id === (row.costCodeId || null) &&
                        labor.account_code === row.accountCode,
                    )
                    .map((labor) => (
                      <label
                        key={labor.id}
                        className="flex items-start gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          disabled={Object.values(rows)
                            .flat()
                            .some(
                              (other) =>
                                other.id !== row.id &&
                                other.laborIds.includes(labor.id),
                            )}
                          checked={row.laborIds.includes(labor.id)}
                          onChange={(event) =>
                            update(employee.employee_reference, row.id, {
                              laborIds: event.target.checked
                                ? [...row.laborIds, labor.id]
                                : row.laborIds.filter((id) => id !== labor.id),
                            })
                          }
                        />
                        <span>
                          {labor.incurred_on} · Wages{" "}
                          {formatPayrollReviewCents(labor.gross_cents)} ·
                          Estimated burden{" "}
                          {formatPayrollReviewCents(
                            labor.estimated_burden_cents,
                          )}
                        </span>
                      </label>
                    ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      update(employee.employee_reference, row.id, {
                        gross: payrollAllocationInputText(employee.gross_cents),
                        taxes: payrollAllocationInputText(
                          employee.employer_taxes_cents,
                        ),
                        benefits: payrollAllocationInputText(
                          employee.employer_benefits_cents,
                        ),
                      })
                    }
                  >
                    Use full provider totals here
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setRows((previous) => ({
                        ...previous,
                        [employee.employee_reference]: previous[
                          employee.employee_reference
                        ].filter((value) => value.id !== row.id),
                      }));
                      setPreview(null);
                    }}
                  >
                    Remove allocation
                  </Button>
                </div>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setRows((previous) => ({
                  ...previous,
                  [employee.employee_reference]: [
                    ...(previous[employee.employee_reference] ?? []),
                    {
                      id: crypto.randomUUID(),
                      projectId: "",
                      costCodeId: "",
                      accountCode: "",
                      gross: "",
                      taxes: "",
                      benefits: "",
                      laborIds: [],
                    },
                  ],
                }));
                setPreview(null);
              }}
            >
              Add allocation for {employee.employee_reference}
            </Button>
          </div>
        ))}
        <Button type="button" onClick={() => run(reconcile)}>
          Reconcile allocations
        </Button>
      </fieldset>
      {preview && (
        <div
          aria-label="Payroll reconciliation result"
          className="space-y-3 rounded-md border p-4"
        >
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Recognized gross", preview.recognizedGrossCents],
              ["Estimated burden", preview.estimatedBurdenCents],
              ["Wage variance", preview.wageVarianceCents],
              ["Cost change", preview.costVarianceCents],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="font-mono tabular-nums">
                  {formatPayrollReviewCents(Number(value))}
                </dd>
              </div>
            ))}
          </dl>
          {preview.construction.allocations.some(
            (allocation) => allocation.blockers.length > 0,
          ) && (
            <p className="text-sm">
              Construction placement or billing decisions are still required.
              Preparing this draft does not resolve those posting controls.
            </p>
          )}
          {preview.liabilities.requiresSettlementAttribution && (
            <p className="text-sm">
              Existing payroll liability movements require attribution before
              posting. This preview does not prove the register is unpaid.
            </p>
          )}
          <label className="grid gap-1 text-sm">
            Allocation review notes
            <textarea
              disabled={busy || Boolean(prepared)}
              className="rounded-md border bg-background p-2"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
          <Button
            disabled={busy || Boolean(prepared) || notes.trim().length < 10}
            onClick={() => run(prepare)}
          >
            Prepare unapproved payroll draft
          </Button>
          {prepared && (
            <p role="status" className="text-sm">
              Unapproved payroll draft prepared. Separate review and posting are
              required.{" "}
              <a
                className="underline"
                href={`/projects/${draftProjectId}/time/payroll?draft=${prepared}`}
              >
                Open prepared draft
              </a>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
