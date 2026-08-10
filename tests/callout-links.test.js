require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  extractCalloutLinks,
  normalizeSheetNumber,
  parseStoredCalloutLinks,
  resolveCalloutLinks,
  CALLOUT_LINKS_ALGO,
  MAX_CALLOUT_LINKS_PER_SHEET,
} = require("../lib/drawings/callout-links")

/** A text run at a defaulted position; positions vary via overrides. */
function run(text, overrides = {}) {
  return { text, x: 0.1, y: 0.2, w: 0.2, h: 0.012, ...overrides }
}

function extract(runs, knownSheetNumbers, options = {}) {
  return extractCalloutLinks({ runs, knownSheetNumbers, ...options })
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

test("normalizeSheetNumber collapses case, spaces, hyphens and periods", () => {
  assert.equal(normalizeSheetNumber("A-501"), "A501")
  assert.equal(normalizeSheetNumber("A501"), "A501")
  assert.equal(normalizeSheetNumber("a 501"), "A501")
  assert.equal(normalizeSheetNumber("A.501"), "A501")
  assert.equal(normalizeSheetNumber("S2.1"), "S21")
  assert.notEqual(normalizeSheetNumber("A-501"), normalizeSheetNumber("A-502"))
})

// ---------------------------------------------------------------------------
// Detail-bubble forms
// ---------------------------------------------------------------------------

test("detail bubble 5/A-501 with a known target", () => {
  const { links, truncated } = extract([run("5/A-501")], ["A-501", "A-101"])
  assert.equal(truncated, false)
  assert.equal(links.length, 1)
  assert.equal(links[0].kind, "detail_bubble")
  assert.equal(links[0].targetSheetNumber, "A-501")
  assert.equal(links[0].detail, "5")
  assert.equal(links[0].confidence, 0.95)
})

test("spaced detail bubble 5 / A501 resolves and keeps the printed form", () => {
  const { links } = extract([run("5 / A501")], ["A-501"])
  assert.equal(links.length, 1)
  // Display uses the number AS PRINTED, not the known register's spelling.
  assert.equal(links[0].targetSheetNumber, "A501")
  assert.equal(links[0].detail, "5")
})

test("reversed detail bubble A-501/5", () => {
  const { links } = extract([run("A-501/5")], ["A-501"])
  assert.equal(links.length, 1)
  assert.equal(links[0].kind, "detail_bubble")
  assert.equal(links[0].targetSheetNumber, "A-501")
  assert.equal(links[0].detail, "5")
})

test("letter detail A/A-301 with a known target", () => {
  const { links } = extract([run("A/A-301")], ["A-301"])
  assert.equal(links.length, 1)
  assert.equal(links[0].detail, "A")
  assert.equal(links[0].confidence, 0.95)
})

test("several bubbles in one note line", () => {
  const { links } = extract([run("SEE 5/A-501 & 6/A-502 TYP")], ["A-501", "A-502"])
  assert.equal(links.length, 2)
  assert.deepEqual(
    links.map((l) => l.targetSheetNumber),
    ["A-501", "A-502"],
  )
})

test("unknown-target detail bubble is kept at reduced confidence", () => {
  // P-401 has not been uploaded yet — the slash pair is structural evidence,
  // and the link goes live once the sheet exists (resolution is read-time).
  const { links } = extract([run("7/P-401")], ["A-101"])
  assert.equal(links.length, 1)
  assert.equal(links[0].kind, "detail_bubble")
  assert.equal(links[0].confidence, 0.5)
})

test("weak unknown targets and letter details without digits stay out", () => {
  // "C2" (one letter, one digit, no separator) is as likely a wall type.
  assert.equal(extract([run("5/C2")], ["A-101"]).links.length, 0)
  // A letter detail against an unknown sheet is too little evidence.
  assert.equal(extract([run("A/P-401")], ["A-101"]).links.length, 0)
  // Known targets clear both bars.
  assert.equal(extract([run("5/C2")], ["C2"]).links.length, 1)
})

// ---------------------------------------------------------------------------
// Bare references
// ---------------------------------------------------------------------------

test("bare reference to a known sheet, exact printed form", () => {
  const { links } = extract([run("REFER TO A-501 FOR DETAILS")], ["A-501"])
  assert.equal(links.length, 1)
  assert.equal(links[0].kind, "sheet_reference")
  assert.equal(links[0].targetSheetNumber, "A-501")
  assert.equal(links[0].detail, undefined)
  assert.equal(links[0].confidence, 0.8)
})

test("bare reference matching only after normalization scores lower", () => {
  const { links } = extract([run("SEE A501")], ["A-501"])
  assert.equal(links.length, 1)
  assert.equal(links[0].targetSheetNumber, "A501")
  assert.equal(links[0].confidence, 0.65)
})

test("bare tokens never link to unknown sheets", () => {
  const { links } = extract([run("SEE X-901 AND A101")], ["A-501"])
  assert.equal(links.length, 0)
})

test("sheet numbers split by a space are not detected as bare tokens", () => {
  // "PLAN A 3" must not read as sheet A-3; normalization only bridges
  // spelling differences on the KNOWN side, never invents tokens.
  const { links } = extract([run("PLAN A 501")], ["A-501"])
  assert.equal(links.length, 0)
})

test("bare token clickable region covers the token, not the whole line", () => {
  const line = run("REFER TO A-501 FOR DETAILS", { x: 0.3, w: 0.26 })
  const { links } = extract([line], ["A-501"])
  assert.equal(links.length, 1)
  assert.ok(links[0].x > line.x, "bbox starts after the line start")
  assert.ok(links[0].w < line.w, "bbox narrower than the line")
  assert.ok(links[0].x + links[0].w <= line.x + line.w + 1e-9, "bbox stays inside the line")
  assert.equal(links[0].y, line.y)
  assert.equal(links[0].h, line.h)
})

// ---------------------------------------------------------------------------
// Precision guards
// ---------------------------------------------------------------------------

test("the sheet's own number is never a link", () => {
  const result = extract(
    [run("A-101"), run("5/A-101"), run("A-101/3")],
    ["A-101", "A-102"],
    { ownSheetNumber: "A-101" },
  )
  assert.equal(result.links.length, 0)
})

test("own-number exclusion is normalization-aware", () => {
  const { links } = extract([run("SEE A101")], ["A-101"], { ownSheetNumber: "A-101" })
  assert.equal(links.length, 0)
})

test("fractions, scales and dates never match", () => {
  const runs = [
    run('1/2" = 1\'-0"'),
    run("GWB 5/8"),
    run("ISSUED 5/8/2026"),
    run("1 1/2 IN CLR"),
  ]
  const { links } = extract(runs, ["A-501", "S2.1"])
  assert.equal(links.length, 0)
})

test("ambiguous normalized known numbers are dropped entirely", () => {
  // "A2.1" and "A-21" both normalize to A21 — guessing is the wrong jump.
  const known = ["A2.1", "A-21"]
  assert.equal(extract([run("SEE A2.1")], known).links.length, 0)
  assert.equal(extract([run("3/A2.1")], known).links.length, 0)
})

test("tokens glued to other codes do not partially match", () => {
  // Beam callout "W8/..." must not read as detail 8; "W12X26" is not a sheet.
  const { links } = extract([run("W8/A-501"), run("W12X26 BEAM")], ["A-501", "X2.6"])
  assert.equal(links.length, 0)
})

// ---------------------------------------------------------------------------
// Dedupe and caps
// ---------------------------------------------------------------------------

test("repeat occurrences at distinct positions all survive", () => {
  const runs = [run("5/A-501", { y: 0.1 }), run("5/A-501", { y: 0.5 }), run("A-501", { y: 0.9 })]
  const { links } = extract(runs, ["A-501"])
  assert.equal(links.length, 3)
})

test("exact-duplicate bboxes collapse to one link", () => {
  const runs = [run("5/A-501"), run("5/A-501")] // identical text AND position
  const { links } = extract(runs, ["A-501"])
  assert.equal(links.length, 1)
})

test("a single run is capped so legend paragraphs stay bounded", () => {
  const numbers = Array.from({ length: 12 }, (_, i) => `A-${101 + i}`)
  const { links } = extract([run(numbers.join(" "))], numbers.concat("Z-1"))
  assert.equal(links.length, 8)
})

test("per-sheet cap truncates and reports it, keeping high confidence first", () => {
  const runs = []
  for (let i = 0; i < 12; i += 1) runs.push(run("A-101", { y: i / 100 }))
  for (let i = 0; i < 3; i += 1) runs.push(run("5/A-102", { y: 0.5 + i / 100 }))
  const { links, truncated } = extract(runs, ["A-101", "A-102"], { maxLinks: 5 })
  assert.equal(truncated, true)
  assert.equal(links.length, 5)
  // All three 0.95 detail bubbles beat the 0.8 bare index rows.
  assert.equal(links.filter((l) => l.kind === "detail_bubble").length, 3)
})

test("default cap matches the exported constant", () => {
  const runs = Array.from({ length: MAX_CALLOUT_LINKS_PER_SHEET + 20 }, (_, i) =>
    run("A-101", { y: i / 1000 }),
  )
  const { links, truncated } = extract(runs, ["A-101"])
  assert.equal(links.length, MAX_CALLOUT_LINKS_PER_SHEET)
  assert.equal(truncated, true)
})

// ---------------------------------------------------------------------------
// Read-time resolution
// ---------------------------------------------------------------------------

test("resolveCalloutLinks maps printed numbers to sheet ids", () => {
  const { links } = extract([run("5/A501"), run("SEE S2.1")], ["A-501", "S2.1"])
  const resolved = resolveCalloutLinks(links, [
    { id: "sheet-a", sheetNumber: "A-501" },
    { id: "sheet-s", sheetNumber: "S2.1" },
  ])
  assert.equal(resolved.length, 2)
  assert.equal(resolved.find((l) => l.targetSheetNumber === "A501").targetSheetId, "sheet-a")
  assert.equal(resolved.find((l) => l.targetSheetNumber === "S2.1").targetSheetId, "sheet-s")
})

test("resolveCalloutLinks drops unresolved, ambiguous and self targets", () => {
  const { links } = extract([run("5/P-401"), run("SEE A-101"), run("A-102")], ["A-101", "A-102"])
  assert.equal(links.length, 3)

  // P-401 still not uploaded; A-102 now normalizes ambiguously; A-101 is us.
  const resolved = resolveCalloutLinks(
    links,
    [
      { id: "self", sheetNumber: "A-101" },
      { id: "sheet-b", sheetNumber: "A-102" },
      { id: "sheet-c", sheetNumber: "A10.2" },
    ],
    "self",
  )
  assert.equal(resolved.length, 0)

  // Once P-401 exists, the stored bubble resolves with no re-extraction.
  const later = resolveCalloutLinks(links, [{ id: "sheet-p", sheetNumber: "P-401" }], "self")
  assert.equal(later.length, 1)
  assert.equal(later[0].targetSheetId, "sheet-p")
})

// ---------------------------------------------------------------------------
// Stored-blob parsing
// ---------------------------------------------------------------------------

test("parseStoredCalloutLinks roundtrips extraction output", () => {
  const { links, truncated } = extract([run("5/A-501"), run("SEE S2.1")], ["A-501", "S2.1"])
  const stored = JSON.parse(
    JSON.stringify({ algo: CALLOUT_LINKS_ALGO, links, truncated, computed_at: "2026-08-03T00:00:00Z" }),
  )
  const parsed = parseStoredCalloutLinks(stored)
  assert.equal(parsed.algo, CALLOUT_LINKS_ALGO)
  assert.equal(parsed.truncated, false)
  assert.deepEqual(parsed.links, links)
})

test("parseStoredCalloutLinks rejects malformed blobs and rows", () => {
  assert.equal(parseStoredCalloutLinks(null), null)
  assert.equal(parseStoredCalloutLinks("nope"), null)
  assert.equal(parseStoredCalloutLinks({ algo: 1, links: [] }), null)
  assert.equal(parseStoredCalloutLinks({ algo: "x" }), null)

  const parsed = parseStoredCalloutLinks({
    algo: CALLOUT_LINKS_ALGO,
    truncated: "yes",
    links: [
      { x: 0.1, y: 0.2, w: 0.1, h: 0.01, targetSheetNumber: "A-1", kind: "detail_bubble", confidence: 0.9 },
      { x: NaN, y: 0.2, w: 0.1, h: 0.01, targetSheetNumber: "A-2", kind: "sheet_reference", confidence: 0.8 },
      { x: 0.1, y: 0.2, w: 0.1, h: 0.01, targetSheetNumber: "A-3", kind: "hyperlink", confidence: 0.8 },
      { x: 0.1, y: 0.2, w: 0.1, h: 0.01, targetSheetNumber: "", kind: "sheet_reference", confidence: 0.8 },
      { x: 0.1, y: 0.2, w: 0.1, h: 0.01, targetSheetNumber: "A-4", kind: "sheet_reference", confidence: 2 },
    ],
  })
  assert.equal(parsed.truncated, false)
  assert.equal(parsed.links.length, 1)
  assert.equal(parsed.links[0].targetSheetNumber, "A-1")
})
