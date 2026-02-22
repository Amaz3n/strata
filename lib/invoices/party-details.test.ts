// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"

import { buildPartyDetailsBlock, parsePartyDetailsBlock } from "@/lib/invoices/party-details"

describe("party details helpers", () => {
  it("builds a normalized multiline block", () => {
    const result = buildPartyDetailsBlock({
      name: "  Jane Doe ",
      email: " jane@doe.com ",
      address: "123 Main St\n Naples, FL 34102 ",
    })

    expect(result).toBe("Jane Doe\njane@doe.com\n123 Main St\nNaples, FL 34102")
  })

  it("parses name, email and address from a multiline block", () => {
    const result = parsePartyDetailsBlock("Jane Doe\njane@doe.com\n123 Main St\nNaples, FL 34102")

    expect(result).toEqual({
      name: "Jane Doe",
      email: "jane@doe.com",
      address: "123 Main St\nNaples, FL 34102",
    })
  })

  it("parses email-first blocks without a name", () => {
    const result = parsePartyDetailsBlock("billing@client.com\n123 Main St")

    expect(result).toEqual({
      name: "",
      email: "billing@client.com",
      address: "123 Main St",
    })
  })
})
