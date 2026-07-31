#!/usr/bin/env node
/**
 * Phase-4 takeoff spike harness.
 *
 * Walks the MuPDF display list for real customer sheets and reports how good
 * their vector content is, so the A/B/C verdict in docs/takeoff-vector-spike.md
 * rests on measurements rather than on a guess about what construction PDFs
 * look like.
 *
 * READ-ONLY. It downloads PDFs and prints numbers; it writes nothing.
 *
 *   node scripts/takeoff-vector-spike.mjs --sheets <id>,<id>,...
 *   node scripts/takeoff-vector-spike.mjs --project <projectId> --limit 8
 *   node scripts/takeoff-vector-spike.mjs --file ./plans.pdf --page 3
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the
 * environment for the --sheets / --project modes (.env.local already has them,
 * and they point at PRODUCTION — this script only reads).
 */

import { readFile } from "node:fs/promises"
import process from "node:process"

import { createClient } from "@supabase/supabase-js"
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3"
import * as mupdf from "mupdf"

import { analyzeSegments, recommendVerdict } from "../lib/drawings/vector-analysis.ts"

const args = parseArgs(process.argv.slice(2))

async function main() {
  const targets = await resolveTargets(args)
  if (targets.length === 0) {
    console.error("Nothing to analyze. Pass --sheets, --project, or --file.")
    process.exit(1)
  }

  const rows = []
  for (const target of targets) {
    try {
      const stats = analyzePage(target.bytes, target.pageIndex)
      const verdict = recommendVerdict(stats)
      rows.push({ label: target.label, stats, verdict })
      printSheet(target.label, stats, verdict)
    } catch (error) {
      console.error(`  ${target.label}: FAILED — ${error.message}`)
    }
  }

  printSummary(rows)
}

// ---------------------------------------------------------------------------
// MuPDF walk
// ---------------------------------------------------------------------------

/**
 * Run the page through a scriptable device that records every stroked and
 * filled path as flat segments in page space. Curves are sampled rather than
 * kept: takeoff geometry is polygonal, and a flattened curve is what a snap
 * would have to bind to anyway.
 */
function analyzePage(pdfBytes, pageIndex) {
  const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf")
  try {
    const page = doc.loadPage(pageIndex)
    const segments = []

    const record = (path, ctm, width, filled) => {
      let cursor = null
      let subpathStart = null
      const push = (from, to) => {
        const a = applyMatrix(ctm, from)
        const b = applyMatrix(ctm, to)
        if (a.x === b.x && a.y === b.y) return
        segments.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, width, filled })
      }
      path.walk({
        moveTo(x, y) {
          cursor = { x, y }
          subpathStart = { x, y }
        },
        lineTo(x, y) {
          if (cursor) push(cursor, { x, y })
          cursor = { x, y }
        },
        curveTo(x1, y1, x2, y2, x3, y3) {
          if (!cursor) {
            cursor = { x: x3, y: y3 }
            return
          }
          // 8 chords is plenty to characterise a curve's contribution.
          const start = cursor
          for (let i = 1; i <= 8; i++) {
            const t = i / 8
            const point = cubicAt(start, { x: x1, y: y1 }, { x: x2, y: y2 }, { x: x3, y: y3 }, t)
            push(cursor, point)
            cursor = point
          }
        },
        closePath() {
          if (cursor && subpathStart) push(cursor, subpathStart)
          cursor = subpathStart
        },
      })
    }

    const device = new mupdf.Device({
      fillPath(path, _evenOdd, ctm) {
        record(path, ctm, 0, true)
      },
      strokePath(path, stroke, ctm) {
        let width = 1
        try {
          width = stroke.getLineWidth()
        } catch {
          width = 1
        }
        record(path, ctm, width, false)
      },
    })

    page.runPageContents(device, mupdf.Matrix.identity)
    device.close?.()

    const stats = analyzeSegments(segments)
    page.destroy?.()
    return stats
  } finally {
    doc.destroy?.()
  }
}

function applyMatrix(ctm, point) {
  const m = Array.isArray(ctm) ? ctm : [1, 0, 0, 1, 0, 0]
  return {
    x: m[0] * point.x + m[2] * point.y + m[4],
    y: m[1] * point.x + m[3] * point.y + m[5],
  }
}

function cubicAt(p0, p1, p2, p3, t) {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  }
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

async function resolveTargets(options) {
  if (options.file) {
    const bytes = await readFile(options.file)
    return [
      {
        label: `${options.file} p${(options.page ?? 0) + 1}`,
        bytes,
        pageIndex: options.page ?? 0,
      },
    ]
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see .env.local).")
    process.exit(1)
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } })

  let versionQuery = supabase
    .from("drawing_sheet_versions")
    .select(
      "id, org_id, page_index, file_id, drawing_sheet_id, drawing_sheets!inner(id, sheet_number, sheet_title, project_id)",
    )
    .limit(options.limit ?? 10)

  if (options.sheets?.length) {
    versionQuery = versionQuery.in("drawing_sheet_id", options.sheets)
  } else if (options.project) {
    versionQuery = versionQuery.eq("drawing_sheets.project_id", options.project)
  } else {
    return []
  }

  const { data: versions, error } = await versionQuery
  if (error) throw new Error(error.message)
  if (!versions?.length) return []

  const targets = []
  for (const version of versions) {
    const { data: file } = await supabase
      .from("files")
      .select("storage_path")
      .eq("org_id", version.org_id)
      .eq("id", version.file_id)
      .maybeSingle()
    if (!file?.storage_path) continue

    // Source PDFs live in R2 (bucket R2_BUCKET, key prefix drawings-pdfs/),
    // not Supabase Storage — mirrors lib/storage/drawings-pdfs-storage.ts,
    // which can't be imported here because of its `server-only` guard.
    let bytes
    try {
      bytes = await downloadPdfFromR2(version.org_id, file.storage_path)
    } catch (error) {
      console.error(`  skip ${version.drawing_sheets.sheet_number}: ${error.message}`)
      continue
    }

    targets.push({
      label: `${version.drawing_sheets.sheet_number} — ${version.drawing_sheets.sheet_title ?? ""}`.trim(),
      bytes,
      pageIndex: version.page_index ?? 0,
    })
  }
  return targets
}

let cachedR2Client = null

function getR2Client() {
  if (cachedR2Client) return cachedR2Client
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const endpoint =
    process.env.R2_ENDPOINT ??
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null)
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("Missing R2 credentials (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)")
  }
  cachedR2Client = new S3Client({
    region: process.env.R2_REGION ?? "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: process.env.R2_FORCE_PATH_STYLE === "true",
  })
  return cachedR2Client
}

async function downloadPdfFromR2(orgId, storagePath) {
  const normalized = storagePath.startsWith("/") ? storagePath.slice(1) : storagePath
  const scoped = normalized.startsWith(`${orgId}/`) ? normalized : `${orgId}/${normalized}`
  const result = await getR2Client().send(
    new GetObjectCommand({
      Bucket: process.env.R2_BUCKET ?? "project-files",
      Key: `drawings-pdfs/${scoped}`,
    }),
  )
  if (!result.Body) throw new Error("empty body")
  const chunks = []
  for await (const chunk of result.Body) chunks.push(chunk)
  return Buffer.concat(chunks)
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printSheet(label, stats, verdict) {
  console.log(`\n${label}`)
  console.log(`  segments            ${stats.segmentCount}`)
  console.log(`  axis-aligned        ${stats.axisAlignedPct}%`)
  console.log(`  sub-noise (<3pt)    ${stats.shortSegmentPct}%`)
  console.log(`  median length       ${stats.medianLength}pt`)
  console.log(`  endpoint connectivity ${stats.connectedEndpointPct}%`)
  console.log(`  closed loops        ${stats.closedLoopCount} (${stats.roomSizedLoopCount} room-sized)`)
  console.log(`  repeated shapes     ${stats.repeatedShapeGroups} groups, largest ${stats.largestRepeatGroup}`)
  console.log(`  → verdict ${verdict.verdict}: ${verdict.reason}`)
}

function printSummary(rows) {
  if (rows.length === 0) return
  const tally = { A: 0, B: 0, C: 0 }
  for (const row of rows) tally[row.verdict.verdict] += 1
  console.log(`\n${"=".repeat(72)}`)
  console.log(`Sheets analyzed: ${rows.length}`)
  console.log(`A (geometry is good): ${tally.A}   B (vision needed): ${tally.B}   C (hybrid): ${tally.C}`)
  const overall = tally.A > rows.length / 2 ? "A" : tally.B > rows.length / 2 ? "B" : "C"
  console.log(`Suggested overall verdict: ${overall}`)
  console.log("Record it in docs/takeoff-vector-spike.md — the human signs off, not this script.")
}

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === "--sheets") options.sheets = value.split(",").map((s) => s.trim()).filter(Boolean)
    else if (flag === "--project") options.project = value
    else if (flag === "--file") options.file = value
    else if (flag === "--page") options.page = Number.parseInt(value, 10)
    else if (flag === "--limit") options.limit = Number.parseInt(value, 10)
  }
  return options
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
