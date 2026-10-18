import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { PageLayout } from "@/components/layout/page-layout";
import { DealWorkbench } from "@/components/pipeline/deal-workbench";
import { DealSkeleton } from "@/components/pipeline/pipeline-skeletons";
import { getDealWorkbench } from "@/lib/services/precon-deals";

type Props = {
  params: Promise<{ dealId: string }>;
  searchParams: Promise<{ row?: string }>;
};

// A fabricated deal id cannot pass authorization; validate with real ids in dev.
export const instant = {
  unstable_disableBuildValidation: true,
};

async function Deal({ params, searchParams }: Props) {
  await connection();
  const [{ dealId }, query] = await Promise.all([params, searchParams]);
  const data = await getDealWorkbench(dealId);
  if (!data) notFound();
  return (
    <PageLayout
      fullBleed
      title={data.deal.name}
      breadcrumbs={[{ label: "Pipeline", href: "/pipeline" }, { label: data.deal.name }]}
    >
      <DealWorkbench
        // Starting pricing turns notes into a saved worksheet; remount so the
        // worksheet state starts from the saved version instead of an unsaved empty one.
        key={`${dealId}:${data.workspace.worksheet ? "pricing" : "notes"}`}
        {...data}
        focusRow={query.row ?? null}
        now={new Date().toISOString()}
      />
    </PageLayout>
  );
}

export default function DealPage(props: Props) {
  return (
    <Suspense fallback={<DealSkeleton />}>
      <Deal {...props} />
    </Suspense>
  );
}
