/**
 * Typed API client for the Express backend.
 *
 * The base URL comes from NEXT_PUBLIC_API_URL (never hardcoded per-environment).
 * Every request attaches the current Clerk session token so the backend can
 * verify identity server-side — the client never sends a trusted user ID.
 */

import type { Gallery, Photo, TeamMember } from "@/types";

// A trailing slash in NEXT_PUBLIC_API_URL would produce "//api/..." paths
// that the backend 404s — normalize once, here.
const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

/** Prefix a backend-relative media path with the API origin. */
export function resolveAssetUrl(url: string): string {
  if (url.startsWith("/")) return `${API_URL}${url}`;
  return url;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Clerk token from useAuth().getToken() — optional for public endpoints. */
  token?: string | null;
}

function buildUrl(path: string): string {
  return `${API_URL}/api/v1${path}`;
}

/** How long to wait for Clerk to produce a session token before giving up. */
const TOKEN_TIMEOUT_MS = 15_000;

/**
 * Bounded Clerk session-token fetch.
 *
 * Clerk's `getToken()` can stay PENDING while its session is still loading or
 * mid-refresh. An unbounded `await` there never resolves and never rejects, so
 * the caller's spinner hangs forever and no request is ever sent — the exact
 * "stuck at 0%" symptom. We cap the wait, then retry once against a fresh
 * (uncached) token, then fail with an actionable message instead of hanging.
 *
 * The retry passes `skipCache` because the usual cause of a null/expired token
 * mid-flow is a cached token that has just passed its ~60s lifetime; asking the
 * cache again returns the same stale value.
 */
export async function getSessionToken(
  getToken: (options?: { skipCache?: boolean }) => Promise<string | null>
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const token = await Promise.race([
      // A rejected getToken() (refresh failure) is a null result, not a crash.
      getToken(attempt > 0 ? { skipCache: true } : undefined).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TOKEN_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));

    if (token) return token;
    // The token may be mid-refresh; give it a beat before forcing a fresh read.
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    "Your session has ended or could not be verified. Please sign in again, then retry the upload."
  );
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, token } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(buildUrl(path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    const message = await res
      .json()
      .then((data) => (typeof data.error === "string" ? data.error : `Request failed`))
      .catch(() => `Request failed with status ${res.status}`);
    throw new ApiError(res.status, message);
  }

  return res.json() as Promise<T>;
}

export const api = {
  me: (token: string | null) => apiFetch<{ id: string; email: string; name: string; role: string }>("/me", { token }),

  // ---- Team management (ADMIN, workspace-scoped) ----
  listMembers: (token: string | null) =>
    apiFetch<{ members: TeamMemberApi[]; invites: InvitationApi[] }>("/team-members", { token }),
  inviteMember: (
    token: string | null,
    input: { name: string; email: string }
  ) => apiFetch<{ member: TeamMemberApi; invited: boolean }>("/team-members/invite", { method: "POST", body: input, token }),
  setMemberRole: (
    token: string | null,
    id: string,
    role: "ADMIN" | "TEAM_MEMBER"
  ) => apiFetch<{ member: TeamMemberApi }>(`/team-members/${id}/role`, { method: "PATCH", body: { role }, token }),
  removeMember: (token: string | null, id: string) =>
    apiFetch<void>(`/team-members/${id}`, { method: "DELETE", token }),

  // ---- Events ----
  listEvents: (token: string | null) => apiFetch<{ events: EventApi[] }>("/events", { token }),
  createEvent: (
    token: string | null,
    input: { name: string; description?: string; location?: string; event_date: string; status?: string }
  ) => apiFetch<{ event: EventApi }>("/events", { method: "POST", body: input, token }),
  getEvent: (token: string | null, id: string) =>
    apiFetch<{ event: EventApi }>(`/events/${id}`, { token }),
  updateEvent: (
    token: string | null,
    id: string,
    input: { name?: string; description?: string; location?: string; event_date?: string; status?: string }
  ) => apiFetch<{ event: EventApi }>(`/events/${id}`, { method: "PATCH", body: input, token }),
  deleteEvent: (token: string | null, id: string) =>
    apiFetch<void>(`/events/${id}`, { method: "DELETE", token }),

  // ---- Event team membership ----
  listEventMembers: (token: string | null, eventId: string) =>
    apiFetch<{ members: TeamMemberApi[] }>(`/events/${eventId}/team-members`, { token }),
  assignEventMember: (token: string | null, eventId: string, userId: string) =>
    apiFetch<{ membership: TeamMemberApi }>(`/events/${eventId}/team-members`, {
      method: "POST",
      body: { user_id: userId },
      token,
    }),
  removeEventMember: (token: string | null, eventId: string, userId: string) =>
    apiFetch<void>(`/events/${eventId}/team-members/${userId}`, { method: "DELETE", token }),

  // ---- Photos ----
  listPhotos: (token: string | null, eventId: string) =>
    apiFetch<{ photos: PhotoApi[] }>(`/events/${eventId}/photos`, { token }),
  deletePhoto: (token: string | null, photoId: string) =>
    apiFetch<void>(`/photos/${photoId}`, { method: "DELETE", token }),

  // ---- Galleries (ADMIN) ----
  createGallery: (
    token: string | null,
    eventId: string,
    input: { name: string; description?: string; photo_ids: string[] }
  ) =>
    apiFetch<{ gallery: GalleryApi }>(`/events/${eventId}/galleries`, {
      method: "POST",
      body: input,
      token,
    }),
  listEventGalleries: (token: string | null, eventId: string) =>
    apiFetch<{ galleries: GalleryApi[] }>(`/events/${eventId}/galleries`, { token }),
  publishGallery: (token: string | null, galleryId: string) =>
    apiFetch<{ gallery: GalleryApi }>(`/galleries/${galleryId}/publish`, { method: "POST", token }),
  setGalleryPin: (token: string | null, galleryId: string, pin: string) =>
    apiFetch<{ gallery: GalleryApi }>(`/galleries/${galleryId}`, {
      method: "PATCH",
      body: { pin },
      token,
    }),
  regenerateGalleryPin: (token: string | null, galleryId: string) =>
    apiFetch<{ gallery: GalleryApi }>(`/galleries/${galleryId}/pin/regenerate`, {
      method: "POST",
      token,
    }),

  // ---- Dashboard stats ----
  stats: (token: string | null) =>
    apiFetch<{
      stats: {
        events: number;
        active_events: number;
        photos: number;
        published_galleries: number;
        /** null for team members — the UI hides people-cards for them. */
        team_members: number | null;
        pending_invites: number | null;
      };
      uploads_per_day: { day: string; uploads: number }[];
      recent_activity: {
        type: "photo_uploaded" | "gallery_published" | "event_created";
        actor_name: string;
        title: string;
        detail: string;
        at: string;
      }[];
    }>("/stats", { token }),

  // ---- Public gallery (customer surface — no Clerk token, PIN-verified server-side) ----
  getPublicGallery: (slug: string) =>
    apiFetch<{ gallery: PublicGalleryApi }>(`/public/galleries/${encodeURIComponent(slug)}`),
  unlockGallery: (slug: string, pin: string) =>
    apiFetch<{ gallery: PublicGalleryApi; photos: PublicPhotoApi[] }>(
      `/public/galleries/${encodeURIComponent(slug)}/unlock`,
      { method: "POST", body: { pin } }
    ),
};

/**
 * Upload photos with real progress events. fetch() has no upload progress,
 * so this uses XMLHttpRequest against the multipart endpoint. Auth token
 * and identity are identical to apiFetch — the backend derives everything.
 */
export function uploadPhotos(
  token: string | null,
  eventId: string,
  files: File[],
  onProgress?: (percent: number) => void
): Promise<{ photos: PhotoApi[] }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/api/v1/events/${eventId}/photos`);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.responseType = "json";
    // No request ever hangs forever — 120s ceiling.
    xhr.timeout = 120_000;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      const body = xhr.response ?? {};
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as { photos: PhotoApi[] });
      } else if (xhr.status === 401 || xhr.status === 403) {
        // Distinct type so the caller can refresh the token and retry.
        reject(new UnauthorizedError(body.error ?? "Your session was rejected. Please try again."));
      } else {
        reject(new ApiError(xhr.status, body.error ?? `Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "Unable to connect to the server. Please try again."));
    xhr.ontimeout = () => reject(new ApiError(0, "Upload timed out. Please try again."));

    const form = new FormData();
    for (const file of files) form.append("photos", file);
    xhr.send(form);
  });
}

/** A 401/403 means the session token was rejected — usually it expired mid-upload. */
export class UnauthorizedError extends ApiError {
  constructor(message: string) {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Upload with one automatic re-authentication.
 *
 * A 60s dev-instance session token can expire while a large batch is still
 * uploading, which surfaced as a bare "Unauthorized" failure and a dead
 * spinner. When the backend rejects the token, fetch a fresh one (skipping the
 * cache) and retry the batch exactly once.
 */
export async function uploadPhotosWithRetry(
  getToken: (options?: { skipCache?: boolean }) => Promise<string | null>,
  eventId: string,
  files: File[],
  onProgress?: (percent: number) => void
): Promise<{ photos: PhotoApi[] }> {
  const token = await getSessionToken(getToken);
  try {
    return await uploadPhotos(token, eventId, files, onProgress);
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
    // The token was rejected — force a fresh one and try the batch once more.
    const fresh = await getSessionToken(() => getToken({ skipCache: true }));
    return uploadPhotos(fresh, eventId, files, onProgress);
  }
}

export interface PhotoApi {
  id: string;
  event_id: string;
  uploaded_by: string;
  /** Uploader display name, joined server-side (null on upload inserts). */
  uploader_name: string | null;
  /** Uploader app role, joined server-side (null on upload inserts). */
  uploader_role: "ADMIN" | "TEAM_MEMBER" | null;
  filename: string;
  mime_type: string;
  file_size: number;
  url: string;
  /** Appwrite attachment endpoint — browsers download instead of navigating. */
  download_url: string;
  created_at: string;
}

/**
 * Single mapping point from the API photo shape to the UI `Photo` shape.
 *
 * Previously each page mapped this inline and hardcoded `"Team member"` for
 * the uploader and dropped the role entirely, so every photo was mislabelled
 * regardless of who uploaded it. Keep this the only place that translates.
 */
export function toPhoto(p: PhotoApi): Photo {
  return {
    id: p.id,
    eventId: p.event_id,
    url: p.url,
    fullUrl: p.url,
    downloadUrl: p.download_url,
    filename: p.filename,
    width: 0,
    height: 0,
    // The API joins the uploader and falls back to their email server-side, so
    // this is only blank if the user row is genuinely gone.
    uploaderName: p.uploader_name || "Former member",
    uploaderRole: p.uploader_role === "ADMIN" ? "admin" : "member",
    uploadedAt: p.created_at,
    selected: false,
  };
}

/**
 * Maps an API gallery to the UI shape. `origin` is passed in because the
 * public link is built client-side, where window.location is available.
 */
export function toGallery(g: GalleryApi, eventName: string, origin = ""): Gallery {
  return {
    id: g.id,
    slug: g.slug,
    eventId: g.event_id,
    eventName,
    name: g.name,
    description: g.description,
    // Galleries have no stored cover; the event's photos are the visual.
    coverUrl: "",
    photoCount: g.photo_count,
    status: g.status,
    createdAt: g.created_at,
    publishedAt: g.published_at ?? undefined,
    pin: g.pin,
    url: `${origin}/gallery/${g.slug}`,
    downloadEnabled: true,
  };
}

/** Maps an event team member from the API to the UI shape. */
export function toTeamMember(m: TeamMemberApi): TeamMember {
  return {
    id: m.id,
    eventId: "",
    userId: m.clerk_user_id,
    name: m.name || m.email,
    email: m.email,
    role: m.role === "ADMIN" ? "admin" : "member",
    photosUploaded: 0,
    joinedAt: m.added_at ?? m.created_at,
  };
}

export interface TeamMemberApi {
  id: string;
  clerk_user_id: string;
  name: string;
  email: string;
  role: "ADMIN" | "TEAM_MEMBER";
  pending: boolean;
  created_at: string;
  added_at?: string;
}

export interface EventApi {
  id: string;
  name: string;
  description: string;
  location: string;
  date: string;
  status: "draft" | "active" | "completed";
  /** Number of photos on this event, counted server-side. */
  photo_count: number;
  createdAt: string;
}

export interface InvitationApi {
  id: string;
  email: string;
  status: "pending" | "accepted" | "revoked";
  created_at: string;
}

export interface GalleryApi {
  id: string;
  event_id: string;
  name: string;
  description: string;
  slug: string;
  status: "draft" | "published";
  photo_count: number;
  pin: string;
  published_at: string | null;
  created_at: string;
}

/** What the public gallery surface returns — deliberately narrow: no PIN, no internal ids. */
export interface PublicGalleryApi {
  name: string;
  description: string;
  slug: string;
  event_name: string | null;
  /** Event date, YYYY-MM-DD. */
  event_date: string | null;
  photo_count: number;
  published_at: string | null;
}

/** Public photo shape — no uploader attribution, with a real download URL. */
export interface PublicPhotoApi {
  id: string;
  filename: string;
  url: string;
  download_url: string;
  created_at: string;
}
