"use server"
import { getBooksPostingStatus, type BooksPostingSourceType } from "@/lib/services/books/posting-status"
export async function loadBooksPostingStatusAction(input: { sourceType: BooksPostingSourceType; sourceId: string }) {
  try { return { success: true as const, data: await getBooksPostingStatus(input) } }
  catch { return { success: false as const, error: "Accounting status is unavailable" } }
}
