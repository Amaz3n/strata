import { Suspense } from "react";
import { connection } from "next/server";
import { AccountingSection } from "@/components/settings/accounting-section";
import { SettingsPanelSkeleton } from "@/components/settings/settings-skeleton";
import { BooksClient } from "@/app/(app)/books/books-client";
import { getBooksWorkspace } from "@/lib/services/books/workspace";

async function OpeningBalances() {
  await connection();
  const workspace = await getBooksWorkspace(undefined, "opening-balances");
  return <BooksClient workspace={workspace} section="opening-balances" />;
}
export default function OpeningBalancesPage() {
  return (
    <AccountingSection title="Opening balances">
      <Suspense fallback={<SettingsPanelSkeleton />}>
        <OpeningBalances />
      </Suspense>
    </AccountingSection>
  );
}
