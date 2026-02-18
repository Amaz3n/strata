// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"

import { escapeQboQueryLiteral } from "@/lib/integrations/accounting/qbo-query"

describe("escapeQboQueryLiteral", () => {
  it("escapes apostrophes for QBO query literals", () => {
    expect(escapeQboQueryLiteral("O'Brien")).toBe("O''Brien")
  })

  it("leaves strings without apostrophes unchanged", () => {
    expect(escapeQboQueryLiteral("Acme LLC")).toBe("Acme LLC")
  })

  it("escapes multiple apostrophes", () => {
    expect(escapeQboQueryLiteral("Bob's \"Aunt's\" Co")).toBe("Bob''s \"Aunt''s\" Co")
  })
})
