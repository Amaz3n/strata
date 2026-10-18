"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type MouseEvent,
} from "react";
import {
  FileQuestion,
  FileText,
  Loader2,
  MessageSquareText,
  Minus,
  Paperclip,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const ACCEPTED_RECEIPT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const MAX_RECEIPT_BYTES = 20 * 1024 * 1024;
const PREVIEW_RETRY_DELAYS = [1_500, 3_000, 5_000];

export type BankingReceiptUpload = {
  fileId: string;
  fileName: string;
  mimeType: string;
};

export function BankingReceiptCell({
  transactionId,
  receiptCount,
  receiptFileId,
  receiptFileName,
  receiptMimeType,
  receiptStatus,
  canEdit,
  canEditMemo,
  memo,
  onOpen,
  onMemoChange,
  onReceiptUploaded,
}: {
  transactionId: string;
  receiptCount: number;
  receiptFileId: string | null;
  receiptFileName: string | null;
  receiptMimeType: string | null;
  receiptStatus?: "missing" | "requested" | "received" | "not_required";
  canEdit: boolean;
  canEditMemo: boolean;
  memo: string;
  onOpen?: () => void;
  onMemoChange?: (memo: string) => void;
  onReceiptUploaded?: (receipt: BankingReceiptUpload) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const previewRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [optimisticReceipt, setOptimisticReceipt] =
    useState<BankingReceiptUpload | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
  const [memoOpen, setMemoOpen] = useState(false);
  const [memoDraft, setMemoDraft] = useState(memo);

  const fileId = optimisticReceipt?.fileId ?? receiptFileId;
  const fileName = optimisticReceipt?.fileName ?? receiptFileName;
  const mimeType = optimisticReceipt?.mimeType ?? receiptMimeType;
  const count = receiptCount + (optimisticReceipt && !receiptFileId ? 1 : 0);

  useEffect(() => {
    setPreviewAttempt(0);
    setPreviewUnavailable(false);
    return () => {
      if (previewRetryRef.current) clearTimeout(previewRetryRef.current);
    };
  }, [fileId]);

  useEffect(() => {
    if (receiptFileId === optimisticReceipt?.fileId) setOptimisticReceipt(null);
  }, [optimisticReceipt?.fileId, receiptFileId]);

  useEffect(() => setMemoDraft(memo), [memo]);

  async function upload(file: File) {
    if (!canEdit || uploading) return;
    if (!ACCEPTED_RECEIPT_TYPES.has(file.type)) {
      toast.error("Choose a PDF, JPG, PNG, WebP, HEIC, or HEIF receipt.");
      return;
    }
    if (file.size > MAX_RECEIPT_BYTES) {
      toast.error("Receipt files must be 20 MB or smaller.");
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("transactionId", transactionId);
      const response = await fetch("/api/books/receipts", {
        method: "POST",
        body: form,
      });
      const result = (await response.json()) as {
        success?: boolean;
        data?: { fileId?: string };
        error?: string;
      };
      if (!response.ok || !result.success || !result.data?.fileId)
        throw new Error(result.error ?? "Receipt upload failed");
      const receipt = {
        fileId: result.data.fileId,
        fileName: file.name,
        mimeType: file.type,
      };
      setOptimisticReceipt(receipt);
      onReceiptUploaded?.(receipt);
      toast.success("Receipt attached");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Receipt upload failed",
      );
    } finally {
      setUploading(false);
    }
  }

  function chooseFile(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (fileId || count > 0) {
      if (onOpen) onOpen();
      else if (fileId)
        window.open(
          `/api/files/${fileId}/raw`,
          "_blank",
          "noopener,noreferrer",
        );
      return;
    }
    if (canEdit) inputRef.current?.click();
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    event.stopPropagation();
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void upload(file);
  }

  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (event.dataTransfer.files.length > 1)
      toast.info(
        "Attach one receipt at a time; only the first file was added.",
      );
    if (file) void upload(file);
  }

  function handlePreviewError() {
    if (previewAttempt >= PREVIEW_RETRY_DELAYS.length) {
      setPreviewUnavailable(true);
      return;
    }
    setPreviewUnavailable(true);
    previewRetryRef.current = setTimeout(() => {
      setPreviewAttempt((attempt) => attempt + 1);
      setPreviewUnavailable(false);
    }, PREVIEW_RETRY_DELAYS[previewAttempt]);
  }

  const hasReceipt = Boolean(fileId || count > 0);
  const tooltip = hasReceipt
    ? `${fileName ?? "Receipt"}${count > 1 ? ` and ${count - 1} more` : ""}`
    : receiptStatus === "not_required"
      ? "Receipt not required"
      : receiptStatus === "requested"
        ? "Receipt requested"
        : canEdit
          ? "Missing receipt · click or drop a file to attach"
          : "Missing receipt";
  const isDirectImage = Boolean(
    fileId &&
    mimeType?.startsWith("image/") &&
    mimeType !== "image/heic" &&
    mimeType !== "image/heif",
  );
  const previewUrl = fileId
    ? isDirectImage
      ? `/api/files/${fileId}/raw`
      : `/api/files/${fileId}/preview?w=96&attempt=${previewAttempt}`
    : null;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center gap-1">
        <Tooltip>
          <div className="relative size-9">
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "relative flex size-9 items-center justify-center overflow-hidden border border-transparent outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                  canEdit && "hover:border-border hover:bg-muted/60",
                  dragging && "border-primary bg-primary/10 text-primary",
                )}
                aria-label={tooltip}
                disabled={uploading}
                aria-disabled={!canEdit && !hasReceipt}
                onClick={chooseFile}
                onDragEnter={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (canEdit) setDragging(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setDragging(false);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onDrop={onDrop}
              >
                {uploading ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : fileId ? (
                  previewUnavailable ? (
                    mimeType === "application/pdf" ? (
                      <FileText className="size-4 text-muted-foreground" />
                    ) : (
                      <Paperclip className="size-4 text-muted-foreground" />
                    )
                  ) : (
                    // The authenticated thumbnail route serves generated previews
                    // for images and PDFs without embedding the full document.
                    <img
                      key={`${fileId}:${previewAttempt}`}
                      src={previewUrl!}
                      alt=""
                      className="size-8 object-cover"
                      loading="lazy"
                      decoding="async"
                      onError={handlePreviewError}
                    />
                  )
                ) : count > 0 ? (
                  <Paperclip className="size-4 text-muted-foreground" />
                ) : receiptStatus === "not_required" ? (
                  <Minus className="size-4 text-muted-foreground" />
                ) : (
                  <FileQuestion className="size-4 text-muted-foreground" />
                )}
                {count > 1 ? (
                  <span className="absolute -right-1 -top-1 min-w-4 bg-foreground px-1 text-center text-[9px] font-semibold leading-4 text-background">
                    {count}
                  </span>
                ) : null}
              </button>
            </TooltipTrigger>
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif"
              onClick={(event) => event.stopPropagation()}
              onChange={onFileChange}
            />
          </div>
          <TooltipContent side="top">{tooltip}</TooltipContent>
        </Tooltip>
        <Popover open={memoOpen} onOpenChange={setMemoOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "relative flex size-9 items-center justify-center text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    memo && "text-foreground",
                  )}
                  aria-label={
                    memo ? "Edit transaction memo" : "Add transaction memo"
                  }
                >
                  <MessageSquareText className="size-4" />
                  {memo ? (
                    <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary" />
                  ) : null}
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">
              {memo ? "Edit memo" : "Add memo"}
            </TooltipContent>
          </Tooltip>
          <PopoverContent
            align="end"
            className="w-72 space-y-3 p-3"
            onClick={(event) => event.stopPropagation()}
          >
            <label
              className="text-xs font-medium"
              htmlFor={`bank-memo-${transactionId}`}
            >
              Transaction memo
            </label>
            <Textarea
              id={`bank-memo-${transactionId}`}
              autoFocus
              rows={3}
              maxLength={200}
              disabled={!canEditMemo}
              value={memoDraft}
              placeholder="Add an internal note…"
              onChange={(event) => setMemoDraft(event.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setMemoDraft(memo);
                  setMemoOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!canEditMemo || memoDraft === memo}
                onClick={() => {
                  onMemoChange?.(memoDraft.trim());
                  setMemoOpen(false);
                }}
              >
                Save memo
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </TooltipProvider>
  );
}
