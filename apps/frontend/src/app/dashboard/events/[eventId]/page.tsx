"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Calendar,
  MapPin,
  Images,
  Upload,
  UserPlus,
  Sparkles,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Copy,
  ExternalLink,
  KeyRound,
  MoreVertical,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

import { formatDate, formatNumber, timeAgo } from "@/lib/utils";
import { api, ApiError, toGallery, toPhoto, toTeamMember } from "@/lib/api/client";
import { useAuth } from "@clerk/nextjs";
import { useCurrentUserState } from "@/lib/api/use-current-user";
import type { Event, EventStatus, Gallery, Photo, TeamMember } from "@/types";
import { AppShell } from "@/components/dashboard/app-shell";
import { EventStatusBadge, GalleryStatusBadge } from "@/components/dashboard/status-badge";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UploadModal } from "@/components/photos/upload-modal";
import { PhotoCard } from "@/components/photos/photo-card";
import { CreateGalleryWizard } from "@/components/galleries/create-gallery-wizard";
import { EventTeamPanel } from "@/components/team/event-team-panel";

export default function EventDetailPage() {
  const params = useParams<{ eventId: string }>();
  const eventId = params.eventId;
  const { user } = useCurrentUserState();
  const isAdmin = user?.role === "admin";
  const { getToken } = useAuth();
  const [loading, setLoading] = React.useState(true);
  const [event, setEvent] = React.useState<Event | null>(null);
  const [members, setMembers] = React.useState<TeamMember[]>([]);
  const [galleries, setGalleries] = React.useState<Gallery[]>([]);
  const [photos, setPhotos] = React.useState<Photo[]>([]);
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState("overview");
  const [wizardOpen, setWizardOpen] = React.useState(false);

  // Refetchable so an upload can refresh photos AND the count in place.
  const load = React.useCallback(
    async (cancelled?: () => boolean) => {
      const token = await getToken();
      // Everything on this page comes from the real API — team members and
      // galleries used to be served from an in-memory mock store, so created
      // galleries never appeared and counts were always empty.
      const [eventRes, membersRes, galleriesRes, photosRes] = await Promise.all([
        api
          .getEvent(token, eventId)
          .then((r) => ({
            id: r.event.id,
            slug: r.event.id,
            name: r.event.name,
            description: r.event.description,
            date: r.event.date,
            location: r.event.location,
            coverUrl:
              "https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1200&h=500&q=80",
            photoCount: r.event.photo_count,
            teamMemberCount: 0,
            status: r.event.status,
            lastActivity: r.event.createdAt,
            createdAt: r.event.createdAt,
          }))
          .catch(() => null),
        api
          .listEventMembers(token, eventId)
          .then((r) => r.members.map(toTeamMember))
          // 404/403 here means no access to this event, not "no members" —
          // leave the list empty but let the event fetch surface the problem.
          .catch(() => [] as TeamMember[]),
        api
          .listEventGalleries(token, eventId)
          .then((r) =>
            r.galleries.map((g) =>
              toGallery(g, "", typeof window !== "undefined" ? window.location.origin : "")
            )
          )
          .catch(() => [] as Gallery[]),
        api
          .listPhotos(token, eventId)
          .then((r) => r.photos.map((p) => toPhoto(p)))
          .catch(() => [] as Photo[]),
      ]);
      if (cancelled?.()) return;
      setEvent(eventRes);
      setMembers(membersRes);
      setGalleries(galleriesRes);
      setPhotos(photosRes);
      setLoading(false);
    },
    [eventId, getToken]
  );

  React.useEffect(() => {
    let isCancelled = false;
    // Kick the load off inside an async IIFE so the effect body itself stays
    // synchronous — setState then happens in a promise callback, never during
    // the effect's synchronous phase.
    void (async () => {
      await load(() => isCancelled);
    })();
    return () => {
      isCancelled = true;
    };
  }, [load]);

  const selectedCount = photos.filter((p) => p.selected).length;

  if (loading) {
    return (
      <AppShell title="Event" crumbs={[{ label: "Events", href: "/dashboard/events" }, { label: "…" }]}>
        <Skeleton className="h-48 w-full rounded-xl" />
        <div className="mt-6 space-y-3">
          <Skeleton className="h-7 w-1/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      </AppShell>
    );
  }

  if (!event) {
    return (
      <AppShell title="Event" crumbs={[{ label: "Events", href: "/dashboard/events" }, { label: "Not found" }]}>
        <EmptyState
          icon={Images}
          title="Event not found"
          description="This event may have been deleted, or the link is out of date."
          action={{ label: "Back to events", href: "/dashboard/events" }}
          className="rounded-xl border border-dashed"
        />
      </AppShell>
    );
  }

  const crumbs = [{ label: "Events", href: "/dashboard/events" }, { label: event.name }];

  return (
    <AppShell
      title={event.name}
      crumbs={crumbs}
      // No header action: "Upload photos" lives in the actions row below the
      // banner, and duplicating it here was confusing.
    >
      <div className="animate-fade-up">
        {/* Banner */}
        <div className="relative h-40 overflow-hidden rounded-xl bg-secondary sm:h-56">
          <Image src={event.coverUrl} alt="" fill sizes="(max-width: 1024px) 100vw, 1100px" className="object-cover" priority />
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/10 to-transparent" />
          <Link
            href="/dashboard/events"
            className="absolute left-4 top-4 inline-flex items-center gap-1.5 rounded-md bg-white/90 px-2.5 py-1.5 text-xs font-medium text-neutral-900 backdrop-blur hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="size-3.5" /> All events
          </Link>
          <div className="absolute bottom-4 left-4 right-4 text-white">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-xl font-semibold tracking-tight sm:text-2xl">{event.name}</h1>
              {isAdmin ? (
                <EventStatusControl
                  event={event}
                  token={getToken}
                  onChange={(status) => setEvent({ ...event, status })}
                />
              ) : (
                <EventStatusBadge status={event.status} />
              )}
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-sm text-white/85">
              <span className="inline-flex items-center gap-1.5">
                <Calendar className="size-3.5" /> {formatDate(event.date)}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="size-3.5" /> {event.location}
              </span>
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => setUploadOpen(true)}>
            <Upload /> Upload photos
          </Button>
          {isAdmin && (
            <Button variant="outline" onClick={() => setActiveTab("team")}>
              <UserPlus /> Assign team
            </Button>
          )}
          <Button variant="outline" onClick={() => setWizardOpen(true)}>
            <Sparkles /> Create gallery
          </Button>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-6">
          <TabsList className="w-full justify-start overflow-x-auto no-scrollbar sm:w-auto">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="photos">Photos</TabsTrigger>
            <TabsTrigger value="team">Team</TabsTrigger>
            <TabsTrigger value="galleries">Galleries</TabsTrigger>
          </TabsList>

          {/* Overview */}
          <TabsContent value="overview">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {[
                { label: "Total photos", value: formatNumber(event.photoCount) },
                { label: "Selected for delivery", value: formatNumber(selectedCount) },
                { label: "Team members", value: String(members.length) },
                { label: "Galleries", value: String(galleries.length) },
              ].map((stat) => (
                <div key={stat.label} className="rounded-xl border bg-card p-4">
                  <p className="text-sm text-muted-foreground">{stat.label}</p>
                  <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{stat.value}</p>
                </div>
              ))}
            </div>

            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <div className="rounded-xl border bg-card">
                <h2 className="border-b px-5 py-3.5 font-display text-sm font-semibold">About</h2>
                <div className="space-y-3 px-5 py-4 text-sm">
                  <p className="text-muted-foreground">{event.description}</p>
                  <p className="text-muted-foreground">
                    Created {formatDate(event.createdAt)} · Last activity {timeAgo(event.lastActivity)}
                  </p>
                </div>
                <h3 className="border-t px-5 py-3 font-display text-sm font-semibold">Recent team</h3>
                <ul className="px-5 pb-4">
                  {members.slice(0, 4).map((m) => (
                    <li key={m.id} className="flex items-center gap-3 py-2">
                      <Avatar className="size-8">
                        <AvatarFallback className="text-[10px]">
                          {m.name.split(" ").map((n) => n[0]).join("")}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{m.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                      </div>
                      {m.role === "admin" && (
                        <span className="text-xs font-medium text-muted-foreground">Admin</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-xl border bg-card">
                <h2 className="border-b px-5 py-3.5 font-display text-sm font-semibold">Latest galleries</h2>
                {galleries.length === 0 ? (
                  // No action here — "Create gallery" is a separate button
                  // above; this panel is informational only.
                  <EmptyState
                    icon={Images}
                    title="No galleries yet"
                    description="Select photos and publish your first client gallery."
                    className="py-10"
                  />
                ) : (
                  <ul className="divide-y">
                    {galleries.slice(0, 4).map((g) => (
                      <li key={g.id} className="flex items-center gap-3 px-5 py-3">
                        {/* Galleries store no cover; show an event photo. */}
                        <div className="relative size-12 shrink-0 overflow-hidden rounded-md bg-secondary">
                          {photos[0] ? (
                            <Image src={photos[0].url} alt="" fill sizes="48px" className="object-cover" />
                          ) : (
                            <span className="flex size-full items-center justify-center">
                              <Images className="size-4 text-muted-foreground" />
                            </span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{g.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatNumber(g.photoCount)}{" "}
                            {g.photoCount === 1 ? "photo" : "photos"} · PIN{" "}
                            <span className="font-mono tabular-nums tracking-wider">{g.pin}</span>
                          </p>
                        </div>
                        <GalleryStatusBadge status={g.status} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </TabsContent>

          {/* Photos — the event's own photos, shown inline. */}
          <TabsContent value="photos">
            {photos.length === 0 ? (
              <div className="rounded-xl border border-dashed">
                <EmptyState
                  icon={Images}
                  title="No photos yet"
                  description="Upload the first batch to get started."
                  action={{ label: "Upload photos", onClick: () => setUploadOpen(true) }}
                />
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">
                    {formatNumber(photos.length)}{" "}
                    {photos.length === 1 ? "photo" : "photos"} in this event
                  </p>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/dashboard/events/${event.id}/photos`}>
                      Curate in photo workspace <CheckCircle2 className="size-4" />
                    </Link>
                  </Button>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {photos.map((photo) => (
                    <PhotoCard key={photo.id} photo={photo} selected={false} />
                  ))}
                </div>
              </>
            )}
          </TabsContent>

          {/* Team */}
          <TabsContent value="team">
            <EventTeamPanel eventId={event.id} isAdmin={user?.role === "admin"} />
          </TabsContent>

          {/* Galleries — every gallery for this event, with its share link and PIN */}
          <TabsContent value="galleries">
            {galleries.length === 0 ? (
              // Informational only — "Create gallery" is a button above.
              <EmptyState
                icon={Images}
                title="No galleries yet"
                description="Select photos and publish your first client gallery."
                className="rounded-xl border border-dashed"
              />
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2">
                {galleries.map((g) => (
                  <li key={g.id} className="rounded-xl border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{g.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatNumber(g.photoCount)}{" "}
                          {g.photoCount === 1 ? "photo" : "photos"}
                          {g.publishedAt
                            ? ` · Published ${formatDate(g.publishedAt)}`
                            : " · Draft"}
                        </p>
                      </div>
                      <GalleryStatusBadge status={g.status} />
                    </div>

                    {/* PIN — the client needs this to open the gallery. */}
                    <div className="mt-3 flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">PIN</span>
                      <code className="rounded bg-secondary px-2 py-0.5 font-mono text-sm tabular-nums tracking-widest">
                        {g.pin}
                      </code>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Copy PIN for ${g.name}`}
                        onClick={() => {
                          void navigator.clipboard
                            ?.writeText(g.pin)
                            .then(() => toast.success("PIN copied"))
                            .catch(() => toast.error("Couldn't copy PIN"));
                        }}
                      >
                        <Copy className="size-3.5" /> Copy
                      </Button>
                      {isAdmin && (
                        <GalleryPinMenu
                          gallery={g}
                          token={getToken}
                          onChanged={() => void load()}
                        />
                      )}
                    </div>

                    {/* Public gallery link */}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button variant="outline" size="sm" asChild>
                        <a href={g.url} target="_blank" rel="noreferrer">
                          Open gallery <ExternalLink className="size-3.5" />
                        </a>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Copy link for ${g.name}`}
                        onClick={() => {
                          void navigator.clipboard
                            ?.writeText(g.url)
                            .then(() => toast.success("Link copied"))
                            .catch(() => toast.error("Couldn't copy link"));
                        }}
                      >
                        <Copy className="size-3.5" /> Copy link
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      </div>

      <UploadModal
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        eventId={eventId}
        onUploaded={() => {
          // Refetch photos and the event count in place — no full page reload.
          void load();
        }}
      />
      {/* Gallery wizard lives here too, so publishing from this page shows up
          in the Galleries tab without a trip to the photo workspace. */}
      {isAdmin && (
        <CreateGalleryWizard
          open={wizardOpen}
          onOpenChange={setWizardOpen}
          eventId={event.id}
          eventName={event.name}
          photos={photos}
          onPublished={() => void load()}
        />
      )}
    </AppShell>
  );
}

/**
 * Per-gallery PIN controls: set a custom PIN, or regenerate a fresh
 * server-generated one. Admin-only surface — the backend re-checks role
 * and workspace on every call.
 */function GalleryPinMenu({
  gallery,
  token,
  onChanged,
}: {
  gallery: Gallery;
  token: (options?: { skipCache?: boolean }) => Promise<string | null>;
  onChanged: () => void;
}) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [pin, setPin] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  async function savePin() {
    setSaving(true);
    try {
      const t = await token();
      await api.setGalleryPin(t, gallery.id, pin);
      toast.success("PIN updated", { description: "Share the new PIN with your client." });
      setDialogOpen(false);
      setPin("");
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't update the PIN");
    } finally {
      setSaving(false);
    }
  }

  async function regenerate() {
    try {
      const t = await token();
      await api.regenerateGalleryPin(t, gallery.id);
      toast.success("New PIN generated", { description: "The old PIN no longer opens this gallery." });
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't regenerate the PIN");
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7" aria-label={`PIN options for ${gallery.name}`}>
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setDialogOpen(true)}>
            <KeyRound className="size-4" /> Set custom PIN…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void regenerate()}>
            <RefreshCw className="size-4" /> Regenerate PIN
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Set a custom PIN</DialogTitle>
            <DialogDescription>
              6 digits. The gallery link stays the same — only the PIN changes.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (pin.length === 6 && !saving) void savePin();
            }}
          >
            <Input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              placeholder="000000"
              className="text-center font-mono text-lg tabular-nums tracking-[0.4em]"
              aria-label="New 6-digit PIN"
              autoFocus
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pin.length !== 6 || saving}>
                Save PIN
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

const EVENT_STATUSES: EventStatus[] = ["draft", "active", "completed"];

/**
 * Admin control for the event lifecycle. Events are always created draft;
 * this is the only place status changes afterwards (the backend re-checks
 * the admin role and workspace on the PATCH).
 */
function EventStatusControl({
  event,
  token,
  onChange,
}: {
  event: Event;
  token: (options?: { skipCache?: boolean }) => Promise<string | null>;
  onChange: (status: EventStatus) => void;
}) {
  const [saving, setSaving] = React.useState(false);

  async function update(status: EventStatus) {
    if (status === event.status || saving) return;
    setSaving(true);
    try {
      const t = await token();
      await api.updateEvent(t, event.id, { status });
      onChange(status);
      toast.success(`Event marked ${status}`, {
        description:
          status === "active"
            ? "It's live for the team and ready for delivery."
            : status === "completed"
              ? "Wrapped — the record stays in your archive."
              : "It's back to draft while you prepare it.",
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't update the status");
    } finally {
      setSaving(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={saving}
          aria-label={`Change event status — currently ${event.status}`}
          className="inline-flex cursor-pointer items-center gap-1 rounded-full transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-wait disabled:opacity-70"
        >
          <EventStatusBadge status={event.status} />
          <ChevronDown className="size-3.5 drop-shadow" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {EVENT_STATUSES.map((s) => (
          <DropdownMenuItem key={s} onSelect={() => void update(s)} className="capitalize">
            <CheckCircle2
              className={s === event.status ? "size-4" : "size-4 opacity-0"}
              aria-hidden="true"
            />
            {s}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
