import "server-only";
import { BOOKS_EXPORT_SCHEMA_VERSION, EXPORT_TABLES, verifyBooksExportBundle, type StreamedObjectDigest } from "@/lib/services/books/export-contract";
export { verifyBooksExportBundle } from "@/lib/services/books/export-contract";

import { historicalDocumentInventory } from "./tax-attachment-archive";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { z } from "zod";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireBooksAuthorization as requireAuthorization } from "@/lib/services/books/access";
import { booksDigest } from "@/lib/services/books/hash";
import { requireOrgContext, runWithServiceOrgContext } from "@/lib/services/context";
import { normalizeProductTier } from "@/lib/product-tier";
import { recordEvent } from "@/lib/services/events";
import { enforceMutationRateLimit } from "@/lib/services/auth-rate-limit";
import { ensureOrgScopedPath, getFilesObjectStream, uploadFilesStream } from "@/lib/storage/files-storage";



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


const RESTORE_INSTRUCTIONS =
  "This data bundle includes supporting storage objects in supportingObjects as base64 bytes keyed by fileId. Verify the archive offline, then decode each object to its manifest storage path, preserving bytes. Schema 8 also retains frozen historical tax objects in supportingHistoricalObjects keyed by attachmentId; supportingHistoricalFiles identifies their original paths and any shared current-file object. Tax attachments lacking frozen metadata do not establish review-time byte identity. Restore data into an empty isolated organization, preserve UUIDs, verify the copied file checksums, and run ledger rebuild and subledger tie-outs before enabling access. Credentials and full tax identities must be re-established separately.";

type Service = ReturnType<typeof createServiceSupabaseClient>;

/** Reads one stored object chunk by chunk, handing each on, and returns its SHA-256 and length. */
async function streamObject(service: Service, orgId: string, path: string, onChunk?: (chunk: Uint8Array) => Promise<void>, limit?: number): Promise<StreamedObjectDigest> {
  const object = await getFilesObjectStream({ supabase: service, orgId, path });
  const reader = object.body.getReader(), digest = createHash("sha256");
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (limit !== undefined && size > limit) { await reader.cancel(); throw new Error("Frozen tax attachment size differs"); }
      digest.update(chunk.value);
      if (onChunk) await onChunk(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return { sha256: digest.digest("hex"), size };
}

/** One object's bytes, for the few the verifier must re-read (payroll registers). */
async function readObject(service: Service, orgId: string, path: string) {
  const chunks: Uint8Array[] = [];
  await streamObject(service, orgId, path, async (chunk) => { chunks.push(chunk); });
  return Buffer.concat(chunks);
}

/** The archive objects the payroll evidence names, which verification re-reads. */
function payrollSourceIds(tables: Record<string, Record<string, unknown>[]>) {
  const ids = new Set<string>();
  for (const row of [...(tables.books_payroll_imports ?? []), ...(tables.books_payroll_correction_sources ?? [])]) {
    const proof = z.object({ storage_path: z.string(), size_bytes: z.number(), checksum: z.string() }).passthrough().safeParse(row.source_proof);
    if (proof.success) ids.add(booksDigest({ storagePath: proof.data.storage_path, sizeBytes: proof.data.size_bytes, checksum: proof.data.checksum }));
  }
  return ids;
}

/**
 * Writes the archive JSON into a gzip stream feeding a multipart upload, so the
 * bytes in memory are one upload part and one document chunk at a time. Each
 * document is base64-encoded as it streams and must match the digest taken in
 * the first pass. Returns the same content hash `booksDigest(json)` gives.
 */
async function streamArchive(service: Service, orgId: string, storagePath: string, archive: {
  head: string;
  files: Array<{ key: "fileId"; id: string; path: string; digest: StreamedObjectDigest | undefined }>;
  historical: Array<{ key: "attachmentId"; id: string; path: string; digest: StreamedObjectDigest | undefined }>;
}) {
  const gzip = createGzip();
  const upload = uploadFilesStream({ orgId, path: storagePath, stream: Readable.toWeb(gzip) as ReadableStream<Uint8Array>,
    contentType: "application/gzip", cacheControl: "private, no-store" });
  // booksDigest of a string hashes its JSON literal: the quoted, escaped text.
  const content = createHash("sha256").update("\"");
  const write = async (text: string) => {
    content.update(JSON.stringify(text).slice(1, -1));
    if (!gzip.write(text)) await once(gzip, "drain");
  };
  try {
    await write(archive.head);
    for (const [name, objects] of [["supportingObjects", archive.files], ["supportingHistoricalObjects", archive.historical]] as const) {
      await write(`,"${name}":[`);
      for (const [index, object] of objects.entries()) {
        await write(`${index ? "," : ""}{"${object.key}":${JSON.stringify(object.id)},"dataBase64":"`);
        let carry = Buffer.alloc(0);
        const digest = await streamObject(service, orgId, object.path, async (chunk) => {
          const bytes = Buffer.concat([carry, chunk]);
          const whole = bytes.length - (bytes.length % 3);
          carry = bytes.subarray(whole);
          if (whole) await write(bytes.subarray(0, whole).toString("base64"));
        });
        await write(`${carry.toString("base64")}"}`);
        if (!object.digest || digest.sha256 !== object.digest.sha256 || digest.size !== object.digest.size)
          throw new Error(`A supporting document changed while the archive was written: ${object.id}`);
      }
      await write("]");
    }
    await write("}");
    gzip.end();
    await upload;
  } catch (error) {
    gzip.destroy(error instanceof Error ? error : new Error(String(error)));
    await upload.catch(() => undefined);
    throw error;
  }
  return content.update("\"").digest("hex");
}

const EXPORT_JOB_TYPE = "generate_books_export";
export const BOOKS_EXPORT_JOB_TYPE = EXPORT_JOB_TYPE;

/**
 * Asks for an archive. It is built in the background (`runBooksExportJob`), so
 * a large company's archive never depends on one request surviving; the export
 * list shows it queued, generating, then ready or failed with the reason.
 */
export async function requestBooksExport(input: {
  exportType?: "complete" | "accountant" | "cutover" | "period";
  orgId?: string;
}) {
  const context = await requireExportContext(input.orgId);
  await enforceMutationRateLimit("books_export", context.orgId);
  const service = createServiceSupabaseClient();
  const exportType = input.exportType ?? "complete";
  const exportId = await insertExport(context, exportType);
  const { error: queueError } = await service.from("outbox").insert({
    org_id: context.orgId, job_type: EXPORT_JOB_TYPE, payload: { export_id: exportId }, run_at: new Date().toISOString(),
  });
  if (queueError) {
    await service.from("books_exports").update({ status: "failed", error_message: `Could not queue the archive: ${queueError.message}` })
      .eq("org_id", context.orgId).eq("id", exportId);
    throw new Error(`Failed to queue Books export: ${queueError.message}`);
  }
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.export_requested", entityType: "books_export", entityId: exportId, payload: { export_type: exportType } });
  return { exportId, status: "queued" as const };
}

async function insertExport(context: { orgId: string; userId: string }, exportType: string) {
  const { data, error } = await createServiceSupabaseClient()
    .from("books_exports")
    .insert({ org_id: context.orgId, export_type: exportType, schema_version: BOOKS_EXPORT_SCHEMA_VERSION, status: "queued", requested_by: context.userId })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to create Books export: ${error.message}`);
  return z.object({ id: z.string().uuid() }).parse(data).id;
}

/** An archive built inside the current request, for a package that waits on it. */
export async function createBooksExportNow(input: { exportType: "complete" | "accountant" | "cutover" | "period"; orgId?: string }) {
  const context = await requireExportContext(input.orgId);
  const exportId = await insertExport(context, input.exportType);
  const built = await buildBooksExport(exportId, context.orgId);
  if (!built) throw new Error("Books export finished elsewhere");
  return built;
}

/**
 * The worker's entry: builds the archive as the member who asked for it, so
 * their export permission is checked again; one who has left stops the job.
 */
export async function runBooksExportJob(orgId: string, exportId: string) {
  const service = createServiceSupabaseClient();
  const [{ data: row, error }, { data: org, error: orgError }] = await Promise.all([
    service.from("books_exports").select("requested_by").eq("org_id", orgId).eq("id", exportId).maybeSingle(),
    service.from("orgs").select("product_tier").eq("id", orgId).maybeSingle(),
  ]);
  if (error || orgError) throw new Error(`Failed to load the Books export: ${(error ?? orgError)?.message}`);
  if (!row) throw new Error("Books export no longer exists");
  const requestedBy = z.string().uuid().parse(row.requested_by);
  const { data: member, error: memberError } = await service.from("memberships").select("id")
    .eq("org_id", orgId).eq("user_id", requestedBy).eq("status", "active").maybeSingle();
  if (memberError) throw new Error(`Failed to verify who requested the export: ${memberError.message}`);
  if (!member) {
    const attempt = await startAttempt(orgId, exportId);
    if (attempt !== null) await failAttempt(orgId, exportId, attempt, "The member who requested this archive is no longer active; create a new export.");
    return null;
  }
  return runWithServiceOrgContext({ supabase: service, orgId, userId: requestedBy, productTier: normalizeProductTier(org?.product_tier) }, () => buildBooksExport(exportId));
}

async function startAttempt(orgId: string, exportId: string) {
  const { data, error } = await createServiceSupabaseClient().rpc("start_books_export_attempt", { p_org_id: orgId, p_export_id: exportId });
  if (error) throw new Error(`Failed to start the Books export: ${error.message}`);
  return z.number().int().positive().nullable().parse(data);
}

async function failAttempt(orgId: string, exportId: string, attempt: number, message: string) {
  const { error } = await createServiceSupabaseClient().rpc("fail_books_export_attempt", { p_org_id: orgId, p_export_id: exportId, p_attempt: attempt, p_error: message });
  if (error) throw new Error(`Failed to record the failed Books export: ${error.message}`);
}

/**
 * One attempt at one archive: a single consistent database snapshot, the
 * supporting bytes checked against it, verification, then upload. The archive is
 * ready only once the attempt that built it has uploaded and verified it.
 */
export async function buildBooksExport(exportId: string, orgId?: string) {
  const context = await requireExportContext(orgId);
  const service = createServiceSupabaseClient();
  const { data: exportRow, error: exportError } = await service.from("books_exports").select("export_type").eq("org_id", context.orgId).eq("id", exportId).single();
  if (exportError) throw new Error(`Books export not found: ${exportError.message}`);
  const exportType = String(exportRow.export_type);
  const attempt = await startAttempt(context.orgId, exportId);
  if (attempt === null) return null;
  try {
    const { data: snapshotData, error: snapshotError } = await service.rpc("capture_books_export_snapshot", { p_org_id: context.orgId });
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
    // Every document is read twice and never held whole: once to check it against
    // its record, then straight into the compressed upload, checked again on the
    // way. Only payroll registers, which the verifier re-reads, stay in memory.
    const fileDigests = new Map<string, StreamedObjectDigest>()
    for (const file of tables.files ?? []) {
      if (typeof file.storage_path !== "string" || !file.storage_path) throw new Error(`Supporting file ${file.id} has no storage path`);
      const digest = await streamObject(service, context.orgId, file.storage_path);
      if (file.checksum && file.checksum !== digest.sha256) throw new Error(`Supporting file checksum mismatch: ${file.id}`);
      if (file.size_bytes != null && Number(file.size_bytes) !== digest.size) throw new Error(`Supporting file size mismatch: ${file.id}`);
      file.checksum = digest.sha256; file.size_bytes = digest.size;
      fileDigests.set(String(file.id), digest);
    }
    const supportingHistoricalFiles = historicalDocumentInventory(tables, context.orgId);
    const historicalDigests = new Map<string, StreamedObjectDigest>()
    for (const attachment of supportingHistoricalFiles) {
      if (attachment.currentFileId) continue; // The current file's object already carries these bytes.
      const digest = await streamObject(service, context.orgId, attachment.storagePath, undefined, attachment.sizeBytes);
      if (digest.size !== attachment.sizeBytes || digest.sha256 !== attachment.checksum) throw new Error("Frozen tax attachment bytes differ from reviewed evidence");
      historicalDigests.set(attachment.id, digest);
    }
    const payrollSources = payrollSourceIds(tables);
    const heldFiles = new Map<string, string>(), heldHistorical = new Map<string, string>();
    for (const attachment of supportingHistoricalFiles) {
      if (!payrollSources.has(attachment.id)) continue;
      const bytes = await readObject(service, context.orgId, attachment.storagePath);
      if (attachment.currentFileId) heldFiles.set(attachment.currentFileId, bytes.toString("base64"));
      else heldHistorical.set(attachment.id, bytes.toString("base64"));
    }
    const generatedAt = new Date().toISOString();
    const manifest = {
      schemaVersion: BOOKS_EXPORT_SCHEMA_VERSION,
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
      restoreInstructions: RESTORE_INSTRUCTIONS,
    };
    const historicalToEmbed = supportingHistoricalFiles.filter((attachment) => !attachment.currentFileId);
    const verification = verifyBooksExportBundle({
      manifest, tables,
      supportingObjects: (tables.files ?? []).map((file) => ({ fileId: String(file.id), dataBase64: heldFiles.get(String(file.id)) })),
      supportingHistoricalObjects: historicalToEmbed.map((attachment) => ({ attachmentId: attachment.id, dataBase64: heldHistorical.get(attachment.id) })),
    }, { files: fileDigests, historical: historicalDigests });
    if (!verification.valid)
      throw new Error(
        `Books export verification failed: ${verification.integrityErrors[0] ?? "Unbalanced or incomplete journal entries"}`,
      );
    // Each attempt writes its own object; only the attempt that finishes names it.
    const storagePath = ensureOrgScopedPath(context.orgId, `books/exports/${exportId}/attempt-${attempt}.json.gz`);
    const contentHash = await streamArchive(service, context.orgId, storagePath, {
      head: `{"manifest":${JSON.stringify(manifest)},"tables":${JSON.stringify(tables)}`,
      files: (tables.files ?? []).map((file) => ({ key: "fileId", id: String(file.id), path: String(file.storage_path), digest: fileDigests.get(String(file.id)) })),
      historical: historicalToEmbed.map((attachment) => ({ key: "attachmentId", id: attachment.id, path: attachment.storagePath, digest: historicalDigests.get(attachment.id) })),
    });
    const { error: updateError } = await service
      .from("books_exports")
      .update({
        status: "ready",
        storage_path: storagePath,
        content_hash: contentHash,
        manifest,
        verification,
        completed_at: new Date().toISOString(),
        expires_at: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      })
      .eq("org_id", context.orgId)
      .eq("id", exportId)
      .eq("attempt_count", attempt)
      .eq("status", "generating");
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
        export_type: exportType,
        content_hash: contentHash,
      },
      channel: "notification",
    });
    return {
      exportId,
      storagePath,
      contentHash,
      manifest,
      verification,
    };
  } catch (error) {
    await failAttempt(context.orgId, exportId, attempt, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Archives whose job is gone fail with the reason instead of reading "generating" forever. */
export async function failStrandedBooksExports() {
  const { data, error } = await createServiceSupabaseClient().rpc("fail_stranded_books_exports", {});
  if (error) throw new Error(`Failed to close out interrupted Books exports: ${error.message}`);
  return z.number().int().parse(data);
}
