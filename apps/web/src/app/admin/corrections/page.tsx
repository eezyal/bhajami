import {
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
  const corrections = cloud ? [] : listCorrections();
  const outbox = cloud ? [] : listOutboxEmails();
  const revisions = cloud ? [] : listRevisions();

  return (
    <AdminModerationClient
      initialCorrections={corrections}
      initialOutbox={outbox}
      initialRevisions={revisions}
      initialSelectedId={params.selected}
    />
  );
}
