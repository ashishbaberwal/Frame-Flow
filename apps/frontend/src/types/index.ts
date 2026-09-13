export type UserRole = "admin" | "member" | "customer";

export type EventStatus = "active" | "completed" | "draft";
export type GalleryStatus = "draft" | "published" | "expired";

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  avatarUrl?: string;
}

export interface TeamMember {
  id: string;
  eventId: string;
  userId: string;
  name: string;
  email: string;
  role: "admin" | "member";
  photosUploaded: number;
  joinedAt: string;
}

export interface Event {
  id: string;
  slug: string;
  name: string;
  description: string;
  date: string;
  location: string;
  coverUrl: string;
  photoCount: number;
  teamMemberCount: number;
  status: EventStatus;
  lastActivity: string;
  createdAt: string;
}

export interface Photo {
  id: string;
  eventId: string;
  url: string;
  fullUrl: string;
  /** Appwrite attachment URL — a real download, not a navigation. */
  downloadUrl?: string;
  /** Original filename from upload metadata (used as the download name). */
  filename?: string;
  width: number;
  height: number;
  /** Display name of whoever uploaded it, from the API. */
  uploaderName: string;
  /** Their app role, so the photo can be tagged "Admin" or "Team member". */
  uploaderRole: "admin" | "member";
  uploadedAt: string;
  selected: boolean;
  favorite?: boolean;
}

export interface Gallery {
  id: string;
  slug: string;
  eventId: string;
  eventName: string;
  name: string;
  description: string;
  coverUrl: string;
  photoCount: number;
  status: GalleryStatus;
  createdAt: string;
  publishedAt?: string;
  expiresAt?: string;
  pin: string;
  url: string;
  downloadEnabled: boolean;
}

export interface UploadItem {
  id: string;
  file: File;
  previewUrl: string;
  progress: number;
  status: "queued" | "uploading" | "uploaded" | "failed";
  error?: string;
}
