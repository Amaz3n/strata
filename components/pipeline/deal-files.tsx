"use client";

import { UnifiedDocumentsLayout } from "@/components/documents";
import type { DocumentsView } from "@/lib/services/files";
import { useDealRoom } from "./deal-room";

/**
 * The deal's files, filed in its pricing project but read as the deal's: the
 * header reads Pipeline › deal › Files › folders, and nothing links out to the
 * project. A fixed-height panel, since the explorer scrolls inside itself.
 */
export function DealFiles({ projectId, path, view }: { projectId: string; path: string | undefined; view: DocumentsView }) {
  const { deal } = useDealRoom();
  const folders = view.childFolders ?? [];
  return (
    <div className="flex h-[calc(100dvh-16rem)] min-h-[32rem] flex-col border bg-card shadow-xs">
      <UnifiedDocumentsLayout
        preconstruction
        project={{ id: projectId, name: deal.name }}
        deal={{ id: deal.id, name: deal.name }}
        initialFiles={view.files}
        initialTotalCount={view.totalCount}
        initialHasMore={view.hasMore}
        initialCounts={view.counts ?? {}}
        initialFolders={folders.map((folder) => folder.path)}
        initialFolderCounts={Object.fromEntries(folders.map((folder) => [folder.path, folder.itemCount]))}
        initialFolderPermissions={view.folderPermissions ?? []}
        initialPath={path}
      />
    </div>
  );
}
