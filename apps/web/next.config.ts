import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  transpilePackages: ['@bhajami/shared'],
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
