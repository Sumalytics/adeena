import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep isolated verification servers separate from the active developer server.
  distDir: process.env.ADEENA_DIST_DIR || ".next",
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
