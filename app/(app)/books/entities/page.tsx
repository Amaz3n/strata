import { connection } from "next/server";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { PageLayout } from "@/components/layout/page-layout";
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton";
import { BooksEntityReview } from "@/components/books/entity-review";
import { getBooksUiAccess } from "@/lib/services/books/ui-access";
import { listBooksLegalEntitySetup } from "@/lib/services/books/legal-entities";
import { requireBooksWorkspaceEnabled } from "@/lib/services/books/module";
async function Content() {
  await connection();
  const [access, c] = await Promise.all([
    getBooksUiAccess(),
    requireBooksWorkspaceEnabled(),
  ]);
  if (!access.read) notFound();
  const setup = await listBooksLegalEntitySetup();
  return (
    <PageLayout
      title="Legal entities"
      breadcrumbs={[{ label: "Books" }, { label: "Legal entities" }]}
    >
      <BooksEntityReview
        key={`${setup.orgId}:${c.userId}`}
        initial={setup}
        actorId={c.userId}
        canManage={access.manage}
        today={new Date().toISOString().slice(0, 10)}
      />
    </PageLayout>
  );
}
export default function Page() {
  return (
    <Suspense
      fallback={
        <PageLayout title="Legal entities">
          <PageLoadingSkeleton />
        </PageLayout>
      }
    >
      <Content />
    </Suspense>
  );
}
