"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Check, Copy, FilePlus2, FolderClosed, Link2, Loader2, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePageTitle } from "@/components/layout/page-title-context";
import { FileDropOverlay } from "@/components/files/file-drop-overlay";
import { FileViewer } from "@/components/files/file-viewer";
import { DrawingViewer } from "@/components/drawings/drawing-viewer";
import { CreateFromDrawingDialog } from "@/components/drawings/create-from-drawing-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DocumentsProvider, useDocuments } from "./documents-context";
import { DocumentsExplorer } from "./documents-explorer";
import { DocumentsToolbar } from "./documents-toolbar";
import { DocumentsContent } from "./documents-content";
import { SheetsContent } from "./sheets-content";
import { FilePropertiesPanel } from "./file-properties-panel";
import { UploadDialog } from "./upload-dialog";
import { EnvelopeWizard, type EnvelopeWizardSourceEntity } from "@/components/esign/envelope-wizard";
import type { UnifiedDocumentsLayoutProps } from "./types";
import type { FileWithDetails } from "@/components/files/types";
import {
  getFileAction,
  getFileDownloadUrlAction,
  listFileVersionsAction,
  uploadFileVersionAction,
  makeVersionCurrentAction,
  updateFileVersionAction,
  deleteFileVersionAction,
  getVersionDownloadUrlAction,
  updateFileAction,
  createFolderAction,
  renameFolderAction,
  deleteFolderAction,
  updateFolderPermissionsAction,
  bulkMoveFilesAction,
  bulkDeleteFilesAction,
  listFileTimelineAction,
  createFileShareLinkAction,
  listFileShareLinksAction,
  revokeFileShareLinkAction,
} from "@/app/(app)/documents/actions";
import type { FileShareLink } from "@/app/(app)/documents/actions";
import type {
  FileVersion,
  FileWithUrls,
  FileTimelineEvent,
} from "@/app/(app)/documents/actions";
import {
  createDrawingSetFromUpload,
  getSheetDownloadUrlAction,
  getSheetOptimizedImageUrlsAction,
  listDrawingMarkupsAction,
  listDrawingPinsWithEntitiesAction,
  createDrawingMarkupAction,
  deleteDrawingMarkupAction,
  createDrawingPinAction,
  createTaskFromDrawingAction,
  createRfiFromDrawingAction,
  createPunchItemFromDrawingAction,
} from "@/app/(app)/drawings/actions";
import type {
  DrawingSheet,
  DrawingMarkup,
  DrawingPin,
} from "@/app/(app)/drawings/actions";
import { uploadDrawingFileToStorage } from "@/lib/services/drawings-client";
import { DRAWING_SET_TYPE_LABELS } from "@/lib/validation/drawings";

function dispatchNavRefresh() {
  window.dispatchEvent(new CustomEvent("docs-nav-refresh"));
}

function getDownloadFileName(contentDisposition: string | null, fallback?: string) {
  if (fallback) return fallback;
  if (!contentDisposition) return "download";

  const utf8Match = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]);
  }

  const quotedMatch = contentDisposition.match(/filename\s*=\s*"([^"]+)"/i);
  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }

  const bareMatch = contentDisposition.match(/filename\s*=\s*([^;]+)/i);
  return bareMatch?.[1]?.trim() || "download";
}

async function downloadUrlToFile(url: string, fileName?: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download request failed with status ${response.status}`);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const resolvedFileName = getDownloadFileName(
    response.headers.get("content-disposition"),
    fileName,
  );

  try {
    link.href = objectUrl;
    link.download = resolvedFileName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}

interface FileVersionInfo {
  id: string;
  version_number: number;
  label?: string;
  notes?: string;
  file_name?: string;
  mime_type?: string;
  size_bytes?: number;
  creator_name?: string;
  created_at: string;
  is_current: boolean;
}

function mapVersion(version: FileVersion): FileVersionInfo {
  return {
    id: version.id,
    version_number: version.version_number,
    label: version.label ?? undefined,
    notes: version.notes ?? undefined,
    file_name: version.file_name ?? undefined,
    mime_type: version.mime_type ?? undefined,
    size_bytes: version.size_bytes ?? undefined,
    creator_name: version.creator_name ?? undefined,
    created_at: version.created_at,
    is_current: version.is_current,
  };
}

function normalizeFolderPath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const normalized = withLeadingSlash.replace(/\/+/g, "/");
  if (normalized === "/") return null;
  return normalized.replace(/\/$/, "");
}

const DRAWING_SET_TYPES = Object.entries(DRAWING_SET_TYPE_LABELS);
const EXPLORER_OPEN_STORAGE_KEY = "documents-explorer-open";
function shareSummary(withClients: boolean, withSubs: boolean): string {
  if (withClients && withSubs) return "Visible to your team, clients, and subcontractors.";
  if (withClients) return "Visible to your team and clients.";
  if (withSubs) return "Visible to your team and subcontractors.";
  return "Visible to your internal team only.";
}

export function UnifiedDocumentsLayout(props: UnifiedDocumentsLayoutProps) {
  return (
    <DocumentsProvider
      project={props.project}
      initialFiles={props.initialFiles}
      initialTotalCount={props.initialTotalCount}
      initialHasMore={props.initialHasMore}
      initialCounts={props.initialCounts}
      initialFolders={props.initialFolders}
      initialSets={props.initialSets}
      initialPath={props.initialPath}
      initialSetId={props.initialSetId}
    >
      <UnifiedDocumentsLayoutInner />
    </DocumentsProvider>
  );
}

function UnifiedDocumentsLayoutInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const ENABLE_TILES_AUTH =
    process.env.NEXT_PUBLIC_DRAWINGS_TILES_SECURE === "true";
  const {
    projectId,
    projectName,
    files,
    folders,
    folderPermissions,
    selectedDrawingSetId,
    currentPath,
    setCurrentPath,
    refreshFiles,
    refreshDrawingSets,
    refreshFolderPermissions,
    navigateToDrawingSet,
  } = useDocuments();
  const { setBreadcrumbs } = usePageTitle();
  const requestedFileId = searchParams.get("fileId");
  const highlightedFileId = searchParams.get("highlight");

  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);

  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const versionFileInputRef = useRef<HTMLInputElement>(null);
  const [versionDialogOpen, setVersionDialogOpen] = useState(false);
  const [versionTargetFile, setVersionTargetFile] = useState<FileWithUrls | null>(null);
  const [versionUploadFile, setVersionUploadFile] = useState<File | null>(null);
  const [versionLabel, setVersionLabel] = useState("");
  const [versionNotes, setVersionNotes] = useState("");
  const [isUploadingVersion, setIsUploadingVersion] = useState(false);
  const drawingSetFileInputRef = useRef<HTMLInputElement>(null);
  const [drawingSetUploadOpen, setDrawingSetUploadOpen] = useState(false);
  const [drawingSetFile, setDrawingSetFile] = useState<File | null>(null);
  const [drawingSetTitle, setDrawingSetTitle] = useState("");
  const [drawingSetType, setDrawingSetType] = useState("general");
  const [drawingSetUploading, setDrawingSetUploading] = useState(false);
  const [drawingSetUploadStage, setDrawingSetUploadStage] = useState<
    string | null
  >(null);

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
  const [draggedFileId, setDraggedFileId] = useState<string | null>(null);
  const [isDraggingDocumentFile, setIsDraggingDocumentFile] = useState(false);

  const [createFolderDialogOpen, setCreateFolderDialogOpen] = useState(false);
  const [newFolderPath, setNewFolderPath] = useState("");
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);

  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameFile, setRenameFile] = useState<FileWithUrls | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);

  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareFile, setShareFile] = useState<FileWithUrls | null>(null);
  const [shareWithClients, setShareWithClients] = useState(false);
  const [shareWithSubs, setShareWithSubs] = useState(false);
  const [isSavingShare, setIsSavingShare] = useState(false);
  const [shareLinks, setShareLinks] = useState<FileShareLink[]>([]);
  const [shareLinksLoading, setShareLinksLoading] = useState(false);
  const [shareLinkExpiry, setShareLinkExpiry] = useState<"7d" | "30d" | "never">("30d");
  const [shareLinkAllowDownload, setShareLinkAllowDownload] = useState(true);
  const [shareLinkLabel, setShareLinkLabel] = useState("");
  const [isCreatingShareLink, setIsCreatingShareLink] = useState(false);
  const [revokingShareLinkId, setRevokingShareLinkId] = useState<string | null>(null);
  const [copiedShareLinkId, setCopiedShareLinkId] = useState<string | null>(null);

  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [moveTargetFolder, setMoveTargetFolder] = useState("");
  const [moveSearchQuery, setMoveSearchQuery] = useState("");
  const [moveFileIds, setMoveFileIds] = useState<string[]>([]);
  const [isMoving, setIsMoving] = useState(false);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteFileIds, setDeleteFileIds] = useState<string[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);

  const [folderRenameOpen, setFolderRenameOpen] = useState(false);
  const [folderRenamePath, setFolderRenamePath] = useState("");
  const [folderRenameValue, setFolderRenameValue] = useState("");
  const [isRenamingFolder, setIsRenamingFolder] = useState(false);

  const [folderDeleteOpen, setFolderDeleteOpen] = useState(false);
  const [folderDeletePath, setFolderDeletePath] = useState("");
  const [isDeletingFolder, setIsDeletingFolder] = useState(false);

  const [folderShareOpen, setFolderShareOpen] = useState(false);
  const [folderSharePath, setFolderSharePath] = useState("");
  const [folderShareWithClients, setFolderShareWithClients] = useState(false);
  const [folderShareWithSubs, setFolderShareWithSubs] = useState(false);
  const [folderShareApplyToExisting, setFolderShareApplyToExisting] = useState(false);
  const [isSavingFolderShare, setIsSavingFolderShare] = useState(false);

  const [propertiesTimelineEvents, setPropertiesTimelineEvents] = useState<FileTimelineEvent[]>([]);
  const [propertiesTimelineLoading, setPropertiesTimelineLoading] = useState(false);

  const [esignOpen, setEsignOpen] = useState(false);
  const [esignFile, setEsignFile] = useState<FileWithUrls | null>(null);
  const [esignSource, setEsignSource] = useState<EnvelopeWizardSourceEntity | null>(null);

  const [drawingViewerOpen, setDrawingViewerOpen] = useState(false);
  const [drawingViewerSheet, setDrawingViewerSheet] =
    useState<DrawingSheet | null>(null);
  const [drawingViewerSheets, setDrawingViewerSheets] = useState<
    DrawingSheet[]
  >([]);
  const [drawingViewerUrl, setDrawingViewerUrl] = useState<string | null>(null);
  const [drawingViewerMarkups, setDrawingViewerMarkups] = useState<
    DrawingMarkup[]
  >([]);
  const [drawingViewerPins, setDrawingViewerPins] = useState<DrawingPin[]>([]);
  const [drawingViewerHighlightedPinId, setDrawingViewerHighlightedPinId] =
    useState<string | null>(null);
  const [createFromDrawingOpen, setCreateFromDrawingOpen] = useState(false);
  const [createFromDrawingPosition, setCreateFromDrawingPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const drawingViewerRequestIdRef = useRef(0);
  const tilesCookieRequestedRef = useRef(false);
  const handledQueryRef = useRef("");
  const [explorerOpen, setExplorerOpen] = useState(false);

  useEffect(() => {
    setSelectedFileIds(new Set());
    setSelectedFolderPaths(new Set());
  }, [currentPath, selectedDrawingSetId]);

  useEffect(() => {
    if (!viewerOpen) {
      lastNotifiedViewerFileIdRef.current = null;
    }
  }, [viewerOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(EXPLORER_OPEN_STORAGE_KEY);
    if (saved === "true") {
      setExplorerOpen(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      EXPLORER_OPEN_STORAGE_KEY,
      explorerOpen ? "true" : "false",
    );
  }, [explorerOpen]);

  useEffect(() => {
    if (!ENABLE_TILES_AUTH || tilesCookieRequestedRef.current) return;
    tilesCookieRequestedRef.current = true;

    fetch("/api/drawings/tiles-cookie", {
      method: "POST",
      credentials: "include",
    }).catch((error) => {
      console.warn("[drawings] Failed to set tiles cookie:", error);
    });
  }, [ENABLE_TILES_AUTH]);

  const folderOptions = useMemo(() => {
    const allFolderPaths = new Set<string>(folders);
    for (const file of files) {
      if (file.folder_path) {
        const normalized = normalizeFolderPath(file.folder_path);
        if (normalized) {
          allFolderPaths.add(normalized);
        }
      }
    }
    return Array.from(allFolderPaths).sort((a, b) => a.localeCompare(b));
  }, [files, folders]);
  const filteredMoveFolderOptions = useMemo(() => {
    const query = moveSearchQuery.trim().toLowerCase();
    if (!query) return folderOptions;
    return folderOptions.filter((folder) => folder.toLowerCase().includes(query));
  }, [folderOptions, moveSearchQuery]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    const hasInternalFileDrag = e.dataTransfer.types.includes(
      "application/x-arc-file-id",
    );
    if (!hasInternalFileDrag && e.dataTransfer.items?.length) {
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

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    dragCounterRef.current = 0;

    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      setUploadFiles(droppedFiles);
      setUploadDialogOpen(true);
    }
  }, []);

  const handleFileClick = useCallback(
    async (fileId: string) => {
      const file = files.find((f) => f.id === fileId);
      if (!file) return;

      const initialDownloadUrl = file.download_url ?? undefined;
      const initialFile: FileWithDetails = {
        ...file,
        category: file.category as any,
        download_url: initialDownloadUrl,
        thumbnail_url:
          file.thumbnail_url ??
          (file.mime_type?.startsWith("image/")
            ? initialDownloadUrl
            : undefined),
      };

      setViewerFile(initialFile);
      setViewerOpen(true);

      try {
        if (!initialDownloadUrl) {
          const downloadUrl = await getFileDownloadUrlAction(fileId);
          setViewerFile((prev) => {
            if (!prev || prev.id !== fileId) return prev;
            return {
              ...prev,
              download_url: downloadUrl,
              thumbnail_url:
                prev.thumbnail_url ??
                (prev.mime_type?.startsWith("image/")
                  ? downloadUrl
                  : undefined),
            };
          });
        }

        const versions = await listFileVersionsAction(fileId);
        setVersionsByFile((prev) => ({
          ...prev,
          [fileId]: versions.map(mapVersion),
        }));
      } catch (error) {
        console.error("Failed to open file:", error);
        toast.error("Failed to open file");
      }
    },
    [files],
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
      const existing = files.find((file) => file.id === fileId);
      if (existing) {
        await handleFileClick(fileId);
        return;
      }

      const file = await getFileAction(fileId);
      if (!file) return;

      const downloadUrl = await getFileDownloadUrlAction(file.id);
      setViewerFile({
        ...file,
        category: file.category as any,
        download_url: downloadUrl,
        thumbnail_url: file.mime_type?.startsWith("image/")
          ? downloadUrl
          : undefined,
      });
      setViewerOpen(true);

      const versions = await listFileVersionsAction(file.id);
      setVersionsByFile((prev) => ({
        ...prev,
        [file.id]: versions.map(mapVersion),
      }));
    },
    [files, handleFileClick],
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

  const resetVersionUploadDialog = useCallback(() => {
    setVersionTargetFile(null);
    setVersionUploadFile(null);
    setVersionLabel("");
    setVersionNotes("");
    setIsUploadingVersion(false);
    if (versionFileInputRef.current) {
      versionFileInputRef.current.value = "";
    }
  }, []);

  const openVersionUploadDialog = useCallback(
    (fileId: string) => {
      const file = files.find((item) => item.id === fileId);
      if (!file) return;
      setVersionTargetFile(file);
      setVersionUploadFile(null);
      setVersionLabel("");
      setVersionNotes("");
      setVersionDialogOpen(true);
      if (versionFileInputRef.current) {
        versionFileInputRef.current.value = "";
      }
    },
    [files],
  );

  const handleVersionFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      if (file) {
        setVersionUploadFile(file);
      }
    },
    [],
  );

  const resetDrawingSetUploadDialog = useCallback(() => {
    setDrawingSetFile(null);
    setDrawingSetTitle("");
    setDrawingSetType("general");
    setDrawingSetUploading(false);
    setDrawingSetUploadStage(null);
    if (drawingSetFileInputRef.current) {
      drawingSetFileInputRef.current.value = "";
    }
  }, []);

  const handleOpenDrawingSetUpload = useCallback(() => {
    resetDrawingSetUploadDialog();
    setDrawingSetUploadOpen(true);
  }, [resetDrawingSetUploadDialog]);

  const handleDrawingSetFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      if (!file) return;
      setDrawingSetFile(file);
      setDrawingSetTitle((prev) => {
        if (prev.trim().length > 0) return prev;
        return file.name.replace(/\.pdf$/i, "");
      });
    },
    [],
  );

  const handleUploadDrawingSet = useCallback(async () => {
    if (!drawingSetFile) {
      toast.error("Select a PDF file to upload");
      return;
    }

    if (drawingSetFile.type !== "application/pdf") {
      toast.error("Only PDF files are supported for drawing sets");
      return;
    }

    const normalizedTitle =
      drawingSetTitle.trim().length > 0
        ? drawingSetTitle.trim()
        : drawingSetFile.name.replace(/\.pdf$/i, "");

    setDrawingSetUploading(true);
    setDrawingSetUploadStage("Uploading PDF…");
    try {
      const { storagePath } = await uploadDrawingFileToStorage(
        drawingSetFile,
        projectId,
      );

      setDrawingSetUploadStage("Queueing sheet processing…");
      await createDrawingSetFromUpload({
        projectId,
        title: normalizedTitle,
        setType: drawingSetType,
        fileName: drawingSetFile.name,
        storagePath,
        fileSize: drawingSetFile.size,
        mimeType: drawingSetFile.type,
      });

      await Promise.all([refreshDrawingSets(), refreshFiles()]);
      dispatchNavRefresh();
      toast.success("Drawing set uploaded. Processing has started.");
      setDrawingSetUploadOpen(false);
      resetDrawingSetUploadDialog();
    } catch (error) {
      console.error("Failed to upload drawing set:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to upload drawing set",
      );
    } finally {
      setDrawingSetUploading(false);
      setDrawingSetUploadStage(null);
    }
  }, [
    drawingSetFile,
    drawingSetTitle,
    drawingSetType,
    projectId,
    refreshDrawingSets,
    refreshFiles,
    resetDrawingSetUploadDialog,
  ]);

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
      setRenameFile(file);
      setRenameValue(file.file_name);
      setRenameDialogOpen(true);
    },
    [files],
  );

  const openShareDialog = useCallback(
    (fileId: string) => {
      const file = files.find((item) => item.id === fileId);
      if (!file) return;
      setShareFile(file);
      setShareWithClients(Boolean(file.share_with_clients));
      setShareWithSubs(Boolean(file.share_with_subs));
      setShareLinks([]);
      setShareLinkLabel("");
      setShareLinkExpiry("30d");
      setShareLinkAllowDownload(true);
      setShareLinksLoading(true);
      setShareDialogOpen(true);
      listFileShareLinksAction(file.id)
        .then((links) => setShareLinks(links))
        .catch((err) => {
          console.error("Failed to load share links", err);
        })
        .finally(() => setShareLinksLoading(false));
    },
    [files],
  );

  const openMoveDialog = useCallback(
    (fileId?: string) => {
      if (fileId) {
        setMoveFileIds([fileId]);
      } else {
        setMoveFileIds(Array.from(selectedFileIds));
      }
      setMoveTargetFolder(currentPath || "");
      setMoveSearchQuery("");
      setMoveDialogOpen(true);
    },
    [selectedFileIds, currentPath],
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

  const resolveDraggedFileIds = useCallback(
    (primaryFileId?: string): string[] => {
      const fileId = primaryFileId ?? draggedFileId;
      if (!fileId) return [];
      if (selectedFileIds.has(fileId)) {
        return Array.from(selectedFileIds);
      }
      return [fileId];
    },
    [draggedFileId, selectedFileIds],
  );

  const handleFileDragStart = useCallback(
    (fileId: string, event: React.DragEvent<HTMLDivElement>) => {
      setDraggedFileId(fileId);
      setIsDraggingDocumentFile(true);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-arc-file-id", fileId);
    },
    [],
  );

  const handleFileDragEnd = useCallback(() => {
    setIsDraggingDocumentFile(false);
    setDraggedFileId(null);
  }, []);

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

      setIsMoving(true);
      try {
        if (normalizedTarget) {
          await createFolderAction(projectId, normalizedTarget);
        }
        await bulkMoveFilesAction(fileIds, normalizedTarget, true);
        toast.success(
          `Moved ${fileIds.length} file${fileIds.length === 1 ? "" : "s"} to ${sourceLabel}`,
        );
        setSelectedFileIds(new Set());
        await refreshFiles();
        dispatchNavRefresh();
      } catch (error) {
        console.error("Failed to move files:", error);
        toast.error("Failed to move files");
      } finally {
        setIsMoving(false);
      }
    },
    [projectId, refreshFiles],
  );

  const handleDropOnFolder = useCallback(
    async (targetPath: string) => {
      const fileIds = resolveDraggedFileIds();
      await moveFilesToFolder(fileIds, targetPath, targetPath);
      setIsDraggingDocumentFile(false);
      setDraggedFileId(null);
    },
    [resolveDraggedFileIds, moveFilesToFolder],
  );

  const handleDropToRoot = useCallback(async () => {
    const fileIds = resolveDraggedFileIds();
    await moveFilesToFolder(fileIds, null, "Root");
    setIsDraggingDocumentFile(false);
    setDraggedFileId(null);
  }, [resolveDraggedFileIds, moveFilesToFolder]);

  const selectedFolderPath = useMemo(
    () => Array.from(selectedFolderPaths)[0] ?? null,
    [selectedFolderPaths],
  );

  const closeDrawingViewer = useCallback(() => {
    drawingViewerRequestIdRef.current += 1;
    setDrawingViewerOpen(false);
    setDrawingViewerSheet(null);
    setDrawingViewerSheets([]);
    setDrawingViewerUrl(null);
    setDrawingViewerMarkups([]);
    setDrawingViewerPins([]);
    setDrawingViewerHighlightedPinId(null);
    setCreateFromDrawingOpen(false);
    setCreateFromDrawingPosition(null);
  }, []);

  const handleSheetClick = useCallback(
    async (sheet: DrawingSheet, sheets: DrawingSheet[] = []) => {
      const requestId = drawingViewerRequestIdRef.current + 1;
      drawingViewerRequestIdRef.current = requestId;
      setDrawingViewerSheet(sheet);
      setDrawingViewerSheets(sheets.length > 0 ? sheets : [sheet]);
      setDrawingViewerUrl(null);
      setDrawingViewerMarkups([]);
      setDrawingViewerPins([]);
      setDrawingViewerHighlightedPinId(null);
      setDrawingViewerOpen(true);

      try {
        const hasTiles = Boolean(
          (sheet as any).tile_base_url && (sheet as any).tile_manifest,
        );
        const hasOptimizedImages = Boolean(
          sheet.image_thumbnail_url &&
          sheet.image_medium_url &&
          sheet.image_full_url,
        );

        const [signedImages, url, markups, pins] = await Promise.all([
          hasOptimizedImages && !hasTiles
            ? getSheetOptimizedImageUrlsAction(sheet.id).catch((error) => {
                console.error("Failed to get signed optimized images:", error);
                return null;
              })
            : Promise.resolve(null),
          getSheetDownloadUrlAction(sheet.id).catch((error) => {
            console.error("Failed to get sheet URL:", error);
            return null;
          }),
          listDrawingMarkupsAction({ drawing_sheet_id: sheet.id }).catch(
            (error) => {
              console.error("Failed to load markups:", error);
              return [];
            },
          ),
          listDrawingPinsWithEntitiesAction(sheet.id).catch((error) => {
            console.error("Failed to load pins:", error);
            return [];
          }),
        ]);

        if (drawingViewerRequestIdRef.current !== requestId) return;

        if (signedImages && !hasTiles) {
          setDrawingViewerSheet((prev) => {
            if (!prev || prev.id !== sheet.id) return prev;
            return {
              ...prev,
              image_thumbnail_url:
                signedImages.thumbnailUrl ?? prev.image_thumbnail_url ?? null,
              image_medium_url:
                signedImages.mediumUrl ?? prev.image_medium_url ?? null,
              image_full_url:
                signedImages.fullUrl ?? prev.image_full_url ?? null,
              image_width: signedImages.width ?? prev.image_width ?? null,
              image_height: signedImages.height ?? prev.image_height ?? null,
            };
          });
        }

        if (!hasOptimizedImages && !hasTiles && !url) {
          toast.error("Sheet file not available");
          closeDrawingViewer();
          return;
        }

        setDrawingViewerUrl(url);
        setDrawingViewerMarkups(markups);
        setDrawingViewerPins(pins);
      } catch (error) {
        console.error("Failed to open sheet:", error);
        if (drawingViewerRequestIdRef.current === requestId) {
          toast.error("Failed to open sheet");
        }
      }
    },
    [closeDrawingViewer],
  );

  const handleDrawingMarkupSave = useCallback(
    async (
      markup: Omit<
        DrawingMarkup,
        "id" | "org_id" | "created_at" | "updated_at"
      >,
    ) => {
      try {
        const created = await createDrawingMarkupAction(markup);
        setDrawingViewerMarkups((prev) => [...prev, created]);
        toast.success("Markup saved");
      } catch (error) {
        console.error("Failed to save markup:", error);
        toast.error("Failed to save markup");
      }
    },
    [],
  );

  const handleDrawingMarkupDelete = useCallback(async (markupId: string) => {
    try {
      await deleteDrawingMarkupAction(markupId);
      setDrawingViewerMarkups((prev) =>
        prev.filter((item) => item.id !== markupId),
      );
      toast.success("Markup deleted");
    } catch (error) {
      console.error("Failed to delete markup:", error);
      toast.error("Failed to delete markup");
    }
  }, []);

  const handleCreateDrawingPin = useCallback((x: number, y: number) => {
    setCreateFromDrawingPosition({ x, y });
    setCreateFromDrawingOpen(true);
  }, []);

  const handleDrawingPinClick = useCallback(
    (pin: DrawingPin) => {
      const base = pin.project_id ? `/projects/${pin.project_id}` : null;
      if (!base) return;

      switch (pin.entity_type) {
        case "task":
          router.push(`${base}/tasks`);
          break;
        case "rfi":
          router.push(`${base}/rfis`);
          break;
        case "submittal":
          router.push(`${base}/submittals`);
          break;
        case "punch_list":
          router.push(`${base}/punch`);
          break;
        case "daily_log":
          router.push(`${base}/daily-logs`);
          break;
        default:
          router.push(base);
      }

      closeDrawingViewer();
    },
    [closeDrawingViewer, router],
  );

  const handleCreateFromDrawing = useCallback(
    async (input: any) => {
      if (!drawingViewerSheet || !createFromDrawingPosition) return;

      try {
        const targetProjectId = input.project_id ?? projectId;
        if (!targetProjectId) {
          throw new Error("Missing project");
        }

        let entityId: string | null = null;

        if (input.entityType === "task") {
          const created = await createTaskFromDrawingAction(targetProjectId, {
            title: input.title,
            description: input.description,
            priority:
              input.priority === "high"
                ? "high"
                : input.priority === "low"
                  ? "low"
                  : "normal",
            status: "todo",
          });
          entityId = created.id;
        } else if (input.entityType === "rfi") {
          const created = await createRfiFromDrawingAction({
            projectId: targetProjectId,
            subject: input.subject ?? input.title,
            question: input.question ?? input.description ?? "",
            priority:
              input.priority === "high"
                ? "high"
                : input.priority === "low"
                  ? "low"
                  : "normal",
          });
          entityId = created.id;
        } else if (input.entityType === "punch_list") {
          const created = await createPunchItemFromDrawingAction({
            projectId: targetProjectId,
            title: input.title,
            description: input.description,
            location: input.location,
            severity: input.priority,
          });
          entityId = created.id;
        } else if (input.entityType === "issue") {
          const created = await createTaskFromDrawingAction(targetProjectId, {
            title: input.title,
            description: input.description,
            priority: "high",
            status: "todo",
            tags: ["issue"],
          });
          entityId = created.id;
        }

        if (!entityId) {
          throw new Error("Unsupported entity type");
        }

        const createdPin = await createDrawingPinAction({
          project_id: targetProjectId,
          drawing_sheet_id: drawingViewerSheet.id,
          x_position: createFromDrawingPosition.x,
          y_position: createFromDrawingPosition.y,
          entity_type: input.entityType,
          entity_id: entityId,
          label: input.title,
          status: "open",
        });

        setDrawingViewerPins((prev) => [...prev, createdPin]);
        setDrawingViewerHighlightedPinId(createdPin.id);
        setCreateFromDrawingOpen(false);
        setCreateFromDrawingPosition(null);
        toast.success("Entity created and pinned to drawing");
      } catch (error) {
        console.error("Failed to create entity from drawing:", error);
        toast.error("Failed to create entity");
      }
    },
    [createFromDrawingPosition, drawingViewerSheet, projectId],
  );

  const handleCreateFolder = useCallback(async () => {
    const normalized = normalizeFolderPath(newFolderPath);
    if (!normalized) {
      toast.error("Enter a folder path like /contracts");
      return;
    }

    setIsCreatingFolder(true);
    try {
      await createFolderAction(projectId, normalized);
      toast.success(`Created folder ${normalized}`);
      setCreateFolderDialogOpen(false);
      setNewFolderPath("");
      await refreshFiles();
      dispatchNavRefresh();
    } catch (error) {
      console.error("Failed to create folder:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to create folder",
      );
    } finally {
      setIsCreatingFolder(false);
    }
  }, [newFolderPath, projectId, refreshFiles]);

  const handleRenameConfirm = useCallback(async () => {
    if (!renameFile) return;
    const nextName = renameValue.trim();
    if (!nextName) {
      toast.error("File name is required");
      return;
    }

    setIsRenaming(true);
    try {
      await updateFileAction(renameFile.id, { file_name: nextName });
      toast.success("File renamed");
      setRenameDialogOpen(false);
      setRenameFile(null);
      await refreshFiles();
    } catch (error) {
      console.error("Failed to rename file:", error);
      toast.error("Failed to rename file");
    } finally {
      setIsRenaming(false);
    }
  }, [renameFile, renameValue, refreshFiles]);

  const handleShareConfirm = useCallback(async () => {
    if (!shareFile) return;
    setIsSavingShare(true);
    try {
      await updateFileAction(shareFile.id, {
        share_with_clients: shareWithClients,
        share_with_subs: shareWithSubs,
      });
      toast.success("Sharing updated");
      setShareDialogOpen(false);
      setShareFile(null);
      await refreshFiles();
    } catch (error) {
      console.error("Failed to update sharing:", error);
      toast.error("Failed to update sharing");
    } finally {
      setIsSavingShare(false);
    }
  }, [refreshFiles, shareFile, shareWithClients, shareWithSubs]);

  const handleCreateShareLink = useCallback(async () => {
    if (!shareFile) return;
    setIsCreatingShareLink(true);
    try {
      const now = new Date();
      const expires_at =
        shareLinkExpiry === "never"
          ? null
          : new Date(
              now.getTime() +
                (shareLinkExpiry === "7d" ? 7 : 30) * 24 * 60 * 60 * 1000,
            ).toISOString();
      const link = await createFileShareLinkAction({
        file_id: shareFile.id,
        label: shareLinkLabel.trim() || null,
        expires_at,
        allow_download: shareLinkAllowDownload,
      });
      setShareLinks((prev) => [link, ...prev]);
      setShareLinkLabel("");
      const origin =
        typeof window !== "undefined" ? window.location.origin : "";
      try {
        await navigator.clipboard.writeText(`${origin}/f/${link.token}`);
        setCopiedShareLinkId(link.id);
        setTimeout(() => setCopiedShareLinkId((prev) => (prev === link.id ? null : prev)), 2000);
        toast.success("Link created and copied");
      } catch {
        toast.success("Link created");
      }
    } catch (error: any) {
      console.error("Failed to create share link", error);
      toast.error(error?.message || "Failed to create share link");
    } finally {
      setIsCreatingShareLink(false);
    }
  }, [shareFile, shareLinkExpiry, shareLinkAllowDownload, shareLinkLabel]);

  const handleCopyShareLink = useCallback(async (link: FileShareLink) => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    try {
      await navigator.clipboard.writeText(`${origin}/f/${link.token}`);
      setCopiedShareLinkId(link.id);
      setTimeout(() => setCopiedShareLinkId((prev) => (prev === link.id ? null : prev)), 2000);
    } catch (err) {
      console.error("Copy failed", err);
      toast.error("Copy failed");
    }
  }, []);

  const handleRevokeShareLink = useCallback(async (link: FileShareLink) => {
    setRevokingShareLinkId(link.id);
    try {
      await revokeFileShareLinkAction(link.id);
      setShareLinks((prev) =>
        prev.map((item) =>
          item.id === link.id
            ? { ...item, revoked_at: new Date().toISOString(), is_active: false }
            : item,
        ),
      );
      toast.success("Link revoked");
    } catch (error: any) {
      console.error("Failed to revoke share link", error);
      toast.error(error?.message || "Failed to revoke link");
    } finally {
      setRevokingShareLinkId(null);
    }
  }, []);

  const handleMoveConfirm = useCallback(async () => {
    if (moveFileIds.length === 0) return;

    const normalizedTarget = normalizeFolderPath(moveTargetFolder);
    await moveFilesToFolder(
      moveFileIds,
      normalizedTarget,
      normalizedTarget ?? "Root",
    );
    setMoveDialogOpen(false);
    setMoveFileIds([]);
    setMoveTargetFolder("");
  }, [moveFileIds, moveTargetFolder, moveFilesToFolder]);

  const handleDeleteConfirm = useCallback(async () => {
    if (deleteFileIds.length === 0) return;

    setIsDeleting(true);
    try {
      await bulkDeleteFilesAction(deleteFileIds);
      toast.success(
        `Deleted ${deleteFileIds.length} file${deleteFileIds.length === 1 ? "" : "s"}`,
      );
      setDeleteDialogOpen(false);
      setDeleteFileIds([]);
      setSelectedFileIds(new Set());
      await refreshFiles();
      dispatchNavRefresh();
    } catch (error) {
      console.error("Failed to delete files:", error);
      toast.error("Failed to delete files");
    } finally {
      setIsDeleting(false);
    }
  }, [deleteFileIds, refreshFiles]);

  const handleDownloadSelected = useCallback(async () => {
    const ids = Array.from(selectedFileIds);
    if (ids.length === 0) return;

    const selectedFiles = files.filter((file) => selectedFileIds.has(file.id));
    if (selectedFiles.length === 0) {
      toast.error("No selected files available for download");
      return;
    }

    setIsDownloadingSelected(true);
    try {
      const downloads = await Promise.all(
        selectedFiles.map(async (file) => {
          try {
            const url = await getFileDownloadUrlAction(file.id);
            return { fileName: file.file_name, url };
          } catch {
            return null;
          }
        }),
      );

      let successCount = 0;
      for (const download of downloads) {
        if (!download) continue;
        try {
          await downloadUrlToFile(download.url, download.fileName);
          successCount += 1;
        } catch {
          // Skip failed files so other selected downloads can continue.
        }
      }

      if (successCount === 0) {
        toast.error("Failed to download selected files");
        return;
      }

      if (successCount < ids.length) {
        toast.success(
          `Downloaded ${successCount} of ${ids.length} selected files`,
        );
      } else {
        toast.success(
          `Downloading ${successCount} selected file${successCount === 1 ? "" : "s"}`,
        );
      }
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
      await uploadFileVersionAction(formData);
      const versions = await listFileVersionsAction(fileId);
      setVersionsByFile((prev) => ({
        ...prev,
        [fileId]: versions.map(mapVersion),
      }));
      await refreshFiles();
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

  const handleConfirmVersionUpload = useCallback(async () => {
    if (!versionTargetFile || !versionUploadFile) {
      toast.error("Choose a file for the new version");
      return;
    }

    setIsUploadingVersion(true);
    try {
      await uploadVersionForFile(
        versionTargetFile.id,
        versionUploadFile,
        versionLabel.trim() || undefined,
        versionNotes.trim() || undefined,
      );
      toast.success("New version uploaded");
      setVersionDialogOpen(false);
      resetVersionUploadDialog();
    } catch (error) {
      console.error("Failed to upload version:", error);
      toast.error("Failed to upload new version");
    } finally {
      setIsUploadingVersion(false);
    }
  }, [
    versionTargetFile,
    versionUploadFile,
    versionLabel,
    versionNotes,
    uploadVersionForFile,
    resetVersionUploadDialog,
  ]);

  const handleMakeCurrentVersion = useCallback(
    async (versionId: string) => {
      if (!viewerFile) return;
      await makeVersionCurrentAction(viewerFile.id, versionId);
      const versions = await listFileVersionsAction(viewerFile.id);
      setVersionsByFile((prev) => ({
        ...prev,
        [viewerFile.id]: versions.map(mapVersion),
      }));
      await refreshFiles();
    },
    [viewerFile, refreshFiles],
  );

  const handleDownloadVersion = useCallback(async (versionId: string) => {
    const url = await getVersionDownloadUrlAction(versionId);
    await downloadUrlToFile(url);
  }, []);

  const handleUpdateVersion = useCallback(
    async (versionId: string, updates: { label?: string; notes?: string }) => {
      await updateFileVersionAction(versionId, updates);
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
      await deleteFileVersionAction(versionId);
      if (viewerFile) {
        const versions = await listFileVersionsAction(viewerFile.id);
        setVersionsByFile((prev) => ({
          ...prev,
          [viewerFile.id]: versions.map(mapVersion),
        }));
        await refreshFiles();
      }
    },
    [viewerFile, refreshFiles],
  );

  const handleRenameFolder = useCallback((path: string) => {
    const parts = path.split("/").filter(Boolean);
    const name = parts[parts.length - 1] || "";
    setFolderRenamePath(path);
    setFolderRenameValue(name);
    setFolderRenameOpen(true);
  }, []);

  const onConfirmRenameFolder = async () => {
    if (!folderRenamePath || !folderRenameValue.trim()) return;
    setIsRenamingFolder(true);
    try {
      await renameFolderAction(projectId, folderRenamePath, folderRenameValue.trim());
      setFolderRenameOpen(false);
      await refreshFiles();
      await refreshFolderPermissions();
      toast.success("Folder renamed");
    } catch (error: any) {
      toast.error(error.message || "Failed to rename folder");
    } finally {
      setIsRenamingFolder(false);
    }
  };

  const handleDeleteFolder = useCallback((path: string) => {
    setFolderDeletePath(path);
    setFolderDeleteOpen(true);
  }, []);

  const onConfirmDeleteFolder = async () => {
    if (!folderDeletePath) return;
    setIsDeletingFolder(true);
    try {
      await deleteFolderAction(projectId, folderDeletePath);
      setFolderDeleteOpen(false);
      await refreshFiles();
      await refreshFolderPermissions();
      toast.success("Folder deleted");
    } catch (error: any) {
      toast.error(error.message || "Failed to delete folder");
    } finally {
      setIsDeletingFolder(false);
    }
  };

  const handleShareFolder = useCallback((path: string) => {
    const perms = folderPermissions.find(p => p.path === path);
    setFolderSharePath(path);
    setFolderShareWithClients(perms?.share_with_clients ?? false);
    setFolderShareWithSubs(perms?.share_with_subs ?? false);
    setFolderShareApplyToExisting(false);
    setFolderShareOpen(true);
  }, [folderPermissions]);

  const onConfirmShareFolder = async (applyToExisting: boolean = false) => {
    if (!folderSharePath) return;
    setIsSavingFolderShare(true);
    try {
      await updateFolderPermissionsAction(
        projectId,
        folderSharePath,
        {
          share_with_clients: folderShareWithClients,
          share_with_subs: folderShareWithSubs,
        },
        applyToExisting
      );
      setFolderShareOpen(false);
      await refreshFolderPermissions();
      if (applyToExisting) {
        await refreshFiles();
      }
      toast.success("Folder permissions updated");
    } catch (error: any) {
      toast.error(error.message || "Failed to update folder permissions");
    } finally {
      setIsSavingFolderShare(false);
    }
  };

  const handleViewerFileChange = useCallback((file: FileWithDetails) => {
    setViewerFile((prev) => (prev?.id === file.id ? prev : file));
    if (lastNotifiedViewerFileIdRef.current === file.id) {
      return;
    }
    lastNotifiedViewerFileIdRef.current = file.id;
    listFileVersionsAction(file.id).then((versions) => {
      setVersionsByFile((prev) => ({
        ...prev,
        [file.id]: versions.map(mapVersion),
      }));
    });
  }, []);

  const handleDownload = useCallback(async (file: FileWithDetails) => {
    try {
      const url = await getFileDownloadUrlAction(file.id);
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
          mime.startsWith("audio/")
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
          category: f.category as any,
        };
      });
  }, [files, viewerFile]);

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
  }, [propertiesFile, refreshPropertiesTimeline]);

  useEffect(() => {
    const breadcrumbs: Array<{ label: string; href?: string }> = [
      { label: "Documents", href: `/projects/${projectId}/documents` },
    ];

    const segments = activeBreadcrumbPath
      ? activeBreadcrumbPath.split("/").filter(Boolean)
      : [];

    segments.forEach((segment, index) => {
      const path = `/${segments.slice(0, index + 1).join("/")}`;
      breadcrumbs.push({
        label: segment,
        href: `/projects/${projectId}/documents?path=${encodeURIComponent(path)}`,
      });
    });

    if (propertiesFile) {
      breadcrumbs.push({ label: propertiesFile.file_name });
    }

    setBreadcrumbs(breadcrumbs);
  }, [activeBreadcrumbPath, projectId, propertiesFile, setBreadcrumbs]);

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

  const handleSendForApproval = useCallback(
    async (fileId: string) => {
      try {
        await updateFileAction(fileId, { status: "submitted" } as any);
        await refreshFiles();
        toast.success("Document submitted for approval");
      } catch (error) {
        toast.error("Failed to submit for approval");
      }
    },
    [refreshFiles],
  );

  const renderContent = () => {
    // If a drawing set is selected (via sidebar), show sheets
    if (selectedDrawingSetId) {
      return (
        <SheetsContent
          onSheetClick={handleSheetClick}
          onUploadDrawingSetClick={handleOpenDrawingSetUpload}
        />
      );
    }

    // Otherwise show files/folders
    return (
        <DocumentsContent
          onFileClick={handleFileClick}
          onDownloadFile={handleDownloadById}
          onFolderClick={handleFolderClick}
          onUploadClick={handleUploadClick}
          onDropOnFolder={handleDropOnFolder}
          selectedFileIds={selectedFileIds}
          selectedFolderPaths={selectedFolderPaths}
          onFileSelectionChange={handleFileSelectionChange}
          onFolderSelectionChange={handleFolderSelectionChange}
          onSelectAllVisibleFiles={handleSelectAllVisibleFiles}
        onRenameFile={openRenameDialog}
        onMoveFile={(fileId) => openMoveDialog(fileId)}
        onDeleteFile={(fileId) => openDeleteDialog(fileId)}
        onViewActivity={openTimeline}
        onShareFile={openShareDialog}
        onUploadNewVersion={openVersionUploadDialog}
        onSendForSignature={handleSendForSignature}
        onSendForApproval={handleSendForApproval}
        onOpenProperties={setPropertiesFileId}
        onFileDragStart={handleFileDragStart}
        onFileDragEnd={handleFileDragEnd}
        onDrawingSetClick={navigateToDrawingSet}
      />
    );
  };

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden bg-background"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <FileDropOverlay isVisible={isDraggingOver} className="rounded-none" />

      <div className="relative z-20 shrink-0 border-b bg-background/95 backdrop-blur-sm px-4 py-3">
        <DocumentsToolbar
          onUploadClick={handleUploadClick}
          onCreateFolderClick={() => {
            setNewFolderPath(currentPath || "");
            setCreateFolderDialogOpen(true);
          }}
          selectedCount={selectedFileIds.size}
          selectedFolderCount={selectedFolderPaths.size}
          onDownloadSelected={handleDownloadSelected}
          onMoveSelected={() => openMoveDialog()}
          onDeleteSelected={() => openDeleteDialog()}
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
          onDropToFolderPath={handleDropOnFolder}
          onDropToRoot={handleDropToRoot}
          isDraggingFiles={isDraggingDocumentFile}
          isDownloadingSelected={isDownloadingSelected}
          explorerOpen={explorerOpen}
          onToggleExplorer={() => setExplorerOpen((open) => !open)}
          activeFile={propertiesFile}
        />
      </div>

      <div className="relative z-10 flex min-h-0 flex-1">
        <aside
          className={cn(
            "hidden shrink-0 overflow-hidden border-r bg-background transition-[width,opacity] duration-200 ease-out lg:block",
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
        <ScrollArea className="h-full flex-1">
          {renderContent()}
        </ScrollArea>
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
              timelineEvents={propertiesTimelineEvents}
              timelineLoading={propertiesTimelineLoading}
              onRefreshTimeline={refreshPropertiesTimeline}
              onSendForSignature={handleSendForSignature}
              onSendForApproval={handleSendForApproval}
              onDelete={(fileId) => openDeleteDialog(fileId)}
            />
          </div>
        </aside>
      </div>

      <UploadDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        initialFiles={uploadFiles}
        projectId={projectId}
        folderPath={currentPath}
        folderOptions={folderOptions}
        onUploadComplete={refreshFiles}
      />

      <Dialog
        open={versionDialogOpen}
        onOpenChange={(open) => {
          setVersionDialogOpen(open);
          if (!open) {
            resetVersionUploadDialog();
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Upload New Version</DialogTitle>
            <DialogDescription>
              Replace the current file while preserving version history, approvals, and sharing.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {versionTargetFile ? (
              <div className="rounded-lg border bg-muted/20 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      Current version
                    </p>
                    <p className="truncate text-sm font-medium">
                      {versionTargetFile.file_name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      v{versionTargetFile.version_number ?? 1} • {formatFileSize(versionTargetFile.size_bytes)}
                    </p>
                  </div>
                  <div className="rounded-md border bg-background px-2.5 py-1 text-[11px] text-muted-foreground">
                    Existing metadata stays attached
                  </div>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  {[
                    "Version history",
                    "Sharing access",
                    "Workflow state",
                  ].map((item) => (
                    <div key={item} className="rounded-md border bg-background px-3 py-2 text-sm">
                      {item}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <input
              ref={versionFileInputRef}
              type="file"
              className="hidden"
              onChange={handleVersionFileChange}
              disabled={isUploadingVersion}
            />

            <Button
              type="button"
              variant="outline"
              onClick={() => versionFileInputRef.current?.click()}
              disabled={isUploadingVersion}
              className="h-auto w-full justify-start rounded-lg border-dashed px-4 py-4 text-left"
            >
              <div className="flex items-start gap-3">
                <FilePlus2 className="mt-0.5 h-4 w-4" />
                <div>
                  <p className="text-sm font-medium">
                    {versionUploadFile ? "Choose a different replacement file" : "Choose replacement file"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Upload the revised PDF, image, or document to become the latest version.
                  </p>
                </div>
              </div>
            </Button>

            {versionUploadFile ? (
              <div className="grid gap-3 rounded-lg border bg-background px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    Incoming file
                  </p>
                  <p className="truncate text-sm font-medium">
                    {versionUploadFile.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatFileSize(versionUploadFile.size)}
                  </p>
                </div>
                <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  Ready to publish as the latest version
                </div>
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="version-label">Version label</Label>
              <Input
                id="version-label"
                value={versionLabel}
                onChange={(event) => setVersionLabel(event.target.value)}
                placeholder="Addendum 2, owner comments, final"
                disabled={isUploadingVersion}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="version-notes">Notes</Label>
              <Textarea
                id="version-notes"
                value={versionNotes}
                onChange={(event) => setVersionNotes(event.target.value)}
                placeholder="What changed in this version?"
                disabled={isUploadingVersion}
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setVersionDialogOpen(false)}
              disabled={isUploadingVersion}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmVersionUpload}
              disabled={isUploadingVersion || !versionUploadFile}
            >
              {isUploadingVersion ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Uploading...
                </>
              ) : (
                "Upload version"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
          refreshFiles();
        }}
      />

      <Dialog
        open={drawingSetUploadOpen}
        onOpenChange={(open) => {
          setDrawingSetUploadOpen(open);
          if (!open) {
            resetDrawingSetUploadDialog();
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upload Drawing Set</DialogTitle>
            <DialogDescription>
              Upload a PDF and we&apos;ll split it into sheets automatically.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="drawing-set-title">Title</Label>
              <Input
                id="drawing-set-title"
                value={drawingSetTitle}
                onChange={(event) => setDrawingSetTitle(event.target.value)}
                placeholder="2026 Permit Set"
                disabled={drawingSetUploading}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="drawing-set-type">Type</Label>
              <select
                id="drawing-set-type"
                value={drawingSetType}
                onChange={(event) => setDrawingSetType(event.target.value)}
                disabled={drawingSetUploading}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {DRAWING_SET_TYPES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            <input
              ref={drawingSetFileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              className="hidden"
              onChange={handleDrawingSetFileChange}
              disabled={drawingSetUploading}
            />

            <Button
              type="button"
              variant="outline"
              onClick={() => drawingSetFileInputRef.current?.click()}
              disabled={drawingSetUploading}
              className="w-full justify-start"
            >
              Choose PDF file
            </Button>

            {drawingSetFile && (
              <div className="rounded-md border bg-muted/40 px-3 py-2">
                <p className="text-sm font-medium truncate">
                  {drawingSetFile.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {(drawingSetFile.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
            )}

            {drawingSetUploadStage && (
              <div className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{drawingSetUploadStage}</span>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDrawingSetUploadOpen(false)}
              disabled={drawingSetUploading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleUploadDrawingSet}
              disabled={drawingSetUploading || !drawingSetFile}
            >
              {drawingSetUploading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Uploading...
                </>
              ) : (
                "Upload drawing set"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      {drawingViewerOpen && drawingViewerSheet && (
        <DrawingViewer
          sheet={drawingViewerSheet}
          fileUrl={drawingViewerUrl ?? undefined}
          markups={drawingViewerMarkups}
          pins={drawingViewerPins}
          highlightedPinId={drawingViewerHighlightedPinId ?? undefined}
          onClose={closeDrawingViewer}
          onSaveMarkup={handleDrawingMarkupSave}
          onDeleteMarkup={handleDrawingMarkupDelete}
          onCreatePin={handleCreateDrawingPin}
          onPinClick={handleDrawingPinClick}
          sheets={drawingViewerSheets}
          onNavigateSheet={(sheet) => {
            void handleSheetClick(sheet, drawingViewerSheets);
          }}
          imageThumbnailUrl={drawingViewerSheet.image_thumbnail_url ?? null}
          imageMediumUrl={drawingViewerSheet.image_medium_url ?? null}
          imageFullUrl={drawingViewerSheet.image_full_url ?? null}
          imageWidth={drawingViewerSheet.image_width ?? null}
          imageHeight={drawingViewerSheet.image_height ?? null}
        />
      )}

      <CreateFromDrawingDialog
        open={createFromDrawingOpen}
        onOpenChange={(open) => {
          setCreateFromDrawingOpen(open);
          if (!open) {
            setCreateFromDrawingPosition(null);
          }
        }}
        onCreate={handleCreateFromDrawing}
        sheet={drawingViewerSheet}
        position={createFromDrawingPosition || { x: 0, y: 0 }}
        projectId={projectId}
      />

      <Dialog
        open={createFolderDialogOpen}
        onOpenChange={setCreateFolderDialogOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create folder</DialogTitle>
            <DialogDescription>
              Folders are virtual and support nested paths like{" "}
              <code>/contracts/subcontracts</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              placeholder="/contracts"
              value={newFolderPath}
              onChange={(event) => setNewFolderPath(event.target.value)}
              disabled={isCreatingFolder}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateFolderDialogOpen(false)}
              disabled={isCreatingFolder}
            >
              Cancel
            </Button>
            <Button onClick={handleCreateFolder} disabled={isCreatingFolder}>
              {isCreatingFolder ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={shareDialogOpen}
        onOpenChange={(open) => {
          setShareDialogOpen(open);
          if (!open) {
            setShareFile(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Share</DialogTitle>
            {shareFile ? (
              <DialogDescription className="truncate">
                {shareFile.file_name}
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <div className="max-h-[70vh] space-y-5 overflow-y-auto py-1 pr-1">
            <section className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Portals
              </p>
              <div className="divide-y rounded-lg border">
                <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Client portal</p>
                    <p className="text-xs text-muted-foreground">
                      Accessible to clients on the client portal.
                    </p>
                  </div>
                  <Switch
                    checked={shareWithClients}
                    onCheckedChange={(value) => setShareWithClients(Boolean(value))}
                    disabled={isSavingShare}
                  />
                </label>
                <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Subcontractor portal</p>
                    <p className="text-xs text-muted-foreground">
                      Accessible to subcontractors on the subcontractor portal.
                    </p>
                  </div>
                  <Switch
                    checked={shareWithSubs}
                    onCheckedChange={(value) => setShareWithSubs(Boolean(value))}
                    disabled={isSavingShare}
                  />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                {shareSummary(shareWithClients, shareWithSubs)}
              </p>
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Public links
                </p>
                <p className="text-xs text-muted-foreground">
                  Anyone with the link
                </p>
              </div>

              <div className="rounded-lg border p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[10rem] flex-1">
                    <Label className="text-xs text-muted-foreground">Label (optional)</Label>
                    <Input
                      value={shareLinkLabel}
                      onChange={(event) => setShareLinkLabel(event.target.value)}
                      placeholder="e.g. Inspector, Lender"
                      disabled={isCreatingShareLink}
                      className="h-9"
                    />
                  </div>
                  <div className="w-[7rem]">
                    <Label className="text-xs text-muted-foreground">Expires</Label>
                    <Select
                      value={shareLinkExpiry}
                      onValueChange={(value) =>
                        setShareLinkExpiry(value as "7d" | "30d" | "never")
                      }
                      disabled={isCreatingShareLink}
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="7d">7 days</SelectItem>
                        <SelectItem value="30d">30 days</SelectItem>
                        <SelectItem value="never">Never</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <label className="mt-3 flex cursor-pointer items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm">Allow download</p>
                    <p className="text-xs text-muted-foreground">
                      Off = view/preview only.
                    </p>
                  </div>
                  <Switch
                    checked={shareLinkAllowDownload}
                    onCheckedChange={(value) => setShareLinkAllowDownload(Boolean(value))}
                    disabled={isCreatingShareLink}
                  />
                </label>
                <Button
                  type="button"
                  onClick={handleCreateShareLink}
                  disabled={isCreatingShareLink || !shareFile}
                  size="sm"
                  className="mt-3 w-full"
                >
                  {isCreatingShareLink ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Creating
                    </>
                  ) : (
                    <>
                      <Link2 className="mr-2 h-4 w-4" />
                      Create link
                    </>
                  )}
                </Button>
              </div>

              {shareLinksLoading ? (
                <p className="px-1 text-xs text-muted-foreground">Loading links…</p>
              ) : shareLinks.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">
                  No public links yet.
                </p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {shareLinks.map((link) => {
                    const expiry = link.expires_at
                      ? new Date(link.expires_at).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })
                      : "Never";
                    const statusLabel = link.revoked_at
                      ? "Revoked"
                      : !link.is_active
                        ? "Expired"
                        : `Expires ${expiry}`;
                    return (
                      <li
                        key={link.id}
                        className="flex items-center gap-2 px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">
                            {link.label || "Untitled link"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {statusLabel}
                            {link.allow_download ? "" : " · View only"}
                            {link.use_count > 0
                              ? ` · ${link.use_count} view${link.use_count === 1 ? "" : "s"}`
                              : ""}
                          </p>
                        </div>
                        {link.is_active ? (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleCopyShareLink(link)}
                              title="Copy link"
                            >
                              {copiedShareLinkId === link.id ? (
                                <Check className="h-4 w-4 text-primary" />
                              ) : (
                                <Copy className="h-4 w-4" />
                              )}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => handleRevokeShareLink(link)}
                              disabled={revokingShareLinkId === link.id}
                              title="Revoke link"
                            >
                              {revokingShareLinkId === link.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <X className="h-4 w-4" />
                              )}
                            </Button>
                          </>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setShareDialogOpen(false)}
              disabled={isSavingShare}
            >
              Cancel
            </Button>
            <Button
              onClick={handleShareConfirm}
              disabled={isSavingShare || !shareFile}
            >
              {isSavingShare ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename file</DialogTitle>
            <DialogDescription>
              Update the file name shown in Documents.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              disabled={isRenaming}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameDialogOpen(false)}
              disabled={isRenaming}
            >
              Cancel
            </Button>
            <Button onClick={handleRenameConfirm} disabled={isRenaming}>
              {isRenaming ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={moveDialogOpen} onOpenChange={setMoveDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Move files</DialogTitle>
            <DialogDescription>
              Pick a destination from your existing folders. Create a new folder only when you need one.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/20 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    Selected
                  </p>
                  <p className="mt-2 text-sm">
                    Move {moveFileIds.length} file{moveFileIds.length === 1 ? "" : "s"} to{" "}
                    <span className="font-medium">{moveTargetFolder || "Root"}</span>.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isMoving}
                  onClick={() => {
                    setMoveDialogOpen(false);
                    setNewFolderPath(moveSearchQuery.trim() ? `/${moveSearchQuery.trim().replace(/^\/+/, "")}` : currentPath || "");
                    setCreateFolderDialogOpen(true);
                  }}
                >
                  New folder
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {moveFileIds.slice(0, 3).map((fileId) => {
                  const file = files.find((item) => item.id === fileId);
                  if (!file) return null;
                  return (
                    <div key={fileId} className="max-w-full rounded-md border bg-background px-3 py-1.5 text-sm">
                      <span className="block truncate">{file.file_name}</span>
                    </div>
                  );
                })}
                {moveFileIds.length > 3 ? (
                  <div className="rounded-md border bg-background px-3 py-1.5 text-sm text-muted-foreground">
                    +{moveFileIds.length - 3} more
                  </div>
                ) : null}
              </div>
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Filter folders"
                value={moveSearchQuery}
                onChange={(event) => setMoveSearchQuery(event.target.value)}
                className="pl-9"
                disabled={isMoving}
              />
            </div>

            <div className="grid gap-2">
              <button
                type="button"
                onClick={() => setMoveTargetFolder("")}
                className={cn(
                  "flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors",
                  moveTargetFolder === "" ? "border-primary bg-primary/5" : "hover:bg-muted/40",
                )}
                disabled={isMoving}
              >
                <div className="flex items-center gap-3">
                  <div className="rounded-md bg-muted p-2 text-muted-foreground">
                    <FolderClosed className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Root</p>
                    <p className="text-xs text-muted-foreground">Keep these files at the top level.</p>
                  </div>
                </div>
                {moveTargetFolder === "" ? <Check className="h-4 w-4 text-primary" /> : null}
              </button>
              <ScrollArea className="max-h-64 rounded-lg border">
                <div className="space-y-1 p-2">
                  {filteredMoveFolderOptions.length === 0 ? (
                    <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                      No folders match that search. Use New folder to add one first.
                    </div>
                  ) : (
                    filteredMoveFolderOptions.map((folder) => (
                      <button
                        key={folder}
                        type="button"
                        onClick={() => setMoveTargetFolder(folder)}
                        className={cn(
                          "flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors",
                          moveTargetFolder === folder ? "bg-primary/10 text-primary" : "hover:bg-muted/40",
                        )}
                        disabled={isMoving}
                      >
                        <span className="truncate">{folder}</span>
                        {moveTargetFolder === folder ? <Check className="h-4 w-4 shrink-0" /> : null}
                      </button>
                    ))
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMoveDialogOpen(false)}
              disabled={isMoving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleMoveConfirm}
              disabled={isMoving || moveFileIds.length === 0}
            >
              {isMoving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Moving...
                </>
              ) : (
                "Move"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete files?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {deleteFileIds.length} file
              {deleteFileIds.length === 1 ? "" : "s"}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Folder Rename Dialog */}
      <Dialog open={folderRenameOpen} onOpenChange={setFolderRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename folder</DialogTitle>
            <DialogDescription>
              This will update the path for all files inside this folder.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              value={folderRenameValue}
              onChange={(e) => setFolderRenameValue(e.target.value)}
              placeholder="Folder name"
              disabled={isRenamingFolder}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderRenameOpen(false)} disabled={isRenamingFolder}>
              Cancel
            </Button>
            <Button onClick={onConfirmRenameFolder} disabled={isRenamingFolder || !folderRenameValue.trim()}>
              {isRenamingFolder ? "Renaming..." : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Folder Delete Dialog */}
      <AlertDialog open={folderDeleteOpen} onOpenChange={setFolderDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete folder?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this folder? This action cannot be undone and will also remove any folder-specific sharing defaults.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingFolder}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onConfirmDeleteFolder}
              disabled={isDeletingFolder}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeletingFolder ? "Deleting..." : "Delete Folder"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={folderShareOpen} onOpenChange={setFolderShareOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share folder</DialogTitle>
            <DialogDescription className="truncate">
              {folderSharePath || "Root"}
            </DialogDescription>
          </DialogHeader>
          <div className="py-1">
            <div className="divide-y rounded-lg border">
              <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Client portal</p>
                  <p className="text-xs text-muted-foreground">
                    New uploads default to the client portal.
                  </p>
                </div>
                <Switch
                  checked={folderShareWithClients}
                  onCheckedChange={(value) => setFolderShareWithClients(Boolean(value))}
                  disabled={isSavingFolderShare}
                />
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Subcontractor portal</p>
                  <p className="text-xs text-muted-foreground">
                    New uploads default to the subcontractor portal.
                  </p>
                </div>
                <Switch
                  checked={folderShareWithSubs}
                  onCheckedChange={(value) => setFolderShareWithSubs(Boolean(value))}
                  disabled={isSavingFolderShare}
                />
              </label>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {shareSummary(folderShareWithClients, folderShareWithSubs)}
            </p>
            <label className="mt-4 flex cursor-pointer items-start gap-2">
              <Checkbox
                checked={folderShareApplyToExisting}
                onCheckedChange={(value) => setFolderShareApplyToExisting(Boolean(value))}
                disabled={isSavingFolderShare}
                className="mt-0.5"
              />
              <span className="text-xs text-muted-foreground">
                Apply to existing files in this folder. Otherwise, only new uploads are affected.
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setFolderShareOpen(false)}
              disabled={isSavingFolderShare}
            >
              Cancel
            </Button>
            <Button
              onClick={() => onConfirmShareFolder(folderShareApplyToExisting)}
              disabled={isSavingFolderShare}
            >
              {isSavingFolderShare ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
