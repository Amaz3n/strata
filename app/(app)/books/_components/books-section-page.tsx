import Link from "next/link";
import { OverheadBudget } from "@/components/books/overhead-budget";
import { CloseWorkspace } from "@/components/books/close-workspace";
import { BooksJournals } from "@/components/books/books-journals";
import { PageLayout } from "@/components/layout/page-layout";
import { getBooksWorkspace } from "@/lib/services/books/workspace";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton";

import { BooksClient, type BooksSection } from "../books-client";

const TITLES: Record<BooksSection, string> = {
  banking: "Banking",
  overhead: "Company budget",
  ledger: "Books · General ledger",
  close: "Close",
  "opening-balances": "Books · Opening balances",
  exports: "Books · Exports",
  taxes: "Books · Taxes",
  cutover: "Books · Cutover",
};

type BooksSectionPageProps = {
  section: BooksSection;
  bankAccountId?: string;
  periodId?: string;
  routeParams?: Promise<{ accountId?: string; periodId?: string }>;
};

export function BooksSectionPage(props: BooksSectionPageProps) {
  return (
    <Suspense
      fallback={
        <PageLayout title={TITLES[props.section]} fullBleed>
          <PageLoadingSkeleton />
        </PageLayout>
      }
    >
      <BooksSectionData {...props} />
    </Suspense>
  );
}

async function BooksSectionData({
  section,
  bankAccountId: initialBankAccountId,
  periodId: initialPeriodId,
  routeParams,
}: BooksSectionPageProps) {
  await connection();
  const scopedRoute: NonNullable<BooksSectionPageProps["routeParams"]> =
    routeParams ?? Promise.resolve({});
  const [route, workspace] = await Promise.all([
    scopedRoute,
    getBooksWorkspace(undefined, section, { includeTransactions: false }),
  ]);
  const bankAccountId = route.accountId ?? initialBankAccountId;
  const periodId = route.periodId ?? initialPeriodId;
  if (
    bankAccountId &&
    !workspace.bankAccounts.some((account) => account.id === bankAccountId)
  )
    notFound();
  if (periodId && !workspace.periods.some((period) => period.id === periodId))
    notFound();
  const focusedWorkspace = {
    ...workspace,
    ...(bankAccountId
      ? {
          bankAccounts: workspace.bankAccounts.filter(
            (account) => account.id === bankAccountId,
          ),
          bankTransactions: workspace.bankTransactions.filter(
            (transaction) => transaction.bank_account_id === bankAccountId,
          ),
          unmatchedTransactions: workspace.unmatchedTransactions.filter(
            (transaction) => transaction.bank_account_id === bankAccountId,
          ),
          bankReconciliations: workspace.bankReconciliations.filter(
            (reconciliation) =>
              reconciliation.bank_account_id === bankAccountId,
          ),
        }
      : {}),
    ...(periodId
      ? {
          periods: workspace.periods.filter((period) => period.id === periodId),
          closeItems: workspace.closeItems.filter(
            (item) => item.period_id === periodId,
          ),
        }
      : {}),
  };
  return (
    <PageLayout
      title={TITLES[section]}
      breadcrumbs={
        section === "banking" ||
        section === "ledger" ||
        section === "close" ||
        section === "overhead" ||
        section === "exports" ||
        section === "taxes"
          ? [
              { label: "Books" },
              {
                label:
                  section === "overhead"
                    ? "Company budget"
                    : section === "ledger"
                      ? "General ledger"
                      : section === "close"
                        ? "Close"
                        : section === "exports"
                          ? "Exports"
                          : section === "taxes"
                            ? "Tax filing records"
                            : "Banking",
              },
            ]
          : undefined
      }
      fullBleed
    >
      {workspace.settings.ledger_authority !== "arc" ? (
        <div className="border-b bg-muted/30 px-5 py-3 text-sm">
          Arc Books setup is in progress. Your official ledger has not changed.{" "}
          <Link
            className="font-medium underline underline-offset-4"
            href="/settings/accounting/setup"
          >
            Continue setup
          </Link>
        </div>
      ) : null}
      {section === "overhead" ? (
        <OverheadBudget
          canEdit={workspace.capabilities.adjust}
          initialYear={
            Number(workspace.asOf.slice(0, 4)) -
            (Number(workspace.asOf.slice(5, 7)) <
            (workspace.settings?.fiscal_year_start_month ?? 1)
              ? 1
              : 0)
          }
        />
      ) : section === "close" ? (
        <CloseWorkspace
          periods={workspace.periods}
          checks={workspace.closeItems}
          findings={workspace.reconciliationItems}
          findingTotal={workspace.reconciliationItemTotal}
          capabilities={workspace.capabilities}
          asOf={workspace.asOf}
          periodId={periodId}
        />
      ) : section === "ledger" ? (
        <BooksJournals
          key={`${workspace.orgId}:${workspace.actorId}`}
          scope={{ orgId: workspace.orgId, actorId: workspace.actorId }}
          accounts={workspace.accounts}
          asOf={workspace.asOf}
        />
      ) : (
        <BooksClient
          workspace={focusedWorkspace}
          section={section}
          reconciliationAccountId={bankAccountId}
        />
      )}
    </PageLayout>
  );
}
