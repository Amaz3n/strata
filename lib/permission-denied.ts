import { TEAM_PERMISSION_OPTIONS } from "@/lib/permission-catalog"

/**
 * Next redacts a thrown error's message to a hash in production builds, but it
 * keeps a `digest` the error already carries. The permission-denied error
 * stamps its missing keys into that digest, so an error boundary can still say
 * which permission was missing. Client-safe: no server imports.
 */
const PERMISSION_DENIED_DIGEST_PREFIX = "AUTH_FORBIDDEN:"
const KEY_SEPARATOR = "|"

export function permissionDeniedDigest(permissions: string[]): string {
  return `${PERMISSION_DENIED_DIGEST_PREFIX}${permissions.join(KEY_SEPARATOR)}`
}

/** The missing permission keys when `error` is a permission denial, otherwise null. */
export function parsePermissionDenied(error: { digest?: string }): string[] | null {
  const digest = error.digest
  if (!digest?.startsWith(PERMISSION_DENIED_DIGEST_PREFIX)) return null
  const keys = digest.slice(PERMISSION_DENIED_DIGEST_PREFIX.length).split(KEY_SEPARATOR).filter(Boolean)
  return keys.length > 0 ? keys : null
}

const LABELS = new Map(TEAM_PERMISSION_OPTIONS.map((option) => [option.key, option.label]))

/** Human label from the RBAC catalog; keys outside it are shown as written. */
export function permissionLabel(key: string): string {
  return LABELS.get(key) ?? key
}
