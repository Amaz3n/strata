import {
  NATIVE_INVOICE_CORRECTION_REVIEW_TABLE,
  verifyNativeInvoiceCorrectionReviewArchive,
} from "./native-invoice-correction-review";
import {
  NATIVE_INVOICE_CORRECTION_PROPOSAL_TABLE,
  verifyNativeInvoiceCorrectionProposalArchive,
} from "./native-invoice-correction-proposal";
import {
  NATIVE_INVOICE_INCOME_RESOLUTION_TABLE,
  verifyNativeIncomeResolutionArchive,
} from "./native-invoice-income-resolution";
import { NATIVE_INVOICE_INCOME_TABLE } from "./native-invoice-income-contract";
import { verifyNativeInvoiceIncomeArchive } from "./native-invoice-income-archive";
import {
  NATIVE_INVOICE_RESOLUTION_TABLE,
  verifyNativeInvoiceResolutionArchive,
} from "./native-invoice-resolution";
import {
  NATIVE_ADJUSTMENT_TABLES,
  NATIVE_INVOICE_POSTING_TABLE,
  verifyNativeAdjustmentArchive,
} from "./native-adjustment-archive";
import {
  PROJECT_OWNER_RESOLUTION_TABLE,
  verifyProjectOwnerResolutionArchive,
} from "./project-owner-resolution-archive";
import {
  PROJECT_ENTITY_TABLES,
  verifyProjectEntityArchive,
} from "./project-entity-archive";
import {
  ENTITY_CHART_TABLES,
  verifyEntityChartArchive,
} from "./entity-chart-archive";
import {
  ENTITY_CALENDAR_TABLES,
  verifyEntityCalendarArchive,
} from "./entity-calendars";
import {
  JOURNAL_RESOLUTION_TABLE,
  verifyJournalResolutionArchive,
} from "./journal-resolution-archive";
import {
  LEGACY_ENTITY_OWNERSHIP_TABLES,
  verifyLegacyEntityOwnershipArchive,
} from "./legacy-entity-ownership";
import {
  LEGAL_ENTITY_ARCHIVE_TABLES,
  verifyLegalEntityArchive,
} from "./legal-entity-archive";
import { verifyPayrollCorrectionPosting } from "./payroll-correction-posting";
import { taxWorkpaperEvidenceSchema } from "@/lib/services/books/tax-adjustment-lines";
import {
  historicalDocumentInventory,
  type ArchivedTaxAttachment,
} from "./tax-attachment-archive";
import { createHash } from "node:crypto";
import { booksDigest } from "@/lib/services/books/hash";
import { parsePayrollDraftEvidence } from "./payroll-draft-evidence";
import { verifyPayrollArchiveSource } from "./payroll-archive-source";
import { parsePayrollPaymentReviewEvidence } from "./payroll-payment-review-rules";
import { verifyPayrollPostingReceipt } from "./payroll-posting-receipt";
import { payrollNativeOwnershipSchema } from "./payroll-native-ownership";
import { verifyPayrollCorrectionSourceBytes } from "./payroll-correction-source";
import { parsePayrollCorrectionProposal } from "./payroll-correction-proposal";
import { parsePayrollPostingProposal } from "./payroll-posting-proposal-evidence";

export const BOOKS_EXPORT_SCHEMA_VERSION = 32 as const;

export const EXPORT_TABLES = [
  NATIVE_INVOICE_CORRECTION_REVIEW_TABLE,
  NATIVE_INVOICE_CORRECTION_PROPOSAL_TABLE,
  ...NATIVE_ADJUSTMENT_TABLES,
  NATIVE_INVOICE_POSTING_TABLE,
  NATIVE_INVOICE_RESOLUTION_TABLE,
  NATIVE_INVOICE_INCOME_TABLE,
  NATIVE_INVOICE_INCOME_RESOLUTION_TABLE,
  PROJECT_OWNER_RESOLUTION_TABLE,
  ...PROJECT_ENTITY_TABLES,
  ...ENTITY_CHART_TABLES,
  ...ENTITY_CALENDAR_TABLES,
  JOURNAL_RESOLUTION_TABLE,
  ...LEGAL_ENTITY_ARCHIVE_TABLES,
  ...LEGACY_ENTITY_OWNERSHIP_TABLES,
  "closings",
  "closing_checklist_items",
  "lot_takedowns",
  "lot_reservations",
  "budgets",
  "budget_lines",
  "commitments",
  "commitment_lines",
  "change_orders",
  "file_links",
  "project_financial_settings",
  "divisions",
  "communities",
  "community_phases",
  "lots",
  "contracts",
  "cost_codes",
  "time_entries",
  "warranty_requests",
  "warranty_service_visits",
  "warranty_backcharges",
  "org_funding_sources",
  "disbursements",
  "payment_runs",
  "payment_run_items",
  "payment_run_fee_charges",
  "receivable_adjustments",
  "books_deposit_batches",
  "books_deposit_batch_items",
  "receivable_payment_groups",
  "receivable_payment_group_items",
  "books_tax_adjustment_workpapers",
  "books_payroll_imports",
  "books_payroll_payment_reviews",
  "books_payroll_posting_proposals",
  "books_payroll_postings",
  "books_payroll_labor_ownership",
  "books_payroll_correction_sources",
  "books_payroll_correction_proposals",
  "books_payroll_correction_postings",
  "books_overhead_budgets",
  "books_overhead_budget_lines",
  "books_settings",
  "accounting_policies",
  "accounting_account_mappings",
  "gl_accounts",
  "books_projection_receipts",
  "accounting_facts",
  "journal_entries",
  "journal_lines",
  "accounting_periods",
  "accounting_reconciliation_runs",
  "accounting_reconciliation_items",
  "poc_snapshots",
  "books_comparison_runs",
  "books_comparison_items",
  "opening_balance_batches",
  "opening_balance_lines",
  "opening_balance_approvals",
  "bank_accounts",
  "bank_transactions",
  "bank_transaction_details",
  "bank_receipts",
  "bank_transaction_revisions",
  "bank_transaction_matches",
  "bank_reconciliations",
  "bank_reconciliation_items",
  "bank_rules",
  "coding_rules",
  "books_debt_instruments",
  "books_debt_events",
  "books_fixed_assets",
  "books_fixed_asset_events",
  "books_tax_jurisdictions",
  "books_tax_filings",
  "books_greenfield_launches",
  "books_journal_proposals",
  "books_cutover_runs",
  "books_cutover_approvals",
  "books_close_items",
  "recurring_posting_templates",
  "recurring_posting_lines",
  "financial_statement_snapshots",
  "tax_policy_versions",
  "companies",
  "contacts",
  "projects",
  "invoices",
  "invoice_lines",
  "payments",
  "payment_allocations",
  "payment_reversals",
  "vendor_bills",
  "bill_lines",
  "project_expenses",
  "project_expense_lines",
  "job_cost_entries",
  "billable_costs",
  "retainage",
  "doc_versions",
  "files",
  "audit_log",
] as const;

export function verifyBooksExportBundle(bundle: {
  tables: Record<string, Record<string, unknown>[]>;
  supportingObjects?: { fileId: string; dataBase64: string }[];
  supportingHistoricalObjects?: { attachmentId: string; dataBase64: string }[];
  manifest?: {
    schemaVersion: number;
    orgId: string;
    legalEntityIds?: string[];
    tables: Record<string, { rows: number; checksum?: string }>;
    supportingFiles?: {
      id: unknown;
      storagePath: unknown;
      sizeBytes: unknown;
      checksum: unknown;
    }[];
    supportingHistoricalFiles?: ArchivedTaxAttachment[];
  };
}) {
  const entries = bundle.tables.journal_entries ?? [];
  const postedEntryIds = new Set(
    entries
      .filter((entry) => ["posted", "reversed"].includes(String(entry.status)))
      .map((entry) => String(entry.id)),
  );
  const integrityErrors: string[] = [];
  const parseCents = (value: unknown): bigint | null => {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      return BigInt(value);
    if (
      typeof value === "string" &&
      value.length <= 19 &&
      /^(0|[1-9][0-9]*)$/.test(value)
    ) {
      const cents = BigInt(value);
      if (cents <= BigInt("9223372036854775807")) return cents;
    }
    return null;
  };
  const totals = new Map<string, { debit: bigint; credit: bigint }>();
  for (const line of bundle.tables.journal_lines ?? []) {
    const entryId = String(line.entry_id);
    const debit = parseCents(line.debit_cents);
    const credit = parseCents(line.credit_cents);
    if (
      debit === null ||
      credit === null ||
      (debit === BigInt(0)) === (credit === BigInt(0))
    ) {
      integrityErrors.push(`Invalid journal line amounts: ${line.id}`);
      continue;
    }
    if (!postedEntryIds.has(entryId)) continue;
    const current = totals.get(entryId) ?? {
      debit: BigInt(0),
      credit: BigInt(0),
    };
    current.debit += debit;
    current.credit += credit;
    totals.set(entryId, current);
  }
  const unbalancedEntryIds = Array.from(totals.entries())
    .filter(
      ([, total]) => total.debit <= BigInt(0) || total.debit !== total.credit,
    )
    .map(([entryId]) => entryId);
  const missingLineEntryIds = Array.from(postedEntryIds).filter(
    (entryId) => !totals.has(entryId),
  );
  if (
    bundle.manifest &&
    ![
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
    ].includes(bundle.manifest.schemaVersion)
  )
    integrityErrors.push("Unsupported Books export schema version");
  if (
    bundle.manifest &&
    [
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
    ].includes(bundle.manifest.schemaVersion)
  ) {
    if (bundle.manifest.schemaVersion >= 31)
      for (const line of bundle.tables.invoice_lines ?? [])
        if (
          line.quantity != null &&
          (typeof line.quantity !== "string" ||
            !/^-?\d+(?:\.\d+)?$/.test(line.quantity))
        )
          integrityErrors.push(
            "Invoice quantity requires exact decimal text in schema31",
          );
    integrityErrors.push(
      ...verifyNativeInvoiceCorrectionReviewArchive(
        bundle.tables,
        bundle.manifest.orgId,
        bundle.manifest.schemaVersion,
      ),
    );
    integrityErrors.push(
      ...verifyNativeInvoiceCorrectionProposalArchive(
        bundle.tables,
        bundle.manifest.orgId,
        bundle.manifest.schemaVersion,
      ),
    );
    integrityErrors.push(
      ...verifyNativeIncomeResolutionArchive(
        bundle.tables,
        bundle.manifest.orgId,
        bundle.manifest.schemaVersion,
      ),
      ...verifyNativeInvoiceIncomeArchive(
        bundle.tables,
        bundle.manifest.orgId,
        bundle.manifest.schemaVersion,
      ),
      ...verifyNativeInvoiceResolutionArchive(
        bundle.tables,
        bundle.manifest.orgId,
        bundle.manifest.schemaVersion,
      ),
      ...verifyNativeAdjustmentArchive(
        bundle.tables,
        bundle.manifest.orgId,
        bundle.manifest.schemaVersion,
      ),
      ...verifyProjectOwnerResolutionArchive(
        bundle.tables,
        bundle.manifest.orgId,
        bundle.manifest.schemaVersion,
      ),
      ...verifyProjectEntityArchive(
        bundle.tables,
        bundle.manifest.orgId,
        bundle.manifest.schemaVersion,
      ),
      ...verifyEntityChartArchive(
        bundle.tables,
        bundle.manifest.orgId,
        bundle.manifest.schemaVersion,
      ),
      ...verifyEntityCalendarArchive(
        bundle.tables,
        bundle.manifest.orgId,
        bundle.manifest.schemaVersion,
      ),
    );
    integrityErrors.push(
      ...verifyJournalResolutionArchive(
        bundle.tables,
        bundle.manifest.orgId,
        bundle.manifest.schemaVersion,
      ),
    );
    integrityErrors.push(
      ...verifyLegacyEntityOwnershipArchive(
        bundle.tables,
        bundle.manifest.orgId,
        bundle.manifest.schemaVersion,
        EXPORT_TABLES.filter(
          (table) =>
            !NATIVE_ADJUSTMENT_TABLES.includes(
              table as (typeof NATIVE_ADJUSTMENT_TABLES)[number],
            ) &&
            table !== NATIVE_INVOICE_INCOME_TABLE &&
            table !== NATIVE_INVOICE_CORRECTION_PROPOSAL_TABLE &&
            table !== NATIVE_INVOICE_CORRECTION_REVIEW_TABLE &&
            table !== NATIVE_INVOICE_INCOME_RESOLUTION_TABLE &&
            table !== NATIVE_INVOICE_RESOLUTION_TABLE &&
            table !== NATIVE_INVOICE_POSTING_TABLE &&
            table !== JOURNAL_RESOLUTION_TABLE &&
            table !== PROJECT_OWNER_RESOLUTION_TABLE &&
            !PROJECT_ENTITY_TABLES.includes(
              table as (typeof PROJECT_ENTITY_TABLES)[number],
            ) &&
            !ENTITY_CHART_TABLES.includes(
              table as (typeof ENTITY_CHART_TABLES)[number],
            ) &&
            !ENTITY_CALENDAR_TABLES.includes(
              table as (typeof ENTITY_CALENDAR_TABLES)[number],
            ) &&
            !LEGACY_ENTITY_OWNERSHIP_TABLES.includes(
              table as (typeof LEGACY_ENTITY_OWNERSHIP_TABLES)[number],
            ),
        ),
      ),
    );
    integrityErrors.push(
      ...verifyLegalEntityArchive(
        bundle.tables,
        bundle.manifest.orgId,
        bundle.manifest.schemaVersion,
      ),
    );
    if (
      bundle.manifest.schemaVersion >= 18 &&
      (bundle.manifest.legalEntityIds !== undefined ||
        (bundle.tables.books_legal_entities ?? []).length)
    ) {
      const expected = (bundle.tables.books_legal_entities ?? [])
        .map((row) => String(row.id))
        .sort();
      if (
        !Array.isArray(bundle.manifest.legalEntityIds) ||
        JSON.stringify(bundle.manifest.legalEntityIds) !==
          JSON.stringify(expected)
      )
        integrityErrors.push("Export legal entity identity inventory differs");
    }
    for (const table of EXPORT_TABLES) {
      if (
        bundle.manifest.schemaVersion < 32 &&
        table === NATIVE_INVOICE_CORRECTION_REVIEW_TABLE
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 30 &&
        table === NATIVE_INVOICE_CORRECTION_PROPOSAL_TABLE
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 29 &&
        table === NATIVE_INVOICE_INCOME_RESOLUTION_TABLE
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 28 &&
        table === NATIVE_INVOICE_INCOME_TABLE
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 27 &&
        table === NATIVE_INVOICE_RESOLUTION_TABLE
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 26 &&
        table === NATIVE_INVOICE_POSTING_TABLE
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 25 &&
        NATIVE_ADJUSTMENT_TABLES.includes(
          table as (typeof NATIVE_ADJUSTMENT_TABLES)[number],
        )
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 24 &&
        table === PROJECT_OWNER_RESOLUTION_TABLE
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 23 &&
        PROJECT_ENTITY_TABLES.includes(
          table as (typeof PROJECT_ENTITY_TABLES)[number],
        ) &&
        !bundle.tables[table]
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 22 &&
        ENTITY_CHART_TABLES.includes(
          table as (typeof ENTITY_CHART_TABLES)[number],
        ) &&
        !bundle.tables[table]
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 21 &&
        ENTITY_CALENDAR_TABLES.includes(
          table as (typeof ENTITY_CALENDAR_TABLES)[number],
        ) &&
        !bundle.tables[table]
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 20 &&
        table === JOURNAL_RESOLUTION_TABLE &&
        !bundle.tables[table]
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 19 &&
        LEGACY_ENTITY_OWNERSHIP_TABLES.includes(
          table as (typeof LEGACY_ENTITY_OWNERSHIP_TABLES)[number],
        ) &&
        !bundle.tables[table]
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 18 &&
        LEGAL_ENTITY_ARCHIVE_TABLES.includes(
          table as (typeof LEGAL_ENTITY_ARCHIVE_TABLES)[number],
        ) &&
        !bundle.tables[table]
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 16 &&
        table === "books_payroll_correction_postings" &&
        !bundle.tables[table]
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 15 &&
        table === "books_payroll_correction_proposals" &&
        !bundle.tables[table]
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 14 &&
        table === "books_payroll_correction_sources" &&
        !bundle.tables[table]
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 13 &&
        table === "books_payroll_labor_ownership" &&
        !bundle.tables[table]
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 12 &&
        table === "books_payroll_postings" &&
        !bundle.tables[table]
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 11 &&
        table === "books_payroll_posting_proposals" &&
        !bundle.tables[table]
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 10 &&
        table === "books_payroll_payment_reviews" &&
        !bundle.tables[table]
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 9 &&
        table === "books_payroll_imports" &&
        !bundle.tables[table]
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 8 &&
        table === "doc_versions" &&
        !bundle.tables[table]
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 7 &&
        table === "books_tax_adjustment_workpapers" &&
        !bundle.tables[table]
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 6 &&
        table === "payment_run_fee_charges" &&
        !bundle.tables[table]
      )
        continue;
      if (
        bundle.manifest.schemaVersion === 2 &&
        ["bank_transaction_details", "bank_receipts"].includes(table) &&
        !bundle.tables[table]
      )
        continue;
      if (
        bundle.manifest.schemaVersion < 5 &&
        table === "books_projection_receipts" &&
        !bundle.tables[table]
      )
        continue;
      const rows = bundle.tables[table];
      const expected = bundle.manifest.tables[table];
      if (!rows || !expected) {
        integrityErrors.push(`Missing table ${table}`);
        continue;
      }
      if (
        rows.length !== expected.rows ||
        booksDigest(rows) !== expected.checksum
      )
        integrityErrors.push(`Checksum or row count differs for ${table}`);
      const ids = rows.map((row) => row.id).filter(Boolean);
      if (rows.some((row) => typeof row.id !== "string" || row.id.length === 0))
        integrityErrors.push(`Missing row identity in ${table}`);
      if (new Set(ids).size !== ids.length)
        integrityErrors.push(`Duplicate IDs in ${table}`);
      if (rows.some((row) => row.org_id !== bundle.manifest?.orgId))
        integrityErrors.push(`Organization mismatch in ${table}`);
    }
    const references = [
      ["books_payroll_labor_ownership", "posting_id", "books_payroll_postings"],
      [
        "books_payroll_correction_proposals",
        "posted_receipt_id",
        "books_payroll_correction_postings",
      ],
      [
        "books_payroll_correction_postings",
        "previous_posting_id",
        "books_payroll_correction_postings",
      ],
      [
        "books_payroll_correction_postings",
        "proposal_id",
        "books_payroll_correction_proposals",
      ],
      [
        "books_payroll_correction_postings",
        "source_id",
        "books_payroll_correction_sources",
      ],
      [
        "books_payroll_correction_postings",
        "posting_id",
        "books_payroll_postings",
      ],
      [
        "books_payroll_correction_sources",
        "posting_id",
        "books_payroll_postings",
      ],
      [
        "books_payroll_correction_proposals",
        "source_id",
        "books_payroll_correction_sources",
      ],
      [
        "books_payroll_correction_proposals",
        "posting_id",
        "books_payroll_postings",
      ],
      ["books_payroll_labor_ownership", "cost_code_id", "cost_codes"],
      ["books_payroll_labor_ownership", "time_entry_id", "time_entries"],
      [
        "books_payroll_labor_ownership",
        "job_cost_entry_id",
        "job_cost_entries",
      ],
      ["books_payroll_labor_ownership", "fact_id", "accounting_facts"],
      ["books_payroll_labor_ownership", "journal_id", "journal_entries"],
      [
        "books_payroll_labor_ownership",
        "projection_receipt_id",
        "books_projection_receipts",
      ],
      [
        "books_payroll_postings",
        "proposal_id",
        "books_payroll_posting_proposals",
      ],
      ["books_payroll_postings", "payroll_import_id", "books_payroll_imports"],
      [
        "books_payroll_posting_proposals",
        "payroll_import_id",
        "books_payroll_imports",
      ],
      [
        "books_payroll_posting_proposals",
        "payment_review_id",
        "books_payroll_payment_reviews",
      ],
      [
        "books_payroll_payment_reviews",
        "payroll_import_id",
        "books_payroll_imports",
      ],
      [
        "books_tax_adjustment_workpapers",
        "supersedes_id",
        "books_tax_adjustment_workpapers",
      ],
      ["payment_run_fee_charges", "run_id", "payment_runs"],
      ["payment_run_fee_charges", "funding_source_id", "org_funding_sources"],
      ["books_projection_receipts", "fact_id", "accounting_facts"],
      ["books_projection_receipts", "journal_id", "journal_entries"],
      ["closings", "closing_invoice_id", "invoices"],
      ["closings", "lot_id", "lots"],
      ["closings", "project_id", "projects"],
      ["closing_checklist_items", "closing_id", "closings"],
      ["budget_lines", "budget_id", "budgets"],
      ["commitment_lines", "commitment_id", "commitments"],
      ["doc_versions", "file_id", "files"],
      ...(bundle.manifest.schemaVersion >= 8
        ? [["files", "current_version_id", "doc_versions"]]
        : []),
      ["file_links", "file_id", "files"],
      ["project_financial_settings", "project_id", "projects"],
      ["lots", "project_id", "projects"],
      ["lots", "community_id", "communities"],
      ["warranty_service_visits", "request_id", "warranty_requests"],
      [
        "warranty_service_visits",
        "books_cost_journal_entry_id",
        "journal_entries",
      ],
      ["time_entries", "project_id", "projects"],
      ["opening_balance_lines", "operational_payment_id", "payments"],
      ["journal_lines", "entry_id", "journal_entries"],
      ["journal_lines", "account_id", "gl_accounts"],
      ["journal_entries", "fact_id", "accounting_facts"],
      ["journal_entries", "reversal_of_entry_id", "journal_entries"],
      ["invoice_lines", "invoice_id", "invoices"],
      ["invoices", "project_id", "projects"],
      ["payments", "invoice_id", "invoices"],
      ["payments", "bill_id", "vendor_bills"],
      ["bill_lines", "bill_id", "vendor_bills"],
      ["vendor_bills", "company_id", "companies"],
      ["receivable_adjustments", "invoice_id", "invoices"],
      ["bank_transaction_matches", "journal_line_id", "journal_lines"],
      ["bank_transaction_matches", "bank_transaction_id", "bank_transactions"],
      ["bank_transactions", "bank_account_id", "bank_accounts"],
      ["bank_transaction_details", "transaction_id", "bank_transactions"],
      ["bank_transaction_details", "entry_id", "journal_entries"],
      ["bank_receipts", "transaction_id", "bank_transactions"],
      ["bank_receipts", "file_id", "files"],
      [
        "bank_reconciliation_items",
        "reconciliation_id",
        "bank_reconciliations",
      ],
      ["books_deposit_batch_items", "batch_id", "books_deposit_batches"],
      ["books_deposit_batch_items", "payment_id", "payments"],
      ["books_deposit_batches", "journal_entry_id", "journal_entries"],
      ["books_deposit_batches", "bank_transaction_id", "bank_transactions"],
      [
        "receivable_payment_group_items",
        "group_id",
        "receivable_payment_groups",
      ],
      ["receivable_payment_group_items", "payment_id", "payments"],
      ["books_overhead_budget_lines", "budget_id", "books_overhead_budgets"],
      ["books_overhead_budget_lines", "account_id", "gl_accounts"],
      ["books_debt_events", "instrument_id", "books_debt_instruments"],
      ["books_fixed_asset_events", "asset_id", "books_fixed_assets"],
      ["opening_balance_lines", "batch_id", "opening_balance_batches"],
      ["recurring_posting_lines", "template_id", "recurring_posting_templates"],
    ];
    for (const workpaper of bundle.tables.books_tax_adjustment_workpapers ??
      []) {
      if (
        !workpaper.base_snapshot ||
        typeof workpaper.base_snapshot !== "object" ||
        Array.isArray(workpaper.base_snapshot) ||
        booksDigest(workpaper.base_snapshot) !== workpaper.base_digest
      )
        integrityErrors.push(
          `Tax workpaper basis digest differs: ${workpaper.id}`,
        );
      if (
        ["approved", "superseded"].includes(String(workpaper.status)) &&
        (!workpaper.reviewed_by ||
          workpaper.reviewed_by === workpaper.prepared_by)
      )
        integrityErrors.push(
          `Tax workpaper lacks separate review: ${workpaper.id}`,
        );
      if (!taxWorkpaperEvidenceSchema.safeParse(workpaper).success) {
        integrityErrors.push(
          `Invalid tax workpaper lines or preparation evidence: ${workpaper.id}`,
        );
        continue;
      }
      for (const line of workpaper.lines as Record<string, unknown>[])
        for (const [column, table] of [
          ["evidence_file_id", "files"],
          ["project_id", "projects"],
        ]) {
          if (
            line[column] != null &&
            !(bundle.tables[table] ?? []).some(
              (parent) => parent.id === line[column],
            )
          )
            integrityErrors.push(
              `Missing ${table} for tax workpaper ${workpaper.id}`,
            );
        }
      if (bundle.manifest.schemaVersion >= 8)
        for (const line of workpaper.lines as Record<string, unknown>[])
          if (line.evidence_snapshot) {
            const proof = line.evidence_snapshot as Record<string, unknown>;
            if (
              proof.document_version_id != null &&
              !(bundle.tables.doc_versions ?? []).some(
                (row) =>
                  row.id === proof.document_version_id &&
                  row.file_id === proof.file_id &&
                  row.storage_path === proof.storage_path &&
                  row.checksum === proof.checksum &&
                  Number(row.size_bytes) === proof.size_bytes,
              )
            )
              integrityErrors.push(
                `Missing frozen document version: ${workpaper.id}`,
              );
          }
      for (const line of workpaper.lines as Record<string, unknown>[])
        if (line.evidence_snapshot && bundle.manifest.schemaVersion < 8) {
          const proof = line.evidence_snapshot as Record<string, unknown>;
          const file = (bundle.tables.files ?? []).find(
            (file) => file.id === line.evidence_file_id,
          );
          // Schema 7 only embeds current file objects. Refuse to silently claim
          // recovery of an older tax attachment until historical objects are carried.
          if (
            proof.org_id !== bundle.manifest?.orgId ||
            !file ||
            proof.storage_path !== file.storage_path ||
            proof.checksum !== file.checksum ||
            proof.size_bytes !== Number(file.size_bytes)
          )
            integrityErrors.push(
              `Frozen tax attachment bytes are missing from archive: ${workpaper.id}`,
            );
        }
    }
    for (const payroll of bundle.tables.books_payroll_imports ?? []) {
      try {
        const keys = [
          "run",
          "reconciliation",
          "labor_evidence",
          "source_proof",
          "column_mapping",
          "evidence_digest",
          "mapping_digest",
          "reconciliation_digest",
          "source_revision",
        ];
        const evidence = parsePayrollDraftEvidence(
          Object.fromEntries(keys.map((key) => [key, payroll[key]])),
        );
        const proof = evidence.source_proof;
        if (evidence.reconciliation.evidenceVersion === 2) {
          const sourceId = booksDigest({
            storagePath: proof.storage_path,
            sizeBytes: proof.size_bytes,
            checksum: proof.checksum,
          });
          const declared = bundle.manifest.supportingHistoricalFiles?.find(
            (item) => item.id === sourceId,
          );
          const encoded = declared?.currentFileId
            ? bundle.supportingObjects?.find(
                (item) => item.fileId === declared.currentFileId,
              )?.dataBase64
            : bundle.supportingHistoricalObjects?.find(
                (item) => item.attachmentId === sourceId,
              )?.dataBase64;
          if (typeof encoded !== "string")
            throw new Error("original payroll register bytes");
          verifyPayrollArchiveSource(evidence, encoded);
        }
        if (
          payroll.org_id !== evidence.run.org_id ||
          payroll.id !== evidence.run.id ||
          payroll.source_checksum !== proof.checksum ||
          payroll.provider !== evidence.run.provider ||
          payroll.provider_run_id !== evidence.run.provider_run_id ||
          payroll.period_start !== evidence.run.period_start ||
          payroll.period_end !== evidence.run.period_end
        )
          throw new Error("identity");
        if (
          !["draft", "reviewed", "withdrawn"].includes(
            String(payroll.status),
          ) ||
          !payroll.prepared_by ||
          !payroll.prepared_at ||
          String(payroll.preparation_notes ?? "").trim().length < 10
        )
          throw new Error("preparation");
        if (
          payroll.status === "reviewed" &&
          (!payroll.reviewed_by ||
            payroll.reviewed_by === payroll.prepared_by ||
            !payroll.reviewed_at ||
            String(payroll.review_notes ?? "").trim().length < 10)
        )
          throw new Error("review");
        if (
          payroll.status === "withdrawn" &&
          (!payroll.withdrawn_by ||
            !payroll.withdrawn_at ||
            String(payroll.withdrawal_reason ?? "").trim().length < 10)
        )
          throw new Error("withdrawal");
        if (
          !(bundle.tables.files ?? []).some(
            (row) => row.id === proof.file_id,
          ) ||
          !(bundle.tables.doc_versions ?? []).some(
            (row) =>
              row.id === proof.document_version_id &&
              row.file_id === proof.file_id &&
              row.storage_path === proof.storage_path &&
              row.checksum === proof.checksum &&
              Number(row.size_bytes) === proof.size_bytes &&
              row.file_name === proof.file_name &&
              (row.mime_type ?? null) === proof.mime_type,
          )
        )
          throw new Error("original version");
        for (const worker of evidence.run.employees)
          for (const allocation of worker.allocations) {
            if (
              (allocation.project_id &&
                !(bundle.tables.projects ?? []).some(
                  (row) => row.id === allocation.project_id,
                )) ||
              (allocation.cost_code_id &&
                !(bundle.tables.cost_codes ?? []).some(
                  (row) => row.id === allocation.cost_code_id,
                ))
            )
              throw new Error("allocation");
          }
        for (const account of evidence.reconciliation.postingAccounts as {
          id: string;
        }[])
          if (
            !(bundle.tables.gl_accounts ?? []).some(
              (row) => row.id === account.id,
            )
          )
            throw new Error("posting account");
        for (const labor of evidence.labor_evidence) {
          const fact = (bundle.tables.accounting_facts ?? []).find(
            (row) => row.id === labor.fact_id,
          );
          const journal = (bundle.tables.journal_entries ?? []).find(
            (row) => row.id === labor.journal_id,
          );
          const source = (bundle.tables.job_cost_entries ?? []).find(
            (row) => row.id === labor.id,
          );
          if (
            !source ||
            !fact ||
            !journal ||
            fact.source_type !== "labor_cost" ||
            fact.source_id !== labor.id ||
            journal.fact_id !== fact.id ||
            journal.source_type !== "labor_cost" ||
            journal.source_id !== labor.id
          )
            throw new Error("labor links");
          const basis = (fact.payload as Record<string, unknown> | undefined)
            ?.labor_basis as Record<string, unknown> | undefined;
          if (
            !basis ||
            basis.org_id !== labor.org_id ||
            basis.job_cost_id !== labor.id ||
            basis.worker_id !== labor.worker_id ||
            basis.project_id !== labor.project_id ||
            basis.cost_code_id !== labor.cost_code_id ||
            basis.incurred_on !== labor.incurred_on ||
            basis.source_revision !== labor.source_revision ||
            basis.gross_cents !== labor.gross_cents ||
            basis.estimated_burden_cents !== labor.estimated_burden_cents ||
            basis.cost_cents !== labor.cost_cents
          )
            throw new Error("original wages");
          if (
            journal.entry_date !== labor.incurred_on ||
            fact.accounting_date !== labor.incurred_on ||
            journal.reversal_of_entry_id != null ||
            !["posted", "reversed"].includes(String(journal.status))
          )
            throw new Error("original journal");
          const originalLines = (bundle.tables.journal_lines ?? []).filter(
            (line) => line.entry_id === journal.id,
          );
          if (originalLines.length !== 2)
            throw new Error("original journal lines");
          for (const line of originalLines) {
            const dimensions = line.dimensions as
                | Record<string, unknown>
                | undefined,
              classification = dimensions?.books_account_classification as
                | Record<string, unknown>
                | undefined;
            if (
              !classification ||
              classification.version !== 1 ||
              classification.account_id !== line.account_id ||
              classification.legacy_unknown ||
              line.project_id !== labor.project_id ||
              (dimensions?.cost_code_id ?? null) !== labor.cost_code_id ||
              dimensions?.labor_job_cost_id !== labor.id ||
              dimensions?.labor_time_entry_id !== basis.time_entry_id ||
              dimensions?.labor_worker_id !== labor.worker_id ||
              dimensions?.labor_basis_hash !== booksDigest(basis)
            )
              throw new Error("original line identity");
            if (classification.code === "2200") {
              if (
                classification.account_type !== "liability" ||
                line.debit_cents !== 0 ||
                line.credit_cents !== labor.clearing_cents
              )
                throw new Error("original clearing");
            } else if (
              classification.code !== labor.account_code ||
              line.credit_cents !== 0 ||
              line.debit_cents !== labor.cost_cents ||
              (!["cogs", "expense"].includes(
                String(classification.account_type),
              ) &&
                !(
                  classification.account_type === "asset" &&
                  classification.subtype === "work_in_progress"
                ))
            )
              throw new Error("original cost");
          }
        }
      } catch {
        integrityErrors.push(
          `Invalid payroll draft/review/source evidence: ${payroll.id}`,
        );
      }
    }
    const paymentCapacity = new Map<
      string,
      { used: bigint; available: bigint }
    >();
    const activePaymentParents = new Set<string>(),
      paymentRetryKeys = new Set<string>();
    for (const review of bundle.tables.books_payroll_payment_reviews ?? []) {
      try {
        const parent = (bundle.tables.books_payroll_imports ?? []).find(
          (row) =>
            row.id === review.payroll_import_id && row.org_id === review.org_id,
        );
        if (!parent) throw new Error("payroll parent");
        const root = parsePayrollDraftEvidence(
          Object.fromEntries(
            [
              "run",
              "reconciliation",
              "labor_evidence",
              "source_proof",
              "column_mapping",
              "evidence_digest",
              "mapping_digest",
              "reconciliation_digest",
              "source_revision",
            ].map((key) => [key, parent[key]]),
          ),
        );
        const parsed = parsePayrollPaymentReviewEvidence(
          root,
          review.request,
          review.evidence,
          String(review.evidence_digest),
        );
        const isUuid = (value: unknown) =>
          typeof value === "string" &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
            value,
          );
        const isDate = (value: unknown) =>
          typeof value === "string" && Number.isFinite(Date.parse(value));
        const hasNotes = (value: unknown) =>
          typeof value === "string" &&
          value.trim().length >= 10 &&
          value.length <= 4000;
        if (
          review.id !== parsed.request.id ||
          review.payroll_import_id !== parsed.request.payroll_import_id ||
          review.org_id !== parsed.evidence.org_id ||
          !["draft", "reviewed", "withdrawn"].includes(String(review.status)) ||
          !isUuid(review.prepared_by) ||
          !isDate(review.prepared_at) ||
          !hasNotes(review.preparation_notes) ||
          typeof review.idempotency_key !== "string" ||
          review.idempotency_key.trim().length < 10
        )
          throw new Error("payment preparation identity");
        if (review.status === "reviewed" || review.reviewed_by != null) {
          if (
            !isUuid(review.reviewed_by) ||
            review.reviewed_by === review.prepared_by ||
            review.reviewed_by === parent.prepared_by ||
            !isDate(review.reviewed_at) ||
            !hasNotes(review.review_notes) ||
            review.status === "draft"
          )
            throw new Error("payment independent review");
        } else if (review.reviewed_at != null || review.review_notes != null)
          throw new Error("payment partial review metadata");
        if (review.status === "withdrawn") {
          if (
            !isUuid(review.withdrawn_by) ||
            !isDate(review.withdrawn_at) ||
            typeof review.withdrawal_reason !== "string" ||
            review.withdrawal_reason.trim().length < 10
          )
            throw new Error("payment withdrawal");
        } else if (
          review.withdrawn_by != null ||
          review.withdrawn_at != null ||
          review.withdrawal_reason != null
        )
          throw new Error("payment partial withdrawal metadata");
        const retryKey = `${review.org_id}:${review.idempotency_key}`,
          parentKey = `${review.org_id}:${review.payroll_import_id}`;
        if (
          paymentRetryKeys.has(retryKey) ||
          (review.status !== "withdrawn" && activePaymentParents.has(parentKey))
        )
          throw new Error("duplicate payroll payment reservation");
        paymentRetryKeys.add(retryKey);
        if (review.status !== "withdrawn") activePaymentParents.add(parentKey);
        if (parent.status === "withdrawn" && review.status !== "withdrawn")
          throw new Error("orphan active payment claim");
        for (const proof of parsed.evidence.supporting_documents) {
          if (
            !(bundle.tables.files ?? []).some(
              (row) => row.id === proof.file_id && row.org_id === proof.org_id,
            ) ||
            !(bundle.tables.doc_versions ?? []).some(
              (row) =>
                row.id === proof.document_version_id &&
                row.org_id === proof.org_id &&
                row.file_id === proof.file_id &&
                row.storage_path === proof.storage_path &&
                row.checksum === proof.checksum &&
                Number(row.size_bytes) === proof.size_bytes &&
                row.file_name === proof.file_name &&
                (row.mime_type ?? null) === proof.mime_type,
            )
          )
            throw new Error("original payment supporting version");
        }
        for (const claim of parsed.evidence.source_line_claims) {
          const source = (bundle.tables.journal_lines ?? []).find(
            (row) =>
              row.id === claim.line_id &&
              row.org_id === review.org_id &&
              row.entry_id === claim.journal_id,
          );
          const original = (
            root.reconciliation.workflowEvidence as {
              sourceTables: { journal_lines: Record<string, unknown>[] };
            }
          ).sourceTables.journal_lines.find((row) => row.id === claim.line_id);
          if (
            !source ||
            !original ||
            source.account_id !== original.account_id ||
            (source.project_id ?? null) !== (original.project_id ?? null) ||
            BigInt(String(source.debit_cents)) !==
              BigInt(String(original.debit_cents)) ||
            BigInt(String(source.credit_cents)) !==
              BigInt(String(original.credit_cents)) ||
            BigInt(String(source.debit_cents)) +
              BigInt(String(source.credit_cents)) !==
              BigInt(claim.available_cents)
          )
            throw new Error("original payment line");
          if (review.status !== "withdrawn") {
            const capacity = paymentCapacity.get(claim.line_id) ?? {
              used: BigInt(0),
              available: BigInt(claim.available_cents),
            };
            if (capacity.available !== BigInt(claim.available_cents))
              throw new Error("payment capacity identity");
            capacity.used += BigInt(claim.claimed_cents);
            paymentCapacity.set(claim.line_id, capacity);
          }
        }
      } catch {
        integrityErrors.push(
          `Invalid payroll payment attribution evidence: ${review.id}`,
        );
      }
    }
    for (const [id, capacity] of paymentCapacity)
      if (capacity.used > capacity.available)
        integrityErrors.push(
          `Payroll payment claims exceed original line capacity: ${id}`,
        );
    const proposalParents = new Set<string>(),
      proposalKeys = new Set<string>();
    for (const proposal of bundle.tables.books_payroll_posting_proposals ??
      []) {
      try {
        const parent = (bundle.tables.books_payroll_imports ?? []).find(
          (row) =>
            row.id === proposal.payroll_import_id &&
            row.org_id === proposal.org_id,
        );
        const payment =
          proposal.payment_review_id == null
            ? null
            : (bundle.tables.books_payroll_payment_reviews ?? []).find(
                (row) =>
                  row.id === proposal.payment_review_id &&
                  row.org_id === proposal.org_id &&
                  row.payroll_import_id === proposal.payroll_import_id,
              );
        const parsed = parsePayrollPostingProposal(
          proposal,
          parent,
          payment ?? null,
        );
        const parentKey = `${proposal.org_id}:${parsed.row.payroll_import_id}`,
          retryKey = `${proposal.org_id}:${parsed.row.idempotency_key}`;
        if (
          proposalKeys.has(retryKey) ||
          (parsed.row.status !== "withdrawn" && proposalParents.has(parentKey))
        )
          throw new Error("duplicate proposal reservation");
        proposalKeys.add(retryKey);
        if (parsed.row.status !== "withdrawn") proposalParents.add(parentKey);
      } catch {
        integrityErrors.push(
          `Invalid payroll posting proposal evidence: ${proposal.id}`,
        );
      }
    }
    const postingParents = new Set<string>(),
      postingKeys = new Set<string>();
    const correctionRevisions = new Set<string>(),
      correctionKeys = new Set<string>(),
      correctionDrafts = new Set<string>();
    const correctionHistory = new Map<string, number[]>();
    for (const source of bundle.tables.books_payroll_correction_sources ?? []) {
      try {
        const proof = source.source_proof as Record<string, unknown>,
          sourceId = booksDigest({
            storagePath: proof.storage_path,
            sizeBytes: proof.size_bytes,
            checksum: proof.checksum,
          });
        const declared = bundle.manifest.supportingHistoricalFiles?.find(
            (item) => item.id === sourceId,
          ),
          encoded = declared?.currentFileId
            ? bundle.supportingObjects?.find(
                (item) => item.fileId === declared.currentFileId,
              )?.dataBase64
            : bundle.supportingHistoricalObjects?.find(
                (item) => item.attachmentId === sourceId,
              )?.dataBase64;
        if (typeof encoded !== "string")
          throw new Error("Correction provider bytes missing");
        const row = verifyPayrollCorrectionSourceBytes(
            source,
            bundle.tables,
            encoded,
          ),
          revision = `${row.org_id}:${row.posting_id}:${row.revision}`,
          key = `${row.org_id}:${row.idempotency_key}`,
          root = `${row.org_id}:${row.posting_id}`;
        if (
          correctionRevisions.has(revision) ||
          correctionKeys.has(key) ||
          (row.status === "draft" && correctionDrafts.has(root))
        )
          throw new Error("Correction source reservation differs");
        correctionRevisions.add(revision);
        correctionKeys.add(key);
        if (row.status === "draft") correctionDrafts.add(root);
        const versions = correctionHistory.get(root) ?? [];
        versions.push(row.revision);
        correctionHistory.set(root, versions);
        if (
          !(bundle.tables.doc_versions ?? []).some(
            (version) =>
              version.org_id === row.org_id &&
              version.id === row.source_proof.document_version_id &&
              version.file_id === row.source_proof.file_id &&
              version.storage_path === row.source_proof.storage_path &&
              version.checksum === row.source_proof.checksum &&
              Number(version.size_bytes) === row.source_proof.size_bytes &&
              version.file_name === row.source_proof.file_name &&
              (version.mime_type ?? null) === row.source_proof.mime_type,
          )
        )
          throw new Error("Correction original version differs");
      } catch {
        integrityErrors.push(`Invalid payroll correction source: ${source.id}`);
      }
    }
    for (const [root, versions] of correctionHistory)
      if (
        versions
          .sort((a, b) => a - b)
          .some((version, index) => version !== index + 1)
      )
        integrityErrors.push(
          `Incomplete payroll correction source history: ${root}`,
        );
    const correctiveRoots = new Set<string>(),
      correctiveKeys = new Set<string>();
    for (const proposal of bundle.tables.books_payroll_correction_proposals ??
      []) {
      try {
        const row = parsePayrollCorrectionProposal(proposal, bundle.tables),
          root = `${row.org_id}:${row.posting_id}`,
          key = `${row.org_id}:${row.idempotency_key}`;
        if (
          correctiveKeys.has(key) ||
          (row.status !== "withdrawn" &&
            row.posted_receipt_id === null &&
            correctiveRoots.has(root))
        )
          throw new Error("Duplicate corrective proposal reservation");
        correctiveKeys.add(key);
        if (row.status !== "withdrawn" && row.posted_receipt_id === null)
          correctiveRoots.add(root);
      } catch {
        integrityErrors.push(
          `Invalid payroll correction proposal: ${proposal.id}`,
        );
      }
    }
    const correctedRoots = new Set<string>(),
      correctedSources = new Set<string>(),
      correctedProposals = new Set<string>(),
      correctedPostingKeys = new Set<string>();
    for (const posting of bundle.tables.books_payroll_correction_postings ??
      []) {
      try {
        if (
          bundle.manifest.schemaVersion < 17 &&
          (posting.result as { version?: unknown })?.version === 2
        )
          throw new Error("Sequential monetary receipts require schema 17");
        const row = verifyPayrollCorrectionPosting(posting, bundle.tables),
          root = `${row.org_id}:${row.posting_id}:${row.sequence}`,
          source = `${row.org_id}:${row.source_id}`,
          proposal = `${row.org_id}:${row.proposal_id}`,
          key = `${row.org_id}:${row.idempotency_key}`;
        if (
          correctedRoots.has(root) ||
          correctedSources.has(source) ||
          correctedProposals.has(proposal) ||
          correctedPostingKeys.has(key)
        )
          throw new Error("Duplicate corrective ownership");
        correctedRoots.add(root);
        correctedSources.add(source);
        correctedProposals.add(proposal);
        correctedPostingKeys.add(key);
      } catch {
        integrityErrors.push(
          `Invalid payroll correction posting: ${posting.id}`,
        );
      }
    }
    for (const table of ["journal_entries", "accounting_facts"])
      for (const row of bundle.tables[table] ?? [])
        if (
          row.source_type === "payroll_correction" &&
          !correctedSources.has(`${row.org_id}:${row.source_id}`)
        )
          integrityErrors.push(
            `Correction money lacks posted ownership: ${table}:${row.id}`,
          );
    for (const row of bundle.tables.job_cost_entries ?? [])
      if (
        row.source_type === "payroll_correction" &&
        !(bundle.tables.books_payroll_correction_postings ?? []).some(
          (p) =>
            p.org_id === row.org_id &&
            p.id ===
              (row.metadata as Record<string, unknown>)
                ?.payroll_correction_posting_id,
        )
      )
        integrityErrors.push(
          `Correction project cost lacks posted ownership: ${row.id}`,
        );
    const nativeTimes = new Set<string>(),
      nativeJobs = new Set<string>();
    for (const source of bundle.tables.books_payroll_labor_ownership ?? []) {
      try {
        const row = payrollNativeOwnershipSchema.parse(source),
          timeKey = `${row.org_id}:${row.time_entry_id}`,
          jobKey = `${row.org_id}:${row.job_cost_entry_id}`;
        if (nativeTimes.has(timeKey) || nativeJobs.has(jobKey))
          throw new Error("Duplicate consumed native source");
        nativeTimes.add(timeKey);
        nativeJobs.add(jobKey);
        const postings = (bundle.tables.books_payroll_postings ?? []).filter(
          (posting) =>
            posting.id === row.posting_id && posting.org_id === row.org_id,
        );
        if (postings.length !== 1)
          throw new Error("Missing native payroll posting");
      } catch {
        integrityErrors.push(`Invalid payroll native ownership: ${source.id}`);
      }
    }
    for (const posting of bundle.tables.books_payroll_postings ?? []) {
      try {
        const receipt = verifyPayrollPostingReceipt(posting, bundle.tables, {
          requireNativeOwnership:
            bundle.manifest.schemaVersion >= 13 ||
            (bundle.tables.books_payroll_labor_ownership ?? []).some(
              (row) =>
                row.org_id === posting.org_id && row.posting_id === posting.id,
            ),
        });
        const parentKey = `${receipt.org_id}:${receipt.payroll_import_id}`,
          retryKey = `${receipt.org_id}:${receipt.idempotency_key}`;
        if (postingParents.has(parentKey) || postingKeys.has(retryKey))
          throw new Error("Duplicate posted payroll ownership");
        postingParents.add(parentKey);
        postingKeys.add(retryKey);
      } catch {
        integrityErrors.push(`Invalid payroll posted receipt: ${posting.id}`);
      }
    }
    for (const table of ["journal_entries", "accounting_facts"])
      for (const source of bundle.tables[table] ?? []) {
        if (
          source.source_type === "payroll_import" &&
          !postingParents.has(`${source.org_id}:${source.source_id}`)
        )
          integrityErrors.push(
            `Payroll source lacks posted ownership: ${table}:${source.id}`,
          );
      }
    for (const cost of bundle.tables.job_cost_entries ?? [])
      if (
        cost.source_type === "payroll_import" &&
        !(bundle.tables.books_payroll_postings ?? []).some(
          (posting) =>
            posting.org_id === cost.org_id &&
            posting.id ===
              (cost.metadata as { payroll_posting_id?: unknown })
                ?.payroll_posting_id,
        )
      )
        integrityErrors.push(
          `Payroll project cost lacks posted ownership: ${cost.id}`,
        );
    for (const [child, column, parent] of references) {
      const parents = new Set(
        (bundle.tables[parent] ?? []).map((row) => row.id),
      );
      for (const row of bundle.tables[child] ?? [])
        if (row[column] != null && !parents.has(row[column]))
          integrityErrors.push(
            `Missing ${parent} for ${child}.${column}:${String(row.id)}`,
          );
    }
  } else if (bundle.manifest)
    integrityErrors.push(
      `Unsupported export schema version ${bundle.manifest.schemaVersion}`,
    );
  if (bundle.manifest && bundle.manifest.schemaVersion >= 4) {
    const objects = bundle.supportingObjects ?? [];
    const files = bundle.tables.files ?? [];
    const declared = bundle.manifest.supportingFiles ?? [];
    const byId = new Map(objects.map((object) => [object.fileId, object]));
    const declaredById = new Map(declared.map((file) => [file.id, file]));
    if (objects.length !== byId.size || declared.length !== declaredById.size)
      integrityErrors.push("Duplicate supporting files");
    if (objects.length !== files.length || declared.length !== files.length)
      integrityErrors.push("Supporting file inventory differs");
    for (const file of files) {
      const object = byId.get(String(file.id));
      const description = declaredById.get(file.id);
      if (!object || !description) {
        integrityErrors.push(`Missing supporting file ${file.id}`);
        continue;
      }
      if (
        description.storagePath !== file.storage_path ||
        description.checksum !== file.checksum ||
        description.sizeBytes !== file.size_bytes
      )
        integrityErrors.push(`Supporting file metadata differs: ${file.id}`);
      if (typeof object.dataBase64 !== "string") {
        integrityErrors.push(`Invalid supporting file encoding: ${file.id}`);
        continue;
      }
      const bytes = Buffer.from(object.dataBase64, "base64");
      if (
        bytes.toString("base64") !== object.dataBase64 ||
        !Number.isSafeInteger(file.size_bytes) ||
        bytes.length !== file.size_bytes ||
        createHash("sha256").update(bytes).digest("hex") !== file.checksum
      )
        integrityErrors.push(`Supporting file bytes differ: ${file.id}`);
    }
  }
  if (bundle.manifest && (bundle.manifest.schemaVersion ?? 0) >= 8) {
    try {
      const versions = new Map(
        (bundle.tables.doc_versions ?? []).map((row) => [row.id, row]),
      );
      for (const file of bundle.tables.files ?? []) {
        if (file.current_version_id == null) continue;
        const version = versions.get(file.current_version_id);
        if (
          !version ||
          version.file_id !== file.id ||
          version.storage_path !== file.storage_path ||
          version.checksum !== file.checksum ||
          Number(version.size_bytes) !== Number(file.size_bytes)
        )
          integrityErrors.push(
            `Current document version differs from file: ${file.id}`,
          );
      }
      const expected = historicalDocumentInventory(
        bundle.tables,
        bundle.manifest.orgId,
      );
      const declared = bundle.manifest.supportingHistoricalFiles;
      if (
        !Array.isArray(declared) ||
        booksDigest([...declared].sort((a, b) => a.id.localeCompare(b.id))) !==
          booksDigest(expected)
      )
        integrityErrors.push("Frozen tax attachment inventory differs");
      const objects = bundle.supportingHistoricalObjects ?? [],
        byId = new Map(objects.map((object) => [object.attachmentId, object]));
      const required = expected.filter((item) => !item.currentFileId);
      if (
        objects.length !== byId.size ||
        objects.length !== required.length ||
        objects.some(
          (object) => !required.some((item) => item.id === object.attachmentId),
        )
      )
        integrityErrors.push("Frozen tax attachment object inventory differs");
      for (const item of expected) {
        const encoded = item.currentFileId
          ? bundle.supportingObjects?.find(
              (object) => object.fileId === item.currentFileId,
            )?.dataBase64
          : byId.get(item.id)?.dataBase64;
        if (typeof encoded !== "string") {
          integrityErrors.push(
            `Missing frozen tax attachment bytes: ${item.id}`,
          );
          continue;
        }
        const bytes = Buffer.from(encoded, "base64");
        if (
          bytes.toString("base64") !== encoded ||
          bytes.length !== item.sizeBytes ||
          createHash("sha256").update(bytes).digest("hex") !== item.checksum
        )
          integrityErrors.push(
            `Frozen tax attachment bytes differ: ${item.id}`,
          );
      }
    } catch {
      integrityErrors.push(
        "Invalid or conflicting frozen tax attachment inventory",
      );
    }
  }
  return {
    valid:
      unbalancedEntryIds.length === 0 &&
      missingLineEntryIds.length === 0 &&
      integrityErrors.length === 0,
    integrityErrors,
    postedEntryCount: postedEntryIds.size,
    unbalancedEntryIds,
    missingLineEntryIds,
  };
}
