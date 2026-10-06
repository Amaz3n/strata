import { Suspense } from "react";
import { connection } from "next/server";
import { PageLayout } from "@/components/layout/page-layout";
import { getBusinessProfile } from "@/lib/services/business-profile";

async function PipelineTitle() {
  await connection();
  const profile = await getBusinessProfile();
  return <PageLayout title={profile.kind === "trade" ? "Opportunities" : "Pipeline"} fullBleed />;
}

export default function PipelinePage() {
  return (
    <>
      <Suspense fallback={null}>
        <PipelineTitle />
      </Suspense>
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <p className="text-sm font-medium">Open a deal to work on it</p>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Deals waiting on you are at the top, oldest first. Each one says what to do next.
          </p>
        </div>
      </div>
    </>
  );
}
