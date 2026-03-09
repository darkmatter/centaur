import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname),
  transpilePackages: ["shiki"],
  experimental: {
    reactCompiler: true,
    optimizePackageImports: ["lucide-react", "@tanstack/react-virtual", "shiki", "recharts", "@pierre/diffs"],
  },
  async redirects() {
    return [
      {
        source: "/threads",
        destination: "/",
        permanent: true,
      },
      {
        source: "/threads/:path*",
        destination: "/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
