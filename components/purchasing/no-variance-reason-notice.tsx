import Link from "next/link"

/** Shown where a purchase-order change needs a reason and the organization has none to offer. */
export function NoVarianceReasonNotice() {
  return (
    <p className="border border-dashed px-3 py-2 text-xs text-muted-foreground">
      This organization has no active variance reason, and a purchase-order change needs one.{" "}
      <Link href="/settings/purchasing" className="font-medium text-foreground underline underline-offset-2">Add a variance reason in Purchasing settings</Link>.
    </p>
  )
}
