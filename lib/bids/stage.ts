// Client-safe (no server imports): shared by the workbench/board client
// components and the server-side desk. Lives outside lib/services because
// those modules pull next/headers and cannot enter a client bundle.

export type BidPackageStage = "setup" | "bidding" | "leveling" | "awarded" | "cancelled"

/** The lifecycle stage the workbench organizes around. Derived, not stored:
 * a package past its deadline is in leveling even if nobody clicked Close. */
export function getBidPackageStage(pkg: { status: string; due_at?: string | null }): BidPackageStage {
  if (pkg.status === "awarded") return "awarded"
  if (pkg.status === "cancelled") return "cancelled"
  if (pkg.status === "draft") return "setup"
  if (pkg.status === "closed") return "leveling"
  if (pkg.due_at && new Date(pkg.due_at) < new Date()) return "leveling"
  return "bidding"
}
