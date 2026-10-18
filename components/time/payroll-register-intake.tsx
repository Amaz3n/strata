"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PayrollAllocationReview } from "./payroll-allocation-review";
import { payrollRegisterFields } from "@/lib/services/books/payroll-register-fields";
import { formatPayrollReviewCents } from "@/lib/services/books/payroll-review-format";
import {
  prepareProjectPayrollUploadAction,
  inspectProjectPayrollUploadAction,
  loadProjectPayrollWorkersAction,
  previewProjectPayrollWorkerLaborAction,
} from "@/app/(app)/projects/[id]/time/payroll/actions";

type Inspection =
  Awaited<ReturnType<typeof inspectProjectPayrollUploadAction>> extends infer R
    ? R extends { success: true; data: infer D }
      ? D
      : never
    : never;
const labels: Record<(typeof payrollRegisterFields)[number], string> = {
  row_type: "Row type",
  provider: "Provider",
  provider_run_id: "Provider run reference",
  period_start: "Work period starts",
  period_end: "Work period ends",
  accrual_date: "Accrual date",
  pay_date: "Pay date",
  employee_reference: "Employee reference",
  gross: "Gross pay",
  net: "Net pay",
  employee_taxes: "Employee taxes",
  employee_deductions: "Employee deductions",
  employer_taxes: "Employer taxes",
  employer_benefits: "Employer benefits",
  funding: "Provider funding",
};
type WorkerPage = Extract<
  Awaited<ReturnType<typeof loadProjectPayrollWorkersAction>>,
  { success: true }
>["data"];
type WorkerLabor = Extract<
  Awaited<ReturnType<typeof previewProjectPayrollWorkerLaborAction>>,
  { success: true }
>["data"];
export function PayrollRegisterIntake({ projectId }: { projectId: string }) {
  const [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [inspection, setInspection] = useState<Inspection | null>(null);
  const [columns, setColumns] = useState<Record<string, string>>({}),
    [unit, setUnit] = useState<"dollars" | "cents">("dollars"),
    [employeeValue, setEmployeeValue] = useState("employee"),
    [controlValue, setControlValue] = useState("control");
  const intent = useRef<{
    file: File;
    fileId: string;
    documentVersionId: string;
    checksum: string;
  } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeRequest.current?.abort();
    };
  }, []);
  const [workerPage, setWorkerPage] = useState<WorkerPage | null>(null),
    [workerIds, setWorkerIds] = useState<Record<string, string>>({}),
    [workerLabor, setWorkerLabor] = useState<WorkerLabor | null>(null);
  function resetWorkers() {
    setWorkerPage(null);
    setWorkerIds({});
    setWorkerLabor(null);
  }
  async function loadWorkers(signal: AbortSignal) {
    const result = await loadProjectPayrollWorkersAction({
      projectId,
      cursor: workerPage?.nextCursor,
    });
    if (signal.aborted) return;
    if (!result.success) throw new Error(result.error);
    setWorkerPage((previous) => ({
      workers: [
        ...new Map(
          [...(previous?.workers ?? []), ...result.data.workers].map(
            (worker) => [worker.id, worker],
          ),
        ).values(),
      ],
      nextCursor: result.data.nextCursor,
    }));
  }
  async function discoverLabor(signal: AbortSignal) {
    if (!inspection?.register)
      throw new Error("Verify provider controls first");
    const result = await previewProjectPayrollWorkerLaborAction({
      projectId,
      fileId: inspection.document.fileId,
      documentVersionId: inspection.document.documentVersionId,
      mapping: {
        columns,
        amount_unit: unit,
        employee_row_value: employeeValue,
        control_row_value: controlValue,
      },
      workers: inspection.register.employees.map((employee) => ({
        employee_reference: employee.employee_reference,
        worker_id: workerIds[employee.employee_reference],
      })),
    });
    if (signal.aborted) return;
    if (!result.success) throw new Error(result.error);
    setWorkerLabor(result.data);
  }
  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    if (!mounted.current || inFlight.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation(controller.signal);
    } catch (e) {
      if (!mounted.current || controller.signal.aborted) return;
      setError(
        e instanceof Error
          ? e.message
          : "Payroll register could not be verified",
      );
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        inFlight.current = false;
        if (mounted.current && !controller.signal.aborted) setBusy(false);
      }
    }
  }
  async function upload(signal: AbortSignal) {
    if (!file) throw new Error("Choose the original provider CSV");
    if (
      !/\.csv$/i.test(file.name) ||
      !file.size ||
      file.size > 16 * 1024 * 1024
    )
      throw new Error("Choose a CSV between 1 byte and 16 MiB");
    if (!intent.current || intent.current.file !== file) {
      const bytes = await file.arrayBuffer();
      if (signal.aborted) return;
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      if (signal.aborted) return;
      intent.current = {
        file,
        fileId: crypto.randomUUID(),
        documentVersionId: crypto.randomUUID(),
        checksum: Array.from(new Uint8Array(digest), (n) =>
          n.toString(16).padStart(2, "0"),
        ).join(""),
      };
    }
    const original = intent.current;
    const prepared = await prepareProjectPayrollUploadAction({
      projectId,
      fileId: original.fileId,
      documentVersionId: original.documentVersionId,
      fileName: file.name,
      sizeBytes: file.size,
      checksum: original.checksum,
    });
    if (signal.aborted) return;
    if (!prepared.success) throw new Error(prepared.error);
    const response = await fetch(prepared.data.uploadUrl, {
      method: "PUT",
      headers: prepared.data.headers,
      body: file,
      credentials: "omit",
      signal,
    });
    if (signal.aborted) return;
    if (!response.ok && response.status !== 412)
      throw new Error(
        `Private upload failed (${response.status}); retry to resume this original`,
      );
    const checked = await inspectProjectPayrollUploadAction({
      projectId,
      fileId: original.fileId,
      documentVersionId: original.documentVersionId,
    });
    if (signal.aborted) return;
    if (!checked.success) throw new Error(checked.error);
    setInspection(checked.data);
    resetWorkers();
    setColumns(
      Object.fromEntries(
        payrollRegisterFields.map((field) => [
          field,
          checked.data.headers.includes(field) ? field : "",
        ]),
      ),
    );
  }
  async function inspect(signal: AbortSignal) {
    if (!inspection) throw new Error("Upload the original register first");
    const checked = await inspectProjectPayrollUploadAction({
      projectId,
      fileId: inspection.document.fileId,
      documentVersionId: inspection.document.documentVersionId,
      mapping: {
        columns,
        amount_unit: unit,
        employee_row_value: employeeValue,
        control_row_value: controlValue,
      },
    });
    if (signal.aborted) return;
    if (!checked.success) throw new Error(checked.error);
    setInspection(checked.data);
    setWorkerLabor(null);
  }
  function changeMapping(update: () => void) {
    update();
    resetWorkers();
    setInspection((value) => (value ? { ...value, register: null } : value));
  }
  return (
    <section
      aria-label="Import provider payroll register"
      className="space-y-5 rounded-lg border p-5"
    >
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">Import a provider register</h2>
        <p className="text-sm text-muted-foreground">
          Retain the original CSV and verify its provider controls before
          assigning workers and construction costs.
        </p>
      </header>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid min-w-0 gap-1 text-sm">
          Original provider CSV
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            className="max-w-full rounded-md border p-2"
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null;
              setFile(selected);
              setInspection(null);
              setColumns({});
              resetWorkers();
              intent.current = null;
              setError(null);
            }}
          />
        </label>
        <Button disabled={busy || !file} onClick={() => run(upload)}>
          {busy
            ? "Verifying…"
            : inspection
              ? "Verify original again"
              : "Upload original privately"}
        </Button>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm"
        >
          {error}
        </p>
      )}
      {inspection && (
        <>
          <p className="text-xs text-muted-foreground">
            Original verified · {inspection.document.fileName} ·{" "}
            {inspection.document.sizeBytes.toLocaleString()} bytes
          </p>
          <fieldset disabled={busy} className="space-y-4">
            <legend className="mb-2 text-sm font-semibold">
              Map every provider column
            </legend>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {payrollRegisterFields.map((field) => (
                <label key={field} className="grid min-w-0 gap-1 text-sm">
                  {labels[field]}
                  <select
                    aria-label={labels[field]}
                    className="min-w-0 rounded-md border bg-background p-2"
                    value={columns[field] ?? ""}
                    onChange={(event) =>
                      changeMapping(() =>
                        setColumns((previous) => ({
                          ...previous,
                          [field]: event.target.value,
                        })),
                      )
                    }
                  >
                    <option value="">Choose a column</option>
                    {inspection.headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="grid gap-1 text-sm">
                Amount units
                <select
                  aria-label="Amount units"
                  className="rounded-md border bg-background p-2"
                  value={unit}
                  onChange={(event) =>
                    changeMapping(() =>
                      setUnit(event.target.value as typeof unit),
                    )
                  }
                >
                  <option value="dollars">Dollars and cents (240.00)</option>
                  <option value="cents">Integer cents (24000)</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Employee row value
                <input
                  className="rounded-md border bg-background p-2"
                  value={employeeValue}
                  onChange={(event) =>
                    changeMapping(() => setEmployeeValue(event.target.value))
                  }
                />
              </label>
              <label className="grid gap-1 text-sm">
                Control row value
                <input
                  className="rounded-md border bg-background p-2"
                  value={controlValue}
                  onChange={(event) =>
                    changeMapping(() => setControlValue(event.target.value))
                  }
                />
              </label>
            </div>
            <Button
              disabled={
                busy || payrollRegisterFields.some((field) => !columns[field])
              }
              onClick={() => run(inspect)}
            >
              Verify provider controls
            </Button>
          </fieldset>
          {inspection.register && (
            <div role="status" className="space-y-3 border-t pt-4">
              <h3 className="font-semibold">
                {inspection.register.provider} ·{" "}
                {inspection.register.provider_run_id}
              </h3>
              <p className="text-sm">
                {inspection.register.period_start} to{" "}
                {inspection.register.period_end} · Pay date{" "}
                {inspection.register.pay_date} ·{" "}
                {inspection.register.employees.length}{" "}
                {inspection.register.employees.length === 1
                  ? "employee"
                  : "employees"}
              </p>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {Object.entries(inspection.register.controls).map(
                  ([key, value]) => (
                    <div key={key}>
                      <dt className="text-xs text-muted-foreground">
                        {key.replace(/_cents$/, "").replaceAll("_", " ")}
                      </dt>
                      <dd className="font-mono tabular-nums">
                        {formatPayrollReviewCents(value)}
                      </dd>
                    </div>
                  ),
                )}
              </dl>
              <p className="text-sm text-muted-foreground">
                Provider controls verified. Worker mapping, native labor
                reconciliation and construction placement must be completed
                before a draft can be reviewed or posted.
              </p>
            </div>
          )}
          {inspection.register && (
            <div
              className="space-y-4 border-t pt-4"
              aria-label="Native worker mapping"
            >
              <h3 className="font-semibold">
                Match provider employees to native workers
              </h3>
              {!workerPage ? (
                <Button disabled={busy} onClick={() => run(loadWorkers)}>
                  Map native workers
                </Button>
              ) : (
                <>
                  <fieldset
                    disabled={busy}
                    className="grid gap-3 sm:grid-cols-2"
                  >
                    {inspection.register.employees.map((employee) => (
                      <label
                        key={employee.employee_reference}
                        className="grid min-w-0 gap-1 text-sm"
                      >
                        Native worker for {employee.employee_reference}
                        <select
                          aria-label={`Native worker for ${employee.employee_reference}`}
                          className="min-w-0 rounded-md border bg-background p-2"
                          value={workerIds[employee.employee_reference] ?? ""}
                          onChange={(event) => {
                            setWorkerIds((previous) => ({
                              ...previous,
                              [employee.employee_reference]: event.target.value,
                            }));
                            setWorkerLabor(null);
                          }}
                        >
                          <option value="">Choose a native worker</option>
                          {workerPage.workers.map((worker) => (
                            <option key={worker.id} value={worker.id}>
                              {worker.name} · {worker.email}
                              {worker.statuses.includes("active")
                                ? ""
                                : " (historical membership)"}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </fieldset>
                  {workerPage.nextCursor && (
                    <Button
                      disabled={busy}
                      variant="outline"
                      onClick={() => run(loadWorkers)}
                    >
                      Load more workers
                    </Button>
                  )}
                  <Button
                    disabled={
                      busy ||
                      inspection.register.employees.some(
                        (employee) => !workerIds[employee.employee_reference],
                      )
                    }
                    onClick={() => run(discoverLabor)}
                  >
                    Find recognized labor
                  </Button>
                </>
              )}
              {workerLabor && (
                <div
                  aria-label="Recognized native labor"
                  className="space-y-3"
                  aria-live="polite"
                >
                  <p className="text-sm">
                    {workerLabor.labor.length} original labor{" "}
                    {workerLabor.labor.length === 1 ? "entry" : "entries"}{" "}
                    verified against posted accounting evidence.
                  </p>
                  {workerLabor.labor.map((labor) => (
                    <div
                      key={labor.id}
                      className="flex flex-wrap justify-between gap-2 rounded-md border p-3 text-sm"
                    >
                      <span>
                        {
                          workerLabor.register.employees.find(
                            (employee) =>
                              workerIds[employee.employee_reference] ===
                              labor.worker_id,
                          )?.employee_reference
                        }{" "}
                        · {labor.incurred_on} · Account {labor.account_code}
                      </span>
                      <span className="font-mono tabular-nums">
                        Wages {formatPayrollReviewCents(labor.gross_cents)} ·
                        Estimated burden{" "}
                        {formatPayrollReviewCents(labor.estimated_burden_cents)}
                      </span>
                    </div>
                  ))}
                  {workerLabor.ownedNativeLabor.length > 0 && (
                    <p className="text-sm">
                      Some labor is already included in a posted payroll
                      register. Use the correction workflow for that register
                      before changing its costs.
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground">
                    Assign all verified labor and provider wages, taxes and
                    benefits to construction or overhead allocations before
                    reconciliation and independent review.
                  </p>
                  {workerLabor.ownedNativeLabor.length === 0 && (
                    <PayrollAllocationReview
                      key={`${workerLabor.document.documentVersionId}:${workerLabor.capturedAt}`}
                      projectId={projectId}
                      native={workerLabor}
                      mapping={{
                        columns: columns as Record<
                          (typeof payrollRegisterFields)[number],
                          string
                        >,
                        amount_unit: unit,
                        employee_row_value: employeeValue,
                        control_row_value: controlValue,
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
