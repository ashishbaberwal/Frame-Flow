import { Router, type Request, type Response } from "express";
import { randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import type { Env } from "../config/env.js";
import {
  addEventMember,
  associateGalleryPhotos,
  checkDatabase,
  createEvent,
  createInvitation,
  deleteEvent,
  deletePhoto,
  getDashboardStats,
  getPool,
  getGalleryById,
  getPendingInvitationByEmail,
  getPhotoById,
  getPublishedGalleryBySlug,
  getRecentActivity,
  getUploadsPerDay,
  getUserByClerkId,
  getUserById,
  getWorkspaceEvent,
  insertGallery,
  insertPhoto,
  isEventMember,
  listEventGalleries,
  listEventMembers,
  listEventPhotos,
  listEventsForUser,
  listGalleryPhotoIds,
  listGalleryPhotos,
  listPendingInvitationsForWorkspace,
  listWorkspaceUsers,
  markInvitationAccepted,
  photosInEvent,
  publishGallery,
  removeEventMember,
  setUserRole,
  uniqueGallerySlug,
  updateEvent,
  updateGalleryPin,
  upsertUserFromClerk,
  type DbEvent,
  type DbGallery,
  type DbInvitation,
  type DbPhoto,
  type DbUser,
} from "../lib/db.js";
import { getClerkClientForEnv } from "../lib/clerk.js";
import { GALLERY_TOKEN_TTL_MS, signGalleryAccessToken, verifyGalleryAccessToken } from "../lib/gallery-tokens.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import { multerErrorHandler, photoUpload } from "../middleware/upload.js";
import {
  ALLOWED_MIME_TYPES,
  deletePhotoQuietly,
  photoDownloadUrl,
  photoUrl,
  readPhotoBytes,
  uploadPhoto,
} from "../lib/storage.js";
import { clearFailures, isRateLimited, recordFailure } from "../lib/rate-limit.js";

export interface CreateRouterOptions {
  env: Env;
}

const createEventSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  location: z.string().max(200).optional(),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  // Deliberately no status: events are ALWAYS born draft. Status only ever
  // changes through PATCH /events/:id, never at creation time.
});

const updateEventSchema = createEventSchema.partial().extend({
  status: z.enum(["draft", "active", "completed"]).optional(),
});

const inviteSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(200),
});

const assignSchema = z.object({ user_id: z.string().uuid() });
const roleSchema = z.object({ role: z.enum(["ADMIN", "TEAM_MEMBER"]) });
const createGallerySchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
  photo_ids: z.array(z.string().uuid()).min(1).max(500),
});

const unlockGallerySchema = z.object({
  pin: z.string().regex(/^\d{6}$/, "PIN must be 6 digits"),
});

const setPinSchema = unlockGallerySchema;

/**
 * Resolve the Postgres row for the verified Clerk identity on the request.
 * Identity comes from requireAuth (verified Clerk token) — never the client.
 */
export async function resolveAppUser(env: Env, req: Request): Promise<DbUser> {
  const auth = (req as AuthedRequest).auth;
  if (!auth) throw new HttpError(401, "Unauthorized");
  const user = await getUserByClerkId(env, auth.userId);
  if (!user) {
    // Verified Clerk identity with no app row yet — provision per role policy
    // (invited → their invitation role; self-signup → ADMIN).
    return upsertUserFromClerk(env, {
      id: auth.userId,
      name: auth.name,
      email: auth.email,
      invitedRole: auth.invitedRole,
    });
  }
  return user;
}

export function createApiRouter({ env }: CreateRouterOptions): Router {
  const router = Router();

  // ------------------------------------------------------------------
  // Health & identity
  // ------------------------------------------------------------------

  router.get("/health", async (_req, res) => {
    const dbOk = await checkDatabase(env).catch(() => false);
    if (!dbOk) {
      res.status(503).json({ status: "degraded", database: "down" });
      return;
    }
    res.json({ status: "ok" });
  });

  router.get("/me", (async (req: Request, res: Response) => {
    const auth = (req as AuthedRequest).auth;
    if (!auth) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const user = await upsertUserFromClerk(env, {
      id: auth.userId,
      name: auth.name,
      email: auth.email,
      invitedRole: auth.invitedRole,
    });
    res.json({
      id: user.clerk_user_id,
      email: user.email,
      name: user.name,
      role: user.role,
    });
  }) as unknown as import("express").RequestHandler);

  /**
   * Real aggregates for the dashboard overview. Admins see the workspace;
   * team members see only their assigned events, and people-counts are
   * withheld (null) so the client can hide those cards.
   */
  router.get("/stats", (async (req: Request, res: Response) => {
    const user = await resolveAppUser(env, req);
    const memberScope = user.role === "ADMIN" ? undefined : user.id;
    const [stats, uploadsPerDay, activity] = await Promise.all([
      getDashboardStats(env, user.workspace_id, memberScope),
      getUploadsPerDay(env, user.workspace_id, memberScope, 14),
      getRecentActivity(env, user.workspace_id, memberScope, 8),
    ]);
    res.json({
      stats: {
        events: stats.events,
        active_events: stats.active_events,
        photos: stats.photos,
        published_galleries: stats.published_galleries,
        team_members: memberScope ? null : stats.team_members,
        pending_invites: memberScope ? null : stats.pending_invites,
      },
      uploads_per_day: uploadsPerDay,
      recent_activity: activity.map((a) => ({
        type: a.type,
        actor_name: a.actor_name ?? "Someone",
        title: a.title,
        detail: a.detail,
        at: new Date(a.at).toISOString(),
      })),
    });
  }) as unknown as import("express").RequestHandler);

  // ------------------------------------------------------------------
  // Team members (ADMIN only, workspace-scoped)
  // ------------------------------------------------------------------

  router.get("/team-members", requireRole(env, "ADMIN"), (async (req: Request, res: Response) => {
    const actor = await resolveAppUser(env, req);
    const users = await listWorkspaceUsers(env, actor.workspace_id);
    const invites = await listPendingInvitationsForWorkspace(env, actor.workspace_id);
    res.json({ members: users.map(serializeUser), invites: invites.map(serializeInvitation) });
  }) as unknown as import("express").RequestHandler);

  /**
   * Invite a team member: creates a Clerk invitation (emails the invitee)
   * and records it in the invitations table bound to the INVITER'S workspace
   * (derived from the authenticated user — never from the request body).
   * The invitation stamps role:'TEAM_MEMBER' into the invitee's Clerk
   * publicMetadata so they provision into this workspace as TEAM_MEMBER.
   */
  router.post("/team-members/invite", requireRole(env, "ADMIN"), (async (
    req: Request,
    res: Response
  ) => {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      return;
    }
    const { name, email } = parsed.data;
    const actor = await resolveAppUser(env, req);

    const workspaceUsers = await listWorkspaceUsers(env, actor.workspace_id);
    const existingMember = workspaceUsers.find(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    );
    if (existingMember) {
      res.status(200).json({ member: serializeUser(existingMember), invited: false });
      return;
    }

    // Send the Clerk invitation. Duplicate invitations (422) are tolerated —
    // the local invitation record below is still ensured.
    let clerkInvitationId: string | undefined;
    let emailSent = true;
    try {
      const invitation = await getClerkClientForEnv(env).invitations.createInvitation({
        emailAddress: email,
        notify: true,
        publicMetadata: {
          invited_by: actor.id,
          workspace_id: actor.workspace_id,
          role: "TEAM_MEMBER",
        },
      });
      clerkInvitationId = invitation.id;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 422) {
        if (status === 403) {
          // Keep a local pending invitation. The member will be linked when
          // they register with this exact email address.
          emailSent = false;
        } else {
          console.error("Clerk invitation failed:", (err as Error).message);
          res.status(502).json({ error: "Failed to create invitation" });
          return;
        }
      }
    }

    await createInvitation(env, {
      email,
      workspace_id: actor.workspace_id,
      invited_by: actor.id,
      clerk_invitation_id: clerkInvitationId,
    });

    // Pre-create the pending placeholder row so the team list shows the
    // invited member before they accept. It is claimed on first sign-in.
    const pendingRes = await listWorkspaceUsers(env, actor.workspace_id);
    const existingPending = pendingRes.find(
      (u) => u.email.toLowerCase() === email.toLowerCase() && u.clerk_user_id.startsWith("pending:")
    );
    if (existingPending) {
      res.status(200).json({ member: serializeUser(existingPending), invited: true, emailSent });
      return;
    }
    const result = await getPool(env).query<DbUser>(
      `INSERT INTO users (clerk_user_id, name, email, role, workspace_id)
       VALUES ($1, $2, $3, 'TEAM_MEMBER', $4)
       RETURNING *`,
      [`pending:${email.toLowerCase()}`, name, email, actor.workspace_id]
    );
    res.status(201).json({ member: serializeUser(result.rows[0]!), invited: true, emailSent });
  }) as unknown as import("express").RequestHandler);

  /**
   * Change a user's application role. Backend-only decision: the actor cannot
   * change their own role, the target must be in the same workspace, and the
   * last remaining ADMIN of the workspace can never be demoted.
   */
  router.patch("/team-members/:id/role", requireRole(env, "ADMIN"), (async (
    req: Request,
    res: Response
  ) => {
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      return;
    }
    const actor = await resolveAppUser(env, req);
    const target = await getUserById(env, String(req.params.id));
    if (!target || target.workspace_id !== actor.workspace_id) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }
    if (target.id === actor.id) {
      res.status(403).json({ error: "You cannot change your own role" });
      return;
    }
    if (target.role === "ADMIN" && parsed.data.role === "TEAM_MEMBER") {
      const admins = (await listWorkspaceUsers(env, actor.workspace_id)).filter(
        (u) => u.role === "ADMIN"
      );
      if (admins.length <= 1) {
        res.status(409).json({ error: "Cannot demote the last admin" });
        return;
      }
    }
    const updated = await setUserRole(env, target.id, parsed.data.role);
    if (!updated) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }
    res.json({ member: serializeUser(updated) });
  }) as unknown as import("express").RequestHandler);

  /**
   * Remove a team member (revoke access). The target must belong to the
   * actor's workspace. Real users keep their Clerk account (auth remains in
   * Clerk) but lose the app row → 401 on next API call; memberships cascade.
   */
  router.delete("/team-members/:id", requireRole(env, "ADMIN"), (async (
    req: Request,
    res: Response
  ) => {
    const actor = await resolveAppUser(env, req);
    const target = await getUserById(env, String(req.params.id));
    if (!target || target.workspace_id !== actor.workspace_id) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }
    if (target.id === actor.id) {
      res.status(403).json({ error: "You cannot remove your own account" });
      return;
    }
    if (target.role === "ADMIN") {
      res.status(403).json({ error: "Demote the admin before removing them" });
      return;
    }
    const { getPool } = await import("../lib/db.js");
    await getPool(env).query("DELETE FROM users WHERE id = $1", [target.id]);
    res.status(204).send();
  }) as unknown as import("express").RequestHandler);

  // ------------------------------------------------------------------
  // Events (workspace-scoped)
  // ------------------------------------------------------------------

  router.get("/events", (async (req: Request, res: Response) => {
    const user = await resolveAppUser(env, req);
    const events = await listEventsForUser(env, user);
    res.json({ events: events.map(serializeEvent) });
  }) as unknown as import("express").RequestHandler);

  router.post("/events", requireRole(env, "ADMIN"), (async (req: Request, res: Response) => {
    const parsed = createEventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      return;
    }
    const actor = await resolveAppUser(env, req);
    // workspace_id derives from the authenticated admin — never the client.
    const event = await createEvent(env, actor.workspace_id, actor.id, parsed.data);
    res.status(201).json({ event: serializeEvent(event) });
  }) as unknown as import("express").RequestHandler);

  router.get("/events/:id", (async (req: Request, res: Response) => {
    const user = await resolveAppUser(env, req);
    // Tenancy gate: event must belong to the caller's workspace.
    const event = await getWorkspaceEvent(env, String(req.params.id), user.workspace_id);
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    // Relationship check: admins pass; members need an event_team_members row.
    if (user.role !== "ADMIN" && !(await isEventMember(env, event.id, user.id))) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    res.json({ event: serializeEvent(event) });
  }) as unknown as import("express").RequestHandler);

  router.patch("/events/:id", requireRole(env, "ADMIN"), (async (req: Request, res: Response) => {
    const parsed = updateEventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      return;
    }
    const actor = await resolveAppUser(env, req);
    const event = await getWorkspaceEvent(env, String(req.params.id), actor.workspace_id);
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    const updated = await updateEvent(env, event.id, parsed.data);
    res.json({ event: serializeEvent(updated!) });
  }) as unknown as import("express").RequestHandler);

  router.delete("/events/:id", requireRole(env, "ADMIN"), (async (req: Request, res: Response) => {
    const actor = await resolveAppUser(env, req);
    const event = await getWorkspaceEvent(env, String(req.params.id), actor.workspace_id);
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    // Collect the storage keys first — deleting the event row cascades the
    // photo metadata away, and there would be nothing left to look up.
    const photos = await listEventPhotos(env, event.id);
    await deleteEvent(env, event.id);
    // Best-effort binary cleanup in Appwrite; a leftover object is preferable
    // to failing a delete whose metadata is already gone.
    await Promise.all(photos.map((p) => deletePhotoQuietly(env, p.storage_file_id)));
    res.status(204).send();
  }) as unknown as import("express").RequestHandler);

  // ------------------------------------------------------------------
  // Photos (binaries in Appwrite, metadata in Postgres, workspace-scoped)
  // ------------------------------------------------------------------

  /**
   * Shared gate for photo operations: event must be in the caller's
   * workspace, and team members must be assigned to the event. Admins pass
   * by workspace membership alone.
   */
  async function authorizeEventAccess(req: Request, res: Response) {
    const user = await resolveAppUser(env, req);
    const event = await getWorkspaceEvent(env, String(req.params.eventId ?? req.params.id), user.workspace_id);
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return null;
    }
    if (user.role !== "ADMIN" && !(await isEventMember(env, event.id, user.id))) {
      res.status(403).json({ error: "Forbidden" });
      return null;
    }
    return { user, event };
  }

  router.post(
    "/events/:eventId/photos",
    photoUpload,
    multerErrorHandler,
    (async (req: Request, res: Response) => {
      const ctx = await authorizeEventAccess(req, res);
      if (!ctx) return;
      const { user, event } = ctx;

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) {
        res.status(400).json({ error: "No photos provided" });
        return;
      }

      const uploaded: unknown[] = [];
      for (const file of files) {
        // Defense in depth: multer's fileFilter already checked this, but
        // never trust a single layer for content-type.
        if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
          res.status(400).json({ error: `Unsupported file type: ${file.mimetype}. Use JPEG, PNG or WebP.` });
          return;
        }
        try {
          const stored = await uploadPhoto(env, file.buffer, file.mimetype, file.originalname);
          try {
            // 2. Metadata → Postgres. uploaded_by is ALWAYS the authenticated
            //    user — any client-supplied value is ignored.
            const photo = await insertPhoto(env, {
              event_id: event.id,
              uploaded_by: user.id,
              filename: file.originalname,
              storage_file_id: stored.storageFileId,
              mime_type: file.mimetype,
              file_size: file.size,
            });
            uploaded.push(serializePhoto(photo, env));
          } catch (metaErr) {
            await deletePhotoQuietly(env, stored.storageFileId);
            throw metaErr;
          }
        } catch (err) {
          console.error("Photo upload failed:", (err as Error).message);
          const message = uploaded.length
            ? `Some photos couldn't be uploaded (${uploaded.length} of ${files.length} succeeded). Try again for the rest.`
            : "Photo upload failed. Please try again.";
          res.status(502).json({ error: message, uploaded });
          return;
        }
      }

      res.status(201).json({ photos: uploaded });
    }) as unknown as import("express").RequestHandler
  );

  router.get("/events/:eventId/photos", (async (req: Request, res: Response) => {
    const ctx = await authorizeEventAccess(req, res);
    if (!ctx) return;
    const photos = await listEventPhotos(
      env,
      ctx.event.id,
      ctx.user.role === "TEAM_MEMBER" ? ctx.user.id : undefined
    );
    res.json({ photos: photos.map((p) => serializePhoto(p, env)) });
  }) as unknown as import("express").RequestHandler);

  router.delete("/photos/:photoId", requireRole(env, "ADMIN"), (async (
    req: Request,
    res: Response
  ) => {
    const actor = await resolveAppUser(env, req);
    const photo = await getPhotoById(env, String(req.params.photoId));
    if (!photo) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }
    // Workspace gate: the photo's event must belong to the admin's workspace.
    const event = await getWorkspaceEvent(env, photo.event_id, actor.workspace_id);
    if (!event) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }
    // 1. Remove the binary first (worst case: orphaned object, no dead link
    //    serving a deleted photo), then the metadata row.
    await deletePhotoQuietly(env, photo.storage_file_id);
    await deletePhoto(env, photo.id);
    res.status(204).send();
  }) as unknown as import("express").RequestHandler);

  // ------------------------------------------------------------------
  // Event team membership (workspace-scoped)
  // ------------------------------------------------------------------

  router.get("/events/:id/team-members", requireRole(env, "ADMIN"), (async (req: Request, res: Response) => {
    const user = await resolveAppUser(env, req);
    const event = await getWorkspaceEvent(env, String(req.params.id), user.workspace_id);
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    if (user.role !== "ADMIN" && !(await isEventMember(env, event.id, user.id))) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const members = await listEventMembers(env, event.id);
    res.json({ members: members.map(serializeMember) });
  }) as unknown as import("express").RequestHandler);

  router.post("/events/:id/team-members", requireRole(env, "ADMIN"), (async (
    req: Request,
    res: Response
  ) => {
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      return;
    }
    const actor = await resolveAppUser(env, req);
    const event = await getWorkspaceEvent(env, String(req.params.id), actor.workspace_id);
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    const target = await getUserById(env, parsed.data.user_id);
    // Both the event AND the assignee must belong to the actor's workspace.
    if (!target || target.workspace_id !== actor.workspace_id) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }
    if (target.clerk_user_id.startsWith("pending:")) {
      res.status(409).json({ error: "This member hasn't accepted their invite yet" });
      return;
    }
    const membership = await addEventMember(env, event.id, target.id, actor.id);
    res.status(201).json({ membership: serializeMember({ ...membership, user: target }) });
  }) as unknown as import("express").RequestHandler);

  router.delete("/events/:id/team-members/:userId", requireRole(env, "ADMIN"), (async (
    req: Request,
    res: Response
  ) => {
    const actor = await resolveAppUser(env, req);
    const event = await getWorkspaceEvent(env, String(req.params.id), actor.workspace_id);
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    const target = await getUserById(env, String(req.params.userId));
    if (!target || target.workspace_id !== actor.workspace_id) {
      res.status(404).json({ error: "Membership not found" });
      return;
    }
    const removed = await removeEventMember(env, event.id, target.id);
    if (!removed) {
      res.status(404).json({ error: "Membership not found" });
      return;
    }
    res.status(204).send();
  }) as unknown as import("express").RequestHandler);

  // ------------------------------------------------------------------
  // Galleries (ADMIN only, workspace-scoped, event-bound)
  // ------------------------------------------------------------------

  /**
   * Create a gallery for an event with selected photos. The PIN is always
   * generated server-side; the slug is derived from the name and made
   * unique. Every photo ID must belong to the same event — enforced in SQL.
   */
  router.post("/events/:id/galleries", requireRole(env, "ADMIN"), (async (
    req: Request,
    res: Response
  ) => {
    const parsed = createGallerySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      return;
    }
    const actor = await resolveAppUser(env, req);
    const event = await getWorkspaceEvent(env, String(req.params.id), actor.workspace_id);
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }

    const photoIds = parsed.data.photo_ids;
    if (photoIds.length === 0) {
      res.status(400).json({ error: "Select at least one photo" });
      return;
    }
    const validCount = await photosInEvent(env, photoIds, event.id);
    if (validCount !== photoIds.length) {
      res.status(400).json({ error: "Some selected photos don't belong to this event" });
      return;
    }

    // Secure 6-digit PIN, server-generated (crypto random, no leading-zero loss).
    const pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const slug = await uniqueGallerySlug(env, parsed.data.name);

    const gallery = await insertGallery(env, {
      event_id: event.id,
      name: parsed.data.name,
      description: parsed.data.description ?? "",
      slug,
      pin,
      created_by: actor.id,
    });
    const associated = await associateGalleryPhotos(env, gallery.id, event.id, photoIds);

    res.status(201).json({ gallery: serializeGallery(gallery, associated) });
  }) as unknown as import("express").RequestHandler);

  router.get("/events/:id/galleries", requireRole(env, "ADMIN"), (async (req: Request, res: Response) => {
    const user = await resolveAppUser(env, req);
    const event = await getWorkspaceEvent(env, String(req.params.id), user.workspace_id);
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    if (user.role !== "ADMIN" && !(await isEventMember(env, event.id, user.id))) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const galleries = await listEventGalleries(env, event.id);
    const withCounts = await Promise.all(
      galleries.map(async (g) =>
        serializeGallery(g, (await listGalleryPhotoIds(env, g.id)).length)
      )
    );
    res.json({ galleries: withCounts });
  }) as unknown as import("express").RequestHandler);

  /**
   * Publish a gallery. Admin-only; the gallery must belong to the admin's
   * workspace (checked through its event). Publishing never modifies photos.
   */
  router.post("/galleries/:id/publish", requireRole(env, "ADMIN"), (async (
    req: Request,
    res: Response
  ) => {
    const actor = await resolveAppUser(env, req);
    const gallery = await getGalleryById(env, String(req.params.id));
    if (!gallery) {
      res.status(404).json({ error: "Gallery not found" });
      return;
    }
    const event = await getWorkspaceEvent(env, gallery.event_id, actor.workspace_id);
    if (!event) {
      res.status(404).json({ error: "Gallery not found" });
      return;
    }
    const published = await publishGallery(env, gallery.id);
    if (!published) {
      res.status(404).json({ error: "Gallery not found" });
      return;
    }
    const photoCount = (await listGalleryPhotoIds(env, gallery.id)).length;
    res.json({ gallery: serializeGallery(published, photoCount) });
  }) as unknown as import("express").RequestHandler);

  /**
   * Shared gate for gallery management: the gallery must exist and belong
   * to the admin's workspace (checked through its event).
   */
  async function authorizeGalleryAccess(req: Request, res: Response) {
    const actor = await resolveAppUser(env, req);
    const gallery = await getGalleryById(env, String(req.params.id));
    if (!gallery) {
      res.status(404).json({ error: "Gallery not found" });
      return null;
    }
    const event = await getWorkspaceEvent(env, gallery.event_id, actor.workspace_id);
    if (!event) {
      res.status(404).json({ error: "Gallery not found" });
      return null;
    }
    return { actor, gallery };
  }

  /** Set a custom PIN — the auto-generated one can always be replaced. */
  router.patch("/galleries/:id", requireRole(env, "ADMIN"), (async (req: Request, res: Response) => {
    const parsed = setPinSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      return;
    }
    const ctx = await authorizeGalleryAccess(req, res);
    if (!ctx) return;
    const updated = await updateGalleryPin(env, ctx.gallery.id, parsed.data.pin);
    const photoCount = (await listGalleryPhotoIds(env, ctx.gallery.id)).length;
    res.json({ gallery: serializeGallery(updated!, photoCount) });
  }) as unknown as import("express").RequestHandler);

  /** Regenerate: a fresh server-generated PIN replaces the current one. */
  router.post("/galleries/:id/pin/regenerate", requireRole(env, "ADMIN"), (async (
    req: Request,
    res: Response
  ) => {
    const ctx = await authorizeGalleryAccess(req, res);
    if (!ctx) return;
    const pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const updated = await updateGalleryPin(env, ctx.gallery.id, pin);
    const photoCount = (await listGalleryPhotoIds(env, ctx.gallery.id)).length;
    res.json({ gallery: serializeGallery(updated!, photoCount) });
  }) as unknown as import("express").RequestHandler);

  // ------------------------------------------------------------------
  // Public gallery surface (no Clerk auth — this is the customer link).
  // The slug itself is unguessable enough for a shareable URL; the photos
  // stay behind the server-verified PIN. Draft galleries 404 so the
  // public surface never reveals an unpublished gallery exists.
  // ------------------------------------------------------------------

  /** Metadata only — enough to render the PIN screen, never the photos. */
  router.get("/public/galleries/:slug", (async (req: Request, res: Response) => {
    const gallery = await getPublishedGalleryBySlug(env, String(req.params.slug));
    if (!gallery) {
      res.status(404).json({ error: "Gallery not found" });
      return;
    }
    const photoCount = (await listGalleryPhotoIds(env, gallery.id)).length;
    res.json({ gallery: serializePublicGallery(gallery, photoCount) });
  }) as unknown as import("express").RequestHandler);

  /**
   * Verify the PIN and return the gallery's photos. Rate limited per
   * slug+IP: 5 wrong attempts per 15 minutes. PIN comparison is
   * timing-safe; the PIN itself never appears in any response.
   */
  router.post("/public/galleries/:slug/unlock", (async (req: Request, res: Response) => {
    const parsed = unlockGallerySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Enter the 6-digit PIN" });
      return;
    }
    const slug = String(req.params.slug);
    const key = `${slug}:${req.ip ?? "unknown"}`;
    if (isRateLimited(key)) {
      res.status(429).json({ error: "Too many incorrect attempts. Try again in 15 minutes." });
      return;
    }
    const gallery = await getPublishedGalleryBySlug(env, slug);
    if (!gallery) {
      res.status(404).json({ error: "Gallery not found" });
      return;
    }
    const given = Buffer.from(parsed.data.pin);
    const expected = Buffer.from(gallery.pin);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      recordFailure(key);
      res.status(403).json({ error: "Incorrect PIN. Please try again." });
      return;
    }
    clearFailures(key);
    const photos = await listGalleryPhotos(env, gallery.id);
    // A successful unlock mints a signed, expiring token. Photo bytes are
    // then served by the backend (see the route below) — the client never
    // receives a raw storage URL.
    const expiresAt = Date.now() + GALLERY_TOKEN_TTL_MS;
    const accessToken = signGalleryAccessToken(env, slug, expiresAt);
    res.json({
      gallery: serializePublicGallery(gallery, photos.length),
      access_token: accessToken,
      expires_at: new Date(expiresAt).toISOString(),
      photos: photos.map((p) => serializePublicPhoto(p, slug, accessToken)),
    });
  }) as unknown as import("express").RequestHandler);

  /**
   * Stream one gallery photo. The signed token from /unlock authorizes this
   * gallery for its TTL; the photo must belong to that gallery, and the
   * gallery must still be published. `dl=1` forces a download instead of
   * inline display.
   */
  router.get("/public/galleries/:slug/photos/:photoId", (async (req: Request, res: Response) => {
    const slug = String(req.params.slug);
    const token = String(req.query.st ?? "");
    if (!verifyGalleryAccessToken(env, slug, token)) {
      res.status(403).json({ error: "This gallery session has expired. Enter the PIN again." });
      return;
    }
    const gallery = await getPublishedGalleryBySlug(env, slug);
    if (!gallery) {
      res.status(404).json({ error: "Gallery not found" });
      return;
    }
    const photo = await getPhotoById(env, String(req.params.photoId));
    if (!photo) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }
    // The photo must actually be part of THIS gallery.
    const photoIds = await listGalleryPhotoIds(env, gallery.id);
    if (!photoIds.includes(photo.id)) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }
    try {
      const bytes = await readPhotoBytes(env, photo.storage_file_id);
      const safeName = photo.filename.replace(/["\\\r\n]/g, "_");
      res.set({
        "Content-Type": photo.mime_type,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": `${req.query.dl === "1" ? "attachment" : "inline"}; filename="${safeName}"`,
        // helmet defaults this to `same-origin`, which makes browsers refuse
        // to embed these bytes on the (different-origin) frontend. Serving
        // cross-origin <img>s is this endpoint's whole job — opt out here,
        // scoped to this route only.
        "Cross-Origin-Resource-Policy": "cross-origin",
      });
      res.send(bytes);
    } catch (err) {
      console.error("Photo proxy failed:", (err as Error).message);
      res.status(502).json({ error: "Couldn't load this photo" });
    }
  }) as unknown as import("express").RequestHandler);

  return router;
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

export type SerializedUser = {
  id: string;
  clerk_user_id: string;
  name: string;
  email: string;
  role: "ADMIN" | "TEAM_MEMBER";
  pending: boolean;
  created_at: string;
};

export function serializeUser(u: DbUser): SerializedUser {
  return {
    id: u.id,
    clerk_user_id: u.clerk_user_id,
    name: u.name,
    email: u.email,
    role: u.role,
    pending: u.clerk_user_id.startsWith("pending:"),
    created_at: new Date(u.created_at).toISOString(),
  };
}

export function serializeEvent(e: DbEvent) {
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    location: e.location,
    date: e.event_date,
    status: e.status,
    // Derived by the query (COUNT over photos) — the UI shows this directly.
    photo_count: Number(e.photo_count ?? 0),
    createdAt: new Date(e.created_at).toISOString(),
  };
}

export function serializeInvitation(i: DbInvitation) {
  return {
    id: i.id,
    email: i.email,
    status: i.status,
    created_at: new Date(i.created_at).toISOString(),
  };
}

export function serializeGallery(g: DbGallery, photoCount: number) {
  return {
    id: g.id,
    event_id: g.event_id,
    name: g.name,
    description: g.description,
    slug: g.slug,
    status: g.status,
    photo_count: photoCount,
    pin: g.pin, // admin-facing response only; never returned by public endpoints
    published_at: g.published_at ? new Date(g.published_at).toISOString() : null,
    created_at: new Date(g.created_at).toISOString(),
  };
}

export function serializePhoto(p: DbPhoto, appwriteEnv: Env) {
  return {
    id: p.id,
    event_id: p.event_id,
    uploaded_by: p.uploaded_by,
    // Attribution for the UI. uploader_* are present on list reads (joined in
    // SQL); on upload-insert they may be absent, so the client falls back.
    uploader_name: p.uploader_name ?? null,
    uploader_role: p.uploader_role ?? null,
    filename: p.filename,
    mime_type: p.mime_type,
    file_size: p.file_size,
    url: photoUrl(appwriteEnv, p.storage_file_id),
    download_url: photoDownloadUrl(appwriteEnv, p.storage_file_id),
    created_at: new Date(p.created_at).toISOString(),
  };
}

/**
 * Public-facing gallery shape for the customer surface: no PIN, no ids of
 * internal rows, no workspace or author information — only what the PIN
 * screen and gallery view render.
 */
export function serializePublicGallery(
  g: DbGallery & { event_name?: string | null; event_date?: string | null },
  photoCount: number
) {
  return {
    name: g.name,
    description: g.description,
    slug: g.slug,
    event_name: g.event_name ?? null,
    event_date: g.event_date ?? null,
    photo_count: photoCount,
    published_at: g.published_at ? new Date(g.published_at).toISOString() : null,
  };
}

/**
 * Public photo shape: backend-proxied URLs carrying the unlock session's
 * signed token — no uploader attribution, no storage URLs, no ids beyond
 * the photo itself.
 */
export function serializePublicPhoto(p: DbPhoto, slug: string, token: string) {
  const base = `/api/v1/public/galleries/${encodeURIComponent(slug)}/photos/${p.id}`;
  const st = encodeURIComponent(token);
  return {
    id: p.id,
    filename: p.filename,
    url: `${base}?st=${st}`,
    download_url: `${base}?st=${st}&dl=1`,
    created_at: new Date(p.created_at).toISOString(),
  };
}

export function serializeMember(m: { user: DbUser; added_at: Date; added_by: string | null }) {
  return {
    ...serializeUser(m.user),
    added_at: new Date(m.added_at).toISOString(),
    added_by: m.added_by,
  };
}
