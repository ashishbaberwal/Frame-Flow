-- Phase 2: image derivatives (thumbnails + optimized variants).
--
-- Originals stay untouched in Appwrite; this table tracks one row per
-- (photo, variant) derivative through an explicit state machine:
--
--   QUEUED → PROCESSING → READY   (happy path)
--   QUEUED → PROCESSING → FAILED   (terminal after MAX attempts, or
--                                   recoverable earlier — attempts and
--                                   last_error decide; the runner retries
--                                   FAILED rows with attempts left)
--
-- Stuck PROCESSING rows (crashed worker) are reset to QUEUED by the
-- recovery sweep when updated_at goes stale. PostgreSQL is the
-- authoritative status — never the queue (Phase 3) or the filesystem.
-- Additive only; photos cascade so event/photo deletion cleans up rows
-- (binary cleanup for derivatives follows the existing best-effort path).

create table public.photo_derivatives (
  id              uuid primary key default gen_random_uuid(),
  photo_id        uuid not null references public.photos (id) on delete cascade,
  variant         text not null
                  check (variant in ('thumb_small', 'thumb_large')),
  storage_file_id text not null,
  mime_type       text not null,
  width           integer not null check (width > 0),
  height          integer not null check (height > 0),
  file_size       integer not null check (file_size >= 0),
  status          text not null default 'QUEUED'
                  check (status in ('QUEUED', 'PROCESSING', 'READY', 'FAILED')),
  attempts        integer not null default 0 check (attempts >= 0),
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One derivative per (photo, variant): duplicate enqueue is a no-op and the
-- runner can never produce two competing thumbnails for the same slot.
create unique index idx_derivatives_photo_variant
  on public.photo_derivatives (photo_id, variant);

-- One metadata row cannot point at the same Appwrite file twice.
create unique index idx_derivatives_storage_file
  on public.photo_derivatives (storage_file_id);

-- The runner's claim query: pending rows oldest-first.
create index idx_derivatives_pending
  on public.photo_derivatives (status, created_at)
  where status in ('QUEUED', 'PROCESSING', 'FAILED');

-- Cross-reference from a stored binary back to its derivative row.
create index idx_derivatives_photo on public.photo_derivatives (photo_id);

create trigger trg_derivatives_updated_at
  before update on public.photo_derivatives
  for each row execute function public.set_updated_at();

alter table public.photo_derivatives enable row level security;
