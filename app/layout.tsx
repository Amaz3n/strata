import type React from "react"
import type { Metadata, Viewport } from "next"
import { DM_Sans, DM_Mono } from "next/font/google"
import Script from "next/script"
import { Analytics } from "@vercel/analytics/react"
import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { ServiceWorkerRegister } from "@/components/service-worker-register"

const _dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-dm-sans" })
const _dmMono = DM_Mono({ weight: "400", subsets: ["latin"], variable: "--font-dm-mono" })

// <CHANGE> Updated metadata for Arc
export const metadata: Metadata = {
  title: "Arc",
  description:
    "A fast, mobile-first operating system for local builders to run projects, schedules, docs, field logs, change orders, and job costing.",
  generator: "v0.app",
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
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
          <Analytics />
          <ServiceWorkerRegister />

          {/* Google Maps JavaScript API Script */}
          {process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY && (
            <Script
              src={`https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&libraries=places`}
              strategy="afterInteractive"
            />
          )}
        </ThemeProvider>
      </body>
    </html>
  )
}
