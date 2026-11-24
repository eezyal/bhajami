import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@bhajami/shared'],
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
