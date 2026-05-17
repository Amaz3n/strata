/** @type {import('next').NextConfig} */
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
    devOverlay: false,
    serverActions: {
      bodySizeLimit: '10mb',
    },
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
