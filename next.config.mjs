import { withSentryConfig } from "@sentry/nextjs"

/** @type {import('next').NextConfig} */
const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
]

const nextConfig = {
  allowedDevOrigins: ['unreproachably-preparoxysmal-talon.ngrok-free.dev', '*.ngrok-free.dev'],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  devIndicators: {
    appIsrStatus: false,
    buildActivity: false,
  },
  // Native Node addons (prevent bundling so bindings resolve correctly)
  serverExternalPackages: ["@napi-rs/canvas"],
  // Ensure bundled PDF fonts ship with the report export function on Vercel.
  outputFileTracingIncludes: {
    "/api/projects/[id]/reports/profitability": ["./lib/pdfs/fonts/**"],
  },
  // Server Actions configuration
  experimental: {
    proxyClientMaxBodySize: '250mb',
    serverActions: {
      bodySizeLimit: '100mb',
    },
    webpackMemoryOptimizations: true,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ]
  },
  async redirects() {
    return [
      {
        source: '/files',
        destination: '/documents',
        permanent: true,
      },
      {
        source: '/projects/:id/files',
        destination: '/projects/:id/documents',
        permanent: true,
      },
    ]
  },
}

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  // Disable Sentry plugins in development to save memory and speed up builds
  disableServerWebpackPlugin: process.env.NODE_ENV !== "production",
  disableClientWebpackPlugin: process.env.NODE_ENV !== "production",
  webpack: {
    automaticVercelMonitors: true,
    treeshake: {
      removeDebugLogging: true,
    },
  },
})
