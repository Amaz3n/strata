/**
 * Who may read and who may change the directory.
 *
 * These two lists were previously inlined at fourteen call sites, and the write
 * list contained `org.member` — which every internal role holds. That made
 * `directory.write` decorative: an `org_user` seeded with read-only directory
 * access passed the write gate anyway. The directory decides who gets paid, so
 * the write side is now a real privilege that has to be granted.
 *
 * Read stays open to any org member on purpose. The directory is org-wide
 * reference data — vendor pickers, client pickers, assignee lists and the
 * command bar all need it — so withholding read would break surfaces that have
 * nothing to do with directory administration.
 */

export const DIRECTORY_READ_PERMISSIONS: string[] = [
  "org.member",
  "org.read",
  "directory.read",
  "directory.write",
]

export const DIRECTORY_WRITE_PERMISSIONS: string[] = ["directory.write"]

/**
 * The UI's copy of the write gate. Server enforcement always runs through
 * `requireAnyPermission(DIRECTORY_WRITE_PERMISSIONS)` in the service; this only
 * decides whether to render the affordance.
 */
export function canEditDirectory(permissions: readonly string[]): boolean {
  return DIRECTORY_WRITE_PERMISSIONS.some((permission) => permissions.includes(permission))
}
