"use strict"

/**
 * Shared fakes for the drawings services: tile storage, the vision provider,
 * the MuPDF loader, permission checks, and small builders for sheet evidence
 * and PDFs.
 *
 * Each `create*` returns a plain object whose `module` is what the service
 * imports, plus the state a test asserts on. Register it with `stubModule`
 * (tests/support/modules.js) BEFORE `freshRequire`-ing the service. The
 * service reads the stub's functions at call time, so a test may also swap
 * one of them for a single case.
 */

const sharp = require("sharp")
const { stubModule } = require("./modules")

// ---------------------------------------------------------------------------
// Tile storage (lib/storage/drawings-tiles-storage)
// ---------------------------------------------------------------------------

/**
 * An in-memory object store. A missing object rejects, as R2 does.
 * `listing` overrides what `listTilesObjectsBounded` reports, for tests about
 * truncated or lying listings.
 */
function createTileStorage(initial = {}) {
  const storage = {
    objects: new Map(Object.entries(initial)),
    reads: [],
    uploads: [],
    deletes: [],
    listing: null,
  }
  storage.module = {
    async downloadTilesObject({ path }) {
      storage.reads.push(path)
      if (!storage.objects.has(path)) throw new Error(`Missing tile object ${path}`)
      return storage.objects.get(path)
    },
    async uploadTilesObject({ path, bytes }) {
      storage.uploads.push({ path, bytes })
      storage.objects.set(path, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))
    },
    async deleteTilesObjects({ paths }) {
      for (const path of paths) {
        storage.deletes.push(path)
        storage.objects.delete(path)
      }
    },
    async listTilesObjectsBounded({ prefix, limit }) {
      if (storage.listing) return storage.listing
      const objects = [...storage.objects]
        .filter(([name]) => name.startsWith(prefix))
        .slice(0, limit)
        .map(([name, bytes]) => ({ name, size: bytes.length }))
      return { objects, complete: true }
    },
  }
  return storage
}

function stubTileStorage(storage = createTileStorage()) {
  stubModule("lib/storage/drawings-tiles-storage.ts", storage.module)
  return storage
}

// ---------------------------------------------------------------------------
// Vision provider (lib/services/ai/drawings-vision)
// ---------------------------------------------------------------------------

/**
 * `answer` is the provider's structured output, a function of the request,
 * or an Error to throw. `configured: false` models a deployment without a
 * vision key.
 */
function createVisionProvider(answer = null, { configured = true } = {}) {
  const provider = { calls: [], answer, configured }
  provider.module = {
    async drawingsVisionConfigured() {
      return provider.configured
    },
    async runDrawingsVisionObject(options) {
      provider.calls.push(options)
      const result = typeof provider.answer === "function" ? await provider.answer(options) : provider.answer
      if (result instanceof Error) throw result
      return structuredClone(result)
    },
  }
  return provider
}

function stubVisionProvider(provider = createVisionProvider()) {
  stubModule("lib/services/ai/drawings-vision.ts", provider.module)
  return provider
}

// ---------------------------------------------------------------------------
// MuPDF and permissions
// ---------------------------------------------------------------------------

/** The real WASM module; the loader's CommonJS-transpiled `import()` cannot load ESM. */
function stubMupdfLoader() {
  return stubModule("lib/services/mupdf-loader.ts", { loadMupdf: () => import("mupdf") })
}

/** Records every permission checked; `deny(key)` makes that key refuse. */
function stubPermissions() {
  const permissions = { checked: [], denied: new Set() }
  permissions.deny = (key) => permissions.denied.add(key)
  permissions.reset = () => {
    permissions.checked.length = 0
    permissions.denied.clear()
  }
  stubModule("lib/services/permissions.ts", {
    async requirePermission(key) {
      permissions.checked.push(key)
      if (permissions.denied.has(key)) throw new Error(`Missing permission: ${key}`)
    },
  })
  return permissions
}

/**
 * Makes every INSERT into `table` on a fake-supabase client fail with
 * `message`, the way PostgREST resolves `{ error }`. Returns the undo.
 */
function failInserts(client, table, message) {
  const from = client.from
  client.from = (name) => {
    const query = from.call(client, name)
    if (name === table) {
      query.insert = () => Promise.resolve({ data: null, error: { message } })
    }
    return query
  }
  return () => {
    client.from = from
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** A vector evidence path through `points` (normalized sheet coordinates). */
function strokePath(id, points, overrides = {}) {
  return {
    id,
    commands: points.map(([x, y], index) => [index ? "L" : "M", x, y]),
    kind: "stroke",
    color: [0],
    colorSpace: "DeviceGray",
    opacity: 1,
    width: 1,
    dashes: [],
    layer: [],
    groups: [],
    clips: [],
    evenOdd: false,
    ...overrides,
  }
}

/** A closed rectangle path, normalized coordinates. */
function rectanglePath(id, [x0, y0, x1, y1], overrides = {}) {
  return strokePath(id, [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], overrides)
}

/** Stored area evidence, the shape the pipeline writes to `area-evidence.json`. */
function areaEvidence(paths) {
  return { version: 1, extractionProfile: "floor-area-2", truncated: false, paths }
}

/**
 * PostgREST filters an embedded resource by `relation.column`
 * (`.eq("drawing_sheets.project_id", id)`). The fake client reads that literal
 * key, so a row carrying an embedded relation also carries its flat copies.
 */
function withEmbedded(row, relation) {
  const flat = Object.entries(row[relation]).map(([column, value]) => [`${relation}.${column}`, value])
  return { ...row, ...Object.fromEntries(flat) }
}

/** A solid white PNG. */
function whitePng(width, height) {
  return sharp({ create: { width, height, channels: 3, background: "white" } }).png().toBuffer()
}

/**
 * A one-page "scanned" PDF: a white bitmap drawn over the page at `dpi`
 * (2in x 1in), or a large blank 25in x 12.5in page with no image at all.
 */
async function scannedPdf({ dpi = 300, large = false } = {}) {
  const { PDFDocument } = require("pdf-lib")
  const document = await PDFDocument.create()
  const page = document.addPage(large ? [1800, 900] : [144, 72])
  if (!large) {
    const image = await document.embedPng(await whitePng(dpi * 2, dpi))
    page.drawImage(image, { x: 0, y: 0, width: 144, height: 72 })
  }
  return Buffer.from(await document.save())
}

module.exports = {
  areaEvidence,
  createTileStorage,
  createVisionProvider,
  failInserts,
  rectanglePath,
  scannedPdf,
  stubMupdfLoader,
  stubPermissions,
  stubTileStorage,
  stubVisionProvider,
  whitePng,
  withEmbedded,
}
