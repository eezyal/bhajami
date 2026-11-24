import { NextResponse } from 'next/server';
import { getCatalogIndex } from '@/lib/catalog-store';
import { hasCloudConfig } from '@/lib/firestore-rest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const index = await getCatalogIndex();
  return NextResponse.json(
    {
      ok: true,
      cloudConfigured: hasCloudConfig(),
      catalogVersion: index.version,
      bhajanCount: index.entries.length,
    },
    { status: 200 },
  );
}
