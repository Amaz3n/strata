/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Native Node addons (prevent bundling so bindings resolve correctly)
  serverExternalPackages: ["@napi-rs/canvas"],
  // Server Actions configuration
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
}

export default nextConfig
