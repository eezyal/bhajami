import {
  listCorrections,
  listOutboxEmails,
  listRevisions,
} from '@/lib/catalog-store';
import { AdminModerationClient } from '@/components/AdminModerationClient';

export const dynamic = 'force-dynamic';

export default async function AdminCorrectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ selected?: string }>;
}) {
  const params = await searchParams;
  const corrections = listCorrections();
  const outbox = listOutboxEmails();
  const revisions = listRevisions();

  return (
    <AdminModerationClient
      initialCorrections={corrections}
      initialOutbox={outbox}
      initialRevisions={revisions}
      initialSelectedId={params.selected}
    />
  );
}
