import { createHash } from "node:crypto"

/**
 * The one digest Books hashes with.
 *
 * Object keys are canonicalized, ARRAYS ARE NOT. That is deliberate — a journal
 * entry's lines are ordered and a rebuild that ignored their order would miss a
 * real divergence — but it makes array order load-bearing for every caller. Any
 * array that reaches a hashed accounting-fact payload must therefore be sorted
 * by the code that builds it (see `sortFactCostLines`); otherwise the order
 * Postgres happened to return rows in reads as an economic revision, and the
 * projector reverses and reposts an identical entry every night.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    )
  }
  return value
}

export function booksDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")
}

