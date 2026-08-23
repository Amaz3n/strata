// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"

import { pickHighestDocNumber } from "@/lib/integrations/accounting/qbo/client"
import { escapeQboQueryLiteral } from "@/lib/integrations/accounting/qbo/query"

describe("escapeQboQueryLiteral", () => {
  it("escapes apostrophes for QBO query literals", () => {
    expect(escapeQboQueryLiteral("O'Brien")).toBe("O\\'Brien")
  })

  it("leaves strings without apostrophes unchanged", () => {
    expect(escapeQboQueryLiteral("Acme LLC")).toBe("Acme LLC")
  })

  it("escapes multiple apostrophes", () => {
    expect(escapeQboQueryLiteral("Bob's \"Aunt's\" Co")).toBe("Bob\\'s \"Aunt\\'s\" Co")
  })

  it("escapes backslashes before apostrophes", () => {
    expect(escapeQboQueryLiteral("Bob\\Alice's Co")).toBe("Bob\\\\Alice\\'s Co")
  })
})

describe("pickHighestDocNumber", () => {
  it("compares numerically rather than lexically", () => {
    // Lexical ordering put "INV-99" above "INV-100" and handed the next invoice
    // a number QuickBooks already had.
    expect(pickHighestDocNumber(["INV-99", "INV-100"])).toBe("INV-100")
    expect(pickHighestDocNumber(["INV-100", "INV-99"])).toBe("INV-100")
    expect(pickHighestDocNumber(["9", "10", "8"])).toBe("10")
  })

  it("compares each numeric run in a multi-part number", () => {
    expect(pickHighestDocNumber(["2026-9", "2026-014"])).toBe("2026-014")
    expect(pickHighestDocNumber(["2025-999", "2026-1"])).toBe("2026-1")
  })

  it("ignores blank, whitespace-only, null, and undefined entries", () => {
    expect(pickHighestDocNumber(["", "  ", null, undefined, "7"])).toBe("7")
  })

  it("trims the winner", () => {
    expect(pickHighestDocNumber([" 42 "])).toBe("42")
  })

  it("returns null when there is nothing usable", () => {
    expect(pickHighestDocNumber([])).toBeNull()
    expect(pickHighestDocNumber(["", "   ", null, undefined])).toBeNull()
  })

  it("still picks a winner from purely alphabetic numbers", () => {
    expect(pickHighestDocNumber(["DRAFT-A", "DRAFT-B"])).toBe("DRAFT-B")
  })
})
