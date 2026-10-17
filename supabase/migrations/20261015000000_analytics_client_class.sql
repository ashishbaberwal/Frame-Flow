-- Phase 7: transparent client classification on analytics events.
--
-- Additive and nullable: rows written before this migration (and events from
-- producers that predate the field) carry NULL, which readers treat as
-- "unclassified" — eligible for popularity rankings, exactly like "human".
-- The CHECK allows only the classifier's vocabulary; NULL is always valid.
alter table public.analytics_event_log
  add column client_class text
  check (client_class is null or client_class in ('human', 'bot', 'suspicious'));

-- Ranking and bot-report queries read "human-ish events for a gallery in a
-- window", so the log gets a workspace/gallery/class index. Existing
-- occurred_at-heavy reads keep their current plans.
create index idx_analytics_event_log_class
  on public.analytics_event_log (gallery_id, client_class, occurred_at desc);
