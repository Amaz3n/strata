require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  analyzeSetCoherence,
  findMissingSheets,
  findOrphanSheets,
  findSequenceGaps,
  findUncoveredDivisions,
  normalizeSheetKey,
  parseSheetNumber,
} = require("../lib/drawings/set-coherence")

function sheet(sheetNumber, discipline = null, sheetTitle = null) {
  return { id: sheetNumber, sheetNumber, discipline, sheetTitle }
}

function callout(fromSheetNumber, targetSheetNumber) {
  return { fromSheetNumber, targetSheetNumber }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("sheet keys ignore separators and case", () => {
  assert.equal(normalizeSheetKey("A-501"), normalizeSheetKey("a501"))
  assert.equal(normalizeSheetKey(" A.501 "), "A501")
})

test("sheet numbers split into discipline and position", () => {
  assert.deepEqual(parseSheetNumber("A-101"), { prefix: "A", major: 101, minor: null })
  assert.deepEqual(parseSheetNumber("FP-1"), { prefix: "FP", major: 1, minor: null })
  assert.equal(parseSheetNumber("SITE PLAN"), null)
})

// ---------------------------------------------------------------------------
// Missing sheets
// ---------------------------------------------------------------------------

test("a callout to a sheet not in the set is reported", () => {
  const findings = findMissingSheets(
    [sheet("A-101"), sheet("A-102")],
    [callout("A-101", "A-514")],
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, "missing_sheet")
  assert.equal(findings[0].subject, "A-514")
  assert.deepEqual(findings[0].relatedSheets, ["A-101"])
})

test("one reference is medium, several is high — a typo versus a pulled sheet", () => {
  const single = findMissingSheets([sheet("A-101")], [callout("A-101", "A-514")])
  assert.equal(single[0].severity, "medium")

  const many = findMissingSheets(
    [sheet("A-101"), sheet("A-102")],
    [callout("A-101", "A-514"), callout("A-102", "A-514")],
  )
  assert.equal(many[0].severity, "high")
  assert.deepEqual(many[0].relatedSheets, ["A-101", "A-102"])
})

test("a callout resolves against a differently punctuated sheet number", () => {
  const findings = findMissingSheets([sheet("A501")], [callout("A-101", "A-501")])
  assert.equal(findings.length, 0)
})

test("the same sheet referenced twice from one sheet counts as one reference", () => {
  const findings = findMissingSheets(
    [sheet("A-101")],
    [callout("A-101", "A-514"), callout("A-101", "A-514")],
  )
  assert.deepEqual(findings[0].relatedSheets, ["A-101"])
  assert.equal(findings[0].severity, "medium")
})

test("the most-referenced missing sheet leads", () => {
  const findings = findMissingSheets(
    [sheet("A-101"), sheet("A-102"), sheet("A-103")],
    [
      callout("A-101", "A-901"),
      callout("A-101", "A-514"),
      callout("A-102", "A-514"),
      callout("A-103", "A-514"),
    ],
  )
  assert.equal(findings[0].subject, "A-514")
})

// ---------------------------------------------------------------------------
// Sequence gaps
// ---------------------------------------------------------------------------

test("a one-sheet hole in a run is reported", () => {
  const findings = findSequenceGaps([
    sheet("A-101"),
    sheet("A-102"),
    sheet("A-104"),
    sheet("A-105"),
  ])
  assert.equal(findings.length, 1)
  assert.match(findings[0].subject, /A-103/)
  assert.equal(findings[0].severity, "low")
})

test("a new series is not a gap", () => {
  const findings = findSequenceGaps([sheet("A-101"), sheet("A-102"), sheet("A-201")])
  assert.equal(findings.length, 0)
})

test("a big jump inside a series is left alone — that is deliberate numbering", () => {
  const findings = findSequenceGaps([sheet("A-101"), sheet("A-102"), sheet("A-140")])
  assert.equal(findings.length, 0)
})

test("a series too short to have a pattern is not judged", () => {
  const findings = findSequenceGaps([sheet("A-101"), sheet("A-104")])
  assert.equal(findings.length, 0)
})

// ---------------------------------------------------------------------------
// Orphans
// ---------------------------------------------------------------------------

test("a detail sheet nothing points at is reported", () => {
  const findings = findOrphanSheets(
    [sheet("A-101"), sheet("A-501", "A", "Wall Details")],
    [callout("A-101", "A-102")],
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].subject, "A-501")
  assert.match(findings[0].message, /Wall Details/)
})

test("a referenced detail sheet is not an orphan", () => {
  const findings = findOrphanSheets(
    [sheet("A-101"), sheet("A-501")],
    [callout("A-101", "A-501")],
  )
  assert.equal(findings.length, 0)
})

test("plan sheets are never orphans — nothing is expected to call them out", () => {
  const findings = findOrphanSheets([sheet("A-101"), sheet("A-102")], [])
  assert.equal(findings.length, 0)
})

test("cover and general sheets are exempt", () => {
  const findings = findOrphanSheets([sheet("G-501"), sheet("T-501"), sheet("A-501")], [])
  assert.deepEqual(
    findings.map((finding) => finding.subject),
    ["A-501"],
  )
})

// ---------------------------------------------------------------------------
// Spec coverage
// ---------------------------------------------------------------------------

test("a specified division with no matching sheets is reported", () => {
  const findings = findUncoveredDivisions(
    [sheet("A-101", "A")],
    [{ division: "26", sectionNumber: "260500", title: "Common Work Results" }],
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, "uncovered_division")
  assert.match(findings[0].message, /Electrical/)
})

test("a division with matching sheets is not reported", () => {
  const findings = findUncoveredDivisions(
    [sheet("A-101", "A"), sheet("E-101", "E")],
    [{ division: "26", sectionNumber: "260500", title: null }],
  )
  assert.equal(findings.length, 0)
})

test("the discipline is inferred from the sheet number when not recorded", () => {
  const findings = findUncoveredDivisions(
    [sheet("E-101", null)],
    [{ division: "26", sectionNumber: "260500", title: null }],
  )
  assert.equal(findings.length, 0)
})

test("a division is reported once however many sections it has", () => {
  const findings = findUncoveredDivisions(
    [sheet("A-101", "A")],
    [
      { division: "26", sectionNumber: "260500", title: null },
      { division: "26", sectionNumber: "262726", title: null },
    ],
  )
  assert.equal(findings.length, 1)
})

test("divisions with no unambiguous discipline are left alone", () => {
  const findings = findUncoveredDivisions(
    [sheet("A-101", "A")],
    [{ division: "01", sectionNumber: "013300", title: "Submittals" }],
  )
  assert.equal(findings.length, 0)
})

test("a missing division field falls back to the section number prefix", () => {
  const findings = findUncoveredDivisions(
    [sheet("A-101", "A")],
    [{ division: null, sectionNumber: "230500", title: null }],
  )
  assert.equal(findings.length, 1)
  assert.match(findings[0].message, /HVAC/)
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

test("findings are ordered so a missing sheet is read before a numbering gap", () => {
  const report = analyzeSetCoherence({
    sheets: [sheet("A-101"), sheet("A-102"), sheet("A-104"), sheet("A-501")],
    callouts: [callout("A-101", "A-514"), callout("A-102", "A-514")],
    specSections: [],
  })
  assert.equal(report.findings[0].kind, "missing_sheet")
  assert.equal(report.findings.at(-1).kind, "sequence_gap")
  assert.equal(report.missingSheets, 1)
  assert.equal(report.sheetsChecked, 4)
  assert.equal(report.calloutsChecked, 2)
})

test("a coherent set produces no findings", () => {
  const report = analyzeSetCoherence({
    sheets: [sheet("A-101"), sheet("A-102"), sheet("A-103"), sheet("A-501")],
    callouts: [callout("A-101", "A-501"), callout("A-102", "A-103")],
    specSections: [],
  })
  assert.deepEqual(report.findings, [])
  assert.equal(report.missingSheets, 0)
})

test("an empty set is analyzable rather than a crash", () => {
  const report = analyzeSetCoherence({ sheets: [], callouts: [] })
  assert.deepEqual(report.findings, [])
  assert.equal(report.sheetsChecked, 0)
})
