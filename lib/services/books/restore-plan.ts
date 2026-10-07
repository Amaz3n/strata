import { createHash } from "node:crypto";
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
  // Before schema 33 the books were one company. Restoring into the legal-entity
  // schema creates that company as the primary one, with a fixed id derived from
  // the organization, and every journal line belongs to it.
  if (
    input.bundle.manifest.schemaVersion < 33 &&
    input.catalog.columns.some(
      (column) =>
        (column.schema ?? "public") === "public" &&
        column.table === "journal_lines" &&
        column.name === "legal_entity_id",
    )
  ) {
    if ((tables.books_legal_entities ?? []).length)
      throw new Error("Older archive cannot carry legal entities");
    const digest = createHash("sha256").update(`books-primary-entity:${input.bundle.manifest.orgId}`).digest("hex");
    const entityId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    // Dated when the books began: the archive's earliest journal entry.
    const capturedAt = (tables.journal_entries ?? []).map((entry) => String(entry.created_at ?? "")).filter(Boolean).sort()[0] ?? "1970-01-01T00:00:00.000Z";
    tables.books_legal_entities = [{ id: entityId, org_id: input.bundle.manifest.orgId, name: "Primary company", legal_name: null, is_primary: true, status: "active", created_by: null, created_at: capturedAt, updated_at: capturedAt }];
    changes.push({ table: "books_legal_entities", rowId: entityId, fields: ["id", "org_id", "name", "is_primary", "status"],
      explanation: "The archive predates legal entities; its books were one company, restored as the primary company" });
    for (const line of tables.journal_lines ?? [])
      if (!("legal_entity_id" in line)) {
        line.legal_entity_id = entityId;
        changes.push({ table: "journal_lines", rowId: String(line.id), fields: ["legal_entity_id"],
          explanation: "Lines posted before legal entities belong to the primary company" });
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
