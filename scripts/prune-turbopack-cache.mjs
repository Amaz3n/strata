#!/usr/bin/env node
/**
 * Turbopack's persistent filesystem cache has no size bound and never garbage
 * collects. Left alone across weeks of development it grows without limit —
 * this repo reached 11GB. The cost is not disk: Turbopack loads and compacts
 * that database on startup and periodically while idle, which on a bloated
 * cache means ~2GB resident and sustained 100%+ CPU doing nothing. Measured on
 * this project: an 11GB cache idled at 1.3–2.7GB RSS, a fresh one at 92MB.
 *
 * Runs as `predev`, so a normal `pnpm dev` keeps the cache (it is what makes
 * warm starts fast) until it crosses the threshold, then drops it once.
 */
import { rm, stat, readdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".next", "dev", "cache")
const LIMIT_BYTES = Number(process.env.TURBOPACK_CACHE_LIMIT_GB ?? 3) * 1024 ** 3

async function dirSize(path) {
  let total = 0
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      total += await dirSize(child)
    } else if (entry.isFile()) {
      try {
        total += (await stat(child)).size
      } catch {
        // Turbopack is rewriting the cache under us; skip the vanished file.
      }
    }
    if (total > LIMIT_BYTES) return total
  }
  return total
}

const size = await dirSize(CACHE_DIR)
if (size > LIMIT_BYTES) {
  const gb = (size / 1024 ** 3).toFixed(1)
  console.log(`[turbopack-cache] ${gb}GB exceeds ${LIMIT_BYTES / 1024 ** 3}GB limit — clearing.`)
  await rm(CACHE_DIR, { recursive: true, force: true })
  console.log("[turbopack-cache] cleared; this start will be slower, the next will not.")
}
