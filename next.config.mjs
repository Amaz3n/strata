import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

import { withSentryConfig } from "@sentry/nextjs"

// Turbopack infers the workspace root from the nearest lockfile. There is a
// stray ~/pnpm-lock.yaml above this project, so it was inferring the entire home
// directory as the root and trying to resolve a module graph across all of it —
// which pegs every core and never finishes compiling a route. Pin it.
const projectRoot = dirname(fileURLToPath(import.meta.url))
const exhaustiveInstantValidation = process.env.NEXT_EXHAUSTIVE_INSTANT_VALIDATION === "true"
const isDevelopment = process.env.NODE_ENV === "development"

// CI fails the build on any route that would block a navigation. Development
// validates every Page and Default segment and reports each blocker as a dev
// overlay insight — that is where a `[id]` route gets checked against a REAL id,
// which a build-time walk with a fabricated id cannot do. Deploys validate only
// the segments that explicitly export `instant`, keeping the expensive graph
// walk off Vercel's deployment-critical path.
const instantValidationLevel = exhaustiveInstantValidation
  ? "experimental-error"
  : isDevelopment
    ? "warning"
    : "experimental-manual-error"

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
  // Cache Components turns every route into a static shell with dynamic work
  // streamed through Suspense. Partial prefetching makes those shells the unit
  // the client router fetches, so visible destinations are ready on click.
  cacheComponents: true,
  partialPrefetching: true,
  // Two lifetimes, both deliberate.
  //
  // `session` is the one that decides whether ANY authenticated UI can be
  // prefetched. Content only reaches a route's App Shell when its `stale` is at
  // least 5 minutes, and it is dropped from prerenders entirely when `expire` is
  // under 5 minutes. The `seconds` preset (expire: 1 minute) fails that second
  // test, so every read downstream of the session — which is all of them —
  // became a dynamic hole resolved after the click.
  //
  // The trade: a validated session object is trusted in ONE browser for up to 10
  // minutes, re-checked against Supabase every minute. Private caches live in
  // browser memory only, never on the server, and never survive a reload.
  //
  // What bounds the staleness is NOT RLS — services read through the service
  // role, so most queries never evaluate a policy. It is that org membership is
  // re-read outside this cache on every request (lib/auth/context.ts), so a
  // revoked member loses access immediately even while their cached identity
  // chrome is still warm.
  cacheLife: {
    session: {
      stale: 600, // 10 minutes — over the 5 minute App Shell threshold
      revalidate: 60, // re-check the session every minute
      expire: 3600,
    },
  },
  turbopack: {
    root: projectRoot,
  },
  allowedDevOrigins: ['unreproachably-preparoxysmal-talon.ngrok-free.dev', '*.ngrok-free.dev'],
  images: {
    unoptimized: true,
  },
  // Native Node addons (prevent bundling so bindings resolve correctly).
  //
  // `mupdf` is here because it is WASM, not JS: when the bundler processes it,
  // the .wasm is emitted as a static asset and the loader is rewritten to
  // fetch `/_next/static/media/mupdf-wasm.<hash>.wasm`, which the server then
  // tries to open as a filesystem path — ENOENT, then an emscripten abort that
  // surfaces as an unhandledRejection. Route handlers happened to survive this;
  // server actions did not. Externalizing makes Node require it from
  // node_modules, where the .wasm sits next to its loader.
  serverExternalPackages: ["@napi-rs/canvas", "mupdf"],
  // Ensure bundled PDF fonts ship with the report export function on Vercel.
  outputFileTracingIncludes: {
    "/api/projects/[id]/reports/profitability": ["./lib/pdfs/fonts/**"],
    // mupdf is externalized (see serverExternalPackages), so its 10MB .wasm is
    // loaded from node_modules at runtime rather than bundled. Trace it
    // explicitly onto the functions that open PDFs — an untraced .wasm fails
    // only in production, and only when someone uploads a drawing.
    "/api/jobs/drawings-pipeline": ["./node_modules/mupdf/dist/*.wasm"],
    "/api/jobs/process-outbox": ["./node_modules/mupdf/dist/*.wasm"],
    "/api/portal/drawings/[token]/[sheetId]": ["./node_modules/mupdf/dist/*.wasm"],
    // Scale detection runs from the drawings surfaces' server actions.
    "/projects/[id]/drawings": ["./node_modules/mupdf/dist/*.wasm"],
    "/drawings": ["./node_modules/mupdf/dist/*.wasm"],
  },
  // Server Actions configuration
  experimental: {
    cachedNavigations: true,
    instantInsights: {
      validationLevel: instantValidationLevel,
    },
    // `instant()` in the Playwright suite drives the same testing API the
    // Navigation Inspector uses. `next dev` exposes it automatically; `next start`
    // does not without this, and playwright.config.ts runs against a production
    // build — so every instant() assertion was scoping to nothing.
    exposeTestingApiInProductionBuild: true,
    proxyClientMaxBodySize: '250mb',
    serverActions: {
      bodySizeLimit: '100mb',
    },
    webpackMemoryOptimizations: true,
    // Client router cache: reuse fetched segments (including the app shell
    // layout and its ~9 identity/permission queries) for 30s of client-side
    // navigation instead of refetching the whole tree on every click. Server
    // actions still invalidate via revalidatePath/revalidateTag, so mutations
    // are unaffected; this only stops nav-to-nav refetch churn.
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
      { source: "/d/:token", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }] },
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
      {
        source: '/starts/pipeline/:id',
        destination: '/starts/:id',
        permanent: true,
      },
      {
        source: '/starts/pipeline',
        destination: '/starts',
        permanent: true,
      },
      {
        source: '/starts/reports',
        destination: '/reports',
        permanent: true,
      },
      {
        source: '/starts/trades',
        destination: '/schedule/trades',
        permanent: true,
      },
      {
        source: '/starts/settings',
        destination: '/settings/starts',
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
