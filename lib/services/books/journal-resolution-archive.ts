import { booksDigest } from "./hash";
import { createHash } from "node:crypto";
import { z } from "zod";
import { journalRecoverySchema } from "./journal-recovery";

export const JOURNAL_RESOLUTION_TABLE = "books_journal_request_resolutions";
const uuid = z.string().uuid();
const rowSchema = z.object({
  id: uuid,
  org_id: uuid,
  actor_id: uuid,
  kind: z.enum(["prepare", "review"]),
  request_key: z.string(),
  request_text: z.string().max(4_194_304),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  resolution: z.enum([
    "cancelled_preparation",
    "cancelled_review",
    "acknowledged_original_review",
    "acknowledged_superseded_review",
  ]),
  observed_proposal_id: uuid.nullable(),
  observed_review: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().trim().min(4).max(1000),
  resolved_at: z.string(),
});
function micros(value: unknown) {
  if (typeof value !== "string")
    throw new Error("Resolution timestamp is missing");
  const m = value.match(
    /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!m || !Number.isFinite(Date.parse(m[1] + m[3])))
    throw new Error("Resolution timestamp is invalid");
  return (
    BigInt(Date.parse(m[1] + m[3])) * 1000n +
    BigInt((m[2] ?? "").padEnd(6, "0"))
  );
}
function lineSignature(lines: unknown, swap = false) {
  if (!Array.isArray(lines) || lines.length < 2)
    throw new Error("Acknowledged journal lines are missing");
  const cents = (value: unknown) => {
    if (typeof value === "number" && !Number.isSafeInteger(value))
      throw new Error("Unsafe acknowledged journal cents");
    if (
      typeof value !== "number" &&
      (typeof value !== "string" || !/^\d+$/.test(value))
    )
      throw new Error("Invalid acknowledged journal cents");
    const n = BigInt(value);
    if (n < 0n) throw new Error("Negative acknowledged journal cents");
    return n.toString();
  };
  return booksDigest(
    lines
      .map((l) => {
        const debit = cents(l.debit_cents ?? 0),
          credit = cents(l.credit_cents ?? 0);
        if ((debit === "0") === (credit === "0"))
          throw new Error("Acknowledged line needs one positive side");
        return booksDigest({
          account: l.account_id,
          project: l.project_id ?? null,
          company: l.company_id ?? null,
          description: l.description ?? null,
          dimensions: l.dimensions ?? {},
          debit: swap ? credit : debit,
          credit: swap ? debit : credit,
        });
      })
      .sort(),
  );
}
/** A checksum alone cannot make a cancelled/acknowledged intent truthful. */
export function verifyJournalResolutionArchive(
  tables: Record<string, Record<string, unknown>[]>,
  orgId: string,
  version: number,
): string[] {
  const rows = tables[JOURNAL_RESOLUTION_TABLE] ?? [];
  if (version < 20)
    return rows.length
      ? ["Journal request resolutions require archive schema 20"]
      : [];
  try {
    if (!tables[JOURNAL_RESOLUTION_TABLE])
      throw new Error("Journal resolution history table is missing");
    const seen = new Set<string>(),
      keys = new Set<string>(),
      proposals = tables.books_journal_proposals ?? [];
    for (const raw of rows) {
      const r = rowSchema.parse(raw);
      micros(r.resolved_at);
      if (r.org_id !== orgId || seen.has(r.id))
        throw new Error("Resolution organization or identity differs");
      seen.add(r.id);
      const sha = createHash("sha256")
        .update(r.request_text, "utf8")
        .digest("hex");
      if (sha !== r.request_sha256)
        throw new Error("Resolution original request hash differs");
      const request = journalRecoverySchema.parse({
        version: 1,
        kind: r.kind,
        request: JSON.parse(r.request_text),
      });
      if (
        request.request.expectedOrgId !== orgId ||
        request.request.expectedActorId !== r.actor_id
      )
        throw new Error("Resolution original request scope differs");
      const key =
        request.kind === "prepare"
          ? request.request.intentId
          : `${request.request.proposalId}:${sha}`;
      if (r.request_key !== key || keys.has(`${r.actor_id}:${r.kind}:${key}`))
        throw new Error("Resolution key differs or is duplicated");
      keys.add(`${r.actor_id}:${r.kind}:${key}`);
      const p = r.observed_proposal_id
        ? proposals.find(
            (p) => p.org_id === orgId && p.id === r.observed_proposal_id,
          )
        : undefined;
      if (request.kind === "prepare") {
        if (
          r.resolution !== "cancelled_preparation" ||
          r.observed_proposal_id !== null ||
          r.observed_review !== null ||
          proposals.some(
            (p) =>
              p.org_id === orgId &&
              p.proposed_by === r.actor_id &&
              p.posting_key === `adjustment-intent:${request.request.intentId}`,
          )
        )
          throw new Error(
            "Cancelled preparation has a committed original receipt",
          );
      } else {
        const intent = request.request;
        if (r.resolution === "cancelled_preparation")
          throw new Error("Review resolution has preparation kind");
        const same = (p: Record<string, unknown>) =>
          p.reviewed_by === r.actor_id &&
          p.status ===
            (intent.decision === "approve" ? "posted" : "rejected") &&
          String(p.review_note ?? "").trim() === intent.note;
        if (r.resolution === "cancelled_review") {
          if (
            r.observed_review !== null ||
            (r.observed_proposal_id !== null &&
              (!p || p.id !== intent.proposalId)) ||
            proposals.some(
              (p) =>
                p.org_id === orgId && p.id === intent.proposalId && same(p),
            )
          )
            throw new Error(
              "Cancelled review has a committed matching decision",
            );
        } else {
          if (
            !p ||
            p.id !== intent.proposalId ||
            !r.observed_review ||
            !["posted", "rejected"].includes(String(p.status)) ||
            p.reviewed_by === p.proposed_by ||
            !p.reviewed_by ||
            !p.reviewed_at
          )
            throw new Error(
              "Acknowledged review has no independent committed proposal",
            );
          const observed = r.observed_review;
          if (
            Object.keys(observed).sort().join(",") !==
              [
                "status",
                "reviewedBy",
                "reviewedAt",
                "note",
                "journalEntryId",
                "reversalEntryId",
              ]
                .sort()
                .join(",") ||
            observed.status !== p.status ||
            observed.reviewedBy !== p.reviewed_by ||
            observed.reviewedAt !== p.reviewed_at ||
            observed.note !== p.review_note ||
            observed.journalEntryId !== p.journal_entry_id ||
            observed.reversalEntryId !== p.reversal_entry_id ||
            micros(r.resolved_at) < micros(p.reviewed_at)
          )
            throw new Error(
              "Acknowledged review evidence differs from retained proposal",
            );
          if ((r.resolution === "acknowledged_original_review") !== same(p))
            throw new Error(
              "Original/superseding review classification differs",
            );
          if (p.status === "posted") {
            const journal = (tables.journal_entries ?? []).find(
              (j) => j.org_id === orgId && j.id === p.journal_entry_id,
            );
            if (
              !journal ||
              !["posted", "reversed"].includes(String(journal.status)) ||
              journal.created_by !== p.proposed_by ||
              journal.posting_key !== p.posting_key ||
              journal.entry_date !== p.entry_date ||
              journal.memo !== p.memo ||
              journal.entry_kind !== "adjusting" ||
              journal.policy_version !== p.policy_version ||
              journal.projection_version !== 1 ||
              journal.fact_id !== null ||
              journal.source_id !== null ||
              journal.source_type !== null ||
              journal.reversal_of_entry_id !== null ||
              lineSignature(
                (tables.journal_lines ?? []).filter(
                  (l) => l.org_id === orgId && l.entry_id === journal.id,
                ),
              ) !== lineSignature(p.lines)
            )
              throw new Error(
                "Acknowledged posted review lacks its original money receipt",
              );
            if (p.reversing_on) {
              const child = (tables.journal_entries ?? []).find(
                (j) => j.org_id === orgId && j.id === p.reversal_entry_id,
              );
              if (
                !child ||
                !["posted", "reversed"].includes(String(child.status)) ||
                child.reversal_of_entry_id !== journal.id ||
                child.entry_date !== p.reversing_on ||
                child.entry_kind !== "reversal" ||
                child.created_by !== p.proposed_by ||
                child.policy_version !== p.policy_version ||
                child.projection_version !== 1 ||
                child.memo !== `Automatic reversal: ${p.memo}` ||
                child.posting_key !==
                  `scheduled_reversal:${journal.id}:${p.reversing_on}` ||
                child.source_type !== null ||
                child.fact_id !== null ||
                child.source_id !== null ||
                lineSignature(
                  (tables.journal_lines ?? []).filter(
                    (l) => l.org_id === orgId && l.entry_id === child.id,
                  ),
                ) !== lineSignature(p.lines, true)
              )
                throw new Error(
                  "Acknowledged scheduled review lacks its reversal",
                );
            } else if (p.reversal_entry_id !== null)
              throw new Error("Unscheduled review has a reversal receipt");
          } else if (
            p.journal_entry_id !== null ||
            p.reversal_entry_id !== null
          )
            throw new Error("Acknowledged rejection has money references");
        }
      }
    }
    return [];
  } catch (error) {
    return [
      `Invalid journal resolution history: ${error instanceof Error ? error.message : "Unknown verification error"}`,
    ];
  }
}
