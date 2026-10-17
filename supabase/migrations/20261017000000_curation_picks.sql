-- Phase 10: workspace-scoped admin curation picks.
--
-- A pick is an explicit "curate this photo" signal from an admin. The
-- deterministic recommendation baseline (lib/recommendations.ts) ranks
-- picked photos first, ahead of any popularity or burst signal, so the
-- strongest human signal always wins a tie against machine heuristics.
--
-- One pick per photo (photo_id is the primary key): picking an already
-- picked photo is an idempotent no-op, and deleting the photo cascades the
-- pick away. workspace_id is denormalized for scoped reads and is written
-- by the insert's SELECT ... JOIN over photos -> events, so it can never
-- disagree with the photo's real workspace. RLS enabled; the backend
-- connects with the privileged role. Additive only.

create table public.curation_picks (
  photo_id     uuid primary key references public.photos (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  picked_by    uuid not null references public.users (id),
  created_at   timestamptz not null default now()
);

-- Scoped reads: "which of these candidates are picked in my workspace?"
create index idx_curation_picks_workspace
  on public.curation_picks (workspace_id, created_at desc);

alter table public.curation_picks enable row level security;
