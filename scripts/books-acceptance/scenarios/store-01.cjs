// STORE-01 — documents in real storage (B06.4, with B06.1-B06.3 and B10.3). Runs
// only against the acceptance bucket (`--storage-env`). A document is private at
// both boundaries: storage refuses an unsigned read, a signed link expires, and
// another organization cannot get a link. A stored path is never overwritten; a
// new version is a new object, and every version keeps its bytes as the current
// one moves. A background archive finishes, downloads and verifies with the
// document's exact bytes, and a document restored from it keeps its privacy and
// checksum.
const { createHash, randomUUID } = require("node:crypto")
const { gunzipSync } = require("node:zlib")
const { app, contractJob } = require("./shared.cjs")

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }

// Objects live under the `project-files/` key prefix (files-storage.ts).
const objectKey = (path) => `project-files/${path.replace(/^\//, "")}`
function storageUrl(path) {
  return `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET}/${objectKey(path).split("/").map(encodeURIComponent).join("/")}`
}
async function fetchBytes(url) {
  const response = await fetch(url)
  return { status: response.status, cacheControl: response.headers.get("cache-control"), bytes: Buffer.from(await response.arrayBuffer()) }
}

async function builderWithDocument(kit, name, bytes) {
  const job = await contractJob(kit, { name, contractCents: 1000000, retainagePercent: 0, periods: ["2026-07"] })
  const file = await kit.as(job.owner, () => app("files").createFileFromUpload({ projectId: job.projectId, category: "permits",
    file: new File([bytes], `permit-${randomUUID().slice(0, 6)}.pdf`, { type: "application/pdf" }) }))
  const row = kit.rows(`select storage_path, checksum, size_bytes from public.files where id=${kit.q(file.id)}`)[0]
  return { job, fileId: file.id, path: row.storage_path, row }
}

async function privateDocuments(kit, expected, check) {
  const bytes = Buffer.from(`%PDF-1.4 permit ${randomUUID()}`)
  const { job, fileId, path, row } = await builderWithDocument(kit, "STORE-01 private documents", bytes)
  const files = app("files")
  const signed = await kit.as(job.owner, () => files.getSignedUrl(fileId, 60))
  const member = await fetchBytes(signed)
  const shortLived = await kit.as(job.owner, () => files.getSignedUrl(fileId, 1))
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const foreign = await contractJob(kit, { name: "STORE-01 another builder", contractCents: 1000000, retainagePercent: 0, periods: ["2026-07"] })
  check.equal("a document is private at both boundaries and its bytes are exact", expected.expected, {
    recorded: { checksumMatches: row.checksum === sha(bytes), size: Number(row.size_bytes) === bytes.length },
    unsignedStorageRead: (await fetchBytes(storageUrl(path))).status,
    member: { status: member.status, bytesExact: sha(member.bytes) === sha(bytes), publicCache: /public/i.test(member.cacheControl ?? "") },
    expiredLink: (await fetchBytes(shortLived)).status,
    anotherOrganization: (await refusal(() => kit.as(foreign.owner, () => files.getSignedUrl(fileId, 60)))) !== "allowed",
  })
  return { orgId: job.orgId, foreignOrgId: foreign.orgId }
}

async function immutableAndVersions(kit, expected, check) {
  const v1 = Buffer.from(`%PDF-1.4 drawing v1 ${randomUUID()}`), v2 = Buffer.from(`%PDF-1.4 drawing v2 ${randomUUID()}`)
  const { job, fileId, path } = await builderWithDocument(kit, "STORE-01 versions", v1)
  const storage = app("../storage/files-storage")
  const service = kit.service
  const put = (bytes) => refusal(() => service(() => storage.uploadFilesObject({ supabase: null, orgId: job.orgId, path, bytes, contentType: "application/pdf", upsert: false })))
  const overwrite = await put(v2), retry = await put(v1)
  const read = async (storagePath) => { const object = await service(() => storage.downloadFilesObject({ supabase: null, orgId: job.orgId, path: storagePath })); return sha(Buffer.from(object)) }
  const versions = app("file-versions")
  const first = await kit.as(job.owner, () => versions.createInitialVersion({ fileId, storagePath: path, fileName: "drawing.pdf", mimeType: "application/pdf", sizeBytes: v1.length, checksum: sha(v1) }))
  const second = await kit.as(job.owner, () => versions.createVersion(fileId, new File([v2], "drawing.pdf", { type: "application/pdf" }), { label: "Revision B" }))
  await kit.as(job.owner, () => versions.makeVersionCurrent(fileId, first.id))
  await kit.as(job.owner, () => versions.makeVersionCurrent(fileId, second.id))
  const listed = await kit.as(job.owner, () => versions.listVersions(fileId))
  const versionBytes = async (versionId) => sha((await fetchBytes(await kit.as(job.owner, () => versions.getVersionSignedUrl(versionId, 60)))).bytes)
  check.equal("a stored path is never overwritten; each version keeps its bytes as the current one moves", expected.expected, {
    overwriteRefused: /never overwritten/.test(overwrite), sameBytesRetryAllowed: retry === "allowed", originalUnchanged: (await read(path)) === sha(v1),
    versions: listed.length, current: listed.find((version) => version.id === second.id)?.is_current === true,
    firstVersionBytes: (await versionBytes(first.id)) === sha(v1), secondVersionBytes: (await versionBytes(second.id)) === sha(v2),
    separateObjects: listed.find((version) => version.id === second.id)?.storage_path !== path,
  })
  return { orgId: job.orgId }
}

async function readyArchive(kit, job) {
  const exports = app("books/exports")
  const { exportId } = await kit.as(job.owner, () => exports.requestBooksExport({ exportType: "complete" }))
  await kit.drainOutbox(job.orgId)
  const row = kit.rows(`select status, storage_path, content_hash, attempt_count from public.books_exports where id=${kit.q(exportId)}`)[0]
  const download = await kit.service(() => app("../storage/files-storage").createFilesDownloadUrl({ supabase: null, orgId: job.orgId, path: row.storage_path, expiresIn: 60 }))
  const fetched = await fetchBytes(download.downloadUrl)
  return { exportId, row, fetched, bundle: JSON.parse(gunzipSync(fetched.bytes).toString("utf8")) }
}

async function archiveWithDocuments(kit, expected, check) {
  const bytes = Buffer.from(`%PDF-1.4 lien waiver ${randomUUID()}`)
  const { job, fileId, path } = await builderWithDocument(kit, "STORE-01 archive", bytes)
  const { row, fetched, bundle } = await readyArchive(kit, job)
  const object = bundle.supportingObjects.find((item) => item.fileId === fileId)
  check.equal("a background archive finishes, downloads privately and carries the document's exact bytes", expected.expected, {
    status: row.status, attempts: Number(row.attempt_count), unsignedStorageRead: (await fetchBytes(storageUrl(row.storage_path))).status,
    download: { status: fetched.status, noStore: /no-store/.test(fetched.cacheControl ?? "") },
    verifies: app("books/exports").verifyBooksExportBundle(bundle).valid,
    documentBytesExact: Boolean(object) && sha(Buffer.from(object.dataBase64, "base64")) === sha(bytes),
    manifestPath: bundle.manifest.supportingFiles.some((file) => file.id === fileId && file.storagePath === path),
  })
  return { orgId: job.orgId }
}

async function restoreDocuments(kit, expected, check) {
  const bytes = Buffer.from(`%PDF-1.4 executed contract ${randomUUID()}`)
  const { job, fileId, path } = await builderWithDocument(kit, "STORE-01 restore", bytes)
  const { bundle } = await readyArchive(kit, job)
  const storage = app("../storage/files-storage")
  // The document is lost, then put back from the archive at its manifest path.
  await kit.service(() => storage.deleteFilesObjects({ supabase: null, orgId: job.orgId, paths: [path] }))
  const lost = await refusal(() => kit.service(() => storage.downloadFilesObject({ supabase: null, orgId: job.orgId, path })))
  const archived = bundle.supportingObjects.find((item) => item.fileId === fileId)
  const manifest = bundle.manifest.supportingFiles.find((file) => file.id === fileId)
  const restored = Buffer.from(archived.dataBase64, "base64")
  await kit.service(() => storage.uploadFilesObject({ supabase: null, orgId: job.orgId, path: manifest.storagePath, bytes: restored, contentType: manifest.mimeType, upsert: false }))
  const signed = await fetchBytes(await kit.as(job.owner, () => app("files").getSignedUrl(fileId, 60)))
  check.equal("a document restored from the archive keeps its checksum and stays private", expected.expected, {
    lostBeforeRestore: lost !== "allowed",
    checksumMatchesManifest: sha(restored) === manifest.checksum,
    signedBytesExact: sha(signed.bytes) === sha(bytes),
    unsignedStorageRead: (await fetchBytes(storageUrl(path))).status,
  })
  return { orgId: job.orgId }
}

// A tax workpaper's attachment is frozen at preparation by its bytes. The
// accountant downloads exactly those bytes; if the stored object is altered
// underneath (a bypass of the never-overwrite rule), review refuses and so does
// the download.
async function taxAttachmentEvidence(kit, expected, check) {
  const bytes = Buffer.from(`%PDF-1.4 depreciation schedule ${randomUUID()}`)
  const job = await contractJob(kit, { name: "STORE-01 tax attachment", contractCents: 1000000, retainagePercent: 0, periods: ["2026-08"] })
  const file = await kit.as(job.owner, () => app("files").createFileFromUpload({ category: "financials",
    file: new File([bytes], `schedule-${randomUUID().slice(0, 6)}.pdf`, { type: "application/pdf" }) }))
  const tax = app("books/tax-adjustments")
  const lineId = randomUUID()
  const workpaper = await kit.as(job.owner, () => tax.prepareTaxWorkpaper({ startDate: "2026-08-01", endDate: "2026-08-31", idempotencyKey: `store-${randomUUID()}`,
    lines: [{ id: lineId, kind: "timing", amount_cents: -10000, description: "Tax depreciation per the accountant's schedule", evidence_reference: "Depreciation schedule, August 2026", evidence_file_id: file.id }] }))
  const download = async () => {
    const delivered = await kit.as(job.reviewer, () => app("books/tax-attachment-download").downloadTaxWorkpaperAttachment(workpaper, lineId))
    const chunks = []; for await (const chunk of delivered.body) chunks.push(Buffer.from(chunk))
    return sha(Buffer.concat(chunks))
  }
  const before = await download()
  const path = kit.rows(`select storage_path from public.files where id=${kit.q(file.id)}`)[0].storage_path
  const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3")
  await new S3Client({ region: "auto", endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } })
    .send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: objectKey(path), Body: Buffer.from(`%PDF-1.4 altered ${randomUUID()}`), ContentType: "application/pdf" }))
  const review = await refusal(() => kit.as(job.reviewer, () => tax.reviewTaxWorkpaper({ id: workpaper, notes: "Checked against the depreciation schedule" })))
  const later = await refusal(download)
  check.equal("the accountant receives the frozen bytes; an altered stored attachment stops review and download", expected.expected, {
    downloadExact: before === sha(bytes),
    reviewAfterAlteration: /differ from frozen evidence|size differs/.test(review),
    downloadAfterAlteration: /differs from saved evidence/.test(later),
  })
  return { orgId: job.orgId }
}

module.exports = {
  id: "STORE-01",
  subcases: {
    "private-documents": privateDocuments,
    "immutable-and-versions": immutableAndVersions,
    "archive-with-documents": archiveWithDocuments,
    "restore-documents": restoreDocuments,
    "tax-attachment-evidence": taxAttachmentEvidence,
  },
}
