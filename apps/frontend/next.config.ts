import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fewer bytes over the wire; no runtime behavior change.
  poweredByHeader: false,
  images: {
    formats: ["image/avif", "image/webp"],
    // Cache optimized images for 30 days at the edge.
    minimumCacheTTL: 2_592_000,
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
        pathname: "/**",
      },
      // Appwrite Storage (photo binaries) — endpoint configured via env.
      {
        protocol: "https",
        hostname: "*.appwrite.io",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "syd.cloud.appwrite.io",
        pathname: "/**",
      },
    ],
  },
  experimental: {
    // Tree-shake large icon/motion/chart packages per import.
    optimizePackageImports: ["lucide-react", "motion", "recharts"],
  },
};

export default nextConfig;
