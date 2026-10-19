import type { FileWithUrls } from "@/app/(app)/documents/types"

const isPlanSet = (file: FileWithUrls) =>
  file.source_contexts?.find((source) => source.type === "drawing_set" || source.type === "drawing_sheet")

/**
 * Where a PDF goes to become plans. A deal's files feed the deal's Plans tab;
 * a project's open its drawings, at the set when the file already is one.
 */
export function plansLink(file: FileWithUrls, dealId: string | null) {
  const set = isPlanSet(file)
  if (dealId)
    return set
      ? { href: `/pipeline/${dealId}/plans`, label: "Open in Plans" }
      : { href: `/pipeline/${dealId}/plans?sourceFile=${file.id}`, label: "Use as the plans" }
  return { href: set?.href ?? `/projects/${file.project_id}/drawings?sourceFile=${file.id}`, label: "Open in Plans & takeoff" }
}
