import { NextRequest, NextResponse } from 'next/server';
import { getBhajanDetail } from '@/lib/catalog-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const bhajan = await getBhajanDetail(id);
  if (!bhajan) {
    return NextResponse.json({ error: 'Bhajan not found.' }, { status: 404 });
  }

  return NextResponse.json(
    { bhajan },
    {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      },
    },
  );
}
