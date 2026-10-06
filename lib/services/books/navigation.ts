import "server-only"

import { cacheLife } from "next/cache"
import { isBooksWorkspaceEnabled } from "@/lib/services/books/module"

/** Browser-private navigation hint; readers and mutations enforce the fresh gate. */
export async function loadBooksNavigationAvailability() {
  "use cache: private"
  cacheLife("session")
  // Accounting changes invalidate the root layout and its private entries.
  // Never use this hint in place of requireBooksWorkspaceEnabled on the server.
  return isBooksWorkspaceEnabled()
}
