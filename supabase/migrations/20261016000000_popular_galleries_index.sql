-- Phase 8: popular-gallery ranking index.
--
-- Rankings aggregate ONE workspace's eligible engagement events
-- (GalleryViewed / PhotoDownloaded, bot-classified rows excluded) over an
-- explicit window — or all time — grouped by gallery. This partial index
-- covers that whole access path: workspace first, then the time filter, and
-- the predicate keeps non-ranking event types and bot noise out of the
-- index entirely. The broader (workspace_id, occurred_at) index stays for
-- session-rate reads; the Phase 7 (gallery_id, client_class, occurred_at)
-- index serves per-gallery and bot-report lookups.
--
-- NULL client_class (pre-Phase-7 rows, legacy replays) is unclassified and
-- stays eligible for ranking — hence IS DISTINCT FROM, not <>.
-- Additive only.
create index idx_analytics_event_log_ranking
  on public.analytics_event_log (workspace_id, occurred_at desc)
  where event_type in ('GalleryViewed', 'PhotoDownloaded')
    and client_class is distinct from 'bot';
