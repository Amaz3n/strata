const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const page = fs.readFileSync(
  path.resolve(__dirname, "../app/(app)/directory/[id]/page.tsx"),
  "utf8",
)

test("directory website links normalize bare domains and reject unsafe schemes", () => {
  assert.match(page, /function safeWebsiteHref/)
  assert.match(page, /const hasExplicitScheme = \/\^\[a-z\]/)
  assert.match(page, /hasExplicitScheme \? normalized : `https:\/\/\$\{normalized\}`/)
  assert.match(page, /url\.protocol === "http:" \|\| url\.protocol === "https:"/)
  assert.match(page, /href=\{websiteHref\}/)
  assert.doesNotMatch(page, /href=\{company\.website\}/)
})
