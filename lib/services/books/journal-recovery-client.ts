"use client";
import {
  proposeAdjustingJournalAction,
  reviewJournalProposalAction,
  resolveJournalRecoveryAction,
} from "@/app/(app)/books/actions";
import {
  clearJournalRecovery,
  journalRecoveryKey,
  persistJournalRecovery,
  persistJournalResolution,
  validateJournalRecoveryReceipt,
  type JournalRecovery,
  type JournalRecoveryScope,
} from "@/lib/services/books/journal-recovery";
export const JOURNAL_RECOVERY_EVENT = "arc:books-journal-recovery-changed";
/** Storage and cross-tab locking must work before the money-related action runs. */
export async function executeJournalRecovery(
  scope: JournalRecoveryScope,
  record: JournalRecovery,
) {
  if (!navigator.locks)
    throw new Error(
      "This browser cannot coordinate journal recovery across tabs. Use a browser with Web Locks support.",
    );
  return navigator.locks.request(journalRecoveryKey(scope), async () => {
    const saved = persistJournalRecovery(window.localStorage, scope, record);
    window.dispatchEvent(new Event(JOURNAL_RECOVERY_EVENT));
    const result =
      saved.kind === "prepare"
        ? await proposeAdjustingJournalAction(saved.request)
        : await reviewJournalProposalAction(saved.request);
    if (!result.success)
      throw new Error(
        result.error ??
          "Journal result could not be confirmed. Recover the original request.",
      );
    const receipt = validateJournalRecoveryReceipt(scope, saved, result.data);
    clearJournalRecovery(window.localStorage, scope, saved);
    window.dispatchEvent(new Event(JOURNAL_RECOVERY_EVENT));
    return receipt;
  });
}

export async function resolveJournalRecoveryRequest(
  scope: JournalRecoveryScope,
  record: JournalRecovery,
  resolution: { id: string; reason: string },
) {
  if (!navigator.locks)
    throw new Error(
      "This browser cannot coordinate journal recovery across tabs. Use a browser with Web Locks support.",
    );
  return navigator.locks.request(journalRecoveryKey(scope), async () => {
    const saved = persistJournalResolution(
      window.localStorage,
      scope,
      record,
      resolution,
    );
    window.dispatchEvent(new Event(JOURNAL_RECOVERY_EVENT));
    const result = await resolveJournalRecoveryAction({
      resolutionId: saved.resolution!.id,
      reason: saved.resolution!.reason,
      record: saved,
    });
    if (!result.success)
      throw new Error(
        result.error ??
          "Resolution could not be confirmed. Retry the original saved decision.",
      );
    const receipt = result.data;
    if (
      receipt.orgId !== scope.orgId ||
      receipt.actorId !== scope.actorId ||
      receipt.id !== saved.resolution!.id ||
      receipt.kind !== saved.kind ||
      ![
        "cancelled_preparation",
        "cancelled_review",
        "acknowledged_original_review",
        "acknowledged_superseded_review",
      ].includes(receipt.resolution)
    )
      throw new Error("Resolution receipt belongs to another request");
    // The server validates the exact hashed JSON; the client independently binds
    // its parsed original fields and resolution identity before deleting recovery.
    const canonical = (v: unknown): string => {
      if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
      if (v && typeof v === "object")
        return (
          "{" +
          Object.keys(v)
            .sort()
            .map(
              (k) =>
                JSON.stringify(k) +
                ":" +
                canonical((v as Record<string, unknown>)[k]),
            )
            .join(",") +
          "}"
        );
      return JSON.stringify(v);
    };
    if (
      canonical(JSON.parse(receipt.requestText)) !==
        canonical(JSON.parse(JSON.stringify(saved.request))) ||
      (saved.kind === "prepare") !==
        (receipt.resolution === "cancelled_preparation")
    )
      throw new Error(
        "Resolution receipt differs from the saved original request",
      );
    clearJournalRecovery(window.localStorage, scope, saved);
    window.dispatchEvent(new Event(JOURNAL_RECOVERY_EVENT));
    return receipt;
  });
}
