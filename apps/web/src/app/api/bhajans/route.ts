import { NextResponse } from 'next/server';
import { getMergedCatalogWithCloud } from '@/lib/catalog-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const { catalog, pendingCount } = await getMergedCatalogWithCloud();
  return NextResponse.json({
    ...catalog,
    pendingCorrectionsCount: pendingCount,
  });
}
