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
  // Server Actions configuration
  experimental: {
    proxyClientMaxBodySize: '250mb',
    serverActions: {
      bodySizeLimit: '100mb',
    },
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

export default nextConfig
