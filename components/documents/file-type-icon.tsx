import {
  Archive,
  File,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
  Mail,
  PencilRuler,
  Presentation,
  Table2,
} from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * One file-type mapping for the whole Documents surface.
 *
 * Resolution is mime-first, extension-second: construction file types that
 * matter here (DWG, DXF, RVT, IFC) have no registered mime type and arrive as
 * `application/octet-stream`, so the extension is the only signal. Uploads also
 * reach us with a blank mime from some mobile and portal paths.
 */

type IconComponent = React.ElementType

/** Longest-prefix wins, so specific Office types beat the generic families. */
const MIME_ICONS: Array<[string, IconComponent]> = [
  ["application/vnd.openxmlformats-officedocument.spreadsheetml", FileSpreadsheet],
  ["application/vnd.openxmlformats-officedocument.presentationml", Presentation],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml", FileType],
  ["application/vnd.ms-excel", FileSpreadsheet],
  ["application/vnd.ms-powerpoint", Presentation],
  ["application/msword", FileType],
  ["application/pdf", FileText],
  ["application/zip", Archive],
  ["application/x-7z-compressed", Archive],
  ["application/vnd.rar", Archive],
  ["application/gzip", Archive],
  ["text/csv", Table2],
  ["image/", FileImage],
  ["video/", FileVideo],
  ["audio/", FileAudio],
  ["text/", FileCode],
]

const EXTENSION_ICONS: Record<string, IconComponent> = {
  // Design and CAD — no registered mime type, so extension is the only signal.
  dwg: PencilRuler,
  dxf: PencilRuler,
  dwf: PencilRuler,
  rvt: PencilRuler,
  rfa: PencilRuler,
  ifc: PencilRuler,
  skp: PencilRuler,
  nwd: PencilRuler,
  // Documents
  pdf: FileText,
  doc: FileType,
  docx: FileType,
  rtf: FileType,
  txt: FileText,
  // Spreadsheets
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  xlsm: FileSpreadsheet,
  csv: Table2,
  // Presentations
  ppt: Presentation,
  pptx: Presentation,
  // Archives
  zip: Archive,
  rar: Archive,
  "7z": Archive,
  gz: Archive,
  tar: Archive,
  // Mail
  msg: Mail,
  eml: Mail,
  // Media
  heic: FileImage,
  heif: FileImage,
  avif: FileImage,
  webp: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  png: FileImage,
  gif: FileImage,
  tif: FileImage,
  tiff: FileImage,
  mp4: FileVideo,
  mov: FileVideo,
  webm: FileVideo,
  mp3: FileAudio,
  wav: FileAudio,
  m4a: FileAudio,
  // Code / data
  json: FileCode,
  xml: FileCode,
  md: FileText,
}

function extensionOf(fileName?: string | null): string | null {
  if (!fileName) return null
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim())
  return match ? match[1].toLowerCase() : null
}

export function getFileIcon(mimeType?: string | null, fileName?: string | null): IconComponent {
  const mime = mimeType?.toLowerCase()

  // A generic binary mime carries no information — go straight to the extension.
  const mimeIsGeneric =
    !mime || mime === "application/octet-stream" || mime === "binary/octet-stream"

  if (!mimeIsGeneric) {
    for (const [prefix, Icon] of MIME_ICONS) {
      if (mime.startsWith(prefix)) return Icon
    }
  }

  const extension = extensionOf(fileName)
  if (extension && EXTENSION_ICONS[extension]) {
    return EXTENSION_ICONS[extension]
  }

  return File
}

interface FileTypeIconProps {
  mimeType?: string | null
  fileName?: string | null
  className?: string
}

/** The icon alone, for callers that render their own container. */
export function FileTypeIcon({ mimeType, fileName, className }: FileTypeIconProps) {
  const Icon = getFileIcon(mimeType, fileName)
  return <Icon className={cn("h-4 w-4 text-muted-foreground", className)} aria-hidden />
}

interface FileThumbnailProps {
  fileName: string
  mimeType?: string | null
  /**
   * Generated preview. Present for every type the preview pipeline covers —
   * PDF and DOCX included, not only images.
   */
  thumbnailUrl?: string | null
  /** Tailwind size classes for the box, e.g. "h-8 w-8". */
  className?: string
  iconClassName?: string
}

/**
 * A file's visual identity: its generated preview when one exists, otherwise a
 * type icon.
 *
 * Deliberately does NOT fall back to the original file when no preview exists —
 * that streamed a full-resolution photo into a 32px box.
 */
export function FileThumbnail({
  fileName,
  mimeType,
  thumbnailUrl,
  className,
  iconClassName,
}: FileThumbnailProps) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden bg-muted",
        className,
      )}
    >
      {thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <FileTypeIcon mimeType={mimeType} fileName={fileName} className={iconClassName} />
      )}
    </div>
  )
}
