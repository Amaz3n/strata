// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"

import { classifyQboPermanentFailure, isQboMissingEntityFault } from "@/lib/integrations/accounting/qbo/error-rules"

describe("isQboMissingEntityFault", () => {
  it("treats HTTP 404 as a missing entity", () => {
    expect(isQboMissingEntityFault({ status: 404 })).toBe(true)
  })

  it("treats fault 610 as a missing entity even though QBO answers it with HTTP 400", () => {
    expect(isQboMissingEntityFault({ status: 400, faultCode: "610" })).toBe(true)
  })

  it("leaves other faults alone", () => {
    expect(isQboMissingEntityFault({ status: 400, faultCode: "5010" })).toBe(false)
    expect(isQboMissingEntityFault({ status: 500 })).toBe(false)
    expect(isQboMissingEntityFault({})).toBe(false)
    expect(isQboMissingEntityFault({ status: null, faultCode: null })).toBe(false)
    // The code is compared as a string; a numeric 610 is not the QBO shape.
    expect(isQboMissingEntityFault({ faultCode: "0610" })).toBe(false)
  })
})

describe("classifyQboPermanentFailure", () => {
  it("names the inactive object when the fault detail carries a quoted name", () => {
    const result = classifyQboPermanentFailure({
      faultCode: "610",
      faultDetail: 'Object Not Found : Something went wrong; the account "Job Materials" was made inactive.',
    })

    expect(result).not.toBeNull()
    expect(result!.message).toContain("“Job Materials”")
    expect(result!.message).toContain("Retrying cannot fix it")
    expect(result!.message).toContain("make “Job Materials” active again")
  })

  it("reads the quoted name out of curly quotes too", () => {
    const result = classifyQboPermanentFailure({
      faultCode: "610",
      faultDetail: "Object Not Found : the vendor “Gulf Coast Drywall” was made inactive",
    })
    expect(result!.message).toContain("“Gulf Coast Drywall”")
  })

  it("falls back to the fault message when there is no fault detail", () => {
    const result = classifyQboPermanentFailure({
      faultCode: "610",
      message: "Object Not Found: the item 'Framing Labor' is inactive",
    })
    expect(result!.message).toContain("“Framing Labor”")
  })

  it("describes the class of object when the inactive fault names nothing", () => {
    const result = classifyQboPermanentFailure({
      faultCode: "610",
      faultDetail: "Object Not Found : a referenced record was made inactive",
    })

    expect(result!.message).toContain("a customer, vendor, account, or item this transaction references")
    expect(result!.message).toContain("make it active again")
  })

  it("gives the restore-or-unlink message for a 610 that is not about inactivity", () => {
    const result = classifyQboPermanentFailure({ faultCode: "610", faultDetail: "Object Not Found" })

    expect(result!.message).toContain("no longer exists there")
    expect(result!.message).toContain("Retrying cannot fix it")
    expect(result!.message).not.toContain("inactive")
  })

  it("classifies an object-not-found detail even when the fault code is missing", () => {
    expect(classifyQboPermanentFailure({ faultDetail: "Object not found for this id" })).not.toBeNull()
  })

  it("returns null for transient errors so the outbox keeps retrying them", () => {
    expect(classifyQboPermanentFailure({ faultCode: "5010", faultDetail: "Stale Object Error" })).toBeNull()
    expect(classifyQboPermanentFailure({ status: 503, message: "Service temporarily unavailable" })).toBeNull()
    expect(classifyQboPermanentFailure({ status: 429, message: "Throttle exceeded" })).toBeNull()
    expect(classifyQboPermanentFailure({})).toBeNull()
    expect(classifyQboPermanentFailure({ faultDetail: null, message: null })).toBeNull()
  })
})
