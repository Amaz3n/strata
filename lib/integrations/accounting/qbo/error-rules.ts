export type QBOFaultIdentity = {
  status?: number | null
  faultCode?: string | null
}

/** QBO uses fault 610 (HTTP 400) for a deleted entity on direct lookups. */
export function isQboMissingEntityFault(error: QBOFaultIdentity): boolean {
  return error.status === 404 || error.faultCode === "610"
}

export type QBOFaultDetail = QBOFaultIdentity & {
  faultDetail?: string | null
  message?: string | null
}

/**
 * The name of the QuickBooks object a 610 is complaining about, when the fault
 * detail carries one — e.g. `Object Not Found : Something went wrong ... the
 * account "Job Materials" was made inactive`.
 */
function inactiveObjectName(detail: string): string | null {
  const quoted = detail.match(/["'“]([^"'”]{1,80})["'”]/)
  return quoted?.[1]?.trim() || null
}

/**
 * A failure that no amount of retrying will cure, paired with the sentence that
 * tells a person how to cure it.
 *
 * QuickBooks answers a push that references a deactivated customer, vendor,
 * account, or item with fault 610 "Object Not Found". The outbox treated that
 * like any transient error: three retries at growing backoff, then a `failed`
 * row nobody sees. Patagonia has had a `qbo_sync_invoice` job failing this way
 * since June with the same message every time, because the only thing that can
 * fix it is somebody reactivating the object in QuickBooks — and nothing ever
 * said so. Returning a message here is what turns the row into work a human can
 * finish instead of a retry loop that cannot.
 */
export function classifyQboPermanentFailure(error: QBOFaultDetail): { message: string } | null {
  const detail = String(error.faultDetail ?? error.message ?? "")
  const lowered = detail.toLowerCase()

  if (error.faultCode === "610" || lowered.includes("object not found")) {
    if (lowered.includes("inactive") || lowered.includes("made inactive")) {
      const name = inactiveObjectName(detail)
      const subject = name ? `“${name}”` : "a customer, vendor, account, or item this transaction references"
      return {
        message:
          `QuickBooks rejected this because ${subject} was made inactive there. Retrying cannot fix it. ` +
          `In QuickBooks, show inactive records for that list, make ${name ? `“${name}”` : "it"} active again, then resync this transaction.`,
      }
    }
    return {
      message:
        "QuickBooks reports that a record this transaction references no longer exists there. Retrying cannot fix it. " +
        "Restore or recreate the QuickBooks record, or unlink this transaction, then resync it.",
    }
  }

  return null
}
