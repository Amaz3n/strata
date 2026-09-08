import "server-only";
import { EXPORT_TABLES, verifyBooksExportBundle } from "@/lib/services/books/export-contract";
export { verifyBooksExportBundle } from "@/lib/services/books/export-contract";

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

async function fetchAllRows(table: string, orgId: string) {
  const service = createServiceSupabaseClient();
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await service
      .from(table)
      .select("*")
      .eq("org_id", orgId)
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(`Failed to export ${table}: ${error.message}`);
    const page = z.array(z.record(z.unknown())).parse(data ?? []);
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
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
      schema_version: 2,
      status: "generating",
      requested_by: context.userId,
    })
    .select("id")
    .single();
  if (createError)
    throw new Error(`Failed to create Books export: ${createError.message}`);
  const exportId = z.object({ id: z.string().uuid() }).parse(exportData).id;
  try {
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const table of EXPORT_TABLES)
      tables[table] = redact(table, await fetchAllRows(table, context.orgId));
    // Hash storage bytes, not only the database's claimed checksum. Process one
    // stream at a time so evidence size does not multiply export memory usage.
    for (const file of tables.files ?? []) {
      if (typeof file.storage_path !== "string" || !file.storage_path) throw new Error(`Supporting file ${file.id} has no storage path`);
      const object = await getFilesObjectStream({ supabase: service, orgId: context.orgId, path: file.storage_path });
      const digest = createHash("sha256"); let bytes = 0;
      if ("getReader" in object.body) {
        const reader = object.body.getReader();
        try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; digest.update(chunk.value); bytes += chunk.value.byteLength; } } finally { reader.releaseLock(); }
      } else { for await (const chunk of object.body) { digest.update(chunk); bytes += chunk.length; } }
      const checksum = digest.digest("hex");
      if (file.checksum && file.checksum !== checksum) throw new Error(`Supporting file checksum mismatch: ${file.id}`);
      if (file.size_bytes != null && Number(file.size_bytes) !== bytes) throw new Error(`Supporting file size mismatch: ${file.id}`);
      file.checksum = checksum; file.size_bytes = bytes;
    }
    const generatedAt = new Date().toISOString();
    const manifest = {
      schemaVersion: 2,
      orgId: context.orgId,
      generatedAt,
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
      restoreInstructions:
        "This data bundle includes a verified manifest of supporting storage objects. Copy those objects separately using the manifest paths, preserving bytes. Restore data into an empty isolated organization, preserve UUIDs, verify the copied file checksums, and run ledger rebuild and subledger tie-outs before enabling access. Credentials and full tax identities must be re-established separately.",
    };
    const bundle = { manifest, tables };
    const verification = verifyBooksExportBundle(bundle);
    if (!verification.valid)
      throw new Error(
        "Books export verification found unbalanced or incomplete journals",
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
