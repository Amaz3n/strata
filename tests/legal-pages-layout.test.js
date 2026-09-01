const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8")
}

test("public legal pages share one document shell", () => {
  for (const pagePath of ["app/privacy/page.tsx", "app/terms/page.tsx", "app/esign-terms/page.tsx"]) {
    const page = source(pagePath)
    assert.match(page, /import \{ LegalDocument \}/)
    assert.match(page, /<LegalDocument/)
    assert.doesNotMatch(page, /<main/)
  }
})

test("the legal shell provides navigable section anchors", () => {
  const layout = source("components/legal/legal-document.tsx")

  assert.match(layout, /aria-label=\{`\$\{title\} sections`\}/)
  assert.match(layout, /href=\{`#\$\{sectionId\(section\.title\)\}`\}/)
  assert.match(layout, /id=\{sectionId\(section\.title\)\}/)
  assert.match(layout, /<details/)
})
