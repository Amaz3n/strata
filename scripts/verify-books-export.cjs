#!/usr/bin/env node
// Offline only: validates an unpacked copy, never connects to Arc or a database.
require("./register-ts-node-test");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { gunzipSync } = require("node:zlib");
const {
  verifyBooksExportBundle,
  BOOKS_EXPORT_SCHEMA_VERSION,
} = require("../lib/services/books/export-contract");
const supportsEmbeddedFiles = (version) =>
  Number.isInteger(version) &&
  version >= 4 &&
  version <= BOOKS_EXPORT_SCHEMA_VERSION;
function readBundle(bundlePath) {
  const bytes = fs.readFileSync(bundlePath);
  return JSON.parse(
    (bytes[0] === 0x1f && bytes[1] === 0x8b
      ? gunzipSync(bytes)
      : bytes
    ).toString("utf8"),
  );
}
async function verifyFileCopy(bundlePath, filesRoot) {
  const bundle = readBundle(bundlePath);
  if (!bundle.manifest)
    throw new Error(
      "A versioned manifest is required to verify a recovery archive",
    );
  const result = verifyBooksExportBundle(bundle);
  if (!result.valid) throw new Error(JSON.stringify(result));
  const expected = [
    ...(bundle.manifest?.supportingFiles ?? []),
    ...(bundle.manifest?.supportingHistoricalFiles ?? []).filter(
      (file) => !file.currentFileId,
    ),
  ];
  if (supportsEmbeddedFiles(bundle.manifest?.schemaVersion) && !filesRoot)
    return {
      ...result,
      verifiedFiles: expected.length,
      supportingFilesEmbedded: true,
    };
  if (expected.length && !filesRoot)
    throw new Error(
      "Provide the root directory containing copied supporting files",
    );
  const root = filesRoot ? fs.realpathSync(filesRoot) : null;
  for (const file of expected) {
    if (!/^[a-f0-9]{64}$/.test(file.checksum ?? ""))
      throw new Error(`Missing SHA-256 checksum for ${file.id}`);
    const target = fs.realpathSync(path.resolve(root, file.storagePath));
    if (!target.startsWith(root + path.sep))
      throw new Error(`File escapes supporting-file directory: ${file.id}`);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of fs.createReadStream(target)) {
      hash.update(chunk);
      size += chunk.length;
    }
    if (hash.digest("hex") !== file.checksum || size !== file.sizeBytes)
      throw new Error(`Supporting file changed: ${file.id}`);
  }
  return { ...result, verifiedFiles: expected.length };
}
async function extractSupportingFiles(bundlePath, destination) {
  const bundle = readBundle(bundlePath);
  const verification = verifyBooksExportBundle(bundle);
  if (!verification.valid) throw new Error(JSON.stringify(verification));
  if (!supportsEmbeddedFiles(bundle.manifest?.schemaVersion))
    throw new Error(
      `Embedded supporting files require schema version 4 through ${BOOKS_EXPORT_SCHEMA_VERSION}`,
    );
  const root = path.resolve(destination);
  const objects = new Map(
    (bundle.supportingObjects ?? []).map((object) => [
      object.fileId,
      object.dataBase64,
    ]),
  );
  const historical = new Map(
    (bundle.supportingHistoricalObjects ?? []).map((object) => [
      object.attachmentId,
      object.dataBase64,
    ]),
  );
  const targets = new Set();
  const files = [
    ...(bundle.manifest.supportingFiles ?? []),
    ...(bundle.manifest.supportingHistoricalFiles ?? []).filter(
      (file) => !file.currentFileId,
    ),
  ].map((file) => {
    const name = file.storagePath;
    if (
      typeof name !== "string" ||
      !name ||
      name.includes("\\") ||
      name.includes("\0") ||
      path.isAbsolute(name) ||
      name.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error(`Unsafe supporting file path: ${file.id}`);
    const target = path.resolve(root, name);
    if (!target.startsWith(root + path.sep) || targets.has(target))
      throw new Error(`Duplicate or unsafe supporting file path: ${file.id}`);
    targets.add(target);
    return {
      target,
      bytes: Buffer.from(
        objects.get(file.id) ?? historical.get(file.id),
        "base64",
      ),
    };
  });
  // A fresh directory avoids overwriting existing evidence or following its symlinks.
  fs.mkdirSync(root);
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(file.target), { recursive: true });
      fs.writeFileSync(file.target, file.bytes, { flag: "wx", mode: 0o600 });
    }
    return await verifyFileCopy(bundlePath, root);
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
module.exports = { verifyFileCopy, extractSupportingFiles };
if (require.main === module) {
  const [bundlePath, filesRoot, destination] = process.argv.slice(2);
  if (!bundlePath) {
    console.error(
      "Usage: node scripts/verify-books-export.cjs bundle.json.gz [copied-files-root | --extract new-directory]",
    );
    process.exitCode = 1;
  } else
    (filesRoot === "--extract"
      ? destination
        ? extractSupportingFiles(bundlePath, destination)
        : Promise.reject(new Error("Provide a new extraction directory"))
      : verifyFileCopy(bundlePath, filesRoot)
    )
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
}
