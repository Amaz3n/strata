import { NATIVE_INVOICE_CORRECTION_REVIEW_TABLE } from "./native-invoice-correction-review";
import { NATIVE_INVOICE_CORRECTION_PROPOSAL_TABLE } from "./native-invoice-correction-proposal";
import { NATIVE_INVOICE_INCOME_RESOLUTION_TABLE } from "./native-invoice-income-resolution";
import { NATIVE_INVOICE_INCOME_TABLE } from "./native-invoice-income-contract";
import { NATIVE_INVOICE_RESOLUTION_TABLE } from "./native-invoice-resolution";
import {
  NATIVE_ADJUSTMENT_TABLES,
  NATIVE_INVOICE_POSTING_TABLE,
} from "./native-adjustment-archive";
import { PROJECT_OWNER_RESOLUTION_TABLE } from "./project-owner-resolution-archive";
import { PROJECT_ENTITY_TABLES } from "./project-entity-archive";
import { ENTITY_CHART_TABLES } from "./entity-chart-archive";
import { ENTITY_CALENDAR_TABLES } from "./entity-calendars";
import { LEGACY_ENTITY_OWNERSHIP_TABLES } from "./legacy-entity-ownership";
import { LEGAL_ENTITY_ARCHIVE_TABLES } from "./legal-entity-archive";
import { booksDigest } from "@/lib/services/books/hash";
import {
  EXPORT_TABLES,
  verifyBooksExportBundle,
} from "@/lib/services/books/export-contract";
import {
  preflightBooksRestore,
  type BooksRestoreCatalog,
  type BooksRestoreDependency,
} from "@/lib/services/books/restore-preflight";
import { derivePayrollNativeOwnership } from "./payroll-native-ownership";
import { verifyPayrollCorrectionPosting } from "./payroll-correction-posting";
import { payrollPostingReceiptSchema } from "./payroll-posting-receipt";

/** Administrative preparation only; executing this plan requires an isolated target. */
export function prepareBooksRestorePlan(input: {
  bundle: Parameters<typeof verifyBooksExportBundle>[0];
  catalog: BooksRestoreCatalog;
  dependencies: BooksRestoreDependency[];
  fundingActors: Record<string, { actorId: string; explanation: string }>;
}) {
  if (!input.bundle.manifest || !verifyBooksExportBundle(input.bundle).valid)
    throw new Error("Restore plan requires a verified versioned archive");
  const allowedTables = new Set<string>(EXPORT_TABLES);
  if (
    Object.keys(input.bundle.tables).some((table) => !allowedTables.has(table))
  )
    throw new Error("Restore archive contains unsupported tables");
  const dependencies = JSON.parse(
    JSON.stringify(input.dependencies),
  ) as BooksRestoreDependency[];
  const allowedDependencies = new Set([
    "public.orgs",
    "public.app_users",
    "auth.users",
  ]);
  const keys = new Set<string>();
  for (const dependency of dependencies) {
    const key = `${dependency.schema}.${dependency.table}`;
    if (!allowedDependencies.has(key) || keys.has(key))
      throw new Error(
        "Restore plan has unsupported or duplicate identity dependencies",
      );
    keys.add(key);
    if (
      dependency.rows.some(
        (record) => typeof record.id !== "string" || !record.id,
      )
    )
      throw new Error(
        "Restore identity dependency requires explicit nonempty IDs",
      );
    if (
      new Set(dependency.rows.map((record) => record.id)).size !==
      dependency.rows.length
    )
      throw new Error("Restore identity dependency has duplicate IDs");
    if (
      key === "auth.users" &&
      dependency.rows.some(
        (record) =>
          record.banned_until !== "infinity" ||
          Object.entries(record).some(
            ([name, value]) =>
              (name === "encrypted_password" || name.includes("token")) &&
              Boolean(value),
          ),
      )
    )
      throw new Error(
        "Restored authentication identities must remain disabled without credentials or tokens",
      );
    if (
      key === "public.orgs" &&
      dependency.rows.some(
        (record) => record.id !== input.bundle.manifest!.orgId,
      )
    )
      throw new Error(
        "Restore organization dependency does not match the archive",
      );
  }
  const tables = JSON.parse(JSON.stringify(input.bundle.tables)) as Record<
    string,
    Record<string, unknown>[]
  >;
  const changes: {
    table: string;
    rowId: string;
    fields: string[];
    explanation: string;
  }[] = [];
  if (input.bundle.manifest.schemaVersion < 32) {
    if ((tables[NATIVE_INVOICE_CORRECTION_REVIEW_TABLE] ?? []).length)
      throw Error("Older archive cannot invent native correction reviews");
    if (
      input.catalog.columns.some(
        (c) =>
          (c.schema ?? "public") === "public" &&
          c.table === NATIVE_INVOICE_CORRECTION_REVIEW_TABLE,
      )
    )
      tables[NATIVE_INVOICE_CORRECTION_REVIEW_TABLE] = [];
  }
  if (input.bundle.manifest.schemaVersion < 30) {
    if ((tables[NATIVE_INVOICE_CORRECTION_PROPOSAL_TABLE] ?? []).length)
      throw Error(
        "Older archive cannot invent native invoice correction proposals",
      );
    if (
      input.catalog.columns.some(
        (c) =>
          (c.schema ?? "public") === "public" &&
          c.table === NATIVE_INVOICE_CORRECTION_PROPOSAL_TABLE,
      )
    )
      tables[NATIVE_INVOICE_CORRECTION_PROPOSAL_TABLE] = [];
  }
  if (input.bundle.manifest.schemaVersion < 29) {
    if ((tables[NATIVE_INVOICE_INCOME_RESOLUTION_TABLE] ?? []).length)
      throw Error("Older archive cannot invent native income cancellations");
    if (
      input.catalog.columns.some(
        (c) =>
          (c.schema ?? "public") === "public" &&
          c.table === NATIVE_INVOICE_INCOME_RESOLUTION_TABLE,
      )
    )
      tables[NATIVE_INVOICE_INCOME_RESOLUTION_TABLE] = [];
  }
  if (input.bundle.manifest.schemaVersion < 28) {
    if ((tables[NATIVE_INVOICE_INCOME_TABLE] ?? []).length)
      throw Error("Older archive cannot invent native income selections");
    if (
      input.catalog.columns.some(
        (c) =>
          (c.schema ?? "public") === "public" &&
          c.table === NATIVE_INVOICE_INCOME_TABLE,
      )
    )
      tables[NATIVE_INVOICE_INCOME_TABLE] = [];
    if (
      input.catalog.columns.some(
        (c) =>
          (c.schema ?? "public") === "public" &&
          c.table === NATIVE_INVOICE_POSTING_TABLE &&
          c.name === "income_selection_id",
      )
    )
      for (const row of tables[NATIVE_INVOICE_POSTING_TABLE] ?? []) {
        if (row.income_selection_id != null)
          throw Error(
            "Older archive cannot invent native income-selection origin",
          );
        if (!("income_selection_id" in row)) {
          row.income_selection_id = null;
          changes.push({
            table: NATIVE_INVOICE_POSTING_TABLE,
            rowId: String(row.id),
            fields: ["income_selection_id"],
            explanation:
              "Retained pre-schema28 native posting predates income-selection provenance",
          });
        }
      }
  }
  if (input.bundle.manifest.schemaVersion < 27) {
    if ((tables[NATIVE_INVOICE_RESOLUTION_TABLE] ?? []).length)
      throw Error("Older archive cannot invent native invoice cancellations");
    if (
      input.catalog.columns.some(
        (c) =>
          (c.schema ?? "public") === "public" &&
          c.table === NATIVE_INVOICE_RESOLUTION_TABLE,
      )
    )
      tables[NATIVE_INVOICE_RESOLUTION_TABLE] = [];
  }
  if (input.bundle.manifest.schemaVersion < 26) {
    if ((tables[NATIVE_INVOICE_POSTING_TABLE] ?? []).length)
      throw Error("Older archive cannot invent native invoice source history");
    if (
      input.catalog.columns.some(
        (c) =>
          (c.schema ?? "public") === "public" &&
          c.table === NATIVE_INVOICE_POSTING_TABLE,
      )
    )
      tables[NATIVE_INVOICE_POSTING_TABLE] = [];
    const hasOrigin = input.catalog.columns.some(
      (c) =>
        (c.schema ?? "public") === "public" &&
        c.table === "books_native_journal_entries" &&
        c.name === "source_posting_id",
    );
    if (hasOrigin)
      for (const row of tables.books_native_journal_entries ?? []) {
        if (row.source_posting_id != null)
          throw Error(
            "Older archive cannot invent native operational journal origin",
          );
        if (!("source_posting_id" in row)) {
          row.source_posting_id = null;
          changes.push({
            table: "books_native_journal_entries",
            rowId: String(row.id),
            fields: ["source_posting_id"],
            explanation:
              "Historical native adjustment has no operational source receipt; preserve explicit null origin.",
          });
        }
      }
  }
  if (input.bundle.manifest.schemaVersion < 25) {
    for (const table of NATIVE_ADJUSTMENT_TABLES) {
      if ((tables[table] ?? []).length)
        throw new Error("Older archive cannot invent native monetary history");
      if (
        input.catalog.columns.some(
          (c) => (c.schema ?? "public") === "public" && c.table === table,
        )
      )
        tables[table] = [];
    }
  }
  if (input.bundle.manifest.schemaVersion < 24) {
    const table = PROJECT_OWNER_RESOLUTION_TABLE;
    if ((tables[table] ?? []).length)
      throw new Error("Older archive cannot invent ownership cancellations");
    if (
      input.catalog.columns.some(
        (c) => (c.schema ?? "public") === "public" && c.table === table,
      )
    )
      tables[table] = [];
  }
  if (input.bundle.manifest.schemaVersion < 23) {
    for (const table of PROJECT_ENTITY_TABLES) {
      if ((tables[table] ?? []).length)
        throw new Error("Older archive cannot invent project ownership");
      if (
        input.catalog.columns.some(
          (c) => (c.schema ?? "public") === "public" && c.table === table,
        )
      )
        tables[table] = [];
    }
  }
  if (input.bundle.manifest.schemaVersion < 22) {
    for (const table of ENTITY_CHART_TABLES) {
      if ((tables[table] ?? []).length)
        throw new Error("Older archive cannot invent entity charts");
      if (
        input.catalog.columns.some(
          (c) => (c.schema ?? "public") === "public" && c.table === table,
        )
      )
        tables[table] = [];
    }
  }
  if (input.bundle.manifest.schemaVersion < 21) {
    for (const table of ENTITY_CALENDAR_TABLES) {
      if ((tables[table] ?? []).length)
        throw new Error("Older archive cannot invent entity fiscal calendars");
      if (
        input.catalog.columns.some(
          (c) => (c.schema ?? "public") === "public" && c.table === table,
        )
      )
        tables[table] = [];
    }
  }
  if (input.bundle.manifest.schemaVersion < 20) {
    if ((tables.books_journal_request_resolutions ?? []).length)
      throw new Error(
        "Older archive cannot invent journal recovery resolutions",
      );
    if (
      input.catalog.columns.some(
        (column) =>
          (column.schema ?? "public") === "public" &&
          column.table === "books_journal_request_resolutions",
      )
    )
      tables.books_journal_request_resolutions = [];
  }
  if (input.bundle.manifest.schemaVersion < 18) {
    for (const table of LEGAL_ENTITY_ARCHIVE_TABLES) {
      if ((tables[table] ?? []).length)
        throw new Error(
          "Legacy archive cannot invent native legal entity ownership",
        );
      if (
        input.catalog.columns.some(
          (column) =>
            (column.schema ?? "public") === "public" && column.table === table,
        )
      )
        tables[table] = [];
    }
  }
  if (input.bundle.manifest.schemaVersion < 19) {
    for (const table of LEGACY_ENTITY_OWNERSHIP_TABLES) {
      if ((tables[table] ?? []).length)
        throw new Error(
          "Older archive cannot invent approved legacy entity ownership",
        );
      if (
        input.catalog.columns.some(
          (column) =>
            (column.schema ?? "public") === "public" && column.table === table,
        )
      )
        tables[table] = [];
    }
  }
  // Restrict historical payroll source and settlement documents without rewriting
  // their immutable source paths, version IDs, checksums or provider evidence.
  if (
    input.catalog.columns.some(
      (column) =>
        (column.schema ?? "public") === "public" &&
        column.table === "files" &&
        column.name === "metadata",
    )
  ) {
    const sourceFiles = new Set(
      [
        ...(tables.books_payroll_imports ?? []),
        ...(tables.books_payroll_correction_sources ?? []),
      ]
        .map(
          (row) =>
            (row.source_proof as { file_id?: unknown } | undefined)?.file_id,
        )
        .filter((value) => typeof value === "string"),
    );
    for (const row of tables.books_payroll_payment_reviews ?? []) {
      const documents = (
        row.evidence as { supporting_documents?: unknown } | undefined
      )?.supporting_documents;
      if (Array.isArray(documents))
        for (const proof of documents)
          if (
            proof &&
            typeof proof === "object" &&
            typeof proof.file_id === "string"
          )
            sourceFiles.add(proof.file_id);
    }
    for (const file of tables.files ?? [])
      if (typeof file.id === "string" && sourceFiles.has(file.id)) {
        const metadata =
          file.metadata &&
          typeof file.metadata === "object" &&
          !Array.isArray(file.metadata)
            ? (file.metadata as Record<string, unknown>)
            : {};
        const fields: string[] = [];
        if (metadata.books_private_kind !== "payroll_register") {
          file.metadata = {
            ...metadata,
            books_private_kind: "payroll_register",
          };
          fields.push("metadata");
        }
        for (const [name, value] of [
          ["visibility", "private"],
          ["share_with_subs", false],
          ["share_with_clients", false],
        ] as const)
          if (
            input.catalog.columns.some(
              (column) =>
                (column.schema ?? "public") === "public" &&
                column.table === "files" &&
                column.name === name,
            ) &&
            file[name] !== value
          ) {
            file[name] = value;
            fields.push(name);
          }
        if (fields.length)
          changes.push({
            table: "files",
            rowId: String(file.id),
            fields,
            explanation:
              "Restrict archived payroll source and settlement documents to the private accounting workflow; preserve all original source/version/path/checksum/amount evidence. Existing public/CDN copies still require a separate private-storage relocation and access audit.",
          });
      }
  }
  const actors = new Set(
    dependencies
      .find(
        (dependency) =>
          dependency.schema === "public" && dependency.table === "app_users",
      )
      ?.rows.map((record) => record.id) ?? [],
  );
  if (
    input.bundle.manifest.schemaVersion < 13 &&
    input.catalog.columns.some(
      (column) =>
        (column.schema ?? "public") === "public" &&
        column.table === "books_payroll_labor_ownership",
    )
  ) {
    if ((tables.books_payroll_labor_ownership ?? []).length)
      throw new Error(
        "Legacy payroll recovery must not contain partial native ownership",
      );
    tables.books_payroll_labor_ownership = [];
    const timeIds = new Set<string>(),
      jobIds = new Set<string>();
    for (const source of tables.books_payroll_postings ?? []) {
      const posting = payrollPostingReceiptSchema.parse(source);
      const parents = (tables.books_payroll_imports ?? []).filter(
        (row) =>
          row.org_id === posting.org_id && row.id === posting.payroll_import_id,
      );
      if (parents.length !== 1)
        throw new Error("Missing/ambiguous original payroll recovery parent");
      for (const row of derivePayrollNativeOwnership(
        posting,
        parents[0],
        tables,
      )) {
        if (timeIds.has(row.time_entry_id) || jobIds.has(row.job_cost_entry_id))
          throw new Error(
            "Legacy payroll recovery consumes a native source more than once",
          );
        timeIds.add(row.time_entry_id);
        jobIds.add(row.job_cost_entry_id);
        tables.books_payroll_labor_ownership.push(row);
        changes.push({
          table: "books_payroll_labor_ownership",
          rowId: row.id,
          fields: Object.keys(row),
          explanation:
            "Recover original consumed native source ownership from the reviewed posting, frozen wage basis and original fact/journal/receipt; preserve original posting timestamp",
        });
      }
    }
  }
  if (
    input.bundle.manifest.schemaVersion < 17 &&
    input.catalog.columns.some(
      (column) =>
        (column.schema ?? "public") === "public" &&
        column.table === "books_payroll_correction_proposals" &&
        column.name === "posted_receipt_id",
    )
  ) {
    for (const source of tables.books_payroll_correction_postings ?? []) {
      const posting = verifyPayrollCorrectionPosting(source, tables);
      if (
        posting.sequence !== 1 ||
        posting.previous_posting_id !== null ||
        posting.result.version !== 1
      )
        throw new Error(
          "Legacy corrective recovery cannot invent sequential money",
        );
      const proposals = (
        tables.books_payroll_correction_proposals ?? []
      ).filter(
        (row) =>
          row.org_id === posting.org_id && row.id === posting.proposal_id,
      );
      if (
        proposals.length !== 1 ||
        (proposals[0].posted_receipt_id != null &&
          proposals[0].posted_receipt_id !== posting.id)
      )
        throw new Error(
          "Legacy corrective recovery proposal ownership differs",
        );
      proposals[0].posted_receipt_id = posting.id;
      changes.push({
        table: "books_payroll_correction_proposals",
        rowId: posting.proposal_id,
        fields: ["posted_receipt_id"],
        explanation:
          "Recover the posted proposal reservation only from independently verified legacy corrective journal, fact, signed project costs and immutable receipt; preserve original monetary approval",
      });
    }
  }
  if (
    input.catalog.columns.some(
      (column) =>
        (column.schema ?? "public") === "public" &&
        column.table === "time_entries" &&
        column.name === "labor_cost_policy_version",
    )
  ) {
    for (const record of tables.time_entries ?? [])
      if (!("labor_cost_policy_version" in record)) {
        record.labor_cost_policy_version = 0;
        changes.push({
          table: "time_entries",
          rowId: String(record.id),
          fields: ["labor_cost_policy_version"],
          explanation:
            "Retain the overtime-only formula used before the double-time policy migration; do not recalculate historical archived labor with the new-row default",
        });
      }
  }
  for (const column of input.catalog.columns) {
    if (!column.generated || (column.schema ?? "public") !== "public") continue;
    for (const record of tables[column.table] ?? [])
      if (column.name in record) {
        delete record[column.name];
        changes.push({
          table: column.table,
          rowId: String(record.id),
          fields: [column.name],
          explanation:
            "Recompute the generated value in the target schema and compare it with archived evidence after insertion",
        });
      }
  }
  for (const source of tables.org_funding_sources ?? []) {
    const id = String(source.id),
      mapping = input.fundingActors[id];
    if (!mapping || !actors.has(mapping.actorId) || !mapping.explanation.trim())
      throw new Error(
        "Funding restore requires an explicit actor mapping and explanation",
      );
    source.provider_customer_id = `restore-disconnected:${id}`;
    source.provider_payment_method_id = `restore-disconnected:${id}`;
    source.provider_mandate_id = null;
    source.created_by = mapping.actorId;
    source.status = "disabled";
    source.mandate_status = "revoked";
    source.verification_status = "pending";
    source.is_default = false;
    source.usable_after = null;
    changes.push({
      table: "org_funding_sources",
      rowId: id,
      fields: [
        "provider_customer_id",
        "provider_payment_method_id",
        "provider_mandate_id",
        "created_by",
        "status",
        "mandate_status",
        "verification_status",
        "is_default",
        "usable_after",
      ],
      explanation: mapping.explanation,
    });
  }
  // The original checksummed archive remains immutable. Record every intentional
  // recovery change in a separately checksummed plan before re-verifying it.
  const manifest = {
    ...input.bundle.manifest,
    tables: Object.fromEntries(
      Object.entries(tables).map(([table, rows]) => [
        table,
        { rows: rows.length, checksum: booksDigest(rows) },
      ]),
    ),
  };
  const preflight = preflightBooksRestore(
    { ...input.bundle, manifest, tables },
    input.catalog,
    dependencies,
    input.bundle,
  );
  const plan = {
    orgId: manifest.orgId,
    sourceSchemaVersion: manifest.schemaVersion,
    sourceManifestDigest: booksDigest(input.bundle.manifest),
    tables,
    dependencies,
    changes,
    preflight,
  };
  return { ...plan, planDigest: booksDigest(plan) };
}
