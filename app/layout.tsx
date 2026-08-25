import React, { Suspense } from "react"
import type { Metadata, Viewport } from "next"
import { DM_Sans, DM_Mono } from "next/font/google"
import Script from "next/script"
import { Analytics } from "@vercel/analytics/react"
import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { PersonalizationProvider } from "@/components/personalization-provider"
import { Toaster } from "@/components/ui/sonner"
import { ServiceWorkerRegister } from "@/components/service-worker-register"

const _dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-dm-sans" })
const _dmMono = DM_Mono({ weight: "400", subsets: ["latin"], variable: "--font-dm-mono" })

/**
 * Build-time input for Next's app-wide Instant Navigation validation.
 *
 * Values are deliberately synthetic: UUID-shaped route params exercise the
 * same code paths as production without referencing a real tenant, while null
 * search params model the normal "filter absent" state. Descendant segments
 * inherit this sample and may override it when their param shape differs.
 */
export const instant = {
  unstable_samples: [
    {
      cookies: [
        { name: "arc_community_context", value: null },
        { name: "arc_division_context", value: null },
        { name: "external_portal_session", value: null },
        { name: "impersonation_expires_at", value: null },
        { name: "impersonation_reason", value: null },
        { name: "impersonation_session_id", value: null },
        { name: "impersonation_started_at", value: null },
        { name: "impersonation_target_user_id", value: null },
        { name: "org_id", value: null },
        { name: "platform_context_org_id", value: null },
        { name: "platform_context_reason", value: null },
        { name: "platform_context_started_at", value: null },
      ],
      headers: [
        ["baggage", null],
        ["sentry-trace", null],
        ["user-agent", null],
        ["x-forwarded-for", null],
      ] as Array<[string, string | null]>,
      params: {
        accountId: "00000000-0000-4000-8000-000000000001",
        billId: "00000000-0000-4000-8000-000000000002",
        dealId: "00000000-0000-4000-8000-000000000003",
        id: "00000000-0000-4000-8000-000000000004",
        importer: "projects",
        orgId: "00000000-0000-4000-8000-000000000005",
        packageId: "00000000-0000-4000-8000-000000000006",
        periodId: "00000000-0000-4000-8000-000000000007",
        projectId: "00000000-0000-4000-8000-000000000008",
        prospectId: "00000000-0000-4000-8000-000000000009",
        setId: "00000000-0000-4000-8000-000000000010",
        sheetId: "00000000-0000-4000-8000-000000000011",
        slug: "summary",
        token: "instant-navigation-validation",
      },
      searchParams: {
        action: null,
        amount_cents: null,
        batch: null,
        bill: null,
        budget_line_id: null,
        classification: null,
        code: null,
        commitment: null,
        community: null,
        condition: null,
        cost_code_id: null,
        description: null,
        direction: null,
        dir: null,
        duplicate: null,
        due: null,
        drawingSheet: null,
        email: null,
        endDate: null,
        entity: null,
        entityType: null,
        external_token: null,
        fileId: null,
        highlight: null,
        incident: null,
        inspection: null,
        invoice: null,
        invoiceId: null,
        item: null,
        key: null,
        kind: null,
        logId: null,
        meeting: null,
        message: null,
        new: null,
        next: null,
        observation: null,
        offset: null,
        orgId: null,
        package: null,
        page: null,
        pageSize: null,
        partyId: null,
        partyType: null,
        path: null,
        payments: null,
        period: null,
        periodEnd: null,
        phase: null,
        plan: null,
        planVersion: null,
        project: null,
        projectId: null,
        project_id: null,
        prospect: null,
        prospectId: null,
        prospect_id: null,
        q: null,
        queue: null,
        report: null,
        reason: null,
        returnTo: null,
        rfi: null,
        role: null,
        run: null,
        scope: null,
        schedule_item: null,
        search: null,
        section: null,
        set: null,
        sheetId: null,
        signed: null,
        sort: null,
        source: null,
        startDate: null,
        status: null,
        submittal: null,
        setup_intent: null,
        tab: null,
        timePeriod: null,
        title: null,
        trade: null,
        token: null,
        token_hash: null,
        type: null,
        types: null,
        user: null,
        verified: null,
        view: null,
        w: null,
        weeks: null,
        window: null,
        zoom: null,
      },
    },
  ],
}

// <CHANGE> Updated metadata for Arc
export const metadata: Metadata = {
  title: "Arc",
  description:
    "A fast, mobile-first operating system for local builders to run projects, schedules, docs, field logs, change orders, and job costing.",
  generator: "v0.app",
  icons: {
    icon: "/arc-favicon.svg",
    apple: "/apple-icon.png",
  },
}

export const viewport: Viewport = {
  themeColor: "#171a2c",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${_dmSans.variable} ${_dmMono.variable} font-sans antialiased`} style={{ fontOpticalSizing: "auto" }}>
        <Script id="arc-ui-size-init" strategy="beforeInteractive">
          {`try{var s=localStorage.getItem("arc-ui-size");document.documentElement.dataset.uiSize=s==="compact"||s==="comfortable"?s:"default"}catch(e){document.documentElement.dataset.uiSize="default"}`}
        </Script>
        <Suspense fallback={<div className="min-h-svh bg-background" aria-busy="true" />}>
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem
            disableTransitionOnChange
          >
            <PersonalizationProvider>{children}</PersonalizationProvider>
            <Toaster />
            <Analytics />
            <ServiceWorkerRegister />

          {/* Google Maps JavaScript API Script */}
            {process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY && (
              <Script
                src={`https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&libraries=places&loading=async`}
                strategy="afterInteractive"
              />
            )}
          </ThemeProvider>
        </Suspense>
      </body>
    </html>
  )
}
