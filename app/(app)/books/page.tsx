import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getBooksModuleSettings } from "@/lib/services/books/module";

// This entry only redirects to the configured ledger workspace.
export const instant = false;

export default async function BooksPage() {
  // A redirect read from the organization's settings: request time, never prerendered.
  await connection();
  const { settings } = await getBooksModuleSettings();
  redirect(
    settings?.ledger_authority === "arc"
      ? "/books/banking"
      : "/settings/accounting/setup",
  );
}
