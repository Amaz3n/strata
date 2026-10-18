import type { ReconstructionIssue } from "./building-reconstruction";

const groupable = new Set([
  "competing-wall-body",
  "wall-pair-small-span",
  "source-pair-continuation",
]);
export const SOURCE_REVIEW_GROUP_SIZE = 128;

/** Group repetitive inference diagnostics by their exact source set, not by
 * proximity or presumed architectural role. Preserve every original identity,
 * message and location. Errors, object-specific issues and missing provenance
 * remain individual; grouping does not resolve or lower their severity. */
export function groupSourceAssemblyReviews(
  issues: readonly ReconstructionIssue[],
): ReconstructionIssue[] {
  const groups = new Map<string, ReconstructionIssue[]>();
  const keys = issues.map((issue) => {
    if (
      issue.severity !== "review" ||
      issue.objectId ||
      issue.members?.length ||
      !issue.pathIds.length ||
      !groupable.has(issue.code)
    )
      return null;
    const ids = [...new Set(issue.pathIds)].sort((a, b) => a - b);
    const key = `${issue.code}:${ids.join(",")}`;
    const group = groups.get(key);
    if (group) group.push(issue);
    else groups.set(key, [issue]);
    return key;
  });
  const emitted = new Set<string>();
  return issues.flatMap((issue, index) => {
    const key = keys[index];
    if (!key) return [issue];
    if (emitted.has(key)) return [];
    emitted.add(key);
    const group = groups.get(key)!;
    if (group.length === 1) return [issue];
    const sorted = [...group].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const result: ReconstructionIssue[] = [];
    for (
      let start = 0;
      start < sorted.length;
      start += SOURCE_REVIEW_GROUP_SIZE
    ) {
      const chunk = sorted.slice(start, start + SOURCE_REVIEW_GROUP_SIZE);
      if (chunk.length === 1) {
        result.push(chunk[0]);
        continue;
      }
      result.push({
        ...chunk[0],
        id: `source-review:${key}:${start / SOURCE_REVIEW_GROUP_SIZE}`,
        pathIds: [...new Set(chunk[0].pathIds)].sort((a, b) => a - b),
        point: chunk.find((member) => member.point)?.point,
        message: `${chunk.length} related source intervals require review. ${chunk[0].message}`,
        members: chunk.map(({ id, message, point }) => ({
          id,
          message,
          ...(point ? { point } : {}),
        })),
      });
    }
    return result;
  });
}
