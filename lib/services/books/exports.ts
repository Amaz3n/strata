import "server-only";
import { BOOKS_EXPORT_SCHEMA_VERSION, EXPORT_TABLES, verifyBooksExportBundle } from "@/lib/services/books/export-contract";
export { verifyBooksExportBundle } from "@/lib/services/books/export-contract";

import { historicalDocumentInventory } from "./tax-attachment-archive";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { z } from "zod";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireBooksAuthorization as requireAuthorization } from "@/lib/services/books/access";
import { booksDigest } from "@/lib/services/books/hash";
import { requireOrgContext } from "@/lib/services/context";
import { recordEvent } from "@/lib/services/events";
import { uploadFilesObject, getFilesObjectStream } from "@/lib/storage/files-storage";



async function requireExportContext(orgId?: string) {
  const context = await requireOrgContext(orgId);
  await requireAuthorization({
    permission: "books.export",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "books_export",
    resourceId: context.orgId,
    logDecision: true,
  });
  return context;
}

function redact(table: string, rows: Record<string, unknown>[]) {
  if (table === "org_funding_sources") return rows.map((row) => Object.fromEntries(["id", "org_id", "provider", "bank_name", "account_type", "last4", "status", "books_gl_account_id", "created_at", "updated_at"].map(key => [key, row[key]])));
  if (table !== "companies") return rows;
  return rows.map((row) => ({
    ...row,
    tax_id: undefined,
    ein: undefined,
    ssn: undefined,
  }));
}


export async function createCompleteBooksExport(input: {
  exportType?: "complete" | "accountant" | "cutover" | "period";
  orgId?: string;
}) {
  const context = await requireExportContext(input.orgId);
  const service = createServiceSupabaseClient();
  const { data: exportData, error: createError } = await service
    .from("books_exports")
    .insert({
      org_id: context.orgId,
      export_type: input.exportType ?? "complete",
      schema_version: BOOKS_EXPORT_SCHEMA_VERSION,
      status: "generating",
      requested_by: context.userId,
    })
    .select("id")
    .single();
  if (createError)
    throw new Error(`Failed to create Books export: ${createError.message}`);
  const exportId = z.object({ id: z.string().uuid() }).parse(exportData).id;
  try {
    const { data: snapshotData, error: snapshotError } = await service.rpc("capture_books_entity_authorized_export", { p_org_id: context.orgId, p_actor_id: context.userId });
    if (snapshotError) throw new Error(`Failed to capture Books export snapshot: ${snapshotError.message}`);
    const snapshot = z.object({
      orgId: z.string(), capturedAt: z.string().datetime({ offset: true }),
      databaseSnapshot: z.string().min(1), tables: z.record(z.array(z.record(z.unknown()))),
    }).parse(snapshotData);
    if (snapshot.orgId !== context.orgId) throw new Error("Books export snapshot organization mismatch");
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const table of EXPORT_TABLES) {
      if (!snapshot.tables[table]) throw new Error(`Books export snapshot missing ${table}`);
      tables[table] = redact(table, snapshot.tables[table]);
    }
    // Include the same bytes we verify; recovery must not depend on live storage.
    const supportingObjects: { fileId: string; dataBase64: string }[] = [];
    for (const file of tables.files ?? []) {
      if (typeof file.storage_path !== "string" || !file.storage_path) throw new Error(`Supporting file ${file.id} has no storage path`);
      const object = await getFilesObjectStream({ supabase: service, orgId: context.orgId, path: file.storage_path });
      const digest = createHash("sha256"); let bytes = 0;
      const chunks: Uint8Array[] = [];
      const reader = object.body.getReader();
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; digest.update(chunk.value); bytes += chunk.value.byteLength; chunks.push(chunk.value); } } finally { reader.releaseLock(); }
      const checksum = digest.digest("hex");
      if (file.checksum && file.checksum !== checksum) throw new Error(`Supporting file checksum mismatch: ${file.id}`);
      if (file.size_bytes != null && Number(file.size_bytes) !== bytes) throw new Error(`Supporting file size mismatch: ${file.id}`);
      file.checksum = checksum; file.size_bytes = bytes;
      supportingObjects.push({ fileId: String(file.id), dataBase64: Buffer.concat(chunks).toString("base64") });
    }
    const supportingHistoricalFiles = historicalDocumentInventory(tables,context.orgId);
    const supportingHistoricalObjects: { attachmentId: string; dataBase64: string }[] = [];
    for (const attachment of supportingHistoricalFiles) {
      if (attachment.currentFileId) continue; // Reuse the already embedded current object.
      const object = await getFilesObjectStream({ supabase: service, orgId: context.orgId, path: attachment.storagePath });
      const reader = object.body.getReader(), digest = createHash("sha256"), chunks: Uint8Array[] = [];
      let size = 0;
      try { for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (!Number.isSafeInteger(size) || size > attachment.sizeBytes) { await reader.cancel(); throw new Error("Frozen tax attachment size differs"); }
        digest.update(chunk.value); chunks.push(chunk.value);
      } } finally { reader.releaseLock(); }
      if (size !== attachment.sizeBytes || digest.digest("hex") !== attachment.checksum) throw new Error("Frozen tax attachment bytes differ from reviewed evidence");
      supportingHistoricalObjects.push({ attachmentId: attachment.id, dataBase64: Buffer.concat(chunks).toString("base64") });
    }
    const generatedAt = new Date().toISOString();
    const manifest = {
      schemaVersion: BOOKS_EXPORT_SCHEMA_VERSION,
      legalEntityIds: (tables.books_legal_entities ?? []).map(row => String(row.id)).sort(),
      orgId: context.orgId,
      generatedAt,
      databaseSnapshot: { capturedAt: snapshot.capturedAt, visibility: snapshot.databaseSnapshot },
      tables: Object.fromEntries(
        Object.entries(tables).map(([table, rows]) => [
          table,
          { rows: rows.length, checksum: booksDigest(rows) },
        ]),
      ),
      redactions: [
        "full tax identifiers",
        "integration credentials",
        "bank-feed provider payloads",
      ],
      supportingFiles: (tables.files ?? []).map((file) => ({
        id: file.id,
        storagePath: file.storage_path,
        fileName: file.file_name,
        sizeBytes: file.size_bytes,
        checksum: file.checksum,
        mimeType: file.mime_type,
      })),
      supportingHistoricalFiles,
      restoreInstructions:
        "This data bundle includes supporting storage objects in supportingObjects as base64 bytes keyed by fileId. Verify the archive offline, then decode each object to its manifest storage path, preserving bytes. Schema 8 also retains frozen historical tax objects in supportingHistoricalObjects keyed by attachmentId; supportingHistoricalFiles identifies their original paths and any shared current-file object. Tax attachments lacking frozen metadata do not establish review-time byte identity. Restore data into an empty isolated organization, preserve UUIDs, verify the copied file checksums, and run ledger rebuild and subledger tie-outs before enabling access. Credentials and full tax identities must be re-established separately.",
    };
    const bundle = { manifest, tables, supportingObjects, supportingHistoricalObjects };
    const verification = verifyBooksExportBundle(bundle);
    if (!verification.valid)
      throw new Error(
        `Books export verification failed: ${verification.integrityErrors[0] ?? "Unbalanced or incomplete journal entries"}`,
      );
    const json = JSON.stringify(bundle);
    const contentHash = booksDigest(json);
    const path = `books/exports/${exportId}.json.gz`;
    const uploaded = await uploadFilesObject({
      supabase: service,
      orgId: context.orgId,
      path,
      bytes: gzipSync(Buffer.from(json)),
      contentType: "application/gzip",
      cacheControl: "private, no-store",
      upsert: false,
    });
    const { error: updateError } = await service
      .from("books_exports")
      .update({
        status: "ready",
        storage_path: uploaded.storagePath,
        content_hash: contentHash,
        manifest,
        verification,
        completed_at: new Date().toISOString(),
        expires_at: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      })
      .eq("org_id", context.orgId)
      .eq("id", exportId);
    if (updateError)
      throw new Error(
        `Failed to complete Books export: ${updateError.message}`,
      );
    await recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "books.export_ready",
      entityType: "books_export",
      entityId: exportId,
      payload: {
        export_type: input.exportType ?? "complete",
        content_hash: contentHash,
      },
      channel: "notification",
    });
    return {
      exportId,
      storagePath: uploaded.storagePath,
      contentHash,
      manifest,
      verification,
    };
  } catch (error) {
    await service
      .from("books_exports")
      .update({
        status: "failed",
        error_message: error instanceof Error ? error.message : String(error),
      })
      .eq("org_id", context.orgId)
      .eq("id", exportId);
    throw error;
  }
}
