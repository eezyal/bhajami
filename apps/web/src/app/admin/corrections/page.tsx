import {
  getCatalogIndex,
  listCorrections,
  listOutboxEmails,
  listRevisions,
} from '@/lib/catalog-store';
import { hasCloudConfig } from '@/lib/firestore-rest';
import { AdminModerationClient } from '@/components/AdminModerationClient';

export const dynamic = 'force-dynamic';

export default async function AdminCorrectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ selected?: string }>;
}) {
  const params = await searchParams;
  const cloud = hasCloudConfig();
  const [corrections, outbox, revisions, catalogIndex] = await Promise.all([
    Promise.resolve(cloud ? [] : listCorrections()),
    Promise.resolve(cloud ? [] : listOutboxEmails()),
    Promise.resolve(cloud ? [] : listRevisions()),
    getCatalogIndex(),
  ]);

  return (
    <AdminModerationClient
      initialCorrections={corrections}
      initialOutbox={outbox}
      initialRevisions={revisions}
      initialSelectedId={params.selected}
      cloudMode={cloud}
      catalogVersion={catalogIndex.version}
      catalogStats={catalogIndex.stats}
    />
  );
}
