// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"

import { compareInvoiceNumbers, incrementInvoiceNumber } from "@/lib/services/invoice-numbers"

describe("invoice number helpers", () => {
  it("compares numeric invoice numbers by sequence", () => {
    expect(compareInvoiceNumbers("1002", "1001")).toBeGreaterThan(0)
    expect(compareInvoiceNumbers("1001", "1002")).toBeLessThan(0)
  })

  it("compares prefixed invoice numbers by numeric suffix", () => {
    expect(compareInvoiceNumbers("INV-0010", "INV-0009", { invoice_number_pattern: "prefix", invoice_number_prefix: "INV-" })).toBeGreaterThan(0)
  })

  it("increments prefixed invoice numbers while preserving padding", () => {
    expect(incrementInvoiceNumber("INV-0012", { invoice_number_pattern: "prefix", invoice_number_prefix: "INV-" })).toBe("INV-0013")
  })
})
