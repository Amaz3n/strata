#!/usr/bin/env node
/** Local-only source inventory. Candidate pages are suggestions, never reference truth. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as mupdf from 'mupdf'

const [directory, output] = process.argv.slice(2)
if (!directory || !output) throw Error('Usage: node scripts/inventory-area-pdfs.mjs PDF_DIRECTORY OUTPUT.json')
const documents = []
for (const file of fs.readdirSync(directory).filter(f => /\.pdf$/i.test(f)).sort()) {
  const bytes = fs.readFileSync(path.join(directory, file))
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex')
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf')
  const pages = []
  try {
    for (let index = 0; index < doc.countPages(); index++) {
      const page = doc.loadPage(index)
      try {
        const structured = page.toStructuredText('preserve-whitespace')
        let lines
        try { lines = (JSON.parse(structured.asJSON()).blocks ?? []).flatMap(b => (b.lines ?? []).map(l => (l.text ?? '').trim())).filter(Boolean) }
        finally { structured.destroy() }
        const layers = new Set()
        let paths = 0, images = 0, layeredPaths = 0, layerDepth = 0
        const paintedPath = () => { paths++; if (layerDepth) layeredPaths++ }
        const device = new mupdf.Device({
          strokePath: paintedPath, fillPath: paintedPath,
          fillImage: () => { images++ }, fillImageMask: () => { images++ },
          beginLayer: name => { layers.add(name); layerDepth++ },
          endLayer: () => { layerDepth = Math.max(0, layerDepth - 1) },
        })
        try { page.runPageContents(device, mupdf.Matrix.identity) }
        finally { device.close(); device.destroy() }
        const titles = lines.filter(l => l.length < 100 && /(?:FLOOR|LEVEL|GROUND|MAIN).*PLAN|PLAN.*(?:FLOOR|LEVEL)/i.test(l))
        const roomTags = lines.filter(l => /^(?:(?:MASTER|PRIMARY|GUEST)\s+)?(?:BEDROOM|BATH(?:ROOM)?|KITCHEN|LIVING|DINING|GARAGE|FOYER|LAUNDRY|OFFICE|PANTRY)(?:\s+(?:ROOM|AREA))?(?:\s*\d+)?$/i.test(l))
        pages.push({ page: index + 1, bounds: page.getBounds(), paths, layeredPaths, images,
          textLines: lines.length, layers: [...layers].sort(), titles: [...new Set(titles)],
          roomTags: [...new Set(roomTags)], roomTagCount: roomTags.length,
          scaleText: [...new Set(lines.filter(l => l.length < 90 && /(?:SCALE\s*:|1\s*\/\s*[24816]+\s*["”]\s*=)/i.test(l)))],
          candidate: roomTags.length >= 3,
          sourceHint: !paths ? 'raster-or-empty' : !lines.length ? 'outlined-or-no-text' : layeredPaths ? 'layered-vector' : 'unlayered-vector',
        })
      } finally { page.destroy() }
    }
  } finally { doc.destroy() }
  documents.push({ file, sourceSha256, bytes: bytes.length, pages })
  process.stdout.write(`${file}: ${pages.length} pages; candidates ${pages.filter(p => p.candidate).map(p => p.page).join(', ')}\n`)
}
fs.writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(),
  qualification: 'Unreviewed inventory. Candidate selection and source hints require source inspection; no scale, truth or accuracy inferred.',
  variationPolicy: 'All derivatives inherit their original project and split; never count derivatives as independent originals.', documents }, null, 2) + '\n')
