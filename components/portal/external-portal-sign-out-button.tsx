"use client"

import type { ComponentProps } from "react"
import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { LogOut } from "lucide-react"
import { toast } from "sonner"

import { signOutExternalPortalAccountAction } from "@/app/actions/external-portal-auth"
import { Button } from "@/components/ui/button"

interface ExternalPortalSignOutButtonProps {
  className?: string
  label?: string
  redirectTo?: string
  size?: ComponentProps<typeof Button>["size"]
  variant?: ComponentProps<typeof Button>["variant"]
}

export function ExternalPortalSignOutButton({
  className,
  label = "Sign out",
  redirectTo = "/access",
  size = "sm",
  variant = "outline",
}: ExternalPortalSignOutButtonProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  return (
    <Button
      className={className}
      size={size}
      variant={variant}
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          try {
            await signOutExternalPortalAccountAction()
            router.push(redirectTo)
            router.refresh()
          } catch (error: any) {
            toast.error(error?.message ?? "Unable to sign out")
          }
        })
      }}
    >
      <LogOut className="h-4 w-4" />
      {isPending ? "Signing out..." : label}
    </Button>
  )
}
