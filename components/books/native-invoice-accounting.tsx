"use client";
import { useEffect, useState } from "react";
import {
  getBooksNativeInvoiceWorkspaceAction,
  previewBooksNativeProjectInvoiceAction,
} from "@/app/(app)/books/actions";
import { unwrapAction } from "@/lib/action-result";
import {
  readNativeInvoiceRecovery,
  type NativeInvoiceRecovery,
} from "@/lib/services/books/native-invoice-recovery";
import {
  executeNativeInvoiceRecovery,
  resolveSavedNativeInvoiceRecovery,
  NATIVE_INVOICE_RECOVERY_EVENT,
} from "@/lib/services/books/native-invoice-recovery-client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatMoneyFromCents } from "@/components/invoices/invoice-presentation";
import {
  readNativeInvoiceIncomeRecovery,
  type NativeInvoiceIncomeRecovery,
} from "@/lib/services/books/native-invoice-income-recovery";
import { executeNativeInvoiceIncomeRecovery } from "@/lib/services/books/native-invoice-income-recovery-client";

type Workspace = NonNullable<
  Extract<
    Awaited<ReturnType<typeof getBooksNativeInvoiceWorkspaceAction>>,
    { success: true }
  >["data"]
>;
type Preview = NonNullable<
  Extract<
    Awaited<ReturnType<typeof previewBooksNativeProjectInvoiceAction>>,
    { success: true }
  >["data"]
>;

/** Native money lives beside the invoice; never implies official activation. */
export function NativeInvoiceAccounting({
  invoiceId,
  revision,
}: {
  invoiceId: string;
  revision?: string;
}) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [pending, setPending] = useState<NativeInvoiceRecovery | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pendingIncome, setPendingIncome] =
    useState<NativeInvoiceIncomeRecovery | null>(null);
  const [incomeChoices, setIncomeChoices] = useState<Record<string, string>>(
    {},
  );
  const [incomeNotes, setIncomeNotes] = useState("");
  const [incomeReason, setIncomeReason] = useState("");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    setNotes("");
    setIncomeNotes("");
    setIncomeChoices({});
    setReason("");
    setIncomeReason("");
  }, [invoiceId]);
  useEffect(() => {
    let active = true;
    setWorkspace(null);
    setPreview(null);
    setPending(null);
    setPendingIncome(null);
    setError(null);
    getBooksNativeInvoiceWorkspaceAction({ invoiceId })
      .then((result) => {
        if (!active) return;
        const value = unwrapAction(result);
        setWorkspace(value);
        if (value.enabled && value.scope) {
          const saved = readNativeInvoiceRecovery(
            window.localStorage,
            value.scope,
          );
          setPending(saved);
          setReason(saved?.resolution?.reason ?? "");
          const coding = readNativeInvoiceIncomeRecovery(
            window.localStorage,
            value.scope,
          );
          setPendingIncome(coding);
          setIncomeReason(coding?.resolution?.reason ?? "");
        }
      })
      .catch((e) => {
        if (active)
          setError(
            e instanceof Error
              ? e.message
              : "Native invoice accounting is unavailable",
          );
      });
    return () => {
      active = false;
    };
  }, [invoiceId, revision, refresh]);
  useEffect(() => {
    const update = (event: Event) => {
      const key =
        event.type === "storage" ? (event as StorageEvent).key : undefined;
      if (
        (event.type === "storage" &&
          (key === null ||
            ((key?.startsWith("arc:native-invoice-request:v1:") ||
              key?.startsWith("arc:native-invoice-income-request:v1:")) &&
              key.includes(invoiceId)))) ||
        (event as CustomEvent).detail?.invoiceId === invoiceId
      )
        setRefresh((r) => r + 1);
    };
    window.addEventListener("storage", update);
    window.addEventListener(NATIVE_INVOICE_RECOVERY_EVENT, update);
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener(NATIVE_INVOICE_RECOVERY_EVENT, update);
    };
  }, [invoiceId]);
  if (workspace && !workspace.enabled) return null;
  async function operate(operation: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Invoice accounting request could not complete. Retain the saved request.",
      );
    } finally {
      setBusy(false);
    }
  }
  const ready = workspace?.enabled && workspace.scope ? workspace : null;
  async function inspect() {
    if (!ready?.scope || !ready.issueDate) return;
    const scope = ready.scope;
    const value = unwrapAction(
      await previewBooksNativeProjectInvoiceAction({
        expectedOrgId: scope.orgId,
        expectedActorId: scope.actorId,
        sourceType: "invoice",
        sourceId: scope.invoiceId,
        entryDate: ready.issueDate,
      }),
    );
    if (
      value.economic.native.projectId !== scope.projectId ||
      value.economic.native.owner.legal_entity_id !== scope.entityId
    )
      throw Error(
        "Invoice ownership changed. Refresh accounting before posting.",
      );
    setPreview(value);
    setIncomeChoices(
      Object.fromEntries(
        value.economic.lines
          .filter(
            (l) =>
              l.source.metadata?.system_generated_kind !== "retainage_hold",
          )
          .map((l) => [
            l.source.id,
            typeof l.source.metadata?.arc_books_entity_account_id === "string"
              ? l.source.metadata.arc_books_entity_account_id
              : "",
          ]),
      ),
    );
  }
  const pricedLines =
    preview?.economic.lines.filter(
      (l) => l.source.metadata?.system_generated_kind !== "retainage_hold",
    ) ?? [];
  const incomeAccounts =
    preview?.economic.native.accounts.filter(
      (a) => a.definition.account_type === "income",
    ) ?? [];
  const defaultIncome = preview
    ? incomeAccounts.find(
        (a) =>
          a.code ===
          JSON.parse(preview.economic.native.chart.definition_text).controls
            .constructionRevenue,
      )
    : undefined;
  const unsavedIncome = pricedLines.some(
    (l) =>
      (incomeChoices[l.source.id] ?? "") !==
      (l.source.metadata?.arc_books_entity_account_id ?? ""),
  );
  async function codeIncome(resolve = false) {
    if (!ready?.scope) return;
    let record = pendingIncome;
    if (!record) {
      if (
        !preview ||
        !pricedLines.length ||
        incomeNotes.trim().length < 10 ||
        pending
      )
        return;
      record = {
        version: 1,
        request: {
          id: crypto.randomUUID(),
          expectedOrgId: ready.scope.orgId,
          expectedActorId: ready.scope.actorId,
          economic: preview.economic,
          assignments: pricedLines.map((l) => ({
            lineId: l.source.id,
            accountId: incomeChoices[l.source.id] || null,
          })),
          notes: incomeNotes.trim(),
        },
      };
    }
    await executeNativeInvoiceIncomeRecovery(
      ready.scope,
      record,
      resolve
        ? (record.resolution ?? {
            id: crypto.randomUUID(),
            reason: incomeReason.trim(),
          })
        : undefined,
    );
    setPreview(null);
    setIncomeNotes("");
    setNotes("");
    setRefresh((r) => r + 1);
  }
  async function submit() {
    if (!ready?.scope) return;
    let record = pending;
    if (!record) {
      if (
        !preview?.plan ||
        notes.trim().length < 10 ||
        unsavedIncome ||
        pendingIncome
      )
        return;
      record = {
        version: 1,
        request: {
          expectedOrgId: ready.scope.orgId,
          expectedActorId: ready.scope.actorId,
          id: crypto.randomUUID(),
          entryId: crypto.randomUUID(),
          economic: preview.economic,
          notes: notes.trim(),
        },
      };
    }
    await executeNativeInvoiceRecovery(ready.scope, record);
    setPreview(null);
    setNotes("");
    setRefresh((r) => r + 1);
  }
  async function resolve() {
    if (!ready?.scope || !pending) return;
    await resolveSavedNativeInvoiceRecovery(
      ready.scope,
      pending,
      pending.resolution ?? { id: crypto.randomUUID(), reason: reason.trim() },
    );
    setPreview(null);
    setRefresh((r) => r + 1);
  }
  return (
    <section
      className="space-y-3 border-t pt-3"
      aria-label="Entity invoice accounting"
      aria-busy={busy}
    >
      <div>
        <h3 className="microlabel">Entity invoice accounting</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Native ledger preparation. Company ledger activation is still pending.
        </p>
      </div>
      {!workspace && !error ? (
        <p className="text-xs text-muted-foreground">
          Checking entity accounting…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {workspace?.enabled && !workspace.scope ? (
        <p className="text-xs text-muted-foreground">{workspace.reason}</p>
      ) : null}
      {ready?.posting?.posted ? (
        <div className="text-xs">
          <p className="font-medium">Native journal verified</p>
          <p className="mt-1 font-mono text-muted-foreground">
            {ready.posting.entry?.id}
          </p>
          <p className="mt-1">
            Journal debits{" "}
            {formatMoneyFromCents(ready.posting.entry?.total_cents ?? 0)} ·{" "}
            {ready.posting.entry?.entry_date}
          </p>
        </div>
      ) : null}
      {pendingIncome ? (
        <div className="space-y-3 border bg-muted/30 p-3 text-xs">
          <p className="font-medium">
            Saved income selection needs confirmation
          </p>
          <p>
            Recover the original selection or confirm its cancellation before
            changing accounts or posting this invoice.
          </p>
          <p className="break-all font-mono text-muted-foreground">
            {pendingIncome.request.id}
          </p>
          {pendingIncome.resolution ? (
            <p>Saved resolution: {pendingIncome.resolution.reason}</p>
          ) : (
            <Textarea
              aria-label="Income selection resolution explanation"
              value={incomeReason}
              onChange={(e) => setIncomeReason(e.target.value)}
              disabled={busy}
              maxLength={2000}
              placeholder="Explain why this saved selection should be resolved"
            />
          )}
          <div className="flex flex-wrap gap-2">
            {!pendingIncome.resolution ? (
              <Button
                size="sm"
                disabled={busy || !ready?.canPost}
                onClick={() => void operate(() => codeIncome())}
              >
                Recover original income selection
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy ||
                !ready?.canPost ||
                (!pendingIncome.resolution && incomeReason.trim().length < 10)
              }
              onClick={() => void operate(() => codeIncome(true))}
            >
              {pendingIncome.resolution
                ? "Recover saved income resolution"
                : "Resolve or cancel income selection"}
            </Button>
          </div>
        </div>
      ) : null}
      {pending ? (
        <div className="space-y-3 border bg-muted/30 p-3 text-xs">
          <p className="font-medium">
            Saved accounting request needs confirmation
          </p>
          <p>
            Recover this original request before preparing another posting.
            Confirmation may return its original journal or cancel it before any
            posting.
          </p>
          <p className="break-all font-mono text-muted-foreground">
            {pending.request.id}
          </p>
          {pending.resolution ? (
            <p>Saved resolution: {pending.resolution.reason}</p>
          ) : (
            <Textarea
              aria-label="Accounting request resolution explanation"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
              placeholder="Explain why this saved request should be resolved"
              maxLength={2000}
            />
          )}
          <div className="flex flex-wrap gap-2">
            {!pending.resolution ? (
              <Button
                size="sm"
                disabled={busy || !ready?.canPost}
                onClick={() => void operate(submit)}
              >
                Recover original posting
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy ||
                !ready?.canPost ||
                (!pending.resolution && reason.trim().length < 10)
              }
              onClick={() => void operate(resolve)}
            >
              {pending.resolution
                ? "Recover saved resolution"
                : "Resolve or cancel request"}
            </Button>
          </div>
        </div>
      ) : ready?.canPost &&
        !ready.posting?.posted &&
        !error &&
        !pendingIncome ? (
        <div className="space-y-3">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !ready.issueDate}
            onClick={() => void operate(inspect)}
          >
            Review native posting
          </Button>
          {preview ? (
            preview.plan ? (
              <>
                {pricedLines.length ? (
                  <fieldset
                    className="space-y-3 rounded-md border p-3"
                    disabled={busy}
                  >
                    <legend className="px-1 text-xs font-medium">
                      Income accounts
                    </legend>
                    <p className="text-xs text-muted-foreground">
                      Choose accounts from the reviewed entity chart. Revenue
                      timing follows the project policy; progress billing
                      remains deferred.
                    </p>
                    {pricedLines.map((line, index) => (
                      <label
                        key={line.source.id}
                        className="grid gap-1 text-xs"
                      >
                        <span>
                          Invoice line {index + 1}
                          {line.quantity != null &&
                          line.source.unit_price_cents != null
                            ? ` · ${line.quantity} × ${formatMoneyFromCents(line.source.unit_price_cents)}`
                            : ""}
                        </span>
                        <select
                          className="h-9 w-full rounded-md border bg-background px-2"
                          aria-label={`Income account for invoice line ${index + 1}`}
                          value={incomeChoices[line.source.id] ?? ""}
                          onChange={(e) =>
                            setIncomeChoices((c) => ({
                              ...c,
                              [line.source.id]: e.target.value,
                            }))
                          }
                        >
                          <option value="">
                            Default ·{" "}
                            {defaultIncome
                              ? `${defaultIncome.code} · ${defaultIncome.definition.name}`
                              : "Construction revenue"}
                          </option>
                          {incomeAccounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.code} · {a.definition.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                    <Textarea
                      aria-label="Income account selection explanation"
                      value={incomeNotes}
                      onChange={(e) => setIncomeNotes(e.target.value)}
                      maxLength={2000}
                      placeholder="Explain these income account choices"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || incomeNotes.trim().length < 10}
                      onClick={() => void operate(() => codeIncome())}
                    >
                      Save income accounts
                    </Button>
                    {unsavedIncome ? (
                      <p className="text-xs text-muted-foreground">
                        Save account choices, then review the updated journal
                        before posting.
                      </p>
                    ) : null}
                  </fieldset>
                ) : null}
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <caption className="pb-2 text-left text-muted-foreground">
                      {
                        {
                          progress_billing: "Progress billing",
                          closing_revenue: "Closing revenue",
                          retainage_release: "Retainage release",
                          collection_request: "Collection request",
                        }[preview.disposition]
                      }{" "}
                      · {preview.plan.entryDate}
                    </caption>
                    <thead>
                      <tr>
                        <th className="text-left">Account</th>
                        <th className="text-right">Debit</th>
                        <th className="text-right">Credit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.plan.lines.map((line, index) => (
                        <tr key={index} className="border-t">
                          <td className="py-2">
                            {(() => {
                              const account =
                                preview.economic.native.accounts.find(
                                  (a) => a.id === line.accountId,
                                );
                              return account
                                ? `${account.code} · ${account.definition.name}`
                                : line.accountId;
                            })()}
                          </td>
                          <td className="text-right tabular-nums">
                            {formatMoneyFromCents(line.debitCents)}
                          </td>
                          <td className="text-right tabular-nums">
                            {formatMoneyFromCents(line.creditCents)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Textarea
                  aria-label="Native invoice posting explanation"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  disabled={busy}
                  maxLength={2000}
                  placeholder="Explain this accounting posting"
                />
                <Button
                  size="sm"
                  disabled={
                    busy ||
                    notes.trim().length < 10 ||
                    unsavedIncome ||
                    !!pendingIncome
                  }
                  onClick={() => void operate(submit)}
                >
                  Post native journal
                </Button>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                This is a collection request. Revenue is recorded through the
                collection workflow.
              </p>
            )
          ) : null}
        </div>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => setRefresh((r) => r + 1)}
      >
        Refresh accounting
      </Button>
    </section>
  );
}
