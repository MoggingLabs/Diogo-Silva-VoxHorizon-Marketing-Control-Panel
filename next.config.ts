import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker runtime image.
  // Produces .next/standalone/server.js with a pruned node_modules tree,
  // typically ~150 MB vs >1 GB for a full `next start` deploy. Required
  // by web/Dockerfile (VPS-7).
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
