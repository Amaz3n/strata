"use client"

import { useState } from "react"
import { Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { unwrapAction } from "@/lib/action-result"
import type { PhotoAlbum } from "@/lib/services/photos"
import { createPhotoAlbumAction, deletePhotoAlbumAction, renamePhotoAlbumAction } from "./actions"

interface PhotoAlbumsDialogProps {
  projectId: string
  albums: PhotoAlbum[]
  canEdit: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onAlbumsChange: (albums: PhotoAlbum[]) => void
}

/**
 * Albums, which the schema has always had and nothing could ever create. The
 * filter existed, the column existed, and the only way to get a row into
 * `photo_albums` was to write one by hand.
 */
export function PhotoAlbumsDialog({
  projectId,
  albums,
  canEdit,
  open,
  onOpenChange,
  onAlbumsChange,
}: PhotoAlbumsDialogProps) {
  const [name, setName] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState("")
  const [pending, setPending] = useState(false)

  async function run<T>(work: () => Promise<T>, onDone: (result: T) => void) {
    setPending(true)
    try {
      onDone(await work())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Album could not be saved")
    } finally {
      setPending(false)
    }
  }

  function handleCreate() {
    const trimmed = name.trim()
    if (trimmed.length < 2) {
      toast.error("Give the album a name")
      return
    }
    void run(
      async () => unwrapAction(await createPhotoAlbumAction({ project_id: projectId, name: trimmed })),
      (next) => {
        onAlbumsChange(next)
        setName("")
        toast.success(`Album "${trimmed}" created`)
      },
    )
  }

  function handleRename(album: PhotoAlbum) {
    const trimmed = editingName.trim()
    if (trimmed.length < 2) {
      toast.error("Give the album a name")
      return
    }
    void run(
      async () => unwrapAction(await renamePhotoAlbumAction({ project_id: projectId, album_id: album.id, name: trimmed })),
      (next) => {
        onAlbumsChange(next)
        setEditingId(null)
        toast.success("Album renamed")
      },
    )
  }

  function handleDelete(album: PhotoAlbum) {
    void run(
      async () => unwrapAction(await deletePhotoAlbumAction({ project_id: projectId, album_id: album.id })),
      (result) => {
        onAlbumsChange(result.albums)
        toast.success(
          result.released > 0
            ? `Album deleted — ${result.released} photo${result.released === 1 ? "" : "s"} returned to unfiled`
            : "Album deleted",
        )
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Albums</DialogTitle>
          <DialogDescription>
            Group photos for a walkthrough, a phase, or a client update. Deleting an album never deletes photos.
          </DialogDescription>
        </DialogHeader>

        {canEdit && (
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  handleCreate()
                }
              }}
              placeholder="New album name"
              className="h-9"
              disabled={pending}
            />
            <Button size="sm" className="h-9" onClick={handleCreate} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Create
            </Button>
          </div>
        )}

        <div className="max-h-72 divide-y overflow-y-auto border">
          {albums.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">No albums yet</p>
          ) : (
            albums.map((album) => (
              <div key={album.id} className="flex items-center gap-2 px-3 py-2">
                {editingId === album.id ? (
                  <>
                    <Input
                      value={editingName}
                      onChange={(event) => setEditingName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault()
                          handleRename(album)
                        }
                        if (event.key === "Escape") setEditingId(null)
                      }}
                      className="h-8"
                      autoFocus
                      disabled={pending}
                    />
                    <Button size="icon" variant="ghost" className="size-8 shrink-0" onClick={() => handleRename(album)} disabled={pending} aria-label="Save name">
                      <Check className="size-4" />
                    </Button>
                    <Button size="icon" variant="ghost" className="size-8 shrink-0" onClick={() => setEditingId(null)} disabled={pending} aria-label="Cancel">
                      <X className="size-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm">{album.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {album.photo_count}
                    </span>
                    {canEdit && (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8 shrink-0"
                          onClick={() => {
                            setEditingId(album.id)
                            setEditingName(album.name)
                          }}
                          disabled={pending}
                          aria-label={`Rename ${album.name}`}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDelete(album)}
                          disabled={pending}
                          aria-label={`Delete ${album.name}`}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </>
                    )}
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
