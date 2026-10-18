import type { ReactNode } from "react"
import Link from "next/link"

import { AuthArc } from "@/components/auth/auth-arc"
import { ArcMark } from "@/components/brand/arc-mark"

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    // The night field is always dark, so the auth surface pins itself to the
    // dark token set regardless of the user's theme.
    <div className="dark auth-surface relative min-h-svh overflow-hidden" style={{ colorScheme: "dark" }}>
      <AuthArc />

      <div className="relative z-10 grid min-h-svh grid-rows-[auto_1fr_auto] px-4 py-5 sm:px-[clamp(24px,11vw,168px)] sm:py-[clamp(20px,5vh,44px)]">
        <Link
          href="/"
          aria-label="Arc home"
          className="justify-self-start focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-(--auth-accent)"
        >
          <ArcMark tier="residential" frameWidth={8} className="h-auto w-[clamp(52px,5vw,68px)]" />
        </Link>

        <main className="flex items-center py-10">
          {/* The arc fades out behind this panel, so nothing in it ever sits on the line. */}
          <div data-auth-panel className="w-full max-w-[360px]">
            {children}
          </div>
        </main>

        <footer className="text-xs text-(--auth-faint)">
          By continuing, you agree to Arc&apos;s{" "}
          <Link href="/terms" className="transition-colors hover:text-(--auth-ink)">
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="transition-colors hover:text-(--auth-ink)">
            Privacy Policy
          </Link>
          .
        </footer>
      </div>
    </div>
  )
}
