import type { BuildingReconstruction } from "./building-reconstruction";
import {
  containsPoint,
  areasOverlap,
  prepareAreaInterpretation,
  type AreaDetection,
  type AreaInput,
  type AreaProposal,
  type AreaBoundary,
  type AreaInterpretationContext,
} from "./area-takeoff";
import { areaRoomLabel, areaTextRuns } from "./area-labels";
import {
  interpretArchitecturalElements,
  type ArchitecturalElement,
} from "./area-semantics";
import type { AreaConflict } from "./area-candidates";

export interface AreaBoundaryAssessment {
  supportedFraction: number;
  /** Geometric assembly provenance, never a correctness probability/CAD role. */
  inferredFraction?: number;
  visualFraction: number;
  unknownPathIds: number[];
  conflictedPathIds: number[];
  /** Deliberately no numeric confidence: not calibrated against held-out truth. */
  status: "source-supported" | "needs-review";
}
export interface AreaArchitecture {
  building?: BuildingReconstruction;
  version: 1;
  elements: ArchitecturalElement[];
  openings: Array<{ id: string; boundary: AreaBoundary; spaceIds: string[] }>;
  spaces: Array<{
    id: string;
    proposalId: string;
    areaSqft: number;
    points: AreaProposal["points"];
    holes: AreaProposal["holes"];
    labels: string[];
    boundary: AreaBoundaryAssessment;
    sourceBoundaries: AreaBoundary[];
  }>;
  finishZones: Array<{
    id: string;
    spaceIds: string[];
    proposalId: string;
    policy: string;
    areaSqft: number;
    scope: "needs-review";
    reasons: string[];
  }>;
  conflicts: AreaConflict[];
  spacePolicy: "drawn-enclosures" | "include-fixtures";
  qualification: "unqualified";
}

export function assessAreaBoundary(
  area: AreaProposal,
  input: Omit<AreaInput, "region">,
  elements: ArchitecturalElement[],
  inferredStructure?:ReadonlySet<number>,
): AreaBoundaryAssessment {
  const byId = new Map(elements.map((e) => [e.pathId, e]));
  let total = 0,
    supported = 0,
    visual = 0, inferred = 0;
  const unknown = new Set<number>(),
    conflicts = new Set<number>();
  for (const edge of area.boundary) {
    const length = Math.hypot(
      (edge.b[0] - edge.a[0]) * input.imageWidth,
      (edge.b[1] - edge.a[1]) * input.imageHeight,
    );
    total += length;
    const element =
      edge.pathId === undefined ? undefined : byId.get(edge.pathId);
    if (
      edge.source !== "drawn" ||
      (element &&
        ["wall", "column", "window"].includes(element.kind) &&
        !element.conflict)
    )
      supported += length;
    else if(edge.pathId!==undefined&&inferredStructure?.has(edge.pathId)&&!element?.conflict)inferred+=length;
    if (element?.basis === "visual" || edge.observationId || edge.source === "window") visual += length;
    if (element?.conflict) conflicts.add(element.pathId);
    if (
      edge.source === "drawn" &&
      (!element || element.kind === "unknown") &&
      edge.pathId !== undefined
    )
      unknown.add(edge.pathId);
  }
  const supportedFraction = total ? supported / total : 0,
    visualFraction = total ? visual / total : 0;
  return {
    supportedFraction,
    inferredFraction:total?inferred/total:0,
    visualFraction,
    unknownPathIds: [...unknown].sort((a, b) => a - b),
    conflictedPathIds: [...conflicts].sort((a, b) => a - b),
    status:
      supportedFraction >= 0.98 && !visual && !conflicts.size
        ? "source-supported"
        : "needs-review",
  };
}

/** Shared physical evidence and finish quantities are distinct records. A space
 * reconstructed from fixture-limited linework stays provisional; this model
 * does not relabel it as a verified architectural room. */
export function attachAreaArchitecture(
  result: AreaDetection,
  input: Omit<AreaInput, "region">,
  conflicts: AreaConflict[] = [],
  physicalProposals?: AreaProposal[],
  sourceInterpretation?:AreaInterpretationContext,
): AreaDetection {
  const elements = interpretArchitecturalElements(input.evidence, input.visualObservations, {sx:input.imageWidth*input.feetPerImagePx,sy:input.imageHeight*input.feetPerImagePx});
  const runs = areaTextRuns(input.textRuns);
  const interpretation=sourceInterpretation??((physicalProposals??result.proposals).length?prepareAreaInterpretation(input):undefined),inferred=new Set([...(interpretation?.inferredStructure??[]),...(interpretation?.leafDoors?.doors.flatMap(d=>d.framePathIds)??[])]);
  const openings = new Map<string, AreaArchitecture["openings"][number]>();
  for(const boundary of result.openingEvidence??[]){
    const key=[boundary.a,boundary.b].map(p=>p.map(n=>n.toFixed(7)).join(",")).sort().join("|");
    openings.set(key,{id:`opening:${key}`,boundary,spaceIds:[]});
  }
  const spaces = (physicalProposals ?? result.proposals).map((area) => {
    const id = `space:${area.id}`;
    for (const boundary of area.boundary.filter(
      (b) => b.source === "doorway",
    )) {
      const key = [boundary.a, boundary.b]
        .map((p) => p.map((n) => n.toFixed(7)).join(","))
        .sort()
        .join("|");
      const opening = openings.get(key) ?? {
        id: `opening:${key}`,
        boundary,
        spaceIds: [],
      };
      opening.spaceIds.push(id);
      openings.set(key, opening);
    }
    return {
      id,
      proposalId: area.id,
      areaSqft: area.areaSqft,
      points: area.points,
      holes: area.holes,
      labels: runs
        .filter(
          (r) =>
            areaRoomLabel(r.text) &&
            containsPoint([r.x + r.w / 2, r.y + r.h / 2], area.points) &&
            !area.holes.some((h) =>
              containsPoint([r.x + r.w / 2, r.y + r.h / 2], h),
            ),
        )
        .map((r) => areaRoomLabel(r.text)!),
      boundary: assessAreaBoundary(area, input, elements,inferred),
      sourceBoundaries: area.boundary,
    };
  });
  const finishZones = result.proposals.map((area) => {
    const related = spaces.filter((space) => areasOverlap(space, area));
    const reasons = [
      "Finish material and scope have not been independently verified.",
    ];
    if (related.some((space) => space.labels.length > 1))
      reasons.push(
        "Multiple labels share this enclosure; confirm any finish transitions or missing partitions.",
      );
    if (area.holes.length || area.warnings.some((w) => /fixture/i.test(w)))
      reasons.push(
        "Confirm fixture footprints and deductions for this finish.",
      );
    if (related.some((space) => space.boundary.visualFraction > 0))
      reasons.push(
        "Visual interpretation supplied boundary classifications; inspect those edges.",
      );
    if (related.some((space) => space.boundary.conflictedPathIds.length))
      reasons.push(
        "Drawing and visual interpretations disagree at this boundary.",
      );
    if (!related.length)
      reasons.push(
        "No physical space was reconstructed for this finish outline.",
      );
    return {
      id: `finish:${area.id}`,
      spaceIds: related.map((space) => space.id),
      proposalId: area.id,
      policy: area.finishPolicy ?? "drawn",
      areaSqft: area.areaSqft,
      scope: "needs-review" as const,
      reasons,
    };
  });
  return {
    ...result,
    architecture: {
      version: 1,
      elements,
      openings: [...openings.values()],
      spaces,
      finishZones,
      conflicts:conflicts.length?conflicts:result.boundaryConflicts??[],
      spacePolicy: physicalProposals ? "include-fixtures" : "drawn-enclosures",
      qualification: "unqualified",
    },
  };
}
