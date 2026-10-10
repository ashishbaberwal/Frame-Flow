-- Phase 1: cursor-pagination support indexes (additive only, no schema change).
--
-- Event photo grids page by (created_at, id) within one event. The existing
-- idx_photos_event covers (event_id, created_at DESC) but has no tiebreaker,
-- so same-millisecond uploads would page non-deterministically. This index
-- adds the unique-ID tiebreak. (The queries compare
-- date_trunc('milliseconds', created_at) because JS cursors only carry ms
-- precision — date_trunc on timestamptz is STABLE so it cannot be indexed;
-- the event_id equality here still narrows the scan and the per-event sort
-- stays trivial.)
create index if not exists idx_photos_event_pagination
  on public.photos (event_id, created_at desc, id desc);

-- Gallery curation order pages by (added_at, photo_id) within one gallery.
-- Association writes every row with one identical now() timestamp, so the
-- photo_id tiebreak is what makes pages stable. listGalleryPhotos currently
-- sorts without an index; this backs the paginated variant without changing
-- the table or existing queries.
create index if not exists idx_gallery_photos_curation
  on public.gallery_photos (gallery_id, added_at asc, photo_id asc);
