import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { PageLayout } from "@/components/layout/page-layout";

export function AccountingSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <PageLayout
      title={title}
      fullBleed
      breadcrumbs={[
        { label: "Accounting", href: "/settings?tab=accounting" },
        { label: title },
      ]}
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <nav
          aria-label="Breadcrumb"
          className="flex shrink-0 items-center gap-2 border-b px-6 py-4 text-sm"
        >
          <Link
            href="/settings?tab=accounting"
            className="text-muted-foreground hover:text-foreground"
          >
            Accounting
          </Link>
          <ChevronRight className="size-3" />
          <h1 className="text-sm font-medium" aria-current="page">
            {title}
          </h1>
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </PageLayout>
  );
}
