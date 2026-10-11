-- Phase 6: engagement aggregation (photo views/downloads, shares).
--
-- Per-photo daily counts plus gallery-level engagement counters. Like the
-- Phase 5 rollups, every counter increments only for newly stored events
-- (rowCount-gated in the same transaction), so redelivery never inflates.
--
-- Deliberate omissions (documented in README):
-- - No per-photo uniques: uniques stay gallery-level estimates; per-photo
--   rows are counts only.
-- - GalleryDownloaded has no emission surface yet (no bulk export exists),
--   so no download rollup reads it; the contract stands ready in the raw log.
-- - Download/share RATES are computed at read time from the raw log's
--   correlation sessions, not precomputed here.
-- Additive only.

create table public.photo_daily_stats (
  photo_id      uuid not null,
  gallery_id    uuid not null,
  workspace_id  uuid not null,
  day           date not null,
  views         integer not null default 0 check (views >= 0),
  downloads     integer not null default 0 check (downloads >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (photo_id, day)
);

create index idx_photo_daily_stats_gallery
  on public.photo_daily_stats (gallery_id, day desc);
create index idx_photo_daily_stats_workspace
  on public.photo_daily_stats (workspace_id, day desc);

-- Gallery-level engagement counters live with the Phase 5 daily rows so
-- dashboard reads stay single-table. Additive columns, existing rows read 0.
alter table public.gallery_daily_stats
  add column photo_views integer not null default 0 check (photo_views >= 0),
  add column photo_downloads integer not null default 0 check (photo_downloads >= 0),
  add column shares integer not null default 0 check (shares >= 0);

create trigger trg_photo_daily_stats_updated_at
  before update on public.photo_daily_stats
  for each row execute function public.set_updated_at();

alter table public.photo_daily_stats enable row level security;
