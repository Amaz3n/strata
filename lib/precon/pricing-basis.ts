export type PricingFileReference = {
  id: string;
  version_id: string | null;
  name: string;
};
export type PricingDrawingReference = {
  id: string;
  drawing_set_id: string;
  revision_label: string;
};
export type PricingSources = {
  files: PricingFileReference[] | null;
  drawings: PricingDrawingReference[] | null;
};

/** Compare saved references without changing the scope of any issued document. */
export function pricingBasisChanges(
  saved: {
    governing_documents?: PricingFileReference[];
    drawing_revisions?: PricingDrawingReference[];
    brief_version?: number;
  },
  current: PricingSources,
  briefVersion: number,
): string[] {
  const changes: string[] = [];
  if (saved.brief_version != null && saved.brief_version < briefVersion)
    changes.push(
      `Pricing basis changed (version ${saved.brief_version} → ${briefVersion}). Review scope and assumptions.`,
    );
  if (current.files)
    for (const file of saved.governing_documents ?? []) {
      const latest = current.files.find((item) => item.id === file.id);
      if (!latest)
        changes.push(`${file.name}: referenced file is unavailable.`);
      else if (latest.version_id !== file.version_id)
        changes.push(`${file.name}: a different file version is current.`);
    }
  if (current.drawings && saved.drawing_revisions) {
    for (const revision of current.drawings) {
      const previous = saved.drawing_revisions.find(
        (item) => item.drawing_set_id === revision.drawing_set_id,
      );
      if (!previous)
        changes.push(`New drawing issuance: ${revision.revision_label}.`);
      else if (previous.id !== revision.id)
        changes.push(
          `Drawings changed: ${previous.revision_label} → ${revision.revision_label}.`,
        );
    }
    for (const previous of saved.drawing_revisions)
      if (
        !current.drawings.some(
          (item) => item.drawing_set_id === previous.drawing_set_id,
        )
      )
        changes.push(
          `Drawing reference unavailable: ${previous.revision_label}.`,
        );
  }
  return changes;
}
