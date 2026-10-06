import {
  NATIVE_INVOICE_INCOME_TABLE,
  verifyNativeInvoiceIncomeSelection,
} from "./native-invoice-income-contract";
import { nativeReceiptTime } from "./native-adjustment-contract";
import { verifyNativeContextArchive } from "./native-context-archive";
type Tables = Record<string, Record<string, unknown>[]>;
export function verifyNativeInvoiceIncomeArchive(
  tables: Tables,
  org: string,
  version: number,
): string[] {
  const rows = tables[NATIVE_INVOICE_INCOME_TABLE];
  if (version < 28)
    return rows?.length ||
      tables.books_native_invoice_postings?.some(
        (p) => p.income_selection_id != null,
      )
      ? ["Native income selections require archive schema28"]
      : [];
  try {
    if (!rows) throw Error("Missing native invoice income selection history");
    const ids = new Set<string>();
    const revisions = new Map<string, number[]>();
    const checked = rows.map((raw) => {
      const v = verifyNativeInvoiceIncomeSelection(raw),
        r = v.selection,
        time = nativeReceiptTime(r.selected_at);
      if (r.org_id !== org || ids.has(r.id))
        throw Error("Foreign/duplicate native income selection");
      ids.add(r.id);
      const key = r.legal_entity_id + ":" + r.invoice_id;
      revisions.set(key, [...(revisions.get(key) ?? []), r.selection_revision]);
      verifyNativeContextArchive(v.request.economic.native, tables, org, false);
      verifyNativeContextArchive(v.economic.native, tables, org, false);
      const events = tables.books_legal_entity_access_history ?? [];
      const event = events.find(
        (e) =>
          e.org_id === org &&
          e.id === r.access_event_id &&
          e.legal_entity_id === r.legal_entity_id &&
          e.user_id === r.actor_id,
      );
      if (
        !event ||
        !["prepare", "manage"].includes(String(event.access_level)) ||
        nativeReceiptTime(String(event.changed_at)) > time ||
        events.some(
          (e) =>
            e.org_id === org &&
            e.legal_entity_id === r.legal_entity_id &&
            e.user_id === r.actor_id &&
            BigInt(String(e.sequence_no)) > BigInt(String(event.sequence_no)) &&
            nativeReceiptTime(String(e.changed_at)) <= time,
        )
      )
        throw Error("Native income historical preparation authority differs");
      const holds = (tables.books_native_period_holds ?? [])
        .filter(
          (h) =>
            h.org_id === org &&
            h.legal_entity_id === r.legal_entity_id &&
            h.period_id === r.period_id &&
            nativeReceiptTime(String(h.recorded_at)) <= time,
        )
        .sort((a, b) =>
          nativeReceiptTime(String(a.recorded_at)) >
          nativeReceiptTime(String(b.recorded_at))
            ? -1
            : 1,
        );
      if (holds[0]?.decision === "hold")
        throw Error("Native income selection occurred during a period hold");
      if (
        (tables.books_native_invoice_postings ?? []).some(
          (p) =>
            p.org_id === org &&
            p.invoice_id === r.invoice_id &&
            nativeReceiptTime(String(p.posted_at)) <= time,
        )
      )
        throw Error("Native invoice was recoded after posting");
      return v;
    });
    for (const chain of revisions.values()) {
      chain.sort((a, b) => a - b);
      if (chain.some((r, i) => r !== i + 1))
        throw Error(
          "Native income revision history is incomplete or duplicated",
        );
    }
    const chronological = [...checked].sort(
      (a, b) => a.selection.selection_revision - b.selection.selection_revision,
    );
    const last = new Map<string, bigint>();
    for (const v of chronological) {
      const key = v.selection.legal_entity_id + ":" + v.selection.invoice_id,
        time = nativeReceiptTime(v.selection.selected_at);
      if (last.has(key) && time < last.get(key)!)
        throw Error("Native income revision chronology differs");
      last.set(key, time);
    }
    for (const p of tables.books_native_invoice_postings ?? []) {
      if (p.income_selection_id == null) {
        if (
          checked.some(
            (v) =>
              v.selection.invoice_id === p.invoice_id &&
              v.selection.legal_entity_id === p.legal_entity_id &&
              nativeReceiptTime(v.selection.selected_at) <=
                nativeReceiptTime(String(p.posted_at)),
          )
        )
          throw Error("Native journal lost its selection provenance");
        continue; // Retained pre-schema28 history.
      }
      const selected = checked.find(
        (v) => v.selection.id === p.income_selection_id,
      );
      if (
        !selected ||
        selected.selection.org_id !== org ||
        selected.selection.legal_entity_id !== p.legal_entity_id ||
        selected.selection.project_id !== p.project_id ||
        selected.selection.invoice_id !== p.invoice_id ||
        nativeReceiptTime(selected.selection.selected_at) >=
          nativeReceiptTime(String(p.posted_at))
      )
        throw Error("Native journal income-selection provenance differs");
      const prior = checked
        .filter(
          (v) =>
            v.selection.invoice_id === p.invoice_id &&
            v.selection.legal_entity_id === p.legal_entity_id &&
            nativeReceiptTime(v.selection.selected_at) <=
              nativeReceiptTime(String(p.posted_at)),
        )
        .sort(
          (a, b) =>
            b.selection.selection_revision - a.selection.selection_revision,
        );
      if (prior[0]?.selection.id !== selected.selection.id)
        throw Error("Native journal bypassed a later income selection");
      const economic = JSON.parse(String(p.request_text));
      for (const line of economic.lines) {
        if (line.source.metadata?.system_generated_kind === "retainage_hold")
          continue;
        const retained = selected.economic.lines.find(
          (l) => l.source.id === line.source.id,
        );
        if (
          !retained ||
          line.source.metadata?.arc_books_entity_income_selection_id !==
            selected.selection.id
        )
          throw Error(
            "Native journal source lost its authorized selection identity",
          );
        if (
          (line.source.metadata?.arc_books_entity_account_id ?? null) !==
          (retained?.source.metadata?.arc_books_entity_account_id ?? null)
        )
          throw Error(
            "Native journal income differs from authorized selection",
          );
      }
    }
    return [];
  } catch (e) {
    return [
      "Invalid native income selection history: " +
        (e instanceof Error ? e.message : String(e)),
    ];
  }
}
