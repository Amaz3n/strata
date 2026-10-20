/**
 * Files a supplier bill to a job from what the bill says about itself. A trade
 * company rarely holds a commitment with its supply house, so the vendor cannot
 * route the bill; the job reference on the invoice ("Smith residence", "PO 4412
 * Oak St") can. Pure: it names a job only when exactly one job's distinctive
 * name or street address appears, because a wrong job is worse than none.
 */

export interface BillMatchJob {
  id: string
  name: string
  address?: string | null
}

export type BillJobMatch =
  | { jobId: string; reason: string }
  | { jobId: null; reason: string }

const GENERIC_WORDS = new Set([
  "job", "jobs", "project", "projects", "residence", "residential", "house", "home", "remodel", "remodeling",
  "renovation", "addition", "new", "build", "construction", "the", "and", "lot", "phase", "repair",
])

const STREET_SUFFIXES = new Set([
  "st", "street", "ave", "avenue", "rd", "road", "dr", "drive", "ln", "lane", "ct", "court", "blvd", "boulevard",
  "way", "pl", "place", "cir", "circle", "ter", "terrace", "hwy", "highway", "pkwy", "parkway", "trl", "trail",
])

const MIN_NAME_LENGTH = 4

const words = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean)
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function distinctiveName(name: string) {
  const phrase = words(name).filter((word) => !GENERIC_WORDS.has(word)).join(" ")
  return phrase.length >= MIN_NAME_LENGTH ? phrase : null
}

/** House number plus street name, e.g. "123 oak" from "123 Oak Street, Austin TX". */
function streetKey(address: string) {
  const tokens = words(address.split(",")[0] ?? "")
  const number = tokens[0]
  if (!number || !/^\d+[a-z]?$/.test(number)) return null
  const rest = tokens.slice(1)
  const suffixAt = rest.findIndex((token) => STREET_SUFFIXES.has(token))
  const name = suffixAt === -1 ? rest.slice(0, 1) : rest.slice(0, suffixAt)
  return name.length ? [number, ...name] : null
}

/** A one-word job name ("Smith") is not a reference on its own; it needs a word beside it that makes it one. */
const JOB_CUE_WORDS = new Set(["job", "jobs", "project", "residence", "house", "home", "remodel", "site", "jobsite", "po", "ref", "reference"])

function removePhrase(haystack: string, phrase: string) {
  const tokens = words(phrase)
  if (!tokens.length) return haystack
  return ` ${haystack} `.replace(new RegExp(` ${tokens.map(escapeRegExp).join(" ")}(?= )`, "g"), " ").trim()
}

function hasJobCue(haystack: string, name: string) {
  const tokens = haystack.split(" ")
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== name) continue
    if (JOB_CUE_WORDS.has(tokens[index - 1] ?? "") || JOB_CUE_WORDS.has(tokens[index + 1] ?? "")) return true
  }
  return false
}

const containsPhrase = (haystack: string, tokens: string[]) =>
  new RegExp(`(?:^| )${tokens.map(escapeRegExp).join(" ")}(?: |$)`).test(haystack)

/**
 * `ignoring` names the supplier (its name, sender, domain): a bill from "Smith
 * Lumber & Supply" is not about the job "Smith Residence".
 */
export function matchBillToJob({
  texts,
  jobs,
  ignoring = [],
}: {
  texts: Array<string | null | undefined>
  jobs: BillMatchJob[]
  ignoring?: Array<string | null | undefined>
}): BillJobMatch {
  let haystack = words(texts.filter((text): text is string => typeof text === "string").join(" ")).join(" ")
  for (const phrase of ignoring) if (phrase) haystack = removePhrase(haystack, phrase)
  if (!haystack) return { jobId: null, reason: "The bill does not mention a job." }

  const hits = new Map<string, string>()
  for (const job of jobs) {
    const name = distinctiveName(job.name)
    if (name && containsPhrase(haystack, name.split(" ")) && (name.includes(" ") || hasJobCue(haystack, name))) {
      hits.set(job.id, `the job name “${job.name}”`)
      continue
    }
    const street = job.address ? streetKey(job.address) : null
    if (street && containsPhrase(haystack, street)) hits.set(job.id, `the address ${street.join(" ")}`)
  }

  if (hits.size === 1) {
    const [[jobId, evidence]] = Array.from(hits)
    return { jobId, reason: `Filed to the job from ${evidence} on the bill.` }
  }
  if (hits.size > 1) return { jobId: null, reason: "The bill matches more than one job — pick the job." }
  return { jobId: null, reason: "The bill does not name a job." }
}
