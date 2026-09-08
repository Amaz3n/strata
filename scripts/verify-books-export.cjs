#!/usr/bin/env node
// Offline only: validates an unpacked copy, never connects to Arc or a database.
require('./register-ts-node-test');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const { verifyBooksExportBundle } = require('../lib/services/books/export-contract');
async function verifyFileCopy(bundlePath, filesRoot) {
  const bytes = fs.readFileSync(bundlePath);
  const bundle = JSON.parse((bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf8'));
  const result = verifyBooksExportBundle(bundle);
  if (!result.valid) throw new Error(JSON.stringify(result));
  const expected = bundle.manifest?.supportingFiles ?? [];
  if (expected.length && !filesRoot) throw new Error('Provide the root directory containing copied supporting files');
  const root = filesRoot ? fs.realpathSync(filesRoot) : null;
  for (const file of expected) {
    if (!/^[a-f0-9]{64}$/.test(file.checksum ?? '')) throw new Error(`Missing SHA-256 checksum for ${file.id}`);
    const target = fs.realpathSync(path.resolve(root, file.storagePath));
    if (!target.startsWith(root + path.sep)) throw new Error(`File escapes supporting-file directory: ${file.id}`);
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of fs.createReadStream(target)) { hash.update(chunk); size += chunk.length; }
    if (hash.digest('hex') !== file.checksum || size !== file.sizeBytes) throw new Error(`Supporting file changed: ${file.id}`);
  }
  return { ...result, verifiedFiles: expected.length };
}
module.exports = { verifyFileCopy };
if (require.main === module) {
  const [bundlePath,filesRoot] = process.argv.slice(2);
  if (!bundlePath) { console.error('Usage: node scripts/verify-books-export.cjs bundle.json.gz [copied-files-root]'); process.exitCode=1; }
  else verifyFileCopy(bundlePath,filesRoot).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
