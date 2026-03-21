import type { ReactNode } from "react"
import Link from "next/link"

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center gap-2 md:justify-start">
          <Link href="/" className="flex items-center gap-2 font-medium">
            <img src="/logo.svg" alt="Arc" className="size-6" />
            <span className="text-sm font-semibold tracking-tight">Arc</span>
          </Link>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm">{children}</div>
        </div>
        <div className="text-center text-xs text-muted-foreground md:text-left">
          &copy; {new Date().getFullYear()} Arc. All rights reserved.
        </div>
      </div>
      <div className="relative hidden overflow-hidden lg:block">
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

        {/* Content */}
        <div className="relative flex h-full flex-col items-center justify-center gap-8 p-16">
          <img src="/logo.svg" alt="" className="size-14 drop-shadow-[0_8px_28px_rgba(120,190,255,0.35)]" />
          <div className="max-w-md space-y-3 text-center">
            <h2 className="text-2xl font-semibold tracking-tight text-white">
              Build better, together
            </h2>
            <p className="text-sm leading-relaxed text-white/60">
              Project management, scheduling, daily logs, and financials — everything your construction team needs in one place.
            </p>
          </div>
          <div className="mt-8 grid grid-cols-3 gap-8 text-center">
            <div>
              <p className="text-2xl font-semibold tabular-nums text-white">100%</p>
              <p className="mt-1 text-xs text-white/50">Cloud-based</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums text-white">Real-time</p>
              <p className="mt-1 text-xs text-white/50">Collaboration</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums text-white">Secure</p>
              <p className="mt-1 text-xs text-white/50">By default</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
