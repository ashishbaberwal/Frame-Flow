import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

import type { Env } from "../config/env.js";

export type DbUser = {
  id: string;
  clerk_user_id: string;
  name: string;
  email: string;
  role: "ADMIN" | "TEAM_MEMBER";
  workspace_id: string;
  created_at: Date;
  updated_at: Date;
};

export type DbWorkspace = {
  id: string;
  name: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

export type DbEvent = {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  location: string;
  event_date: string;
  status: "draft" | "active" | "completed";
  created_by: string;
  created_at: Date;
  updated_at: Date;
  /**
   * Derived, not stored: COUNT of photos for this event. Every event query
   * below selects it so the UI never has to guess or hardcode a count.
   */
  photo_count: string | number;
};

export type DbEventMember = {
  event_id: string;
  user_id: string;
  added_by: string | null;
  added_at: Date;
};

let pool: pg.Pool | null = null;

export function getPool(env: Env): pg.Pool {
  if (!pool) {
    // TLS strategy:
    // - DATABASE_SSL_CA set → full verification against Supabase's CA cert
    //   (download from Supabase Dashboard → Database Settings → SSL).
    // - No CA configured: development falls back to relaxed verification
    //   (Supabase's pooler CA is not in Node's trust store); production
    //   requires the CA and refuses to boot without it.
    const isLocal =
      env.DATABASE_URL.includes("localhost") || env.DATABASE_URL.includes("127.0.0.1");

    let ssl: pg.PoolConfig["ssl"] = false;
    if (!isLocal) {
      if (env.DATABASE_SSL_CA) {
        const ca = readFileSync(env.DATABASE_SSL_CA, "utf8");
        ssl = { rejectUnauthorized: true, ca };
      } else if (env.NODE_ENV === "production") {
        throw new Error(
          "DATABASE_SSL_CA is required in production — set it to the Supabase CA cert path"
        );
      } else {
        console.warn(
          "WARNING: DATABASE_SSL_CA not set — TLS chain verification relaxed (development only). " +
            "Download the Supabase CA cert and set DATABASE_SSL_CA for full verification."
        );
        ssl = { rejectUnauthorized: false };
      }
    }

    pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl,
    });
    pool.on("error", (err) => {
      // Don't crash the process on idle-client errors; just log.
      console.error("Unexpected PostgreSQL pool error:", err.message);
    });
  }
  return pool;
}

/** Closes the pool — used by graceful shutdown and tests. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Lightweight connectivity check for the health endpoint. */
export async function checkDatabase(env: Env): Promise<boolean> {
  const client = await getPool(env).connect();
  try {
    await client.query("SELECT 1");
    return true;
  } finally {
    client.release();
  }
}

/**
 * Provision a verified Clerk identity into the application.
 *
 * Multi-tenant rules:
 * - Self-registered users (no invitation metadata): get their OWN new
 *   workspace and role ADMIN. The workspace initially contains only them.
 * - Invited users (invitation stamped role:'TEAM_MEMBER' into Clerk
 *   publicMetadata): join the INVITER's workspace as TEAM_MEMBER — never
 *   their own workspace.
 * - Existing users: nothing changes except a name/email refresh; role and
 *   workspace are never overwritten here.
 */
export async function upsertUserFromClerk(
  env: Env,
  clerkUser: { id: string; name: string; email: string; invitedRole?: "ADMIN" | "TEAM_MEMBER" }
): Promise<DbUser> {
  const pool = getPool(env);

  const existing = await pool.query<DbUser>(
    "SELECT * FROM users WHERE clerk_user_id = $1",
    [clerkUser.id]
  );
  let user = existing.rows[0];

  if (!user) {
    // New identity — decide tenancy path.
    const pending = await getPendingInvitationByEmail(env, clerkUser.email);
    const invited = clerkUser.invitedRole === "TEAM_MEMBER" || Boolean(pending);
    if (invited) {
      // Flow B: attach to the inviter's workspace via the pending invitation.
      if (pending) {
        const ws = await pool.query<{ id: string }>(
          "SELECT id FROM workspaces WHERE id = $1",
          [pending.workspace_id]
        );
        const workspaceId = ws.rows[0]?.id;
        if (!workspaceId) throw new Error("Invitation workspace missing");
        const created = await pool.query<DbUser>(
          `INSERT INTO users (clerk_user_id, name, email, role, workspace_id)
           VALUES ($1, $2, $3, 'TEAM_MEMBER', $4)
           RETURNING *`,
          [clerkUser.id, clerkUser.name, clerkUser.email, workspaceId]
        );
        user = created.rows[0]!;
        await markInvitationAccepted(env, pending.id);
      }
      // If no pending invitation row exists (invited but row lost), fall
      // through to the self-signup path — better an isolated workspace than
      // an invented membership.
    }

    if (!user) {
      // Flow A: independent registration → own workspace + ADMIN.
      const workspace = await pool.query<DbWorkspace>(
        `INSERT INTO workspaces (name, created_by)
         VALUES ($1, NULL)
         RETURNING *`,
        [
          (clerkUser.name || clerkUser.email.split("@")[0] || "My") + "'s Studio",
        ]
      );
      const created = await pool.query<DbUser>(
        `INSERT INTO users (clerk_user_id, name, email, role, workspace_id)
         VALUES ($1, $2, $3, 'ADMIN', $4)
         RETURNING *`,
        [clerkUser.id, clerkUser.name, clerkUser.email, workspace.rows[0]!.id]
      );
      user = created.rows[0]!;
      // Workspace owner is now known — link it.
      await pool.query("UPDATE workspaces SET created_by = $1 WHERE id = $2", [
        user.id,
        workspace.rows[0]!.id,
      ]);
    }
  } else {
    // Existing user — refresh profile fields only.
    const refreshed = await pool.query<DbUser>(
      `UPDATE users SET name = $2, email = $3, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [user.id, clerkUser.name, clerkUser.email]
    );
    user = refreshed.rows[0]!;
  }

  // Claim a pending placeholder row for the same email, if any (invited
  // member whose pre-created row exists). Move its event memberships over,
  // then delete the placeholder.
  const pendingRowRes = await pool.query<DbUser>(
    "SELECT * FROM users WHERE email = $1 AND clerk_user_id = $2 AND id <> $3",
    [clerkUser.email, `pending:${clerkUser.email.toLowerCase()}`, user.id]
  );
  const pendingRow = pendingRowRes.rows[0];
  if (pendingRow) {
    await pool.query(
      `INSERT INTO event_team_members (event_id, user_id, added_by, added_at)
       SELECT event_id, $2, added_by, added_at FROM event_team_members WHERE user_id = $1
       ON CONFLICT (event_id, user_id) DO NOTHING`,
      [pendingRow.id, user.id]
    );
    await pool.query("DELETE FROM event_team_members WHERE user_id = $1", [pendingRow.id]);
    await pool.query("DELETE FROM users WHERE id = $1", [pendingRow.id]);
  }

  return user;
}

// ---------------------------------------------------------------------------
// Photos (metadata only — binaries live in Appwrite)
// ---------------------------------------------------------------------------

export type DbPhoto = {
  id: string;
  event_id: string;
  uploaded_by: string;
  filename: string;
  storage_file_id: string;
  storage_provider: string;
  mime_type: string;
  file_size: number;
  created_at: Date;
  updated_at: Date;
  /** Present on reads that join users — the uploader's display name. */
  uploader_name?: string | null;
  /** Present on reads that join users — the uploader's app role. */
  uploader_role?: "ADMIN" | "TEAM_MEMBER" | null;
};

export async function insertPhoto(
  env: Env,
  input: {
    event_id: string;
    uploaded_by: string;
    filename: string;
    storage_file_id: string;
    mime_type: string;
    file_size: number;
  }
): Promise<DbPhoto> {
  // Return the uploader's attribution alongside the new row so the upload
  // response is immediately renderable without a second round trip.
  const result = await getPool(env).query<DbPhoto>(
    `WITH inserted AS (
       INSERT INTO photos (event_id, uploaded_by, filename, storage_file_id, mime_type, file_size)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *
     )
     SELECT i.*,
            COALESCE(NULLIF(u.name, ''), u.email) AS uploader_name,
            u.role AS uploader_role
     FROM inserted i
     LEFT JOIN users u ON u.id = i.uploaded_by`,
    [input.event_id, input.uploaded_by, input.filename, input.storage_file_id, input.mime_type, input.file_size]
  );
  return result.rows[0]!;
}

/** All photos of an event, newest first (scoped by event_id — never global). */
export async function listEventPhotos(
  env: Env,
  eventId: string,
  uploadedBy?: string
): Promise<DbPhoto[]> {
  // Join the uploader so the UI can attribute each photo. LEFT JOIN keeps the
  // photo visible even if the user row were ever missing. COALESCE falls back
  // to the email because accounts created without a display name have name=''.
  const uploaderFilter = uploadedBy ? "AND p.uploaded_by = $2" : "";
  const params = uploadedBy ? [eventId, uploadedBy] : [eventId];
  const result = await getPool(env).query<DbPhoto>(
    `SELECT p.*,
            COALESCE(NULLIF(u.name, ''), u.email) AS uploader_name,
            u.role AS uploader_role
     FROM photos p
     LEFT JOIN users u ON u.id = p.uploaded_by
     WHERE p.event_id = $1 ${uploaderFilter}
     ORDER BY p.created_at DESC`,
    params
  );
  return result.rows;
}

export async function getPhotoById(env: Env, id: string): Promise<DbPhoto | null> {
  const result = await getPool(env).query<DbPhoto>("SELECT * FROM photos WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function deletePhoto(env: Env, id: string): Promise<boolean> {
  const result = await getPool(env).query("DELETE FROM photos WHERE id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Galleries (admin workflow) — a gallery belongs to one event and contains
// only photos from that same event.
// ---------------------------------------------------------------------------

export type DbGallery = {
  id: string;
  event_id: string;
  name: string;
  description: string;
  slug: string;
  pin: string;
  status: "draft" | "published";
  published_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};

export async function insertGallery(
  env: Env,
  input: {
    event_id: string;
    name: string;
    description: string;
    slug: string;
    pin: string;
    created_by: string;
  }
): Promise<DbGallery> {
  const result = await getPool(env).query<DbGallery>(
    `INSERT INTO galleries (event_id, name, description, slug, pin, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [input.event_id, input.name, input.description, input.slug, input.pin, input.created_by]
  );
  return result.rows[0]!;
}

/**
 * Associate selected photos with a gallery. Every photo ID must belong to
 * the gallery's event — verified by the caller via photosInEvent before
 * calling this; the INSERT ... SELECT re-verifies in SQL as defense in depth.
 */
export async function associateGalleryPhotos(
  env: Env,
  galleryId: string,
  eventId: string,
  photoIds: string[]
): Promise<number> {
  if (photoIds.length === 0) return 0;
  const result = await getPool(env).query(
    `INSERT INTO gallery_photos (gallery_id, photo_id)
     SELECT $1, id FROM photos WHERE id = ANY($2::uuid[]) AND event_id = $3
     ON CONFLICT (gallery_id, photo_id) DO NOTHING`,
    [galleryId, photoIds, eventId]
  );
  return result.rowCount ?? 0;
}

export async function getGalleryById(env: Env, id: string): Promise<DbGallery | null> {
  const result = await getPool(env).query<DbGallery>("SELECT * FROM galleries WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

/**
 * Public read: a PUBLISHED gallery by slug, joined with its event name and
 * date. Draft galleries behave exactly like missing ones — the public
 * surface must not reveal that a slug exists while unpublished.
 */
export async function getPublishedGalleryBySlug(
  env: Env,
  slug: string
): Promise<(DbGallery & { event_name: string; event_date: string }) | null> {
  const result = await getPool(env).query<DbGallery & { event_name: string; event_date: string }>(
    `SELECT g.*, e.name AS event_name, e.event_date::text AS event_date
     FROM galleries g
     JOIN events e ON e.id = g.event_id
     WHERE g.slug = $1 AND g.status = 'published'`,
    [slug]
  );
  return result.rows[0] ?? null;
}

/** Photos bound to a gallery, in curation order (no uploader attribution). */
export async function listGalleryPhotos(env: Env, galleryId: string): Promise<DbPhoto[]> {
  const result = await getPool(env).query<DbPhoto>(
    `SELECT p.*
     FROM photos p
     JOIN gallery_photos gp ON gp.photo_id = p.id
     WHERE gp.gallery_id = $1
     ORDER BY gp.added_at ASC`,
    [galleryId]
  );
  return result.rows;
}

/** Galleries of an event, newest first (event is already workspace-scoped). */
export async function listEventGalleries(env: Env, eventId: string): Promise<DbGallery[]> {
  const result = await getPool(env).query<DbGallery>(
    "SELECT * FROM galleries WHERE event_id = $1 ORDER BY created_at DESC",
    [eventId]
  );
  return result.rows;
}

export async function publishGallery(env: Env, id: string): Promise<DbGallery | null> {
  const result = await getPool(env).query<DbGallery>(
    `UPDATE galleries
     SET status = 'published', published_at = now(), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id]
  );
  return result.rows[0] ?? null;
}

/** Replace a gallery's PIN (admin-set custom PIN or a regenerated one). */
export async function updateGalleryPin(env: Env, id: string, pin: string): Promise<DbGallery | null> {
  const result = await getPool(env).query<DbGallery>(
    `UPDATE galleries SET pin = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, pin]
  );
  return result.rows[0] ?? null;
}

/** Photo IDs associated with a gallery, in insertion order. */
export async function listGalleryPhotoIds(env: Env, galleryId: string): Promise<string[]> {
  const result = await getPool(env).query<{ photo_id: string }>(
    "SELECT photo_id FROM gallery_photos WHERE gallery_id = $1 ORDER BY added_at ASC",
    [galleryId]
  );
  return result.rows.map((r) => r.photo_id);
}

/**
 * Count how many of the given photo IDs actually belong to the event.
 * Used to reject cross-event photo selection before creating a gallery.
 */
export async function photosInEvent(
  env: Env,
  photoIds: string[],
  eventId: string
): Promise<number> {
  const result = await getPool(env).query<{ id: string }>(
    "SELECT id FROM photos WHERE id = ANY($1::uuid[]) AND event_id = $2",
    [photoIds, eventId]
  );
  return result.rowCount ?? 0;
}

/** Derive a unique URL-safe slug from a gallery name. */
export async function uniqueGallerySlug(env: Env, name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "gallery";
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${randomInt(1000, 9999)}`;
    const exists = await getPool(env).query("SELECT 1 FROM galleries WHERE slug = $1", [candidate]);
    if ((exists.rowCount ?? 0) === 0) return candidate;
  }
  // Practically unreachable; fall back to a random suffix.
  return `${base}-${randomInt(100000, 999999)}`;
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export type DbInvitation = {
  id: string;
  email: string;
  workspace_id: string;
  invited_by: string;
  status: "pending" | "accepted" | "revoked";
  clerk_invitation_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function createInvitation(
  env: Env,
  input: { email: string; workspace_id: string; invited_by: string; clerk_invitation_id?: string }
): Promise<DbInvitation> {
  const result = await getPool(env).query<DbInvitation>(
    `INSERT INTO invitations (email, workspace_id, invited_by, clerk_invitation_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.email.toLowerCase(), input.workspace_id, input.invited_by, input.clerk_invitation_id ?? null]
  );
  return result.rows[0]!;
}

export async function getPendingInvitationByEmail(
  env: Env,
  email: string
): Promise<DbInvitation | null> {
  const result = await getPool(env).query<DbInvitation>(
    "SELECT * FROM invitations WHERE email = $1 AND status = 'pending' ORDER BY created_at DESC",
    [email.toLowerCase()]
  );
  return result.rows[0] ?? null;
}

export async function markInvitationAccepted(env: Env, id: string): Promise<void> {
  await getPool(env).query(
    "UPDATE invitations SET status = 'accepted', updated_at = now() WHERE id = $1",
    [id]
  );
}

export async function listPendingInvitationsForWorkspace(
  env: Env,
  workspaceId: string
): Promise<DbInvitation[]> {
  const result = await getPool(env).query<DbInvitation>(
    "SELECT * FROM invitations WHERE workspace_id = $1 AND status = 'pending' ORDER BY created_at DESC",
    [workspaceId]
  );
  return result.rows;
}

/** Fetch the application user row for a verified Clerk user ID. */
export async function getUserByClerkId(env: Env, clerkUserId: string): Promise<DbUser | null> {
  const result = await getPool(env).query<DbUser>(
    "SELECT * FROM users WHERE clerk_user_id = $1",
    [clerkUserId]
  );
  return result.rows[0] ?? null;
}

export async function getUserById(env: Env, id: string): Promise<DbUser | null> {
  const result = await getPool(env).query<DbUser>("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

/** Workspace members only — never a global user list. */
export async function listWorkspaceUsers(env: Env, workspaceId: string): Promise<DbUser[]> {
  const result = await getPool(env).query<DbUser>(
    "SELECT * FROM users WHERE workspace_id = $1 ORDER BY created_at DESC",
    [workspaceId]
  );
  return result.rows;
}

/** Promote/demote an application user. Called only from admin-gated routes. */
export async function setUserRole(
  env: Env,
  userId: string,
  role: "ADMIN" | "TEAM_MEMBER"
): Promise<DbUser | null> {
  const result = await getPool(env).query<DbUser>(
    "UPDATE users SET role = $2, updated_at = now() WHERE id = $1 RETURNING *",
    [userId, role]
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface CreateEventInput {
  name: string;
  description?: string;
  location?: string;
  event_date: string;
  status?: "draft" | "active" | "completed";
}

export async function createEvent(
  env: Env,
  workspaceId: string,
  createdByUserId: string,
  input: CreateEventInput
): Promise<DbEvent> {
  const result = await getPool(env).query<DbEvent>(
    `INSERT INTO events (workspace_id, name, description, location, event_date, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      workspaceId,
      input.name,
      input.description ?? "",
      input.location ?? "",
      input.event_date,
      input.status ?? "draft",
      createdByUserId,
    ]
  );
  return result.rows[0]!;
}

/** Every event read selects photo_count so the UI never hardcodes a count. */
const EVENT_COLUMNS = `e.*, (SELECT COUNT(*) FROM photos p WHERE p.event_id = e.id) AS photo_count`;

export async function listWorkspaceEvents(env: Env, workspaceId: string): Promise<DbEvent[]> {
  const result = await getPool(env).query<DbEvent>(
    `SELECT ${EVENT_COLUMNS} FROM events e
     WHERE e.workspace_id = $1 ORDER BY e.created_at DESC`,
    [workspaceId]
  );
  return result.rows;
}

/** Events a user can access: workspace events for admins, assigned for members. */
export async function listEventsForUser(env: Env, user: DbUser): Promise<DbEvent[]> {
  if (user.role === "ADMIN") {
    return listWorkspaceEvents(env, user.workspace_id);
  }
  const result = await getPool(env).query<DbEvent>(
    `SELECT e.*, COUNT(p.id)::int AS photo_count
     FROM events e
     JOIN event_team_members etm ON etm.event_id = e.id
     LEFT JOIN photos p ON p.event_id = e.id AND p.uploaded_by = $1
     WHERE etm.user_id = $1 AND e.workspace_id = $2
     GROUP BY e.id
     ORDER BY e.created_at DESC`,
    [user.id, user.workspace_id]
  );
  return result.rows;
}

/**
 * Workspace-aware fetch: returns the event only if it belongs to the given
 * workspace. This is the tenancy gate for every event access.
 */
export async function getWorkspaceEvent(
  env: Env,
  id: string,
  workspaceId: string
): Promise<DbEvent | null> {
  const result = await getPool(env).query<DbEvent>(
    `SELECT ${EVENT_COLUMNS} FROM events e WHERE e.id = $1 AND e.workspace_id = $2`,
    [id, workspaceId]
  );
  return result.rows[0] ?? null;
}

export async function getEventById(env: Env, id: string): Promise<DbEvent | null> {
  const result = await getPool(env).query<DbEvent>(
    `SELECT ${EVENT_COLUMNS} FROM events e WHERE e.id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export interface UpdateEventInput {
  name?: string;
  description?: string;
  location?: string;
  event_date?: string;
  status?: "draft" | "active" | "completed";
}

export async function updateEvent(
  env: Env,
  id: string,
  input: UpdateEventInput
): Promise<DbEvent | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let param = 1;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    fields.push(`${key} = $${param++}`);
    values.push(value);
  }
  if (fields.length === 0) return getEventById(env, id);
  values.push(id);
  const result = await getPool(env).query<DbEvent>(
    `UPDATE events SET ${fields.join(", ")}, updated_at = now() WHERE id = $${param} RETURNING *`,
    values
  );
  return result.rows[0] ?? null;
}

export async function deleteEvent(env: Env, id: string): Promise<boolean> {
  const result = await getPool(env).query("DELETE FROM events WHERE id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Event team membership
// ---------------------------------------------------------------------------

/** Relationship check — the only source of event access for team members. */
export async function isEventMember(
  env: Env,
  eventId: string,
  userId: string
): Promise<boolean> {
  const result = await getPool(env).query(
    "SELECT 1 FROM event_team_members WHERE event_id = $1 AND user_id = $2",
    [eventId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Assign a user to an event. Idempotent: re-assignment never duplicates the
 * relationship (primary key (event_id, user_id) + ON CONFLICT DO NOTHING).
 */
export async function addEventMember(
  env: Env,
  eventId: string,
  userId: string,
  addedBy: string
): Promise<DbEventMember> {
  const result = await getPool(env).query<DbEventMember>(
    `INSERT INTO event_team_members (event_id, user_id, added_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id, user_id) DO NOTHING
     RETURNING *`,
    [eventId, userId, addedBy]
  );
  if (result.rows[0]) return result.rows[0];
  // Already existed — return the existing relationship.
  const existing = await getPool(env).query<DbEventMember>(
    "SELECT * FROM event_team_members WHERE event_id = $1 AND user_id = $2",
    [eventId, userId]
  );
  return existing.rows[0]!;
}

export async function removeEventMember(
  env: Env,
  eventId: string,
  userId: string
): Promise<boolean> {
  const result = await getPool(env).query(
    "DELETE FROM event_team_members WHERE event_id = $1 AND user_id = $2",
    [eventId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** All members of an event, joined with their user profiles. */
export async function listEventMembers(
  env: Env,
  eventId: string
): Promise<Array<DbEventMember & { user: DbUser }>> {
  const result = await getPool(env).query<{
    event_id: string;
    user_id: string;
    added_by: string | null;
    added_at: Date;
    clerk_user_id: string;
    name: string;
    email: string;
    role: "ADMIN" | "TEAM_MEMBER";
    workspace_id: string;
    user_created_at: Date;
    user_updated_at: Date;
  }>(
    `SELECT etm.event_id, etm.user_id, etm.added_by, etm.added_at,
            u.clerk_user_id, u.name, u.email, u.role, u.workspace_id,
            u.created_at AS "user_created_at", u.updated_at AS "user_updated_at"
     FROM event_team_members etm
     JOIN users u ON u.id = etm.user_id
     WHERE etm.event_id = $1
     ORDER BY etm.added_at ASC`,
    [eventId]
  );
  return result.rows.map((row) => ({
    event_id: row.event_id,
    user_id: row.user_id,
    added_by: row.added_by,
    added_at: row.added_at,
    user: {
      id: row.user_id,
      clerk_user_id: row.clerk_user_id,
      name: row.name,
      email: row.email,
      role: row.role,
      workspace_id: row.workspace_id,
      created_at: row.user_created_at,
      updated_at: row.user_updated_at,
    },
  }));
}

// Dashboard stats — workspace-level for admins; passing memberUserId scopes
// everything to that member's assigned events. Counts are ::int so JSON
// numbers survive the pg driver.

export type DashboardStats = {
  events: number;
  active_events: number;
  photos: number;
  published_galleries: number;
  team_members: number;
  pending_invites: number;
};

function activityScope(memberUserId?: string): { sql: string; params: unknown[] } {
  if (!memberUserId) return { sql: "", params: [] };
  return {
    sql: "AND e.id IN (SELECT event_id FROM event_team_members WHERE user_id = $2)",
    params: [memberUserId],
  };
}

export async function getDashboardStats(
  env: Env,
  workspaceId: string,
  memberUserId?: string
): Promise<DashboardStats> {
  const { sql: scope } = activityScope(memberUserId);
  const result = await getPool(env).query<DashboardStats>(
    `SELECT
       (SELECT COUNT(*)::int FROM events e
        WHERE e.workspace_id = $1 ${scope}) AS events,
       (SELECT COUNT(*)::int FROM events e
        WHERE e.workspace_id = $1 AND e.status = 'active' ${scope}) AS active_events,
       (SELECT COUNT(*)::int FROM photos p JOIN events e ON e.id = p.event_id
        WHERE e.workspace_id = $1 ${scope}) AS photos,
       (SELECT COUNT(*)::int FROM galleries g JOIN events e ON e.id = g.event_id
        WHERE e.workspace_id = $1 AND g.status = 'published' ${scope}) AS published_galleries,
       (SELECT COUNT(*)::int FROM users WHERE workspace_id = $1
         ${memberUserId ? "AND FALSE" : ""}) AS team_members,
       (SELECT COUNT(*)::int FROM invitations WHERE workspace_id = $1 AND status = 'pending'
         ${memberUserId ? "AND FALSE" : ""}) AS pending_invites`,
    memberUserId ? [workspaceId, memberUserId] : [workspaceId]
  );
  return result.rows[0]!;
}

/** Daily upload counts for the last `days` days — zero-filled. */
export async function getUploadsPerDay(
  env: Env,
  workspaceId: string,
  memberUserId: string | undefined,
  days = 14
): Promise<{ day: string; uploads: number }[]> {
  const { sql: scope, params: scopeParams } = activityScope(memberUserId);
  const result = await getPool(env).query<{ day: string; uploads: number }>(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(c.uploads, 0)::int AS uploads
     FROM generate_series(CURRENT_DATE - ($${scopeParams.length + 2}::int - 1), CURRENT_DATE, interval '1 day') AS d(day)
     LEFT JOIN (
       SELECT date_trunc('day', p.created_at) AS day, COUNT(*)::int AS uploads
       FROM photos p JOIN events e ON e.id = p.event_id
       WHERE e.workspace_id = $1 AND p.created_at >= CURRENT_DATE - ($${scopeParams.length + 2}::int - 1) ${scope}
       GROUP BY 1
     ) c ON c.day = d.day
     ORDER BY d.day`,
    [workspaceId, ...scopeParams, days]
  );
  return result.rows;
}

export type DashboardActivityRow = {
  type: "photo_uploaded" | "gallery_published" | "event_created";
  actor_name: string | null;
  title: string;
  detail: string;
  at: Date;
};

/** Newest activity across photos, gallery publishes, and event creation. */
export async function getRecentActivity(
  env: Env,
  workspaceId: string,
  memberUserId: string | undefined,
  limit = 8
): Promise<DashboardActivityRow[]> {
  const { sql: scope, params: scopeParams } = activityScope(memberUserId);
  const result = await getPool(env).query<DashboardActivityRow>(
    `SELECT * FROM (
       (SELECT 'photo_uploaded'::text AS type,
               COALESCE(NULLIF(u.name, ''), u.email) AS actor_name,
               p.filename AS title,
               'uploaded to ' || e.name AS detail,
               p.created_at AS at
        FROM photos p
        JOIN events e ON e.id = p.event_id
        LEFT JOIN users u ON u.id = p.uploaded_by
        WHERE e.workspace_id = $1 ${scope})
       UNION ALL
       (SELECT 'gallery_published'::text AS type,
               COALESCE(NULLIF(a.name, ''), a.email) AS actor_name,
               g.name AS title,
               'published the gallery · ' || e.name AS detail,
               g.published_at AS at
        FROM galleries g
        JOIN events e ON e.id = g.event_id
        LEFT JOIN users a ON a.id = g.created_by
        WHERE e.workspace_id = $1 AND g.published_at IS NOT NULL ${scope})
       UNION ALL
       (SELECT 'event_created'::text AS type,
               COALESCE(NULLIF(c.name, ''), c.email) AS actor_name,
               e.name AS title,
               'created the event' AS detail,
               e.created_at AS at
        FROM events e
        LEFT JOIN users c ON c.id = e.created_by
        WHERE e.workspace_id = $1 ${scope})
     ) activity
     ORDER BY at DESC
     LIMIT $${scopeParams.length + 2}`,
    [workspaceId, ...scopeParams, limit]
  );
  return result.rows;
}
