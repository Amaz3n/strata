import { z } from "zod"

import type { SearchPickerPage } from "@/components/ui/search-picker"

/** What `SearchPicker` sends: the typed text and, past the first page, the page it wants. */
export const searchPickerQuerySchema = z.object({
  search: z.string().trim().max(80).default(""),
  page: z.number().int().min(1).max(100_000).default(1),
})

export const SEARCH_PICKER_PAGE_SIZE = 25

/** One picker page from a page-numbered read; `nextPage` is null once the last row has been shown. */
export function searchPickerPage(items: SearchPickerPage["items"], page: number, pageSize: number, total: number): SearchPickerPage {
  return { items, nextCursor: null, nextPage: page * pageSize < total ? page + 1 : null }
}
