import type { ReactNode } from "react"
import Link from "next/link"

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    // The gradient is always dark, so the auth surface pins itself to the dark
    // token set regardless of the user's theme — otherwise light-mode inputs
    // render near-black on a near-black background.
    <div
      className="dark relative min-h-svh overflow-hidden text-foreground"
      style={{ colorScheme: "dark" }}
    >
      {/* Deep blue space gradient */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,oklch(0.35_0.18_264),oklch(0.18_0.12_270)_50%,oklch(0.10_0.06_275))]" />

      {/* Subtle star-like dots */}
      <div className="absolute inset-0 opacity-30"
        style={{
          backgroundImage: `radial-gradient(1px 1px at 20% 30%, white 50%, transparent 100%),
            radial-gradient(1px 1px at 40% 70%, white 50%, transparent 100%),
            radial-gradient(1px 1px at 60% 20%, white 50%, transparent 100%),
            radial-gradient(1px 1px at 80% 50%, white 50%, transparent 100%),
            radial-gradient(1px 1px at 10% 80%, white 50%, transparent 100%),
            radial-gradient(1px 1px at 70% 85%, white 50%, transparent 100%),
            radial-gradient(1.5px 1.5px at 30% 50%, white 50%, transparent 100%),
            radial-gradient(1.5px 1.5px at 90% 15%, white 50%, transparent 100%),
            radial-gradient(1px 1px at 50% 95%, white 50%, transparent 100%),
            radial-gradient(1px 1px at 15% 45%, white 50%, transparent 100%)`,
        }}
      />

      {/* Soft glow orbs */}
      <div className="absolute -top-1/4 -right-1/4 size-[600px] rounded-full bg-[oklch(0.45_0.20_264)] opacity-15 blur-[120px]" />
      <div className="absolute -bottom-1/4 -left-1/4 size-[500px] rounded-full bg-[oklch(0.35_0.15_280)] opacity-20 blur-[100px]" />

      {/* Mark sits out of flow so the form centers on the viewport, not on the
          space left over beneath a header. */}
      <div className="absolute top-6 left-6 z-10 md:top-10 md:left-10">
        <Link href="/" className="flex items-center gap-2.5">
          <img src="/arc-logo2.svg" alt="Arc" className="size-14" />
          <span className="text-xl font-semibold tracking-tight">Arc</span>
        </Link>
      </div>

      <div className="relative flex min-h-svh items-center justify-center p-6">
        <div className="w-full max-w-md">{children}</div>
      </div>
    </div>
  )
}
