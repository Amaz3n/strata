import "server-only"

import { revalidateTag } from "next/cache"

/**
 * Drop the browser-private cache behind one directory account's tabs.
 *
 * The account header and every tab are cached per browser for up to a minute so
 * a tab click resolves before the click lands (`registerDirectoryTabCache`).
 * Builder-side mutations clear it with `revalidatePath`, but a vendor uploading
 * through their portal — or carrying a certificate in from another builder —
 * writes to the same records from a request that has no path in common with the
 * builder's page. The notification email then linked to a compliance tab that
 * still read "Not on file" for up to a minute after the document arrived.
 */
export function revalidateDirectoryParty(partyId: string) {
  // `{ expire: 0 }` because the point is that the next read is fresh: a vendor
  // clicks the link in the notification email seconds after the write, and the
  // account's own profile would let a stale entry answer for up to a minute.
  revalidateTag(`directory-party:${partyId}`, { expire: 0 })
}
