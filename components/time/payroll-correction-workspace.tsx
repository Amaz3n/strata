"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatPayrollReviewCents } from "@/lib/services/books/payroll-review-format";
import { unwrapAction } from "@/lib/action-result";
import type {
  PayrollCorrectionWorkspace as Workspace,
  PayrollCorrectionDetail as Detail,
} from "@/lib/services/books/payroll-correction-workspace";
import { payrollCorrectionConstructionDecisionsSchema } from "@/lib/services/books/payroll-correction-construction-decisions";
import {
  loadProjectPayrollCorrectionsAction,
  loadProjectPayrollCorrectionAction,
  previewProjectPayrollPlacementAction,
  reviewProjectPayrollSourceAction,
  withdrawProjectPayrollSourceAction,
  prepareProjectPayrollProposalAction,
  reviewProjectPayrollProposalAction,
  withdrawProjectPayrollProposalAction,
  postProjectPayrollProposalAction,
} from "@/app/(app)/projects/[id]/time/payroll/actions";

const blockerLabels: Record<string, string> = {
  review_new_or_reallocated_budget_and_gmp:
    "Choose a budget and GMP placement for the new cost leg.",
  review_customer_billing_basis: "Confirm the customer billing treatment.",
  review_current_customer_billing_policy:
    "Resolve the project's current billing policy before posting.",
  review_late_project_cost_policy:
    "Review costs for this completed or cancelled project.",
  review_closed_home_cost_and_customer_settlement:
    "Review the closed home's cost accounting and customer settlement.",
  review_incomplete_project_financial_setup:
    "Complete the project's financial setup.",
  review_missing_or_ambiguous_active_contract:
    "Resolve the project's active contract.",
  review_changed_budget_scope:
    "Restore or resolve the original budget placement.",
  review_changed_customer_billing_basis:
    "Resolve changed native customer billing evidence.",
  review_employee_or_provider_overpayment_recovery:
    "Review employee or provider overpayment recovery.",
  review_provider_tax_correction_evidence:
    "Review the provider's tax correction evidence.",
  review_additional_liability_attribution:
    "Attribute later payroll payments or remittances.",
  correction_date_requires_one_open_period:
    "Choose a date in one open accounting period.",
  review_original_account_classification:
    "Review changed ledger account classifications.",
  no_accounting_change: "This register has no remaining accounting change.",
  job_cost_integer_capacity: "The cost exceeds the supported posting amount.",
  review_unknown_project_status: "Resolve the project's lifecycle status.",
};
const componentName = (value: string) =>
  ({
    gross_variance: "Wages",
    employer_taxes: "Employer taxes",
    employer_benefits: "Employer benefits",
  })[value] ?? value;
type Choice = { budget: string; gmp: string; reason: string };
const identity = (cost: Detail["costs"][number]) =>
  JSON.stringify([
    cost.workerId,
    cost.allocationId,
    cost.projectId,
    cost.costCodeId,
    cost.accountId,
    cost.component,
  ]);

export function PayrollCorrectionWorkspace({
  initial,
  initialDetail = null,
  initialError = null,
}: {
  initial: Workspace;
  initialDetail?: Detail | null;
  initialError?: string | null;
}) {
  const [workspace, setWorkspace] = useState(initial),
    [detail, setDetail] = useState<Detail | null>(initialDetail),
    [notes, setNotes] = useState(""),
    [choices, setChoices] = useState<Record<string, Choice>>({}),
    [preview, setPreview] = useState<{
      blocked: boolean;
      messages: string[];
    } | null>(null),
    [error, setError] = useState<string | null>(initialError),
    [pending, startTransition] = useTransition();
  const intents = useRef(new Map<string, { id: string; key: string }>());
  const [serverSource, setServerSource] = useState({
    initial,
    initialDetail,
    initialError,
    localSourceId: null as string | null,
  });
  const [refreshedSource, setRefreshedSource] = useState<{
    source: typeof serverSource;
    failed: boolean;
  } | null>(null);
  if (
    serverSource.initial !== initial ||
    serverSource.initialDetail !== initialDetail ||
    serverSource.initialError !== initialError
  ) {
    setServerSource({
      initial,
      initialDetail,
      initialError,
      localSourceId:
        !initialDetail && !serverSource.initialDetail
          ? detail?.sourceId ?? null
          : null,
    });
    setWorkspace(initial);
    setError(initialError);
    setPreview(null);
    if (initialDetail || serverSource.initialDetail) {
      setDetail(initialDetail);
      if (initialDetail?.sourceId !== detail?.sourceId) {
        setNotes("");
        setChoices({});
      }
    }
  }
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const currentSource = useRef(serverSource);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    currentSource.current = serverSource;
    const sourceId = serverSource.localSourceId;
    if (!sourceId) return;
    let active = true;
    const refreshSelected = async () => {
      try {
        const response = await loadProjectPayrollCorrectionAction({
          projectId: serverSource.initial.projectId,
          sourceId,
        });
        if (!active || !mounted.current) return;
        setDetail(unwrapAction(response));
        setPreview(null);
        setRefreshedSource({ source: serverSource, failed: false });
      } catch (failure) {
        if (!active || !mounted.current) return;
        setError(
          failure instanceof Error
            ? failure.message
            : "The selected register could not be refreshed",
        );
        setRefreshedSource({ source: serverSource, failed: true });
      }
    };
    void refreshSelected();
    return () => {
      active = false;
    };
  }, [serverSource]);
  const refreshing =
    !!serverSource.localSourceId && refreshedSource?.source !== serverSource;
  const refreshFailed =
    !!serverSource.localSourceId &&
    refreshedSource?.source === serverSource &&
    refreshedSource.failed;
  const busy = pending || refreshing || refreshFailed;
  const run = (work: () => Promise<void>) => {
    if (!mounted.current || inFlight.current || refreshing || refreshFailed) return;
    inFlight.current = true;
    startTransition(async () => {
      setError(null);
      try {
        await work();
      } catch (e) {
        if (!mounted.current || currentSource.current !== serverSource) return;
        const message =
          e instanceof SyntaxError
            ? "The response could not be read. Retry this action to check its saved result."
            : e instanceof Error
              ? e.message
              : "Payroll review could not be completed";
        setError(message);
        toast.error(message);
      } finally {
        inFlight.current = false;
      }
    });
  };
  const select = async (sourceId: string) => {
    if (!mounted.current || currentSource.current !== serverSource) return;
    const response = await loadProjectPayrollCorrectionAction({
      projectId: workspace.projectId,
      sourceId,
    });
    if (!mounted.current || currentSource.current !== serverSource) return;
    const next = unwrapAction(response);
    setDetail(next);
    setNotes("");
    setChoices({});
    setPreview(null);
  };
  const refresh = async (sourceId: string) => {
    if (!mounted.current || currentSource.current !== serverSource) return;
    const response = await loadProjectPayrollCorrectionsAction(
      workspace.projectId,
    );
    if (!mounted.current || currentSource.current !== serverSource) return;
    const next = unwrapAction(response);
    setWorkspace(next);
    await select(sourceId);
  };
  const loadOlder = async () => {
    if (!workspace.nextCursor) return;
    const response = await loadProjectPayrollCorrectionsAction(
      workspace.projectId,
      workspace.nextCursor,
    );
    if (!mounted.current || currentSource.current !== serverSource) return;
    const next = unwrapAction(response);
    const seen = new Set(workspace.sources.map((source) => source.id));
    setWorkspace({
      ...next,
      sources: [
        ...workspace.sources,
        ...next.sources.filter((source) => !seen.has(source.id)),
      ],
    });
  };
  const needed =
    detail?.costs.filter((cost) =>
      cost.blockers.includes("review_new_or_reallocated_budget_and_gmp"),
    ) ?? [];
  const decisions = () =>
    payrollCorrectionConstructionDecisionsSchema.parse(
      needed.map((cost) => {
        const choice = choices[identity(cost)];
        if (!choice?.budget || !choice.gmp)
          throw new Error(
            "Select budget placement and GMP classification for every new cost leg",
          );
        return {
          ...Object.fromEntries(
            [
              "workerId",
              "allocationId",
              "projectId",
              "costCodeId",
              "accountId",
              "component",
            ].map((key) => [key, cost[key as keyof typeof cost]]),
          ),
          budgetLineId: choice.budget === "unbudgeted" ? null : choice.budget,
          gmpClassification: choice.gmp,
          billingTreatment: "preserve_time_and_materials_rates",
          reason: choice.reason,
        };
      }),
    );
  const intent = (signature: string) => {
    let value = intents.current.get(signature);
    if (!value) {
      const id = crypto.randomUUID();
      value = { id, key: `payroll-workflow-${id}` };
      intents.current.set(signature, value);
    }
    return value;
  };
  const updateChoice = (
    cost: Detail["costs"][number],
    patch: Partial<Choice>,
  ) => {
    setChoices((current) => ({
      ...current,
      [identity(cost)]: {
        ...(current[identity(cost)] ?? { budget: "", gmp: "", reason: "" }),
        ...patch,
      },
    }));
    setPreview(null);
  };
  const messages = [
    ...new Set([
      ...(detail?.blockers ?? []),
      ...(detail?.costs.flatMap((cost) => cost.blockers) ?? []),
    ]),
  ];
  const actionable =
    !!detail && !detail.receipt && detail.sourceStatus === "reviewed";
  return (
    <div className="space-y-6">
      <div className="border-b pb-4">
        <p className="text-sm text-muted-foreground">
          Review corrected provider registers with their job costs. Corrections
          may affect several projects; the review below covers the entire
          payroll run.
        </p>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {refreshing && (
        <p role="status" className="text-sm text-muted-foreground">
          Refreshing the selected register…
        </p>
      )}
      {refreshFailed && (
        <Button
          variant="outline"
          onClick={() => {
            setError(null);
            setServerSource({ ...serverSource });
          }}
        >
          Retry register refresh
        </Button>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(220px,280px)_minmax(0,1fr)]">
        <aside aria-label="Corrected provider registers" className="space-y-2">
          {workspace.sources.length === 0 ? (
            <p className="rounded-md border border-dashed p-5 text-sm text-muted-foreground">
              No corrected provider registers have been prepared for this
              project's payroll.
            </p>
          ) : (
            workspace.sources.map((source) => (
              <button
                key={source.id}
                type="button"
                disabled={busy}
                aria-pressed={detail?.sourceId === source.id}
                onClick={() => run(() => select(source.id))}
                className={`w-full rounded-md border p-4 text-left transition-colors hover:bg-muted/50 ${detail?.sourceId === source.id ? "border-primary bg-muted/40" : "border-border"}`}
              >
                <span className="flex items-center justify-between gap-2 text-xs uppercase tracking-wide text-muted-foreground">
                  <span>{source.provider}</span>
                  <span>{source.status}</span>
                </span>
                <span className="mt-2 block font-medium">
                  {source.runReference}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {source.periodStart} – {source.periodEnd} · revision{" "}
                  {source.revision}
                </span>
                <span className="mt-2 block text-sm">{source.reason}</span>
              </button>
            ))
          )}
          {workspace.nextCursor && (
            <Button
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() => run(loadOlder)}
            >
              Load older registers
            </Button>
          )}
        </aside>
        {!detail ? (
          <div className="flex min-h-64 items-center justify-center rounded-md border border-dashed p-6 text-sm text-muted-foreground">
            Select a register to review its source, cost placement and posting.
          </div>
        ) : (
          <section
            aria-label="Payroll correction review"
            className="min-w-0 space-y-6"
          >
            <header>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-xl font-semibold">{detail.runReference}</h2>
                <span className="rounded-md border px-2 py-1 text-xs">
                  {detail.receipt
                    ? `Posted · correction ${detail.receipt.sequence}`
                    : (detail.proposal?.status ?? detail.sourceStatus)}
                </span>
              </div>
              <p className="mt-2 text-sm">{detail.reason}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Accounting date {detail.accountingDate} ·{" "}
                {detail.sourceFileName}
              </p>
              <a
                href={`/api/books/payroll/documents/${detail.sourceFileId}/versions/${detail.sourceDocumentVersionId}`}
                className="mt-2 inline-block text-sm underline underline-offset-4"
              >
                Download original provider register
              </a>
            </header>
            <div className="grid grid-cols-2 gap-4 border-y py-4 sm:grid-cols-4">
              {[
                ["Corrected gross", detail.registerTotals.gross_cents],
                ["Corrected net pay", detail.registerTotals.net_cents],
                ["Cost change", detail.costDeltaCents],
                ["Remaining unpaid net", detail.remainingNetPayCents],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-1 font-mono text-lg tabular-nums">
                    {value === null
                      ? "—"
                      : formatPayrollReviewCents(Number(value))}
                  </p>
                </div>
              ))}
            </div>
            <details className="rounded-md border p-4">
              <summary className="cursor-pointer text-sm font-medium">
                Corrected provider amounts and allocations
              </summary>
              <div className="mt-4 space-y-3">
                {detail.workers.map((worker) => (
                  <div key={worker.id} className="border-t pt-3 text-sm">
                    <div className="flex justify-between gap-3">
                      <span>{worker.reference}</span>
                      <span className="font-mono tabular-nums">
                        Gross {formatPayrollReviewCents(worker.grossCents)} ·
                        net {formatPayrollReviewCents(worker.netCents)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Employee taxes{" "}
                      {formatPayrollReviewCents(worker.employeeTaxesCents)} ·
                      deductions{" "}
                      {formatPayrollReviewCents(worker.employeeDeductionsCents)}{" "}
                      · employer taxes{" "}
                      {formatPayrollReviewCents(worker.employerTaxesCents)} ·
                      benefits{" "}
                      {formatPayrollReviewCents(worker.employerBenefitsCents)}
                    </p>
                    {worker.allocations.map((allocation) => (
                      <p
                        key={allocation.id}
                        className="mt-1 text-xs text-muted-foreground"
                      >
                        {allocation.projectName} · account{" "}
                        {allocation.accountCode} · wages{" "}
                        {formatPayrollReviewCents(allocation.grossCents)} ·
                        employer taxes{" "}
                        {formatPayrollReviewCents(
                          allocation.employerTaxesCents,
                        )}{" "}
                        · benefits{" "}
                        {formatPayrollReviewCents(
                          allocation.employerBenefitsCents,
                        )}
                      </p>
                    ))}
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  Funding control{" "}
                  {formatPayrollReviewCents(
                    detail.registerTotals.funding_cents,
                  )}{" "}
                  · employee taxes{" "}
                  {formatPayrollReviewCents(
                    detail.registerTotals.employee_taxes_cents,
                  )}{" "}
                  · deductions{" "}
                  {formatPayrollReviewCents(
                    detail.registerTotals.employee_deductions_cents,
                  )}{" "}
                  · employer taxes{" "}
                  {formatPayrollReviewCents(
                    detail.registerTotals.employer_taxes_cents,
                  )}{" "}
                  · benefits{" "}
                  {formatPayrollReviewCents(
                    detail.registerTotals.employer_benefits_cents,
                  )}
                </p>
              </div>
            </details>
            {detail.sourceReviewNotes && (
              <div className="rounded-md border p-4 text-sm">
                <h3 className="font-medium">Provider source review</h3>
                <p className="mt-2">{detail.sourceReviewNotes}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {detail.sourceReviewedAt}
                </p>
              </div>
            )}
            {detail.currentError && (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 p-3 text-sm text-destructive"
              >
                {detail.currentError}
              </p>
            )}
            {messages.length > 0 && (
              <div className="rounded-md border p-4">
                <h3 className="text-sm font-medium">Decisions needed</h3>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {messages.map((message) => (
                    <li key={message}>
                      {blockerLabels[message] ??
                        "Additional accounting review is required before posting."}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {detail.costs.length > 0 && (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <caption className="sr-only">
                    Signed project cost changes for the entire correction
                  </caption>
                  <thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="p-3">Project / worker</th>
                      <th className="p-3">Cost</th>
                      <th className="p-3">Placement</th>
                      <th className="p-3 text-right">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.costs.map((cost) => (
                      <tr
                        key={identity(cost)}
                        className="border-b last:border-0"
                      >
                        <td className="p-3">
                          <Link
                            className="font-medium hover:underline"
                            href={`/projects/${cost.projectId}/financials`}
                          >
                            {cost.projectName}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {cost.workerReference}
                          </p>
                        </td>
                        <td className="p-3">
                          {componentName(cost.component)}
                          <p className="text-xs text-muted-foreground">
                            {cost.costCodeLabel} · account {cost.accountCode}
                          </p>
                        </td>
                        <td className="p-3 text-xs">
                          {cost.budgetLineId
                            ? (detail.budgetLines.find(
                                (b) => b.id === cost.budgetLineId,
                              )?.label ?? "Reviewed budget line")
                            : cost.blockers.includes(
                                  "review_new_or_reallocated_budget_and_gmp",
                                )
                              ? "Select placement"
                              : "Unbudgeted"}
                          <p className="text-muted-foreground">
                            {cost.gmpClassification?.replaceAll("_", " ") ??
                              "Placement needs review"}
                          </p>
                        </td>
                        <td className="whitespace-nowrap p-3 text-right font-mono tabular-nums">
                          {formatPayrollReviewCents(cost.costCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {actionable && !detail.proposal && needed.length > 0 && (
              <fieldset
                disabled={busy}
                className="space-y-4 rounded-md border p-4"
              >
                <legend className="px-1 text-sm font-medium">
                  New cost placement
                </legend>
                <p className="text-xs text-muted-foreground">
                  Choose each destination budget and GMP treatment. Customer
                  hours and rates stay unchanged; billing-policy decisions must
                  be resolved separately.
                </p>
                {needed.map((cost, index) => (
                  <div key={identity(cost)} className="space-y-3 border-t pt-3">
                    <p className="text-sm font-medium">
                      {cost.projectName} · {cost.workerReference} ·{" "}
                      {componentName(cost.component)} ·{" "}
                      {formatPayrollReviewCents(cost.costCents)}
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <Label htmlFor={`budget-${index}`}>
                          Budget placement
                        </Label>
                        <select
                          id={`budget-${index}`}
                          className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                          value={choices[identity(cost)]?.budget ?? ""}
                          onChange={(e) =>
                            updateChoice(cost, { budget: e.target.value })
                          }
                        >
                          <option value="">Select placement</option>
                          <option value="unbudgeted">
                            Explicitly unbudgeted
                          </option>
                          {detail.budgetLines
                            .filter(
                              (b) =>
                                b.projectId === cost.projectId &&
                                b.costCodeId === cost.costCodeId,
                            )
                            .map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.label}
                              </option>
                            ))}
                        </select>
                      </div>
                      <div>
                        <Label htmlFor={`gmp-${index}`}>
                          GMP classification
                        </Label>
                        <select
                          id={`gmp-${index}`}
                          className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                          value={choices[identity(cost)]?.gmp ?? ""}
                          onChange={(e) =>
                            updateChoice(cost, { gmp: e.target.value })
                          }
                        >
                          <option value="">Select classification</option>
                          <option value="inside_gmp">Inside GMP</option>
                          <option value="outside_gmp">Outside GMP</option>
                        </select>
                      </div>
                    </div>
                    <Label htmlFor={`reason-${index}`}>
                      Placement explanation
                    </Label>
                    <Textarea
                      id={`reason-${index}`}
                      minLength={20}
                      maxLength={4000}
                      value={choices[identity(cost)]?.reason ?? ""}
                      onChange={(e) =>
                        updateChoice(cost, { reason: e.target.value })
                      }
                    />
                  </div>
                ))}
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const response = await previewProjectPayrollPlacementAction({
                          projectId: workspace.projectId,
                          sourceId: detail.sourceId,
                          constructionDecisions: decisions(),
                        });
                      if (!mounted.current || currentSource.current !== serverSource) return;
                      const result = unwrapAction(response);
                      setPreview({
                        blocked:
                          result.requiresConstructionReview ||
                          result.blockers.length > 0,
                        messages: [
                          ...new Set([
                            ...result.blockers,
                            ...result.projectCosts.flatMap(
                              (c) => c.blockers as string[],
                            ),
                          ]),
                        ],
                      });
                    })
                  }
                >
                  Check placement
                </Button>
                {preview && (
                  <p role="status" className="text-sm">
                    {preview.blocked
                      ? preview.messages
                          .map(
                            (m) =>
                              blockerLabels[m] ??
                              "Additional accounting review required.",
                          )
                          .join(" ")
                      : "Placement checks passed. Prepare the proposal for independent monetary review."}
                  </p>
                )}
              </fieldset>
            )}
            {detail.proposal && (
              <div className="rounded-md border p-4 text-sm">
                <h3 className="font-medium">Monetary review</h3>
                <p className="mt-2">{detail.proposal.preparationNotes}</p>
                {detail.proposal.reviewNotes && (
                  <p className="mt-2 text-muted-foreground">
                    Reviewed: {detail.proposal.reviewNotes}
                  </p>
                )}
                {detail.proposal.constructionDecisions?.map((choice, index) => (
                  <p key={index} className="mt-2 text-xs text-muted-foreground">
                    {componentName(choice.component)} ·{" "}
                    {choice.gmpClassification.replaceAll("_", " ")} ·{" "}
                    {choice.reason}
                  </p>
                ))}
              </div>
            )}
            {detail.reviewHistory.some((row) => row.status === "withdrawn") && (
              <details className="rounded-md border p-4">
                <summary className="cursor-pointer text-sm font-medium">
                  Monetary review history
                </summary>
                <div className="mt-3 space-y-3">
                  {detail.reviewHistory.map((row) => (
                    <div key={row.id} className="border-t pt-3 text-sm">
                      <p className="font-medium">
                        {row.status} · {row.preparedAt}
                      </p>
                      <p className="mt-1">{row.preparationNotes}</p>
                      {row.reviewNotes && (
                        <p className="mt-1 text-muted-foreground">
                          Reviewed {row.reviewedAt}: {row.reviewNotes}
                        </p>
                      )}
                      {row.withdrawalReason && (
                        <p className="mt-1 text-muted-foreground">
                          Withdrawn: {row.withdrawalReason}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}
            {detail.receipt ? (
              <div className="rounded-md border p-4 text-sm">
                <h3 className="font-medium">Recorded in Books</h3>
                <p className="mt-2">{detail.receipt.notes}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {detail.receipt.postedAt} · journal {detail.receipt.journalId}
                </p>
              </div>
            ) : (
              detail.sourceStatus !== "withdrawn" && (
                <div className="space-y-3 border-t pt-4">
                  <Label htmlFor="payroll-review-notes">
                    Review or posting explanation
                  </Label>
                  <Textarea
                    id="payroll-review-notes"
                    value={notes}
                    maxLength={4000}
                    minLength={10}
                    disabled={busy}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                  <div className="flex flex-wrap gap-2">
                    {detail.sourceStatus === "draft" && (
                      <Button
                        disabled={
                          busy ||
                          !detail.canReviewSource ||
                          notes.trim().length < 10
                        }
                        onClick={() =>
                          run(async () => {
                            unwrapAction(
                              await reviewProjectPayrollSourceAction({
                                projectId: workspace.projectId,
                                sourceId: detail.sourceId,
                                notes,
                              }),
                            );
                            if (!mounted.current) return;
                            toast.success("Provider source reviewed");
                            await refresh(detail.sourceId);
                          })
                        }
                      >
                        Review provider source
                      </Button>
                    )}
                    {actionable && !detail.proposal && (
                      <Button
                        disabled={
                          busy ||
                          notes.trim().length < 10 ||
                          !!detail.currentError ||
                          (needed.length > 0
                            ? !preview || preview.blocked
                            : !detail.ready)
                        }
                        onClick={() =>
                          run(async () => {
                            const selected = needed.length
                                ? decisions()
                                : undefined,
                              request = intent(
                                JSON.stringify([
                                  detail.sourceId,
                                  "prepare",
                                  notes,
                                  selected,
                                ]),
                              );
                            unwrapAction(
                              await prepareProjectPayrollProposalAction({
                                projectId: workspace.projectId,
                                sourceId: detail.sourceId,
                                id: request.id,
                                notes,
                                idempotencyKey: request.key,
                                constructionDecisions: selected,
                              }),
                            );
                            if (!mounted.current) return;
                            toast.success(
                              "Proposal prepared for independent review",
                            );
                            await refresh(detail.sourceId);
                          })
                        }
                      >
                        Prepare monetary proposal
                      </Button>
                    )}
                    {detail.proposal?.status === "draft" && (
                      <Button
                        disabled={
                          busy ||
                          !detail.proposal.canReview ||
                          !detail.ready ||
                          notes.trim().length < 10
                        }
                        onClick={() =>
                          run(async () => {
                            unwrapAction(
                              await reviewProjectPayrollProposalAction({
                                projectId: workspace.projectId,
                                proposalId: detail.proposal!.id,
                                notes,
                              }),
                            );
                            if (!mounted.current) return;
                            toast.success("Monetary proposal reviewed");
                            await refresh(detail.sourceId);
                          })
                        }
                      >
                        Review monetary proposal
                      </Button>
                    )}
                    {detail.proposal?.status === "reviewed" && (
                      <Button
                        disabled={
                          busy || !detail.ready || notes.trim().length < 10
                        }
                        onClick={() =>
                          run(async () => {
                            const request = intent(
                              JSON.stringify([
                                detail.sourceId,
                                "post",
                                detail.proposal!.id,
                                detail.proposal!.digest,
                                notes,
                              ]),
                            );
                            unwrapAction(
                              await postProjectPayrollProposalAction({
                                projectId: workspace.projectId,
                                proposalId: detail.proposal!.id,
                                id: request.id,
                                planDigest: detail.proposal!.digest,
                                notes,
                                idempotencyKey: request.key,
                              }),
                            );
                            if (!mounted.current) return;
                            toast.success("Correction posted in Books");
                            await refresh(detail.sourceId);
                          })
                        }
                      >
                        Post reviewed correction
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      disabled={busy || notes.trim().length < 10}
                      onClick={() =>
                        run(async () => {
                          unwrapAction(
                            await withdrawProjectPayrollSourceAction({
                              projectId: workspace.projectId,
                              sourceId: detail.sourceId,
                              notes,
                            }),
                          );
                          toast.success(
                            "Provider source withdrawn; review history preserved",
                          );
                          await refresh(detail.sourceId);
                        })
                      }
                    >
                      Withdraw provider source
                    </Button>
                    {detail.proposal && (
                      <Button
                        variant="outline"
                        disabled={busy || notes.trim().length < 10}
                        onClick={() =>
                          run(async () => {
                            unwrapAction(
                              await withdrawProjectPayrollProposalAction({
                                projectId: workspace.projectId,
                                proposalId: detail.proposal!.id,
                                notes,
                              }),
                            );
                            if (!mounted.current) return;
                            toast.success(
                              "Proposal withdrawn; review history preserved",
                            );
                            await refresh(detail.sourceId);
                          })
                        }
                      >
                        Withdraw proposal
                      </Button>
                    )}
                  </div>
                  {((detail.sourceStatus === "draft" &&
                    !detail.canReviewSource) ||
                    (detail.proposal?.status === "draft" &&
                      !detail.proposal.canReview)) && (
                    <p className="text-xs text-muted-foreground">
                      A separate reviewer with organization-wide accounting
                      access must complete this review.
                    </p>
                  )}
                  {pending && (
                    <p role="status" className="text-xs text-muted-foreground">
                      Checking payroll evidence…
                    </p>
                  )}
                </div>
              )
            )}
          </section>
        )}
      </div>
    </div>
  );
}
