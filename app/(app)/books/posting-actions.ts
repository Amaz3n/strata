"use server"
import { getBooksPostingStatus } from "@/lib/services/books/posting-status"
export async function loadBooksPostingStatusAction(input: { sourceType: "invoice" | "vendor_bill" | "expense"; sourceId: string }) {
  try { return { success: true as const, data: await getBooksPostingStatus(input) } }
  catch { return { success: false as const, error: "Accounting status is unavailable" } }
}
