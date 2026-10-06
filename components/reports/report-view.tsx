import { listSavedReportConfigs } from "@/lib/services/report-configs";
import { ReportWorkspace } from "@/components/reports/report-workspace";
import { reportFingerprint } from "@/app/(app)/reports/actions";
import { getAmbientDeskContext } from "@/lib/services/desk-context";
import type {
  ReportDefinition,
  ReportParams,
  ReportResult,
  ReportScopeContext,
} from "@/lib/reports/types";
import type { ReportRunDTO } from "@/lib/services/report-runs";

export async function ReportView({
  definition,
  context,
  params,
  result,
  snapshot,
  saved,
}: {
  definition: ReportDefinition;
  context: ReportScopeContext;
  params: ReportParams;
  result: ReportResult;
  snapshot?: ReportRunDTO;
  saved?: { id: string; name: string; owned: boolean };
}) {
  const [ambient, configs, fingerprint] = await Promise.all([
    getAmbientDeskContext(),
    definition.slug === "report-packet" && !snapshot ? listSavedReportConfigs() : Promise.resolve([]),
    reportFingerprint(result),
  ]);
  const packetReports = configs
    .filter((r) => r.slug !== "report-packet")
    .map((r) => ({ id: r.id, name: r.name }));
  return (
    <ReportWorkspace
      key={JSON.stringify([
        context.scope, context.projectId, context.divisionId, context.communityId,
        saved?.id ?? definition.slug, snapshot?.id ?? "live", params,
      ])}
      definition={{
        slug: definition.slug,
        title: definition.title,
        summary: definition.summary,
        params: definition.params,
        ambientScope: definition.ambientScope,
      }}
      context={context}
      params={params}
      base={result}
      fingerprint={fingerprint}
      snapshot={snapshot}
      saved={saved}
      packetReports={packetReports}
      lenses={{
        divisions: ambient.divisions.map((d) => ({ id: d.id, name: d.name })),
        communities: ambient.communities.map((c) => ({
          id: c.id,
          name: c.name,
        })),
      }}
    />
  );
}
