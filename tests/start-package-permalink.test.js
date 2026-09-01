const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const page = fs.readFileSync(
  path.resolve(__dirname, "../app/(app)/starts/[id]/page.tsx"),
  "utf8",
)

test("start package permalinks encode the path id as one query value", () => {
  assert.match(page, /new URLSearchParams\(\{ package: id \}\)/)
  assert.match(page, /redirect\(`\/starts\?\$\{query\}`\)/)
  assert.doesNotMatch(page, /package=\$\{id\}/)
})
