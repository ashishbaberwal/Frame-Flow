-- Phase 4: raw analytics event sink.
--
-- The Kafka consumer persists every validated event here BEFORE committing
-- its offset (at-least-once + idempotent writes). event_id is the producer-
-- minted UUID with a primary-key guard, so redelivered events collapse into
-- the existing row instead of double-counting.
--
-- workspace_id and gallery_id are denormalized at emission: analytics must
-- stay queryable per workspace even after a gallery is deleted, so there is
-- deliberately NO foreign key to galleries (events outlive galleries).
-- photos referenced by photo_id behave the same way.
--
-- Phase 5 aggregates read from this table; nothing else writes to it.
-- Additive only.

create table public.analytics_event_log (
  event_id        text primary key,
  event_type      text not null
                  check (event_type in (
                    'GalleryViewed', 'PhotoViewed', 'PhotoDownloaded',
                    'GalleryDownloaded', 'GalleryShared'
                  )),
  schema_version  integer not null default 1 check (schema_version >= 1),
  occurred_at     timestamptz not null,
  gallery_id      uuid not null,
  workspace_id    uuid not null,
  visitor_id      text,
  correlation_id  text not null,
  traffic_source  text not null,
  traffic_medium  text,
  traffic_campaign text,
  photo_id        uuid,
  photo_count     integer,
  channel         text,
  raw             jsonb not null,
  received_at     timestamptz not null default now()
);

-- Dashboard reads: per-gallery and per-workspace time ranges.
create index idx_analytics_gallery_time
  on public.analytics_event_log (gallery_id, occurred_at desc);
create index idx_analytics_workspace_time
  on public.analytics_event_log (workspace_id, occurred_at desc);
-- Dedupe/correlation lookups.
create index idx_analytics_correlation
  on public.analytics_event_log (correlation_id);

alter table public.analytics_event_log enable row level security;
