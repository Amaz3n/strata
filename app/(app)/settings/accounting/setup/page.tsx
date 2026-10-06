import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { AccountingSection } from "@/components/settings/accounting-section";
import { SettingsPanelSkeleton } from "@/components/settings/settings-skeleton";
import { BooksClient } from "@/app/(app)/books/books-client";
import { getBooksWorkspace } from "@/lib/services/books/workspace";

async function Setup() {
  await connection();
  const workspace = await getBooksWorkspace(undefined, "cutover");
  return (
    <>
      <div className="mx-auto w-full max-w-[1500px] px-4 pt-6 sm:px-6 lg:px-8">
        <p className="text-sm text-muted-foreground">
          {workspace.settings.ledger_authority === "arc"
            ? "Arc Books is your official ledger. Review migration history and recovery controls below."
            : "Prepare your accounts and starting balances, then launch new books or migrate your existing ledger."}
        </p>
        <nav
          aria-label="Accounting setup steps"
          className="mt-4 flex flex-wrap gap-3 text-sm"
        >
          <Link
            className="rounded-md border px-3 py-2 hover:bg-muted"
            href="/settings/accounting/chart-of-accounts"
          >
            1. Chart of accounts
          </Link>
          <Link
            className="rounded-md border px-3 py-2 hover:bg-muted"
            href="/settings/accounting/calendar"
          >
            2. Accounting calendar
          </Link>
          <Link
            className="rounded-md border px-3 py-2 hover:bg-muted"
            href="/settings/accounting/opening-balances"
          >
            3. Opening balances
          </Link>
        </nav>
      </div>
      <BooksClient workspace={workspace} section="cutover" />
    </>
  );
}
export default function AccountingSetupPage() {
  return (
    <AccountingSection title="Setup & migration">
      <Suspense fallback={<SettingsPanelSkeleton />}>
        <Setup />
      </Suspense>
    </AccountingSection>
  );
}
