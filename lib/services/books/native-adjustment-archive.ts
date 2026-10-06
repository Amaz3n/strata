import { verifyNativeContextArchive } from "./native-context-archive";
import { verifyNativeInvoicePostingReceipt } from "./native-invoice-posting-receipt";
import { booksDigest } from "./hash";
import {
  nativePeriodHoldSchema,
  nativeReceiptTime,
  verifyNativeAdjustmentFact,
  verifyNativeAdjustmentReview,
} from "./native-adjustment-contract";
import type { nativePostingContextSchema } from "./native-posting-plan";
import type { z } from "zod";
export const NATIVE_ADJUSTMENT_TABLES = [
  "books_native_adjustment_facts",
  "books_native_adjustment_reviews",
  "books_native_journal_entries",
  "books_native_journal_lines",
  "books_native_period_holds",
] as const;
export const NATIVE_INVOICE_POSTING_TABLE =
  "books_native_invoice_postings" as const;
type Tables = Record<string, Record<string, unknown>[]>;
/** Historical closure uses retained immutable definitions, never today's mutable source amounts. */
export function verifyNativeAdjustmentArchive(
  tables: Tables,
  org: string,
  version: number,
): string[] {
  if (
    version < 26 &&
    ((tables[NATIVE_INVOICE_POSTING_TABLE] ?? []).length ||
      (tables.books_native_journal_entries ?? []).some(
        (e) => e.source_posting_id != null,
      ))
  )
    return ["Native invoice receipts require archive schema26"];
  if (version < 25)
    return NATIVE_ADJUSTMENT_TABLES.some((t) => tables[t]?.length)
      ? ["Native adjustments require archive schema25"]
      : [];
  try {
    for (const table of [
      ...NATIVE_ADJUSTMENT_TABLES,
      ...(version >= 26 ? [NATIVE_INVOICE_POSTING_TABLE] : []),
    ]) {
      if (!tables[table])
        throw Error("Missing native adjustment history: " + table);
      const ids = new Set();
      for (const row of tables[table]) {
        if (row.org_id !== org || ids.has(row.id))
          throw Error("Foreign or duplicate native accounting identity");
        ids.add(row.id);
      }
    }
    const match = (table: string, id: unknown) => {
      const rows = (tables[table] ?? []).filter(
        (r) => r.org_id === org && r.id === id,
      );
      if (rows.length !== 1)
        throw Error("Missing or ambiguous native dependency: " + table);
      return rows[0];
    };
    const authority = (
      entity: string,
      actor: string,
      event: string,
      operation: string,
      at: string,
    ) => {
      const e = match("books_legal_entity_access_history", event),
        time = nativeReceiptTime(at);
      if (
        e.legal_entity_id !== entity ||
        e.user_id !== actor ||
        ![operation, "manage"].includes(String(e.access_level)) ||
        nativeReceiptTime(String(e.changed_at)) > time ||
        (tables.books_legal_entity_access_history ?? []).some(
          (r) =>
            r.org_id === org &&
            r.legal_entity_id === entity &&
            r.user_id === actor &&
            BigInt(String(r.sequence_no)) > BigInt(String(e.sequence_no)) &&
            nativeReceiptTime(String(r.changed_at)) <= time,
        )
      )
        throw Error("Native historical authority differs");
    };
    const closure = (c: z.infer<typeof nativePostingContextSchema>) =>
      verifyNativeContextArchive(c, tables, org);
    const holds = tables.books_native_period_holds.map((r) =>
      nativePeriodHoldSchema.parse(r),
    );
    const chains = new Map<string, typeof holds>();
    for (const h of holds) {
      const period = match("books_entity_fiscal_periods", h.period_id);
      if (period.legal_entity_id !== h.legal_entity_id)
        throw Error("Native hold period scope differs");
      authority(
        h.legal_entity_id,
        h.actor_id,
        h.access_event_id,
        "manage",
        h.recorded_at,
      );
      const key = h.legal_entity_id + ":" + h.period_id;
      chains.set(key, [...(chains.get(key) ?? []), h]);
    }
    for (const chain of chains.values()) {
      chain.sort((a, b) => a.sequence_no - b.sequence_no);
      for (const [i, h] of chain.entries()) {
        const prev = chain[i - 1];
        if (
          h.sequence_no !== i + 1 ||
          h.previous_id !== (prev?.id ?? null) ||
          h.decision !== (i % 2 === 0 ? "hold" : "release") ||
          (prev &&
            (nativeReceiptTime(h.recorded_at) <
              nativeReceiptTime(prev.recorded_at) ||
              (h.decision === "release" && h.actor_id === prev.actor_id)))
        )
          throw Error(
            "Native period hold chain or independent release differs",
          );
      }
    }
    const available = (entity: string, period: string, at: string) => {
      const chain = chains.get(entity + ":" + period) ?? [];
      const latest = chain
        .filter(
          (h) => nativeReceiptTime(h.recorded_at) <= nativeReceiptTime(at),
        )
        .at(-1);
      if (latest?.decision === "hold")
        throw Error(
          "Native money was prepared or approved during a posting hold",
        );
    };
    const reviews = tables.books_native_adjustment_reviews,
      entries = tables.books_native_journal_entries,
      lines = tables.books_native_journal_lines;
    const usedReviews = new Set(),
      usedEntries = new Set(),
      usedLines = new Set();
    for (const raw of tables.books_native_adjustment_facts) {
      const verified = verifyNativeAdjustmentFact(raw),
        f = verified.fact;
      closure(verified.request.context);
      closure(verified.validated);
      authority(
        f.legal_entity_id,
        f.prepared_by,
        f.prepared_access_event_id,
        "prepare",
        f.prepared_at,
      );
      available(f.legal_entity_id, f.period_id, f.prepared_at);
      const rs = reviews.filter((r) => r.fact_id === f.id),
        es = entries.filter((e) => e.fact_id === f.id);
      if (rs.length > 1 || es.length > 1 || (!rs.length && es.length))
        throw Error("Duplicate or orphan native approval money");
      if (!rs.length) continue;
      const r = rs[0],
        e = es[0] ?? null,
        ls = e
          ? lines
              .filter((l) => l.entry_id === e.id)
              .sort((a, b) => Number(a.position) - Number(b.position))
          : [];
      if (e?.source_posting_id != null)
        throw Error(
          "Manual adjustment cannot own an operational source receipt",
        );
      const receipt = verifyNativeAdjustmentReview(raw, r, e, ls);
      authority(
        f.legal_entity_id,
        receipt.review.reviewed_by,
        receipt.review.reviewed_access_event_id,
        "review",
        receipt.review.reviewed_at,
      );
      if (receipt.review.decision === "approve") {
        const access = (tables.books_legal_entity_access_history ?? [])
          .filter(
            (a) =>
              a.org_id === org &&
              a.legal_entity_id === f.legal_entity_id &&
              a.user_id === f.prepared_by &&
              nativeReceiptTime(String(a.changed_at)) <=
                nativeReceiptTime(receipt.review.reviewed_at),
          )
          .sort((a, b) =>
            BigInt(String(a.sequence_no)) > BigInt(String(b.sequence_no))
              ? -1
              : 1,
          )[0];
        if (
          !access ||
          !["prepare", "manage"].includes(String(access.access_level))
        )
          throw Error("Native maker lacked preparation authority at approval");
        closure(JSON.parse(receipt.review.validated_context_text!));
        available(f.legal_entity_id, f.period_id, receipt.review.reviewed_at);
      }
      for (const l of receipt.lines) {
        if (l.company_id) match("companies", l.company_id);
        if (l.cost_code_id) match("cost_codes", l.cost_code_id);
        usedLines.add(l.id);
      }
      usedReviews.add(r.id);
      if (e) usedEntries.add(e.id);
    }
    const seenInvoices = new Set();
    for (const raw of tables[NATIVE_INVOICE_POSTING_TABLE] ?? []) {
      const es = entries.filter((e) => e.source_posting_id === raw.id);
      if (es.length !== 1)
        throw Error("Native invoice receipt requires one original journal");
      const e = es[0],
        ls = lines
          .filter((l) => l.entry_id === e.id)
          .sort((a, b) => Number(a.position) - Number(b.position));
      const verified = verifyNativeInvoicePostingReceipt(raw, e, ls),
        r = verified.posting;
      const key = r.legal_entity_id + ":" + r.invoice_id;
      if (seenInvoices.has(key))
        throw Error("Duplicate native initial invoice money");
      seenInvoices.add(key);
      for (const economic of [
        verified.original.economic,
        verified.validated.economic,
      ]) {
        closure(economic.native);
        const source = match("invoices", r.invoice_id);
        if (
          !["sent", "partial", "paid", "overdue"].includes(
            String(source.status),
          )
        )
          throw Error("Retained posted native invoice status differs");
        const currentRetainage = (tables.retainage ?? []).filter(
          (r) => r.org_id === org && r.invoice_id === source.id,
        );
        if (
          currentRetainage.length !==
          economic.retainage.filter((r) => r.invoice_id === source.id).length
        )
          throw Error("Native original retainage inventory differs");
        const fields = ["project_id", "issue_date", "total_cents", "tax_cents"];
        for (const k of fields)
          if (booksDigest(source[k]) !== booksDigest(economic.native.source[k]))
            throw Error("Retained native invoice principal differs");
        for (const k of ["invoice_kind", "source_closing_id", "settlement"])
          if (
            booksDigest(
              (source.metadata as Record<string, unknown> | null)?.[k] ?? null,
            ) !==
            booksDigest(
              (
                economic.native.source.metadata as Record<
                  string,
                  unknown
                > | null
              )?.[k] ?? null,
            )
          )
            throw Error("Retained native invoice source settlement differs");
        const policy = match("accounting_policies", economic.policy.id);
        for (const [k, v] of Object.entries(economic.policy))
          if (
            !["status", "updated_at", "approval_note"].includes(k) &&
            booksDigest(v) !== booksDigest(policy[k])
          )
            throw Error("Retained native invoice policy evidence differs");
        if (!["approved", "superseded"].includes(String(policy.status)))
          throw Error("Retained used native policy is not approved history");
        const actualLines = (tables.invoice_lines ?? []).filter(
          (l) => l.org_id === org && l.invoice_id === r.invoice_id,
        );
        if (actualLines.length !== economic.lines.length)
          throw Error("Native original priced line inventory differs");
        for (const l of economic.lines) {
          const actual = match("invoice_lines", l.source.id);
          for (const k of ["invoice_id", "unit_price_cents", "cost_code_id"])
            if (booksDigest(actual[k]) !== booksDigest(l.source[k]))
              throw Error("Native original line pricing differs");
          // Current exports bind the exact decimal, not the rounded JSON view.
          if (actual.quantity === null && l.quantity === null) {
            // Preserve absent pricing on generated presentation lines.
          } else if (typeof actual.quantity === "string") {
            if (actual.quantity !== l.quantity)
              throw Error("Native original exact line quantity differs");
          } else {
            const decimal = (v: string) =>
              v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v;
            if (
              version >= 31 ||
              l.quantity === null ||
              typeof actual.quantity !== "number" ||
              decimal(String(actual.quantity)) !== decimal(l.quantity) ||
              booksDigest(actual.quantity) !== booksDigest(l.source.quantity)
            )
              throw Error(
                "Native original line quantity differs or lost precision",
              );
          }
          for (const k of [
            "system_generated_kind",
            "arc_books_gl_account_id",
            "arc_books_entity_account_id",
          ])
            if (
              booksDigest(
                (actual.metadata as Record<string, unknown> | null)?.[k] ??
                  null,
              ) !== booksDigest(l.source.metadata?.[k] ?? null)
            )
              throw Error("Native original line coding differs");
          if (l.costCode) match("cost_codes", l.costCode.id);
        }
        for (const retained of economic.retainage) {
          const actual = match("retainage", retained.id);
          for (const k of ["project_id", "invoice_id", "amount_cents"])
            if (booksDigest(actual[k]) !== booksDigest(retained[k]))
              throw Error("Native original retainage principal differs");
          if (
            retained.release_invoice_id === r.invoice_id &&
            actual.release_invoice_id !== r.invoice_id
          )
            throw Error("Native original retainage release linkage differs");
        }
        for (const original of economic.originalInvoices) {
          if (match("invoices", original.id).project_id !== r.project_id)
            throw Error("Native released principal source project differs");
        }
        for (const closing of economic.closings) {
          const actual = match("closings", closing.id);
          for (const k of [
            "project_id",
            "closing_invoice_id",
            "status",
            "actual_date",
            "settlement",
          ])
            if (booksDigest(actual[k]) !== booksDigest(closing[k]))
              throw Error("Native original closing evidence differs");
        }
        available(r.legal_entity_id, r.period_id, economic.native.capturedAt);
      }
      authority(
        r.legal_entity_id,
        r.posted_by,
        r.access_event_id,
        "prepare",
        r.posted_at,
      );
      available(r.legal_entity_id, r.period_id, r.posted_at);
      usedEntries.add(e.id);
      for (const l of ls) {
        if (l.company_id) match("companies", l.company_id);
        if (l.cost_code_id) match("cost_codes", l.cost_code_id);
        usedLines.add(l.id);
      }
    }
    if (
      usedReviews.size !== reviews.length ||
      usedEntries.size !== entries.length ||
      usedLines.size !== lines.length
    )
      throw Error("Orphan native monetary receipt or leg");
    return [];
  } catch (e) {
    return [
      "Invalid native adjustment history: " +
        (e instanceof Error ? e.message : String(e)),
    ];
  }
}
