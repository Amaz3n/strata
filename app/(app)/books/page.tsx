import { redirect } from "next/navigation";
import { getBooksModuleSettings } from "@/lib/services/books/module";

// This entry only redirects to the configured ledger workspace.
export const instant = false;

export default async function BooksPage() {
  const { settings } = await getBooksModuleSettings();
  redirect(
    settings?.ledger_authority === "arc"
      ? "/books/banking"
      : "/settings/accounting/setup",
  );
}
