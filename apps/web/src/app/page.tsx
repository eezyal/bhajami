import { getBhajanDetail, getCatalogIndex } from '@/lib/catalog-store';
import { hasCloudConfig } from '@/lib/firestore-rest';
import { JamStudioClient } from '@/components/JamStudioClient';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const index = await getCatalogIndex();
  const initialBhajan = index.entries[0] ? await getBhajanDetail(index.entries[0].id) : null;

  return (
    <JamStudioClient
      initialIndex={{
        generatedAt: index.generatedAt,
        version: index.version,
        stats: index.stats,
        entries: index.entries,
      }}
      initialBhajan={initialBhajan}
      initialPendingCount={index.pendingCount}
      cloudMode={hasCloudConfig()}
    />
  );
}
