// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"

import { mapQboAccountRows, pickPreferredQboIncomeAccounts } from "@/lib/integrations/accounting/qbo-account-utils"

describe("QBO account utils", () => {
  it("maps valid account rows and ignores invalid rows", () => {
    const mapped = mapQboAccountRows([
      { Id: "1", Name: "Sales", FullyQualifiedName: "Income:Sales" },
      { Id: "2" },
      { Name: "Missing ID" },
    ])

    expect(mapped).toEqual([{ id: "1", name: "Sales", fullyQualifiedName: "Income:Sales" }])
  })

  it("prefers income/other-income accounts over revenue fallback", () => {
    const picked = pickPreferredQboIncomeAccounts({
      income: [{ id: "1", name: "Income A" }],
      otherIncome: [{ id: "2", name: "Other Income B" }],
      revenueFallback: [{ id: "9", name: "Revenue Fallback" }],
    })

    expect(picked.map((item) => item.id)).toEqual(["1", "2"])
  })

  it("uses revenue fallback when primary lists are empty", () => {
    const picked = pickPreferredQboIncomeAccounts({
      income: [],
      otherIncome: [],
      revenueFallback: [{ id: "9", name: "Revenue Fallback" }],
    })

    expect(picked).toEqual([{ id: "9", name: "Revenue Fallback" }])
  })
})
