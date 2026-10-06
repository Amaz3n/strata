import { z } from "zod";
import { booksDigest } from "./hash";
import {
  BOOKS_EXPORT_SCHEMA_VERSION,
  EXPORT_TABLES,
  verifyBooksExportBundle,
} from "./export-contract";

type Bundle = Parameters<typeof verifyBooksExportBundle>[0];
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const cutoff = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === v;
  });

/** Preparation evidence only. Including every retained row avoids treating an
 * invoice date, mutable project assignment or provider label as an ownership
 * decision. Post-cutoff rows remain visible and require review too. */
export function prepareLegacyOwnershipInventory(
  bundle: Bundle,
  input: {
    orgId: string;
    accountingCutoff: string;
  },
) {
  const orgId = uuid.parse(input.orgId);
  const accountingCutoff = cutoff.parse(input.accountingCutoff);
  if (
    bundle.manifest?.orgId !== orgId ||
    bundle.manifest.schemaVersion !== BOOKS_EXPORT_SCHEMA_VERSION
  )
    throw new Error(
      "Use a current complete archive of the requested organization",
    );
  const verification = verifyBooksExportBundle(bundle);
  if (!verification.valid)
    throw new Error(
      `Ownership inventory requires a verified archive: ${verification.integrityErrors[0] ?? "invalid journals"}`,
    );
  // The export verifier accepts old manifests for recovery. This preparation
  // path deliberately requires the entire current table inventory.
  if (
    [
      ...Object.keys(bundle.tables),
      ...Object.keys(bundle.manifest.tables),
    ].some(
      (table) =>
        !EXPORT_TABLES.includes(table as (typeof EXPORT_TABLES)[number]),
    )
  )
    throw new Error(
      "Unknown archive table requires an ownership inventory upgrade",
    );
  const populations = EXPORT_TABLES.map((table) => {
    const rows = bundle.tables[table];
    if (!rows || !bundle.manifest?.tables[table])
      throw new Error(`Ownership inventory missing ${table}`);
    const identities = new Set<string>();
    const retainedRows = rows
      .map((row) => {
        const id =
          table === "audit_log"
            ? z
                .string()
                .regex(/^[1-9][0-9]{0,18}$/)
                .refine((v) => BigInt(v) <= 9223372036854775807n)
                .parse(row.id)
            : uuid.parse(row.id);
        if (identities.has(id))
          throw new Error(`Duplicate ownership inventory identity in ${table}`);
        identities.add(id);
        if (row.org_id !== orgId)
          throw new Error(
            `Ownership inventory organization differs in ${table}`,
          );
        return { id, evidenceSha256: booksDigest(row) };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    return {
      table,
      rows: retainedRows.length,
      populationSha256: booksDigest(retainedRows),
      retainedRows,
    };
  });
  const evidence = {
    inventoryVersion: 1 as const,
    status: "UNREVIEWED" as const,
    scope: "complete_current_export" as const,
    orgId,
    accountingCutoff,
    archiveSchemaVersion: BOOKS_EXPORT_SCHEMA_VERSION,
    archiveEvidenceSha256: booksDigest(bundle),
    // No dates filter populations: cutoff is the intended accounting review
    // date, not a license to exclude undated, future or historical evidence.
    includesEveryRetainedRow: true as const,
    populations,
    entityAssignments: [] as never[],
    approvedForLedgerActivation: false as const,
  };
  return { ...evidence, inventorySha256: booksDigest(evidence) };
}

/** A future reviewed proposal must pin this original receipt and recapture
 * evidence transactionally before committing ownership. This offline check
 * detects drift; it is not that database commit or an approval. */
export function assertLegacyOwnershipInventoryCurrent(
  inventory: ReturnType<typeof prepareLegacyOwnershipInventory>,
  bundle: Bundle,
) {
  const { inventorySha256, ...evidence } = inventory;
  if (booksDigest(evidence) !== inventorySha256)
    throw new Error("Ownership inventory receipt changed");
  const current = prepareLegacyOwnershipInventory(bundle, {
    orgId: inventory.orgId,
    accountingCutoff: inventory.accountingCutoff,
  });
  if (current.inventorySha256 !== inventorySha256)
    throw new Error(
      "Ownership evidence changed; recapture and review the full inventory",
    );
}
