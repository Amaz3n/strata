"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatMoneyCentsExact } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  readJournalRecovery,
  journalRecoveryKey,
  type JournalRecovery,
  type JournalRecoveryScope,
} from "@/lib/services/books/journal-recovery";
import {
  executeJournalRecovery,
  resolveJournalRecoveryRequest,
  JOURNAL_RECOVERY_EVENT,
} from "@/lib/services/books/journal-recovery-client";

export function JournalRecoveryPanel({
  scope,
  onRecovered,
  onBlockedChange,
}: {
  scope: JournalRecoveryScope;
  onRecovered: () => void;
  onBlockedChange: (blocked: boolean) => void;
}) {
  const [saved, setSaved] = useState<JournalRecovery | null>(null),
    [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState(false);
  const [reason, setReason] = useState("");
  const inflight = useRef(false);
  const load = useCallback(() => {
    try {
      const record = readJournalRecovery(window.localStorage, scope);
      setSaved(record);
      setError(null);
      onBlockedChange(Boolean(record));
    } catch {
      setSaved(null);
      setError(
        "The saved journal request could not be read. New submissions are unavailable until recovery is resolved.",
      );
      onBlockedChange(true);
    }
  }, [scope, onBlockedChange]);
  useEffect(() => {
    load();
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === journalRecoveryKey(scope)) load();
    };
    window.addEventListener(JOURNAL_RECOVERY_EVENT, load);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener(JOURNAL_RECOVERY_EVENT, load);
      window.removeEventListener("storage", storage);
    };
  }, [load, scope]);
  const recover = async () => {
    if (!saved || inflight.current) return;
    inflight.current = true;
    setPending(true);
    setError(null);
    try {
      await executeJournalRecovery(scope, saved);
      load();
      onRecovered();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Journal recovery result could not be confirmed.",
      );
    } finally {
      inflight.current = false;
      setPending(false);
    }
  };
  const resolve = async () => {
    if (!saved || inflight.current) return;
    if (!saved.resolution && reason.trim().length < 4) {
      setError("Explain the resolution in at least four characters.");
      return;
    }
    inflight.current = true;
    setPending(true);
    setError(null);
    try {
      await resolveJournalRecoveryRequest(
        scope,
        saved,
        saved.resolution ?? { id: crypto.randomUUID(), reason: reason.trim() },
      );
      load();
      onRecovered();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Resolution could not be confirmed. Retry the saved decision.",
      );
    } finally {
      inflight.current = false;
      setPending(false);
    }
  };
  if (!saved && !error) return null;
  return (
    <aside
      className="shrink-0 space-y-3 border-b bg-muted/20 px-5 py-4"
      aria-label="Saved journal recovery"
    >
      <p className="text-sm font-medium">
        {saved?.kind === "review"
          ? "A journal review needs confirmation"
          : "A journal submission needs confirmation"}
      </p>
      {saved && (
        <>
          <p className="text-xs text-muted-foreground">
            {saved.kind === "prepare"
              ? `${saved.request.entryDate} · ${saved.request.memo}`
              : `${saved.request.decision === "approve" ? "Approval" : "Rejection"} · Proposal ${saved.request.proposalId}`}
          </p>
          <details>
            <summary className="cursor-pointer text-xs font-medium">
              Inspect the original saved request
            </summary>
            {saved.kind === "prepare" ? (
              <div className="mt-3 overflow-x-auto">
                <p className="mb-2 text-xs">
                  {saved.request.reversingOn
                    ? `Automatic reversal: ${saved.request.reversingOn}`
                    : "No automatic reversal"}
                </p>
                <table className="w-full text-left text-xs">
                  <caption className="sr-only">
                    Original submitted journal lines
                  </caption>
                  <thead>
                    <tr>
                      <th>Account and description</th>
                      <th className="text-right">Debit</th>
                      <th className="text-right">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {saved.request.lines.map((line, index) => (
                      <tr key={index} className="border-t">
                        <td className="py-2 pr-4">
                          {line.accountCode} ·{" "}
                          {line.description || "No line description"}
                          {line.projectId && <p>Project: {line.projectId}</p>}
                          {line.companyId && <p>Company: {line.companyId}</p>}
                          {line.dimensions &&
                            Object.entries(line.dimensions).map(
                              ([name, value]) => (
                                <p key={name} className="text-muted-foreground">
                                  {name}:{" "}
                                  {typeof value === "string"
                                    ? value
                                    : JSON.stringify(value)}
                                </p>
                              ),
                            )}
                        </td>
                        <td className="text-right font-mono">
                          {formatMoneyCentsExact(line.debitCents)}
                        </td>
                        <td className="text-right font-mono">
                          {formatMoneyCentsExact(line.creditCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-2 whitespace-pre-wrap text-xs">
                Review note: {saved.request.note || "No review note"}
              </p>
            )}
          </details>
          <p className="text-xs text-muted-foreground">
            Recovering confirms the original request. It preserves the same
            submission identity or review decision.
          </p>
        </>
      )}
      {saved && (
        <div className="space-y-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            Cancel a submission only after the database confirms it has not
            committed. For reviews, cancel the pending request or acknowledge
            the outcome that already resolved the proposal.
          </p>
          <label className="block space-y-1">
            <span className="text-xs font-medium">Resolution explanation</span>
            <Textarea
              maxLength={1000}
              value={saved.resolution?.reason ?? reason}
              disabled={pending || Boolean(saved.resolution)}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void resolve()}
          >
            {saved.resolution
              ? "Retry saved resolution"
              : saved.kind === "prepare"
                ? "Cancel uncommitted submission"
                : "Resolve saved review"}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={pending} onClick={load}>
          Reload saved request
        </Button>
        {saved && (
          <Button size="sm" disabled={pending} onClick={() => void recover()}>
            {pending
              ? "Confirming original request…"
              : "Recover original request"}
          </Button>
        )}
      </div>
    </aside>
  );
}
