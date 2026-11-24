import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getCatalogIndex } from '@/lib/catalog-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const index = await getCatalogIndex();
  let latestUpdated = '';
  for (const entry of index.entries) {
    if (entry.updatedAt && entry.updatedAt > latestUpdated) {
      latestUpdated = entry.updatedAt;
    }
  }

  const hash = crypto
    .createHash('sha1')
    .update(
      `${index.version}|${index.generatedAt}|${index.entries.length}|${latestUpdated}|${index.pendingCount}`,
    )
    .digest('hex')
    .slice(0, 12);
  const etag = `W/"v${index.version}-${hash}"`;

  const cacheHeaders = {
    ETag: etag,
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
  };

  if (request.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers: cacheHeaders });
  }

  return NextResponse.json(
    {
      generatedAt: index.generatedAt,
      version: index.version,
      stats: index.stats,
      entries: index.entries,
      pendingCorrectionsCount: index.pendingCount,
    },
    { status: 200, headers: cacheHeaders },
  );
}
