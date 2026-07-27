"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Camera } from "@/components/icons"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { AppearanceSettings } from "@/components/settings/appearance-settings"
import { DevicesField } from "@/components/settings/devices-field"
import { PasswordField } from "@/components/settings/password-field"
import { SettingsError, SettingsField, SettingsGroup } from "@/components/settings/settings-section"
import { TwoFactorField } from "@/components/settings/two-factor-field"
import { updateUserAvatarAction } from "@/app/(app)/settings/actions"
import { unwrapAction } from "@/lib/action-result"
import type { User } from "@/lib/types"
import { cn } from "@/lib/utils"

const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]
const MAX_AVATAR_BYTES = 5 * 1024 * 1024
const PHOTO_HINT = "PNG, JPG, WEBP, or SVG. 5MB max."

function getInitials(fullName: string | null | undefined, email: string | null | undefined) {
  const source = fullName?.trim() || email?.trim()
  if (!source) return "?"
  return source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

export function ProfilePanel({
  user,
  roleLabel,
  roleLoading = false,
}: {
  user: User | null
  roleLabel: string | null
  roleLoading?: boolean
}) {
  const router = useRouter()
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user?.avatar_url ?? null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [isUpdatingPhoto, startPhotoUpdate] = useTransition()
  const photoInputRef = useRef<HTMLInputElement | null>(null)

  const name = user?.full_name?.trim() || ""
  const email = user?.email?.trim() || ""
  // Name isn't self-editable, so fall back to the email rather than a placeholder that
  // reads like the person is literally named "Your name". Only repeat the email below
  // when it isn't already standing in as the heading.
  const heading = name || email || "Your account"
  const showEmailLine = Boolean(email) && email !== heading

  useEffect(() => {
    setAvatarUrl(user?.avatar_url ?? null)
  }, [user?.avatar_url])

  useEffect(() => {
    // Revokes the previous object URL whenever the preview swaps or unmounts.
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const initials = getInitials(name, email)

  const handlePhotoSelection = (file: File | null) => {
    if (!file || isUpdatingPhoto) return

    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setPhotoError("That file type isn't supported. Use PNG, JPG, WEBP, or SVG.")
      return
    }

    if (file.size > MAX_AVATAR_BYTES) {
      setPhotoError("That photo is larger than 5MB. Pick a smaller one.")
      return
    }

    setPreviewUrl(URL.createObjectURL(file))
    setPhotoError(null)

    startPhotoUpdate(async () => {
      try {
        const payload = new FormData()
        payload.set("avatar", file)
        const result = unwrapAction(await updateUserAvatarAction(payload))

        if (result?.error) {
          setPhotoError(result.error)
          setPreviewUrl(null)
          return
        }

        setAvatarUrl(result.avatarUrl ?? null)
        setPreviewUrl(null)
        router.refresh()
        toast.success("Profile photo updated")
      } catch (error) {
        // An unexpected throw (e.g. session expiry) surfaces here rather than as a
        // silent rejection that would leave the local preview stuck on screen.
        setPhotoError(error instanceof Error ? error.message : "Couldn't update your photo. Try again.")
        setPreviewUrl(null)
      } finally {
        if (photoInputRef.current) photoInputRef.current.value = ""
      }
    })
  }

  const handlePhotoRemove = () => {
    setPhotoError(null)
    startPhotoUpdate(async () => {
      try {
        const payload = new FormData()
        payload.set("remove", "true")
        const result = unwrapAction(await updateUserAvatarAction(payload))

        if (result?.error) {
          setPhotoError(result.error)
          return
        }

        setAvatarUrl(null)
        setPreviewUrl(null)
        router.refresh()
        toast.success("Profile photo removed")
      } catch (error) {
        setPhotoError(error instanceof Error ? error.message : "Couldn't remove your photo. Try again.")
      } finally {
        if (photoInputRef.current) photoInputRef.current.value = ""
      }
    })
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-5 py-6 lg:px-8 lg:py-8">
      <SettingsGroup title="Account">
        {/* Identity: the avatar is the only thing you can change here — an admin owns your
            name and email, so they read as fact, not fields. */}
        <div
          className="py-4"
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return
            // Swallow the drop even while busy, so the browser never navigates to the file.
            event.preventDefault()
            if (!isUpdatingPhoto) setDragging(true)
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
            setDragging(false)
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return
            event.preventDefault()
            setDragging(false)
            handlePhotoSelection(event.dataTransfer.files?.[0] ?? null)
          }}
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <button
              type="button"
              onClick={() => photoInputRef.current?.click()}
              disabled={isUpdatingPhoto}
              aria-label={avatarUrl ? "Change profile photo" : "Upload a profile photo"}
              title={PHOTO_HINT}
              className={cn(
                "group relative size-16 shrink-0 border border-border transition-shadow",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                dragging && "border-primary ring-2 ring-primary/40",
              )}
            >
              <Avatar className="size-full rounded-none">
                <AvatarImage src={previewUrl ?? avatarUrl ?? undefined} alt="" className="object-cover" />
                <AvatarFallback className="rounded-none bg-muted text-base font-semibold text-muted-foreground">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <span
                className={cn(
                  "absolute inset-0 flex items-center justify-center bg-foreground/55 text-background opacity-0 transition-opacity duration-150",
                  "group-hover:opacity-100 group-focus-visible:opacity-100",
                  (isUpdatingPhoto || dragging) && "opacity-100",
                )}
              >
                {isUpdatingPhoto ? <Spinner className="size-4" /> : <Camera className="size-4" />}
              </span>
              {/* Resting-state affordance: with no upload button, this signals the avatar is editable
                  even without hover (touch). It yields to the full overlay on hover/focus. */}
              <span
                className={cn(
                  "pointer-events-none absolute -bottom-1 -right-1 flex size-5 items-center justify-center border border-border bg-background text-muted-foreground transition-opacity",
                  "group-hover:opacity-0 group-focus-visible:opacity-0",
                  (isUpdatingPhoto || dragging) && "opacity-0",
                )}
              >
                <Camera className="size-3" />
              </span>
            </button>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="truncate text-base font-medium leading-6 text-foreground">{heading}</p>
                {roleLoading ? (
                  <Skeleton className="h-5 w-16 rounded-none" />
                ) : roleLabel ? (
                  <span
                    title="Your role is set by an organization admin."
                    className="border border-border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
                  >
                    {roleLabel}
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 truncate text-sm text-muted-foreground">
                {dragging ? "Drop the image to use it as your photo" : showEmailLine ? email : "Managed by your admin"}
              </p>
            </div>

            <input
              ref={photoInputRef}
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(",")}
              className="hidden"
              onChange={(event) => handlePhotoSelection(event.target.files?.[0] ?? null)}
              disabled={isUpdatingPhoto}
            />
            {avatarUrl ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onClick={handlePhotoRemove}
                disabled={isUpdatingPhoto}
              >
                Remove
              </Button>
            ) : null}
          </div>

          {photoError ? <SettingsError className="mt-3">{photoError}</SettingsError> : null}
        </div>

        <PasswordField />
        <TwoFactorField />

        <SettingsField label="Devices" hint="Where your account is signed in right now.">
          <DevicesField />
        </SettingsField>
      </SettingsGroup>

      <AppearanceSettings />
    </div>
  )
}
