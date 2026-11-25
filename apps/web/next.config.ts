import os from 'node:os';
import type { NextConfig } from 'next';

function getLanAllowedDevOrigins(): string[] {
  const origins = new Set<string>(['localhost', '127.0.0.1']);
  const host = os.hostname().trim();
  if (host) {
    origins.add(host);
    if (!host.endsWith('.local')) {
      origins.add(`${host}.local`);
    }
  }
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const info of entries ?? []) {
      if (info.family === 'IPv4' && !info.internal && info.address) {
        origins.add(info.address);
      }
    }
  }
  return Array.from(origins);
}

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  allowedDevOrigins: getLanAllowedDevOrigins(),
  transpilePackages: ['@bhajami/shared'],
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
