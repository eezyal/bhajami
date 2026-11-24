---
name: lyrics-moderation
description: Manages community lyric & metadata corrections, pschax@gmail.com admin diff emails, and the /admin/corrections approval workflow.
---

# bhaJami Lyrics Correction & Admin Moderation Workflow

## Data Collections & Local Fallback Stores
- **Firestore**: `lyricCorrections/{id}`, `bhajans/{id}`, `bhajans/{id}/revisions/{revId}`, `mail/{mailId}`
- **Local Dev JSON Stores** (`apps/web/data/`): `corrections-store.json`, `approved-overrides.json`, `revisions-store.json`, `email-outbox.json`

## Email Delivery to `pschax@gmail.com`
Every `POST /api/corrections` builds a rich HTML + plain-text LCS diff email addressed to `pschax@gmail.com` (`ADMIN_EMAIL`) and dispatches via:
1. **Resend API** (when `RESEND_API_KEY` is configured),
2. **Firebase Trigger Email (`mail` collection)** (when Firebase Admin SDK credentials are configured), and
3. **Local Dev Email Outbox** (`data/email-outbox.json`), visible live in `/admin/corrections` under the **Admin Email Outbox** tab.

## Moderation Lifecycle
- User submission sets `status: 'pending'` (appears under **Waiting for Approval**).
- Admin inspects LCS diff at `/admin/corrections`, can refine the proposed lyrics before publishing, and clicks **Approve & Publish** (`PATCH /api/corrections/[id]`) or **Reject**.
- Approval atomically updates published lyrics overrides and appends an immutable `BhajanRevision` record.
