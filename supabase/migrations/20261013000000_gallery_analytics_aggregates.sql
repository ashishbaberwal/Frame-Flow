-- Phase 5: gallery analytics aggregates.
--
-- VIEW DEFINITION (documented, deliberate): one view = one successful gallery
-- unlock (one GalleryViewed event). Re-entering the PIN counts as a new view;
-- redelivery of the SAME event (same event_id) never counts twice — the raw
-- log's primary key plus conditional aggregation below enforce that.
--
-- Uniques are visitor-day estimates: one row per (gallery, UTC day, visitor
-- hash). Cookie clearing, multiple devices, and shared links inflate them;
-- missing visitor ids count as views but never as uniques. All buckets are
-- UTC days derived from the event's occurred_at (NOT ingestion time).
--
-- Photo-level events (PhotoViewed/PhotoDownloaded) stay in the raw log for
-- Phase 6; only GalleryViewed aggregates here. Additive only.

-- Per-gallery daily rollup. views/uniques increment only for newly stored
-- events (see the aggregator), so replays are safe.
create table public.gallery_daily_stats (
  gallery_id       uuid not null,
  workspace_id     uuid not null,
  day              date not null,
  views            integer not null default 0 check (views >= 0),
  unique_visitors  integer not null default 0 check (unique_visitors >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (gallery_id, day)
);

-- One row per (gallery, day, visitor): the deduplicated unique-visitor set.
-- visitor_hash is SHA-256 hex of the pseudonymous visitor id (never the id).
create table public.gallery_visitor_days (
  gallery_id    uuid not null,
  workspace_id  uuid not null,
  day           date not null,
  visitor_hash  text not null,
  created_at    timestamptz not null default now(),
  primary key (gallery_id, day, visitor_hash)
);

-- Per-source daily rollup (source = "direct" | "unknown" | hostname).
create table public.gallery_traffic_sources (
  gallery_id       uuid not null,
  workspace_id     uuid not null,
  day              date not null,
  source           text not null,
  views            integer not null default 0 check (views >= 0),
  unique_visitors  integer not null default 0 check (unique_visitors >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (gallery_id, day, source)
);

-- Visitor set per (gallery, day, source): backs per-source uniques.
create table public.gallery_traffic_visitors (
  gallery_id    uuid not null,
  workspace_id  uuid not null,
  day           date not null,
  source        text not null,
  visitor_hash  text not null,
  created_at    timestamptz not null default now(),
  primary key (gallery_id, day, source, visitor_hash)
);

-- Workspace-scoped dashboard reads.
create index idx_gallery_daily_stats_workspace
  on public.gallery_daily_stats (workspace_id, day desc);
create index idx_traffic_sources_workspace
  on public.gallery_traffic_sources (workspace_id, day desc);

create trigger trg_gallery_daily_stats_updated_at
  before update on public.gallery_daily_stats
  for each row execute function public.set_updated_at();

create trigger trg_traffic_sources_updated_at
  before update on public.gallery_traffic_sources
  for each row execute function public.set_updated_at();

alter table public.gallery_daily_stats enable row level security;
alter table public.gallery_visitor_days enable row level security;
alter table public.gallery_traffic_sources enable row level security;
alter table public.gallery_traffic_visitors enable row level security;
