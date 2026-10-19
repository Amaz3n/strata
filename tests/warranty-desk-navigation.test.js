const assert = require("node:assert/strict")
const { test } = require("node:test")

const { stubModule, freshRequire } = require("./support/modules")

let query = new URLSearchParams()
stubModule("next/navigation", { useSearchParams: () => query })

const { Suspense } = require("react")
const { WarrantyDeskNavigation } = freshRequire("app/(app)/warranty/warranty-desk-navigation.tsx")

test("a new desk query resets the loading boundary so last week's rows are hidden", () => {
  const children = { rows: "desk" }
  const fallback = { rows: "skeleton" }
  const boundary = (search) => {
    query = new URLSearchParams(search)
    return WarrantyDeskNavigation({ children, fallback })
  }

  const thisWeek = boundary("tab=dispatch&week=2026-10-04")
  const nextWeek = boundary("tab=dispatch&week=2026-10-11")

  assert.equal(nextWeek.type, Suspense)
  assert.deepEqual([nextWeek.props.children, nextWeek.props.fallback], [children, fallback])
  assert.notEqual(thisWeek.key, nextWeek.key)
  assert.equal(boundary("tab=dispatch&week=2026-10-11").key, nextWeek.key)
})
