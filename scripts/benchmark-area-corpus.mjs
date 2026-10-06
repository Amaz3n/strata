#!/usr/bin/env node
/** Bounded local diagnostic batch. No truth generation and no production access. */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

const [manifestPath, outputDirectory] = process.argv.slice(2)
if (!manifestPath || !outputDirectory) throw Error('Usage: node scripts/benchmark-area-corpus.mjs CASES.json OUTPUT_DIRECTORY')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const sourceFiles=[...fs.readdirSync('lib/drawings').filter(f=>/^(?:area-.*|scale|text-runs)\.ts$/.test(f)).map(f=>'lib/drawings/'+f),'lib/services/area-evidence-extract.ts','scripts/import-area-pdf.js','scripts/check-area-pdf.js','scripts/register-ts-node-test.js','scripts/benchmark-area-corpus.mjs'].sort()
const fingerprint=()=>createHash('sha256').update(sourceFiles.map(file=>file+':'+createHash('sha256').update(fs.readFileSync(file)).digest('hex')).join('\n')).digest('hex')
const sourceFingerprint=fingerprint()
const ids = new Set(), hashes = new Map()
for (const c of manifest.cases) {
  if (!/^[a-z0-9-]+$/.test(c.id) || ids.has(c.id)) throw Error('Case IDs must be unique safe filenames')
  ids.add(c.id)
  if (!Number.isInteger(c.page) || c.page < 1 || !Number.isFinite(c.feetPerPdfPoint) || c.feetPerPdfPoint <= 0) throw Error(`Invalid page/scale: ${c.id}`)
  if (!hashes.has(c.file)) hashes.set(c.file, createHash('sha256').update(fs.readFileSync(c.file)).digest('hex'))
  if (hashes.get(c.file) !== c.sha256) throw Error(`Source changed: ${c.file}`)
  if (!['original', 'layer-metadata-removed'].includes(c.variant)) throw Error(`Invalid variant: ${c.id}`)
  if (c.split !== 'development') throw Error('Diagnostic inspection requires development cases; retire exposed holdouts explicitly first')
}
// A new run directory prevents stale reports from masquerading as completed work.
fs.mkdirSync(outputDirectory)
const results = []
let next = 0
async function worker() {
  while (next < manifest.cases.length) {
    const c = manifest.cases[next++], output = path.resolve(outputDirectory, c.id + '.json')
    if(fingerprint()!==sourceFingerprint)throw Error('Detector source changed during the corpus run. Retain this diagnostic and start a fresh run after code is frozen.')
    const started = performance.now()
    const args = ['scripts/check-area-pdf.js', c.file, String(c.page), String(c.feetPerPdfPoint), output]
    if (c.variant !== 'original') args.push('--without-layers')
    const execution = await new Promise(resolve => execFile(process.execPath, args,
      {timeout:120_000,killSignal:'SIGKILL',maxBuffer:8*1024*1024}, (error, stdout, stderr) => resolve({error, stdout, stderr})))
    fs.writeFileSync(path.join(outputDirectory, c.id + '.log'), execution.stdout + execution.stderr)
    const sourceChanged=fingerprint()!==sourceFingerprint
    const report = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null
    const labels = report?.detection.coverage?.labels ?? []
    const row = { ...c, sourceFingerprint,sourceChanged,status:sourceChanged?'source-changed':execution.error ? 'execution-failed' : 'completed',
      error:execution.error ? {message:execution.error.message.slice(0,1500),killed:execution.error.killed,code:execution.error.code} : null,
      wallMs:performance.now()-started, detectionMs:report?.elapsedMs ?? null,
      proposals:report?.detection.proposals.length ?? null, invalidGeometry:report?.invalidGeometry.length ?? null,
      labelEntries:labels.length, coveredEntries:labels.filter(l=>l.proposalIds.length>0).length,
      sharedEntries:labels.filter(l=>l.status==='shared-zone').length,
      sourceCategory:report?.sourceCategory ?? null,evidence:report?.evidence ?? null,
      warnings:report?.detection.warnings ?? [],report:report ? output : null }
    results.push(row)
    fs.writeFileSync(path.join(outputDirectory,'summary.json'),JSON.stringify({
      qualification:'Development diagnostics only. Label coverage is not geometric accuracy. No independent reference boundaries.',
      releaseReady:false,sourceFingerprint,sourceFiles,expected:manifest.cases.length,completed:results.length,results },null,2)+'\n')
    process.stdout.write(`${results.length}/${manifest.cases.length} ${c.id}: ${row.status}, ${row.proposals} proposals\n`)
  }
}
await Promise.all([worker(),worker()])
if (results.some(r=>r.status !== 'completed')) process.exitCode = 1
