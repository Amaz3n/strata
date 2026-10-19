"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePageTitle } from "@/components/layout/page-title-context";
import { FileDropOverlay } from "@/components/files/file-drop-overlay";
import { FileViewer, preloadPdfViewer } from "@/components/files/file-viewer";
import { downloadFilesAsZip, downloadUrlToFile } from "@/components/files/download";
import { useIsMobile } from "@/hooks/use-mobile";
import { DocumentsProvider, useDocuments } from "./documents-context";
import {
  DRAG_OVERLAY_STYLE,
  DocumentsDragProvider,
  FileDragChip,
  FolderDropDock,
  IDLE_DOCUMENTS_DRAG,
  documentsCollisionDetection,
  documentsDragAnnouncements,
  documentsDragInstructions,
  folderLabel,
  followPointerModifier,
  normalizeDropPath,
  parseDocumentsDropId,
  readFileDragPayload,
  type DocumentsDragState,
  type FileDragPayload,
} from "./documents-dnd";
import { DocumentsExplorer } from "./documents-explorer";
import { DocumentsToolbar } from "./documents-toolbar";
import { DocumentsContent } from "./documents-content";
import { DocumentsMobileLayout } from "./documents-mobile-layout";
import { FilePropertiesPanel } from "./file-properties-panel";
import { UploadDialog } from "./upload-dialog";
import { CreateFolderDialog } from "./dialogs/create-folder-dialog";
import { DeleteFilesDialog } from "./dialogs/delete-files-dialog";
import { FileShareDialog } from "./dialogs/file-share-dialog";
import { mapVersion, type FileVersionInfo } from "./dialogs/file-versions";
import { FolderDeleteDialog } from "./dialogs/folder-delete-dialog";
import { normalizeFolderPath } from "./dialogs/folder-path";
import { FolderRenameDialog } from "./dialogs/folder-rename-dialog";
import { FolderShareDialog, type FolderShareTarget } from "./dialogs/folder-share-dialog";
import { MoveFilesDialog } from "./dialogs/move-files-dialog";
import { RenameFileDialog } from "./dialogs/rename-file-dialog";
import { VersionUploadDialog } from "./dialogs/version-upload-dialog";
import type { EnvelopeWizardSourceEntity } from "@/components/esign/envelope-wizard";
import type { UnifiedDocumentsLayoutProps } from "./types";
import { isBrowserRenderableImage, isWordPreviewable, type FileWithDetails } from "@/components/files/types";
import {
  getFileAction,
  getFileDownloadUrlAction,
  listFileVersionsAction,
  bulkRestoreFilesAction,
  undoDocumentMutationAction,
  makeVersionCurrentAction,
  updateFileVersionAction,
  deleteFileVersionAction,
  getVersionDownloadUrlAction,
  bulkMoveFilesAction,
  listFileTimelineAction,
} from "@/app/(app)/documents/actions";
import type {
  FileWithUrls,
  FileTimelineEvent,
} from "@/app/(app)/documents/types";
import { useDocumentTransfers } from "./transfer-provider";

import { unwrapAction } from "@/lib/action-result"

const EnvelopeWizard = dynamic(
  () => import("@/components/esign/envelope-wizard").then((module) => module.EnvelopeWizard),
  { ssr: false },
);

const EXPLORER_OPEN_STORAGE_KEY = "documents-explorer-open";

const DRAG_OVERLAY_MODIFIERS = [followPointerModifier];

export function UnifiedDocumentsLayout(props: UnifiedDocumentsLayoutProps) {
  return (
    <DocumentsProvider
      project={props.project}
      dealId={props.deal?.id ?? null}
      initialFiles={props.initialFiles}
      initialTotalCount={props.initialTotalCount}
      initialHasMore={props.initialHasMore}
      initialCounts={props.initialCounts}
      initialFolders={props.initialFolders}
      initialFolderCounts={props.initialFolderCounts}
      initialFolderPermissions={props.initialFolderPermissions}
      initialPath={props.initialPath}
    >
      <UnifiedDocumentsLayoutInner preconstruction={props.preconstruction} deal={props.deal} />
    </DocumentsProvider>
  );
}

function UnifiedDocumentsLayoutInner({ preconstruction = false, deal }: Pick<UnifiedDocumentsLayoutProps, "preconstruction" | "deal">) {
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();
  const {
    projectId,
    projectName,
    files,
    folders,
    folderPermissions,
    currentPath,
    setCurrentPath,
    refreshFiles,
    beginOptimisticMove,
  } = useDocuments();
  // A deal's files stay on the deal; the organization library has no project to link back to.
  const projectBase = projectId ? `/projects/${projectId}` : undefined;
  const documentsBase = deal ? `/pipeline/${deal.id}/files` : projectBase ? `${projectBase}/documents` : "/documents";
  const transfers = useDocumentTransfers();
  const { setBreadcrumbs } = usePageTitle();
  const requestedFileId = searchParams.get("fileId");
  const highlightedFileId = searchParams.get("highlight");

  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);

  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [versionDialogOpen, setVersionDialogOpen] = useState(false);
  const [versionTargetFile, setVersionTargetFile] = useState<FileWithUrls | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerFile, setViewerFile] = useState<FileWithDetails | null>(null);
  const [versionsByFile, setVersionsByFile] = useState<
    Record<string, FileVersionInfo[]>
  >({});
  const lastNotifiedViewerFileIdRef = useRef<string | null>(null);

  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedFolderPaths, setSelectedFolderPaths] = useState<Set<string>>(
    new Set(),
  );
  const [propertiesFileId, setPropertiesFileId] = useState<string | null>(null);
  const [isDownloadingSelected, setIsDownloadingSelected] = useState(false);
  const [isDirectUploading, setIsDirectUploading] = useState(false);

  const [activeDrag, setActiveDrag] = useState<{
    payload: FileDragPayload;
    originPaths: string[];
  } | null>(null);
  const [overFolderPath, setOverFolderPath] = useState<string | null>(null);

  const dragSensors = useSensors(
    // 4px of travel before the drag arms: below that the gesture is still a
    // click, which is what keeps row clicks, checkboxes and the row menu working.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  const [createFolderDialogOpen, setCreateFolderDialogOpen] = useState(false);
  const [createFolderInitialPath, setCreateFolderInitialPath] = useState("");

  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameTargetFile, setRenameTargetFile] = useState<FileWithUrls | null>(null);

  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareTargetFile, setShareTargetFile] = useState<FileWithUrls | null>(null);

  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [moveFileIds, setMoveFileIds] = useState<string[]>([]);
  const [isMoving, setIsMoving] = useState(false);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteFileIds, setDeleteFileIds] = useState<string[]>([]);

  const [folderRenameOpen, setFolderRenameOpen] = useState(false);
  const [folderRenamePath, setFolderRenamePath] = useState("");

  const [folderDeleteOpen, setFolderDeleteOpen] = useState(false);
  const [folderDeletePath, setFolderDeletePath] = useState("");

  const [folderShareOpen, setFolderShareOpen] = useState(false);
  const [folderShareTarget, setFolderShareTarget] = useState<FolderShareTarget | null>(null);

  const [propertiesTimelineEvents, setPropertiesTimelineEvents] = useState<FileTimelineEvent[]>([]);
  const [propertiesTimelineLoading, setPropertiesTimelineLoading] = useState(false);

  const [esignOpen, setEsignOpen] = useState(false);
  const [esignFile, setEsignFile] = useState<FileWithUrls | null>(null);
  const [esignSource, setEsignSource] = useState<EnvelopeWizardSourceEntity | null>(null);

  const handledQueryRef = useRef("");
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [explorerRestored, setExplorerRestored] = useState(false);

  useEffect(() => {
    setSelectedFileIds(new Set());
    setSelectedFolderPaths(new Set());
  }, [currentPath]);

  useEffect(() => {
    if (!viewerOpen) {
      lastNotifiedViewerFileIdRef.current = null;
    }
  }, [viewerOpen]);

  // The stored preference can only be read after mount, so the panel starts closed.
  // Suppress the width transition until it has been restored, otherwise users who
  // keep the explorer open watch it slide in on every load.
  useEffect(() => {
    if (window.localStorage.getItem(EXPLORER_OPEN_STORAGE_KEY) === "true") {
      setExplorerOpen(true);
    }
    setExplorerRestored(true);
  }, []);

  useEffect(() => {
    if (!explorerRestored) return;
    window.localStorage.setItem(
      EXPLORER_OPEN_STORAGE_KEY,
      explorerOpen ? "true" : "false",
    );
  }, [explorerOpen, explorerRestored]);

  const loadVersionsForFile = useCallback(async (fileId: string) => {
    const versions = await listFileVersionsAction(fileId);
    setVersionsByFile((prev) => ({
      ...prev,
      [fileId]: versions.map(mapVersion),
    }));
  }, []);

  useEffect(() => {
    if (!viewerFile) return;
    const latest = files.find(file => file.id === viewerFile.id);
    if (!latest || latest.storage_path === viewerFile.storage_path) return;
    setViewerFile(latest);
    void loadVersionsForFile(latest.id).catch(() => toast.error("Could not refresh version history"));
  }, [files, viewerFile, loadVersionsForFile]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    // Only OS files ever reach the native drag API now — internal moves run
    // through dnd-kit, which never fires a dragenter.
    if (e.dataTransfer.items?.length) {
      setIsDraggingOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const uploadDroppedFiles = useCallback(
    async (droppedFiles: File[], targetPath: string | null) => {
      if (!droppedFiles.length) return;
      setIsDirectUploading(true);
      try {
        const results = await Promise.allSettled(droppedFiles.map(file => transfers.enqueue(file, {
          projectId, folderPath: targetPath ? normalizeFolderPath(targetPath) : "/",
        })));
        const succeeded = results.filter(result => result.status === "fulfilled").length;
        if (succeeded) toast.success(`${succeeded} file${succeeded === 1 ? "" : "s"} uploaded`);
        if (succeeded !== results.length) toast.error("Some uploads need attention. Open Transfers to retry.");
      } finally { setIsDirectUploading(false); }
    }, [projectId, transfers],
  );

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ projectId: string | undefined }>).detail.projectId !== projectId) return;
      clearTimeout(timeout);
      timeout = setTimeout(() => { void refreshFiles({ invalidateCache: true }); }, 250);
    };
    window.addEventListener("arc:documents-changed", changed);
    return () => { clearTimeout(timeout); window.removeEventListener("arc:documents-changed", changed); };
  }, [projectId, refreshFiles]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDraggingOver(false);
      dragCounterRef.current = 0;

      const droppedFiles = Array.from(e.dataTransfer.files);
      if (droppedFiles.length > 0) {
        void uploadDroppedFiles(droppedFiles, currentPath || null);
      }
    },
    [currentPath, uploadDroppedFiles],
  );

  const handleFileClick = useCallback(
    async (fileId: string) => {
      const file = files.find((f) => f.id === fileId);
      if (!file) return;

      const initialDownloadUrl = file.download_url ?? undefined;
      const initialFile: FileWithDetails = {
        ...file,
        category: file.category,
        download_url: initialDownloadUrl,
        thumbnail_url:
          file.thumbnail_url ??
          (isBrowserRenderableImage(file.mime_type, file.file_name, Boolean(file.thumbnail_url))
            ? initialDownloadUrl
            : undefined),
      };

      setViewerFile(initialFile);
      setViewerOpen(true);

      try {
        const downloadUrl = unwrapAction(await getFileDownloadUrlAction(fileId));
        setViewerFile((prev) => {
          if (!prev || prev.id !== fileId) return prev;
          return {
            ...prev,
            download_url: downloadUrl,
            thumbnail_url:
              isBrowserRenderableImage(prev.mime_type, prev.file_name)
                ? downloadUrl
                : prev.thumbnail_url,
          };
        });

        await loadVersionsForFile(fileId);
      } catch (error) {
        console.error("Failed to open file:", error);
        toast.error("Failed to open file");
      }
    },
    [files, loadVersionsForFile],
  );

  const resolveFileForDeepLink = useCallback(
    async (fileId: string): Promise<FileWithUrls | null> => {
      const existing = files.find((file) => file.id === fileId);
      if (existing) return existing;
      return await getFileAction(fileId);
    },
    [files],
  );

  const openPreviewFromDeepLink = useCallback(
    async (fileId: string) => {
      if (files.some((file) => file.id === fileId)) {
        await handleFileClick(fileId);
        return;
      }

      const file = await resolveFileForDeepLink(fileId);
      if (!file) return;

      const [downloadUrl, versions] = await Promise.all([
        getFileDownloadUrlAction(file.id).then(unwrapAction),
        listFileVersionsAction(file.id),
      ]);

      setViewerFile({
        ...file,
        download_url: downloadUrl,
        thumbnail_url: isBrowserRenderableImage(file.mime_type, file.file_name)
          ? downloadUrl
          : undefined,
      });
      setViewerOpen(true);
      setVersionsByFile((prev) => ({
        ...prev,
        [file.id]: versions.map(mapVersion),
      }));
    },
    [files, handleFileClick, resolveFileForDeepLink],
  );

  const focusFileFromDeepLink = useCallback(
    async (fileId: string) => {
      const file = await resolveFileForDeepLink(fileId);
      if (!file) return;

      setCurrentPath(file.folder_path ?? "");
      setPropertiesFileId(file.id);
    },
    [resolveFileForDeepLink, setCurrentPath],
  );

  useEffect(() => {
    const queryKey = `${requestedFileId ?? ""}|${highlightedFileId ?? ""}`;
    if (queryKey === "|") {
      handledQueryRef.current = "";
      return;
    }
    if (handledQueryRef.current === queryKey) {
      return;
    }

    handledQueryRef.current = queryKey;

    const run = async () => {
      try {
        if (requestedFileId) {
          await openPreviewFromDeepLink(requestedFileId);
          return;
        }

        if (highlightedFileId) {
          await focusFileFromDeepLink(highlightedFileId);
        }
      } catch (error) {
        console.error("Failed to resolve documents deep link:", error);
      }
    };

    void run();
  }, [
    requestedFileId,
    highlightedFileId,
    openPreviewFromDeepLink,
    focusFileFromDeepLink,
  ]);

  const handleFolderClick = useCallback(
    (path: string) => {
      setCurrentPath(path);
    },
    [setCurrentPath],
  );

  const handleUploadClick = useCallback(() => {
    setUploadFiles([]);
    setUploadDialogOpen(true);
  }, []);

  const openVersionUploadDialog = useCallback(
    (fileId: string) => {
      const file = files.find((item) => item.id === fileId);
      if (!file) return;
      setVersionTargetFile(file);
      setVersionDialogOpen(true);
    },
    [files],
  );

  const handleFileSelectionChange = useCallback(
    (fileId: string, selected: boolean) => {
      setSelectedFolderPaths(new Set());
      setSelectedFileIds((prev) => {
        const next = new Set(prev);
        if (selected) {
          next.add(fileId);
        } else {
          next.delete(fileId);
        }
        return next;
      });
    },
    [],
  );

  const handleFolderSelectionChange = useCallback(
    (path: string, selected: boolean) => {
      setSelectedFileIds(new Set());
      setSelectedFolderPaths((prev) => {
        const next = new Set<string>();
        if (selected) {
          next.add(path);
        }
        return next;
      });
    },
    [],
  );

  const handleSelectAllVisibleFiles = useCallback(
    (fileIds: string[], selected: boolean) => {
      setSelectedFolderPaths(new Set());
      setSelectedFileIds((prev) => {
        const next = new Set(prev);
        for (const id of fileIds) {
          if (selected) {
            next.add(id);
          } else {
            next.delete(id);
          }
        }
        return next;
      });
    },
    [],
  );

  const openRenameDialog = useCallback(
    (fileId: string) => {
      const file = files.find((item) => item.id === fileId);
      if (!file) return;
      setRenameTargetFile(file);
      setRenameDialogOpen(true);
    },
    [files],
  );

  const openShareDialog = useCallback(
    (fileId: string) => {
      const file = files.find((item) => item.id === fileId);
      if (!file) return;
      setShareTargetFile(file);
      setShareDialogOpen(true);
    },
    [files],
  );

  const openMoveDialog = useCallback(
    (fileId?: string) => {
      setMoveFileIds(fileId ? [fileId] : Array.from(selectedFileIds));
      setMoveDialogOpen(true);
    },
    [selectedFileIds],
  );

  const openDeleteDialog = useCallback(
    (fileId?: string) => {
      if (fileId) {
        setDeleteFileIds([fileId]);
      } else {
        setDeleteFileIds(Array.from(selectedFileIds));
      }
      setDeleteDialogOpen(true);
    },
    [selectedFileIds],
  );

  const undoMutation = useCallback(async (receiptId: string) => {
    try {
      unwrapAction(await undoDocumentMutationAction(receiptId));
      await refreshFiles({ invalidateCache: true });
      toast.success("Change undone");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not undo change"); }
  }, [refreshFiles]);

  const moveFilesToFolder = useCallback(
    async (
      fileIds: string[],
      targetPath: string | null,
      sourceLabel: string,
    ) => {
      if (fileIds.length === 0) return;
      const normalizedTarget = targetPath
        ? normalizeFolderPath(targetPath)
        : null;
      const toastId = toast.loading(
        `Moving ${fileIds.length} file${fileIds.length === 1 ? "" : "s"} to ${sourceLabel}...`,
      );

      setIsMoving(true);
      const settleMove = beginOptimisticMove(fileIds);
      try {
        const result = unwrapAction(await bulkMoveFilesAction(fileIds, normalizedTarget, true));
        toast.success(
          `Moved ${fileIds.length} file${fileIds.length === 1 ? "" : "s"} to ${sourceLabel}`,
          { id: toastId, duration: 10000, action: result.receiptId ? {
            label: "Undo", onClick: () => { void undoMutation(result.receiptId!); },
          } : undefined },
        );
        setSelectedFileIds(new Set());
        await refreshFiles({ invalidateCache: true });
      } catch (error) {
        console.error("Failed to move files:", error);
        toast.error("Failed to move files", { id: toastId });
      } finally {
        settleMove();
        setIsMoving(false);
      }
    },
    [beginOptimisticMove, refreshFiles, undoMutation],
  );

  const handleUploadToFolder = useCallback(
    (targetPath: string, droppedFiles: File[]) => {
      void uploadDroppedFiles(droppedFiles, targetPath);
    },
    [uploadDroppedFiles],
  );

  const folderPathForFile = useCallback(
    (fileId: string) =>
      normalizeDropPath(files.find((file) => file.id === fileId)?.folder_path),
    [files],
  );

  const handleFilesDragStart = useCallback(
    (event: DragStartEvent) => {
      const payload = readFileDragPayload(event.active.data.current);
      if (!payload) return;
      setOverFolderPath(null);
      setActiveDrag({
        payload,
        originPaths: Array.from(new Set(payload.fileIds.map(folderPathForFile))),
      });
    },
    [folderPathForFile],
  );

  const handleFilesDragOver = useCallback((event: DragOverEvent) => {
    const target = event.over ? parseDocumentsDropId(String(event.over.id)) : null;
    setOverFolderPath(target ? target.folderPath : null);
  }, []);

  const handleFilesDragCancel = useCallback(() => {
    setActiveDrag(null);
    setOverFolderPath(null);
  }, []);

  const handleFilesDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDrag(null);
      setOverFolderPath(null);

      const payload = readFileDragPayload(event.active.data.current);
      const target = event.over ? parseDocumentsDropId(String(event.over.id)) : null;
      // Dropped on empty space: the overlay already said so while the pointer
      // was there, so there is nothing left to report.
      if (!payload || !target) return;

      // Files that already live in the target are dropped from the request. If
      // that leaves nothing, the whole drop is a no-op — no toast, no refetch,
      // no server call.
      const movable = payload.fileIds.filter(
        (fileId) => folderPathForFile(fileId) !== target.folderPath,
      );
      if (movable.length === 0) return;

      void moveFilesToFolder(
        movable,
        target.folderPath || null,
        folderLabel(target.folderPath),
      );
    },
    [folderPathForFile, moveFilesToFolder],
  );

  const dragState = useMemo<DocumentsDragState>(
    () =>
      activeDrag
        ? {
            draggedFileIds: activeDrag.payload.fileIds,
            originPaths: activeDrag.originPaths,
            overFolderPath,
          }
        : IDLE_DOCUMENTS_DRAG,
    [activeDrag, overFolderPath],
  );

  const selectedFolderPath = useMemo(
    () => Array.from(selectedFolderPaths)[0] ?? null,
    [selectedFolderPaths],
  );

  const handleRestoreFiles = useCallback(
    async (fileIds: string[]) => {
      const ids = Array.from(new Set(fileIds)).filter(Boolean);
      if (ids.length === 0) return;

      try {
        unwrapAction(await bulkRestoreFilesAction(ids));
        toast.success(`Restored ${ids.length} file${ids.length === 1 ? "" : "s"}`);
        setSelectedFileIds(new Set());
        await refreshFiles({ includeMetadata: true, invalidateCache: true });
      } catch (error) {
        console.error("Failed to restore files:", error);
        toast.error("Failed to restore files");
      }
    },
    [refreshFiles],
  );

  const handleDownloadSelected = useCallback(async () => {
    const ids = Array.from(selectedFileIds);
    if (ids.length === 0) return;

    setIsDownloadingSelected(true);
    try {
      if (ids.length === 1) {
        const file = files.find((row) => row.id === ids[0]);
        if (file) {
          await downloadUrlToFile(`/api/documents/download?fileId=${encodeURIComponent(file.id)}`, file.file_name);
          return;
        }
      }

      await downloadFilesAsZip(ids, `arc-documents-${new Date().toISOString().slice(0, 10)}.zip`);
      toast.success(`Downloading ${ids.length} files as ZIP`);
    } catch (error) {
      console.error("Failed to download selected files:", error);
      toast.error(error instanceof Error ? error.message : "Failed to download selected files");
    } finally {
      setIsDownloadingSelected(false);
    }
  }, [files, selectedFileIds]);

  const uploadVersionForFile = useCallback(
    async (fileId: string, file: File, label?: string, notes?: string) => {
      await transfers.enqueue(file, { projectId, version: { fileId, label, notes } });
      const versions = await listFileVersionsAction(fileId);
      setVersionsByFile((prev) => ({
        ...prev,
        [fileId]: versions.map(mapVersion),
      }));
      await refreshFiles({ invalidateCache: true });
    },
    [projectId, transfers, refreshFiles],
  );

  const handleUploadVersion = useCallback(
    async (file: File, label?: string, notes?: string) => {
      if (!viewerFile) return;
      await uploadVersionForFile(viewerFile.id, file, label, notes);
    },
    [viewerFile, uploadVersionForFile],
  );

  const handleMakeCurrentVersion = useCallback(
    async (versionId: string) => {
      if (!viewerFile) return;
      unwrapAction(await makeVersionCurrentAction(viewerFile.id, versionId));
      const versions = await listFileVersionsAction(viewerFile.id);
      setVersionsByFile((prev) => ({
        ...prev,
        [viewerFile.id]: versions.map(mapVersion),
      }));
      await refreshFiles({ invalidateCache: true });
    },
    [viewerFile, refreshFiles],
  );

  const handleDownloadVersion = useCallback(async (versionId: string) => {
    const url = unwrapAction(await getVersionDownloadUrlAction(versionId));
    await downloadUrlToFile(url);
  }, []);

  const handleUpdateVersion = useCallback(
    async (versionId: string, updates: { label?: string; notes?: string }) => {
      unwrapAction(await updateFileVersionAction(versionId, updates));
      if (viewerFile) {
        const versions = await listFileVersionsAction(viewerFile.id);
        setVersionsByFile((prev) => ({
          ...prev,
          [viewerFile.id]: versions.map(mapVersion),
        }));
      }
    },
    [viewerFile],
  );

  const handleDeleteVersion = useCallback(
    async (versionId: string) => {
      unwrapAction(await deleteFileVersionAction(versionId));
      if (viewerFile) {
        const versions = await listFileVersionsAction(viewerFile.id);
        setVersionsByFile((prev) => ({
          ...prev,
          [viewerFile.id]: versions.map(mapVersion),
        }));
        await refreshFiles({ invalidateCache: true });
      }
    },
    [viewerFile, refreshFiles],
  );

  const handleRenameFolder = useCallback((path: string) => {
    setFolderRenamePath(path);
    setFolderRenameOpen(true);
  }, []);

  const handleDeleteFolder = useCallback((path: string) => {
    setFolderDeletePath(path);
    setFolderDeleteOpen(true);
  }, []);

  const handleShareFolder = useCallback(
    (path: string) => {
      const permissions = folderPermissions.find((entry) => entry.path === path);
      setFolderShareTarget({
        path,
        shareWithClients: permissions?.share_with_clients ?? false,
        shareWithSubs: permissions?.share_with_subs ?? false,
      });
      setFolderShareOpen(true);
    },
    [folderPermissions],
  );

  const handleViewerFileChange = useCallback((file: FileWithDetails) => {
    setViewerFile((prev) => (prev?.id === file.id ? prev : file));
    if (lastNotifiedViewerFileIdRef.current === file.id) {
      return;
    }
    lastNotifiedViewerFileIdRef.current = file.id;
    getFileDownloadUrlAction(file.id).then((result) => {
      const downloadUrl = unwrapAction(result);
      setViewerFile((prev) => {
        if (!prev || prev.id !== file.id) return prev;
        return {
          ...prev,
          download_url: downloadUrl,
          thumbnail_url: isBrowserRenderableImage(prev.mime_type, prev.file_name) ? downloadUrl : prev.thumbnail_url,
        };
      });
    }).catch((error) => {
      console.error("Failed to refresh file download URL:", error);
    });
    listFileVersionsAction(file.id).then((versions) => {
      setVersionsByFile((prev) => ({
        ...prev,
        [file.id]: versions.map(mapVersion),
      }));
    });
  }, []);

  const handleDownload = useCallback(async (file: FileWithDetails) => {
    try {
      await downloadUrlToFile(`/api/documents/download?fileId=${encodeURIComponent(file.id)}`, file.file_name);
      toast.success(`Downloading ${file.file_name}`);
    } catch (error) {
      console.error("Download failed:", error);
      toast.error("Failed to download file");
    }
  }, []);

  const handleDownloadFromProperties = useCallback(
    async (file: FileWithUrls) => {
      await handleDownload(file as FileWithDetails);
    },
    [handleDownload],
  );

  const handleDownloadById = useCallback(
    async (fileId: string) => {
      const file = files.find((item) => item.id === fileId);
      if (!file) {
        toast.error("File not found");
        return;
      }
      await handleDownload(file as FileWithDetails);
    },
    [files, handleDownload],
  );

  const previewableFiles = useMemo(() => {
    return files
      .filter((f) => {
        const mime = f.mime_type ?? "";
        return (
          mime.startsWith("image/") ||
          mime === "application/pdf" ||
          mime.startsWith("video/") ||
          mime.startsWith("audio/") ||
          isWordPreviewable(f.mime_type, f.file_name)
        );
      })
      .map((f) => {
        const selectedViewer = viewerFile?.id === f.id ? viewerFile : null;
        return {
          ...f,
          ...(selectedViewer
            ? {
                download_url: selectedViewer.download_url,
                thumbnail_url: selectedViewer.thumbnail_url,
              }
            : {}),
          category: f.category,
        };
      });
  }, [files, viewerFile]);

  const folderHasPdf = useMemo(
    () => files.some((file) => file.mime_type === "application/pdf"),
    [files],
  );

  // Warm the PDF stack once we know this folder holds one. The first PDF opened
  // otherwise pays for ~1MB of viewer chunk and the worker before it can render
  // anything, which makes it feel much slower than every PDF opened after it.
  // The time someone spends scanning the table is exactly when that is free.
  useEffect(() => {
    if (!folderHasPdf) return;

    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(() => preloadPdfViewer(), { timeout: 3000 });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(preloadPdfViewer, 1500);
    return () => window.clearTimeout(handle);
  }, [folderHasPdf]);

  const propertiesFile = useMemo(() => {
    if (!propertiesFileId) return null;
    return files.find((file) => file.id === propertiesFileId) ?? null;
  }, [files, propertiesFileId]);
  const activeBreadcrumbPath = propertiesFile?.folder_path ?? currentPath;

  useEffect(() => {
    if (propertiesFileId && !propertiesFile) {
      setPropertiesFileId(null);
    }
  }, [propertiesFile, propertiesFileId]);

  const refreshPropertiesTimeline = useCallback(
    async (fileId: string) => {
      setPropertiesTimelineLoading(true);
      try {
        const events = await listFileTimelineAction(fileId);
        setPropertiesTimelineEvents(events);
      } catch (error) {
        console.error("Failed to load properties timeline:", error);
        setPropertiesTimelineEvents([]);
      } finally {
        setPropertiesTimelineLoading(false);
      }
    },
    [],
  );

  const openTimeline = useCallback(
    async (fileId: string) => {
      setPropertiesFileId(fileId);
      await refreshPropertiesTimeline(fileId);
    },
    [refreshPropertiesTimeline],
  );

  useEffect(() => {
    if (!propertiesFile) {
      setPropertiesTimelineEvents([]);
      setPropertiesTimelineLoading(false);
      return;
    }

    void refreshPropertiesTimeline(propertiesFile.id);
    listFileVersionsAction(propertiesFile.id)
      .then((versions) => {
        setVersionsByFile((prev) => ({
          ...prev,
          [propertiesFile.id]: versions.map(mapVersion),
        }));
      })
      .catch((error) => {
        console.error("Failed to load properties version history:", error);
      });
  }, [propertiesFile, refreshPropertiesTimeline]);

  useEffect(() => {
    const breadcrumbs: Array<{ label: string; href?: string; onClick?: () => void }> = [
      ...(deal
        ? [
            { label: "Pipeline", href: "/pipeline" },
            { label: deal.name, href: `/pipeline/${deal.id}` },
          ]
        : projectBase
          ? [{ label: projectName, href: projectBase }]
          : []),
      {
        label: deal ? "Files" : "Documents",
        href: documentsBase,
        onClick: () => {
          setPropertiesFileId(null);
          setCurrentPath("");
        },
      },
    ];

    const segments = activeBreadcrumbPath
      ? activeBreadcrumbPath.split("/").filter(Boolean)
      : [];

    segments.forEach((segment, index) => {
      const path = `/${segments.slice(0, index + 1).join("/")}`;
      breadcrumbs.push({
        label: segment,
        href: `${documentsBase}?path=${encodeURIComponent(path)}`,
        onClick: () => {
          setPropertiesFileId(null);
          setCurrentPath(path);
        },
      });
    });

    if (propertiesFile) {
      breadcrumbs.push({ label: propertiesFile.file_name });
    }

    setBreadcrumbs(breadcrumbs);
  }, [activeBreadcrumbPath, deal, documentsBase, projectBase, projectName, propertiesFile, setBreadcrumbs, setCurrentPath]);

  const handleSendForSignature = useCallback(
    (fileId: string) => {
      const file = files.find((f) => f.id === fileId);
      if (!file) return;

      setEsignFile(file);
      setEsignSource({
        type: "other",
        id: file.id,
        project_id: projectId ?? null,
        title: file.file_name,
        document_type: "other",
      });
      setEsignOpen(true);
    },
    [files, projectId],
  );

  const renderContent = () => {
    return (
      <DocumentsContent
        preconstruction={preconstruction}
          onFileClick={handleFileClick}
          onDownloadFile={handleDownloadById}
          onFolderClick={handleFolderClick}
          onRenameFolder={handleRenameFolder}
          onShareFolder={projectId ? handleShareFolder : undefined}
          onDeleteFolder={handleDeleteFolder}
          onUploadClick={handleUploadClick}
          onUploadToFolder={handleUploadToFolder}
          selectedFileIds={selectedFileIds}
          selectedFolderPaths={selectedFolderPaths}
          onFileSelectionChange={handleFileSelectionChange}
          onFolderSelectionChange={handleFolderSelectionChange}
          onSelectAllVisibleFiles={handleSelectAllVisibleFiles}
        onRenameFile={openRenameDialog}
        onMoveFile={(fileId) => openMoveDialog(fileId)}
        onDeleteFile={(fileId) => openDeleteDialog(fileId)}
        onRestoreFile={(fileId) => handleRestoreFiles([fileId])}
        onViewActivity={openTimeline}
        onShareFile={openShareDialog}
        onUploadNewVersion={openVersionUploadDialog}
        onSendForSignature={handleSendForSignature}
        onOpenProperties={setPropertiesFileId}
      />
    );
  };

  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-background"
      aria-busy={isDirectUploading}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <FileDropOverlay isVisible={isDraggingOver} className="rounded-none" />

      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", preconstruction && "overflow-hidden bg-card")}>

      {isMobile ? (
        <DocumentsMobileLayout
          preconstruction={preconstruction}
          onFileClick={handleFileClick}
          onDownloadFile={handleDownloadById}
          onUploadClick={handleUploadClick}
          onCreateFolderClick={() => {
            setCreateFolderInitialPath(currentPath || "");
            setCreateFolderDialogOpen(true);
          }}
          onRenameFile={openRenameDialog}
          onMoveFile={(fileId) => openMoveDialog(fileId)}
          onDeleteFile={(fileId) => openDeleteDialog(fileId)}
          onRestoreFile={(fileId) => handleRestoreFiles([fileId])}
          onViewActivity={openTimeline}
          onShareFile={openShareDialog}
          onUploadNewVersion={openVersionUploadDialog}
          onSendForSignature={handleSendForSignature}
          onOpenProperties={setPropertiesFileId}
          propertiesFile={propertiesFile}
          onCloseProperties={() => setPropertiesFileId(null)}
          onDownloadFromProperties={handleDownloadFromProperties}
          propertiesVersions={propertiesFile ? (versionsByFile[propertiesFile.id] ?? []) : []}
          onDownloadVersion={handleDownloadVersion}
          propertiesTimelineEvents={propertiesTimelineEvents}
          propertiesTimelineLoading={propertiesTimelineLoading}
          onRefreshTimeline={refreshPropertiesTimeline}
        />
      ) : (
      <DndContext
        id="documents-layout"
        sensors={dragSensors}
        collisionDetection={documentsCollisionDetection}
        accessibility={{
          announcements: documentsDragAnnouncements,
          screenReaderInstructions: documentsDragInstructions,
        }}
        onDragStart={handleFilesDragStart}
        onDragOver={handleFilesDragOver}
        onDragCancel={handleFilesDragCancel}
        onDragEnd={handleFilesDragEnd}
      >
      <DocumentsDragProvider state={dragState}>
      <div className={cn("relative z-20 shrink-0 border-b bg-background px-4 py-3", preconstruction && "bg-card")}>
        <DocumentsToolbar
          preconstruction={preconstruction}
          onUploadClick={handleUploadClick}
          onCreateFolderClick={() => {
            setCreateFolderInitialPath(currentPath || "");
            setCreateFolderDialogOpen(true);
          }}
          selectedCount={selectedFileIds.size}
          selectedFolderCount={selectedFolderPaths.size}
          onDownloadSelected={handleDownloadSelected}
          onMoveSelected={() => openMoveDialog()}
          onDeleteSelected={() => openDeleteDialog()}
          onRestoreSelected={() => handleRestoreFiles(Array.from(selectedFileIds))}
          onClearSelection={() => {
            setSelectedFileIds(new Set());
            setSelectedFolderPaths(new Set());
          }}
          onOpenSelectedFolder={() => {
            if (selectedFolderPath) {
              setCurrentPath(selectedFolderPath);
            }
          }}
          onRenameSelectedFolder={() => {
            if (selectedFolderPath) {
              handleRenameFolder(selectedFolderPath);
            }
          }}
          onShareSelectedFolder={() => {
            if (selectedFolderPath) {
              handleShareFolder(selectedFolderPath);
            }
          }}
          onDeleteSelectedFolder={() => {
            if (selectedFolderPath) {
              handleDeleteFolder(selectedFolderPath);
            }
          }}
          isDownloadingSelected={isDownloadingSelected}
          explorerOpen={explorerOpen && !(preconstruction && propertiesFile)}
          onToggleExplorer={() => {
            if (preconstruction && propertiesFile) {
              setPropertiesFileId(null);
              setExplorerOpen(true);
              return;
            }
            setExplorerOpen((open) => !open);
          }}
        />
      </div>

      <div className="relative z-10 flex min-h-0 min-w-0 flex-1">
        <aside
          className={cn(
            "hidden shrink-0 overflow-hidden border-r bg-background lg:block",
            preconstruction && "bg-muted/15",
            preconstruction && propertiesFile && "lg:hidden",
            explorerRestored && "transition-[width,opacity] duration-200 ease-out",
            explorerOpen ? "w-[280px] opacity-100" : "w-0 border-r-0 opacity-0",
          )}
        >
          <DocumentsExplorer
            className="h-full"
            onRenameFolder={handleRenameFolder}
            onDeleteFolder={handleDeleteFolder}
            onShareFolder={projectId ? handleShareFolder : undefined}
          />
        </aside>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <ScrollArea className="h-full flex-1">
            {renderContent()}
          </ScrollArea>
          <FolderDropDock currentPath={currentPath} />
        </div>
        <aside
          className={`min-h-0 shrink-0 overflow-hidden border-l bg-background transition-[width,opacity] duration-200 ease-out ${
            propertiesFile ? "w-[380px] opacity-100" : "w-0 border-l-0 opacity-0"
          }`}
        >
          <div className="h-full w-[380px]">
            <FilePropertiesPanel
              file={propertiesFile}
              onClose={() => setPropertiesFileId(null)}
              onPreview={handleFileClick}
              onDownload={handleDownloadFromProperties}
              onRename={openRenameDialog}
              onMove={(fileId) => openMoveDialog(fileId)}
              onShare={openShareDialog}
              onUploadNewVersion={openVersionUploadDialog}
              versions={propertiesFile ? (versionsByFile[propertiesFile.id] ?? []) : []}
              onDownloadVersion={handleDownloadVersion}
              timelineEvents={propertiesTimelineEvents}
              timelineLoading={propertiesTimelineLoading}
              onRefreshTimeline={refreshPropertiesTimeline}
              onSendForSignature={handleSendForSignature}
              onDelete={(fileId) => openDeleteDialog(fileId)}
            />
          </div>
        </aside>
      </div>

      <DragOverlay
        dropAnimation={null}
        style={DRAG_OVERLAY_STYLE}
        modifiers={DRAG_OVERLAY_MODIFIERS}
      >
        {activeDrag ? (
          <FileDragChip
            payload={activeDrag.payload}
            targetLabel={overFolderPath === null ? null : folderLabel(overFolderPath)}
          />
        ) : null}
      </DragOverlay>
      </DocumentsDragProvider>
      </DndContext>
      )}
      </div>

      <UploadDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        initialFiles={uploadFiles}
        projectId={projectId}
        folderPath={currentPath}
        onUploadComplete={() => refreshFiles({ invalidateCache: true })}
      />

      <VersionUploadDialog
        open={versionDialogOpen}
        onOpenChange={(open) => {
          setVersionDialogOpen(open);
          if (!open) {
            setVersionTargetFile(null);
          }
        }}
        file={versionTargetFile}
        versions={versionTargetFile ? (versionsByFile[versionTargetFile.id] ?? []) : []}
        onLoadVersions={loadVersionsForFile}
        onUploadVersion={uploadVersionForFile}
      />

      <EnvelopeWizard
        open={esignOpen}
        onOpenChange={(open) => {
          setEsignOpen(open);
          if (!open) {
            setEsignFile(null);
            setEsignSource(null);
          }
        }}
        sourceEntity={esignSource}
        initialFile={esignFile}
        onEnvelopeSent={() => {
          void refreshFiles({ invalidateCache: true });
        }}
      />

      <FileViewer
        file={viewerFile}
        files={previewableFiles}
        open={viewerOpen}
        onOpenChange={(open) => {
          setViewerOpen(open);
          if (!open) {
            setViewerFile(null);
          }
        }}
        onDownload={handleDownload}
        versions={viewerFile ? (versionsByFile[viewerFile.id] ?? []) : []}
        onUploadVersion={handleUploadVersion}
        onMakeCurrentVersion={handleMakeCurrentVersion}
        onDownloadVersion={handleDownloadVersion}
        onUpdateVersion={handleUpdateVersion}
        onDeleteVersion={handleDeleteVersion}
        onRefreshVersions={async () => {
          if (viewerFile) {
            const versions = await listFileVersionsAction(viewerFile.id);
            setVersionsByFile((prev) => ({
              ...prev,
              [viewerFile.id]: versions.map(mapVersion),
            }));
          }
        }}
        onFileChange={viewerOpen ? handleViewerFileChange : undefined}
      />

      <CreateFolderDialog
        open={createFolderDialogOpen}
        onOpenChange={setCreateFolderDialogOpen}
        initialPath={createFolderInitialPath}
      />

      <FileShareDialog
        open={shareDialogOpen}
        onOpenChange={(open) => {
          setShareDialogOpen(open);
          if (!open) {
            setShareTargetFile(null);
          }
        }}
        file={shareTargetFile}
      />

      <RenameFileDialog
        open={renameDialogOpen}
        onOpenChange={(open) => {
          setRenameDialogOpen(open);
          if (!open) {
            setRenameTargetFile(null);
          }
        }}
        file={renameTargetFile}
      />

      <MoveFilesDialog
        open={moveDialogOpen}
        onOpenChange={(open) => {
          setMoveDialogOpen(open);
          if (!open) {
            setMoveFileIds([]);
          }
        }}
        fileIds={moveFileIds}
        isMoving={isMoving}
        onMoveFiles={moveFilesToFolder}
        onRequestNewFolder={(suggestedPath) => {
          setMoveDialogOpen(false);
          setCreateFolderInitialPath(suggestedPath);
          setCreateFolderDialogOpen(true);
        }}
      />

      <DeleteFilesDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) {
            setDeleteFileIds([]);
          }
        }}
        fileIds={deleteFileIds}
        onDeleted={async () => {
          setSelectedFileIds(new Set());
          await refreshFiles({ invalidateCache: true });
        }}
      />

      <FolderRenameDialog
        open={folderRenameOpen}
        onOpenChange={setFolderRenameOpen}
        path={folderRenamePath}
      />

      <FolderDeleteDialog
        open={folderDeleteOpen}
        onOpenChange={setFolderDeleteOpen}
        path={folderDeletePath}
      />

      <FolderShareDialog
        open={folderShareOpen}
        onOpenChange={(open) => {
          setFolderShareOpen(open);
          if (!open) {
            setFolderShareTarget(null);
          }
        }}
        target={folderShareTarget}
      />

    </div>
  );
}
