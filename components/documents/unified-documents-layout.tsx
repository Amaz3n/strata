"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
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
import { downloadUrlToFile, getDownloadFileName } from "@/components/files/download";
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
import { EnvelopeWizard, type EnvelopeWizardSourceEntity } from "@/components/esign/envelope-wizard";
import type { UnifiedDocumentsLayoutProps } from "./types";
import { isBrowserRenderableImage, isWordPreviewable, type FileWithDetails } from "@/components/files/types";
import {
  getFileAction,
  getFileDownloadUrlAction,
  listFileVersionsAction,
  unarchiveFileAction,
  uploadFileVersionAction,
  makeVersionCurrentAction,
  updateFileVersionAction,
  deleteFileVersionAction,
  getVersionDownloadUrlAction,
  createFolderAction,
  bulkMoveFilesAction,
  listFileTimelineAction,
} from "@/app/(app)/documents/actions";
import type {
  FileWithUrls,
  FileTimelineEvent,
} from "@/app/(app)/documents/types";
import { uploadDocumentFileDirect } from "@/lib/services/files-client";

import { unwrapAction } from "@/lib/action-result"

const EXPLORER_OPEN_STORAGE_KEY = "documents-explorer-open";

const DRAG_OVERLAY_MODIFIERS = [followPointerModifier];

export function UnifiedDocumentsLayout(props: UnifiedDocumentsLayoutProps) {
  return (
    <DocumentsProvider
      project={props.project}
      initialFiles={props.initialFiles}
      initialTotalCount={props.initialTotalCount}
      initialHasMore={props.initialHasMore}
      initialCounts={props.initialCounts}
      initialFolders={props.initialFolders}
      initialFolderCounts={props.initialFolderCounts}
      initialFolderPermissions={props.initialFolderPermissions}
      initialPath={props.initialPath}
    >
      <UnifiedDocumentsLayoutInner />
    </DocumentsProvider>
  );
}

function UnifiedDocumentsLayoutInner() {
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();
  const {
    projectId,
    projectName,
    files,
    folderPermissions,
    currentPath,
    setCurrentPath,
    refreshFiles,
  } = useDocuments();
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
      if (droppedFiles.length === 0) return;

      const normalizedTarget = targetPath ? normalizeFolderPath(targetPath) : null;
      setIsDirectUploading(true);
      const startedAt = performance.now();
      const loadedByFile = new Map<string, number>();
      const stageByFile = new Map<string, string>();
      const formatSpeed = (loaded: number) => {
        const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.5);
        const mbps = loaded / 1024 / 1024 / elapsedSeconds;
        return `${mbps.toFixed(1)} MB/s`;
      };
      const formatProgress = () => {
        const total = droppedFiles.reduce((sum, file) => sum + file.size, 0);
        const loaded = droppedFiles.reduce(
          (sum, file) => sum + (loadedByFile.get(file.name) ?? 0),
          0,
        );
        const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
        const hasFinalizing = Array.from(stageByFile.values()).some((stage) => stage === "finalizing");
        const verb = hasFinalizing ? "Finalizing" : "Uploading";
        if (droppedFiles.length === 1) {
          return `${verb} ${droppedFiles[0].name}... ${percent}% (${formatSpeed(loaded)})`;
        }
        return `${verb} ${droppedFiles.length} files... ${percent}% (${formatSpeed(loaded)})`;
      };
      const toastId = toast.loading(formatProgress());

      const uploadOne = async (file: File) => {
        await uploadDocumentFileDirect(file, {
          projectId,
          folderPath: normalizedTarget ?? "",
          onStage: (stage) => {
            stageByFile.set(file.name, stage);
            toast.loading(formatProgress(), { id: toastId });
          },
          onProgress: ({ loaded }) => {
            loadedByFile.set(file.name, loaded);
            toast.loading(formatProgress(), { id: toastId });
          },
        });
      };

      try {
        const results = await Promise.allSettled(droppedFiles.map(uploadOne));
        const successCount = results.filter((result) => result.status === "fulfilled").length;
        const failCount = results.length - successCount;

        if (successCount > 0) {
          await refreshFiles({ invalidateCache: true });
        }

        if (failCount === 0) {
          toast.success(
            `${successCount} file${successCount === 1 ? "" : "s"} uploaded`,
            { id: toastId },
          );
          return;
        }

        const firstFailure = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        const message =
          firstFailure?.reason instanceof Error
            ? firstFailure.reason.message
            : "Some files failed to upload";

        if (successCount > 0) {
          toast.warning(
            `${successCount} uploaded, ${failCount} failed. ${message}`,
            { id: toastId },
          );
        } else {
          toast.error(message, { id: toastId });
        }
      } finally {
        setIsDirectUploading(false);
      }
    },
    [projectId, refreshFiles],
  );

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
      try {
        if (normalizedTarget) {
          unwrapAction(await createFolderAction(projectId, normalizedTarget));
        }
        unwrapAction(await bulkMoveFilesAction(fileIds, normalizedTarget, true));
        toast.success(
          `Moved ${fileIds.length} file${fileIds.length === 1 ? "" : "s"} to ${sourceLabel}`,
          { id: toastId },
        );
        setSelectedFileIds(new Set());
        await refreshFiles({ invalidateCache: true });
      } catch (error) {
        console.error("Failed to move files:", error);
        toast.error("Failed to move files", { id: toastId });
      } finally {
        setIsMoving(false);
      }
    },
    [projectId, refreshFiles],
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
        await Promise.all(ids.map((fileId) => unarchiveFileAction(fileId)));
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
          const url = unwrapAction(await getFileDownloadUrlAction(file.id));
          await downloadUrlToFile(url, file.file_name);
          return;
        }
      }

      const response = await fetch("/api/documents/download-zip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileIds: ids }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        toast.error(payload?.error ?? "Failed to create ZIP download");
        return;
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = getDownloadFileName(
        response.headers.get("content-disposition"),
        `arc-documents-${new Date().toISOString().slice(0, 10)}.zip`,
      );
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      toast.success(`Downloading ${ids.length} files as ZIP`);
    } catch (error) {
      console.error("Failed to download selected files:", error);
      toast.error("Failed to download selected files");
    } finally {
      setIsDownloadingSelected(false);
    }
  }, [files, selectedFileIds]);

  const uploadVersionForFile = useCallback(
    async (fileId: string, file: File, label?: string, notes?: string) => {
      const formData = new FormData();
      formData.append("fileId", fileId);
      formData.append("file", file);
      if (label) formData.append("label", label);
      if (notes) formData.append("notes", notes);
      unwrapAction(await uploadFileVersionAction(formData));
      const versions = await listFileVersionsAction(fileId);
      setVersionsByFile((prev) => ({
        ...prev,
        [fileId]: versions.map(mapVersion),
      }));
      await refreshFiles({ invalidateCache: true });
    },
    [refreshFiles],
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
      const url = unwrapAction(await getFileDownloadUrlAction(file.id));
      await downloadUrlToFile(url, file.file_name);
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
      { label: projectName, href: `/projects/${projectId}` },
      {
        label: "Documents",
        href: `/projects/${projectId}/documents`,
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
        href: `/projects/${projectId}/documents?path=${encodeURIComponent(path)}`,
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
  }, [activeBreadcrumbPath, projectId, projectName, propertiesFile, setBreadcrumbs, setCurrentPath]);

  const handleSendForSignature = useCallback(
    (fileId: string) => {
      const file = files.find((f) => f.id === fileId);
      if (!file) return;

      setEsignFile(file);
      setEsignSource({
        type: "other",
        id: file.id,
        project_id: projectId,
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
          onFileClick={handleFileClick}
          onDownloadFile={handleDownloadById}
          onFolderClick={handleFolderClick}
          onRenameFolder={handleRenameFolder}
          onShareFolder={handleShareFolder}
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
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background"
      aria-busy={isDirectUploading}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <FileDropOverlay isVisible={isDraggingOver} className="rounded-none" />

      {isMobile ? (
        <DocumentsMobileLayout
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
      <div className="relative z-20 shrink-0 border-b bg-background px-4 py-3">
        <DocumentsToolbar
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
          explorerOpen={explorerOpen}
          onToggleExplorer={() => setExplorerOpen((open) => !open)}
        />
      </div>

      <div className="relative z-10 flex min-h-0 flex-1">
        <aside
          className={cn(
            "hidden shrink-0 overflow-hidden border-r bg-background lg:block",
            explorerRestored && "transition-[width,opacity] duration-200 ease-out",
            explorerOpen ? "w-[280px] opacity-100" : "w-0 border-r-0 opacity-0",
          )}
        >
          <DocumentsExplorer
            className="h-full"
            onRenameFolder={handleRenameFolder}
            onDeleteFolder={handleDeleteFolder}
            onShareFolder={handleShareFolder}
          />
        </aside>
        <div className="relative flex min-h-0 flex-1 flex-col">
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
