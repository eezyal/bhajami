import { getMergedCatalogWithCloud } from '@/lib/catalog-store';
import { JamStudioClient } from '@/components/JamStudioClient';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const { catalog, pendingCount } = await getMergedCatalogWithCloud();
  return (
    <JamStudioClient
      initialCatalog={catalog}
      initialPendingCount={pendingCount}
    />
  );
}
