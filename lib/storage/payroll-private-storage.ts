import "server-only";
import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import { requireOrgContext } from "@/lib/services/context";
import { requireBooksAuthorization } from "@/lib/services/books/access";
import { requireBooksWorkspaceEnabled } from "@/lib/services/books/module";

export function isPrivatePayrollPath(path: string) {
  return /^[0-9a-f-]{36}\/books\/payroll-private\/[0-9a-f-]{36}\/source\.csv$/i.test(
    path,
  );
}
export async function requirePrivatePayrollRead(orgId: string) {
  const c = await requireOrgContext(orgId);
  if (c.orgId !== orgId)
    throw new Error("Payroll storage organization differs");
  await requireBooksAuthorization({
    permission: "books.adjust",
    orgId,
    userId: c.userId,
    supabase: c.supabase,
    resourceType: "payroll_import",
    resourceId: orgId,
    logDecision: true,
  });
  await requireBooksWorkspaceEnabled(orgId);
  return c;
}
function storage() {
  const bucket = process.env.R2_PAYROLL_BUCKET;
  if (!bucket || bucket === (process.env.R2_BUCKET ?? "project-files"))
    throw new Error(
      "Configure a separate private R2_PAYROLL_BUCKET before uploading payroll registers",
    );
  const endpoint =
    process.env.R2_ENDPOINT ??
    (process.env.R2_ACCOUNT_ID
      ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : undefined);
  if (
    !endpoint ||
    !process.env.R2_ACCESS_KEY_ID ||
    !process.env.R2_SECRET_ACCESS_KEY
  )
    throw new Error("Private payroll storage is not configured");
  return {
    bucket,
    client: new S3Client({
      endpoint,
      region: process.env.R2_REGION ?? "auto",
      requestChecksumCalculation: "WHEN_REQUIRED",
      forcePathStyle: process.env.R2_FORCE_PATH_STYLE === "true",
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    }),
  };
}
function scope(orgId: string, path: string) {
  if (!isPrivatePayrollPath(path) || !path.startsWith(`${orgId}/`))
    throw new Error("Invalid private payroll object scope");
  return `books-payroll/${path}`;
}
/** No public CDN URL, signed general-document URL, copy, or bucket fallback. */
export async function readPrivatePayrollRegisterObject(
  orgId: string,
  path: string,
  range?: string,
) {
  const key = scope(orgId, path);
  await requirePrivatePayrollRead(orgId);
  const { client, bucket } = storage();
  const result = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }),
  );
  if (!result.Body) throw new Error("Private payroll object is unavailable");
  const body = result.Body;
  return {
    body:
      typeof body.transformToWebStream === "function"
        ? body.transformToWebStream()
        : (Readable.toWeb(
            body as Readable,
          ) as unknown as ReadableStream<Uint8Array>),
    metadata: result.Metadata,
    contentLength: result.ContentLength,
    contentRange: result.ContentRange,
    contentType: result.ContentType,
    etag: result.ETag,
    lastModified: result.LastModified,
  };
}
/** Retry writes are create-only; an existing object must match every original byte. */
export async function putPrivatePayrollRegisterObject(
  orgId: string,
  path: string,
  bytes: Buffer,
) {
  const key = scope(orgId, path);
  if (!bytes.length || bytes.length > 16 * 1024 * 1024)
    throw new Error("Payroll register must contain 1 byte to 16 MiB");
  const c = await requirePrivatePayrollRead(orgId);
  const { client, bucket } = storage();
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentType: "text/csv",
        CacheControl: "private, no-store",
        IfNoneMatch: "*",
        Metadata: {
          arc_actor_id: c.userId,
          arc_org_id: orgId,
          arc_sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      }),
    );
  } catch (error) {
    const e = error as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };
    if (e.name !== "PreconditionFailed" && e.$metadata?.httpStatusCode !== 412)
      throw error;
    const original = await readPrivatePayrollRegisterObject(orgId, path),
      reader = original.body.getReader(),
      hash = createHash("sha256");
    let size = 0;
    try {
      if (
        original.metadata?.arc_actor_id !== c.userId ||
        original.metadata?.arc_org_id !== orgId
      )
        throw new Error("Payroll upload belongs to a different actor");
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > bytes.length)
          throw new Error(
            "Payroll upload identity belongs to different original bytes",
          );
        hash.update(chunk.value);
      }
      if (
        size !== bytes.length ||
        hash.digest("hex") !== createHash("sha256").update(bytes).digest("hex")
      )
        throw new Error(
          "Payroll upload identity belongs to different original bytes",
        );
    } catch (failure) {
      await reader.cancel().catch(() => {});
      throw failure;
    } finally {
      reader.releaseLock();
    }
  }
}

export function assertPrivatePayrollStorageConfigured() {
  storage();
}
export async function createPrivatePayrollUploadUrl(input: {
  orgId: string;
  path: string;
  size: number;
  checksum: string;
}) {
  const key = scope(input.orgId, input.path),
    c = await requirePrivatePayrollRead(input.orgId);
  const { client, bucket } = storage();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentLength: input.size,
    ContentType: "text/csv",
    CacheControl: "private, no-store",
    IfNoneMatch: "*",
    Metadata: {
      arc_actor_id: c.userId,
      arc_org_id: input.orgId,
      arc_sha256: input.checksum,
    },
  });
  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: 300,
    signableHeaders: new Set([
      "if-none-match",
      "content-type",
      "content-length",
    ]),
  });
  return {
    uploadUrl,
    headers: {
      "Content-Type": "text/csv",
      "If-None-Match": "*",
      "Cache-Control": "private, no-store",
    },
    expiresIn: 300,
  };
}
