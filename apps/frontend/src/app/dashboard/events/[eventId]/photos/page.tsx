"use client";

import * as React from "react";
import {
  ArrowUpDown,
  CheckSquare,
  Images,
  Sparkles,
  Square,
  Upload,
  X,
} from "lucide-react";
import { useAuth } from "@clerk/nextjs";
import { useParams, useSearchParams, useRouter } from "next/navigation";

import { cn, formatNumber } from "@/lib/utils";
import { api, ApiError, listAllPhotos, toPhoto } from "@/lib/api/client";
import { useCurrentUserState } from "@/lib/api/use-current-user";
import type { Photo } from "@/types";
import { AppShell } from "@/components/dashboard/app-shell";
import { PhotoCard } from "@/components/photos/photo-card";
import { UploadModal } from "@/components/photos/upload-modal";
import { CreateGalleryWizard } from "@/components/galleries/create-gallery-wizard";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Sort = "newest" | "oldest" | "uploader";

/**
 * Real photo workspace: list comes from GET /api/v1/events/:id/photos,
 * uploads go through the multipart endpoint (Appwrite + Postgres).
 * Local selection state is temporary UI only — gallery persistence is a
 * later phase and is intentionally NOT wired here.
 */
export default function PhotosPage() {
  const params = useParams<{ eventId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const eventId = params.eventId;
  const { getToken } = useAuth();
  const { user } = useCurrentUserState();
  const isAdmin = user?.role === "admin";

  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [photos, setPhotos] = React.useState<Photo[]>([]);
  const [eventName, setEventName] = React.useState("Event");
  const [sort, setSort] = React.useState<Sort>("newest");
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [wizardOpen, setWizardOpen] = React.useState(false);
  const lastClickedIndex = React.useRef<number | null>(null);

  // Deep link from the event page opens the gallery wizard directly.
  const openWizardParam = searchParams.get("createGallery") === "1";
  React.useEffect(() => {
    if (!openWizardParam || !isAdmin) return;
    const t = setTimeout(() => {
      setWizardOpen(true);
      router.replace(`/dashboard/events/${eventId}/photos`);
    }, 0);
    return () => clearTimeout(t);
  }, [openWizardParam, isAdmin, eventId, router]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const [data, eventRes] = await Promise.all([
        listAllPhotos(token, eventId),
        api
          .getEvent(token, eventId)
          .then((r) => r.event.name)
          .catch(() => "Event"),
      ]);
      setEventName(eventRes);
      setPhotos(data.photos.map((p) => toPhoto(p)));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError("You don't have permission to view photos for this event.");
      } else if (err instanceof ApiError && err.status === 404) {
        setError("Event not found, or it belongs to another workspace.");
      } else {
        setError("Unable to connect to the server. Please try again.");
      }
      setPhotos([]);
    } finally {
      setLoading(false);
    }
  }, [eventId, getToken]);
  void load; // retained for retry button

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const token = await getToken();
        const data = await listAllPhotos(token, eventId);
        if (cancelled) return;
        setPhotos(data.photos.map((p) => toPhoto(p)));
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) {
          setError("You don't have permission to view photos for this event.");
        } else if (err instanceof ApiError && err.status === 404) {
          setError("Event not found, or it belongs to another workspace.");
        } else {
          setError("Unable to connect to the server. Please try again.");
        }
        setPhotos([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, getToken]);

  const visible = React.useMemo(() => {
    const list = [...photos];
    list.sort((a, b) => {
      if (sort === "newest") return +new Date(b.uploadedAt) - +new Date(a.uploadedAt);
      if (sort === "oldest") return +new Date(a.uploadedAt) - +new Date(b.uploadedAt);
      return a.uploaderName.localeCompare(b.uploaderName);
    });
    return list;
  }, [photos, sort]);

  const selectedIds = React.useMemo(() => photos.filter((p) => p.selected).map((p) => p.id), [photos]);

  function togglePhoto(photo: Photo, shiftKey: boolean) {
    setPhotos((prev) => {
      const index = prev.findIndex((p) => p.id === photo.id);
      if (index === -1) return prev;
      const next = [...prev];
      const target = !prev[index].selected;

      if (shiftKey && lastClickedIndex.current !== null) {
        const [start, end] = [lastClickedIndex.current, index].sort((a, b) => a - b);
        for (let i = start; i <= end; i++) {
          next[i] = { ...next[i], selected: target };
        }
      } else {
        next[index] = { ...next[index], selected: target };
      }
      lastClickedIndex.current = index;
      return next;
    });
  }

  function selectVisible(selected: boolean) {
    const ids = new Set(visible.map((p) => p.id));
    setPhotos((prev) => prev.map((p) => (ids.has(p.id) ? { ...p, selected } : p)));
  }

  const crumbs = [
    { label: "Events", href: "/dashboard/events" },
    { label: "Photos", href: `/dashboard/events/${eventId}/photos` },
  ];

  return (
    <AppShell
      title="Photos"
      crumbs={crumbs}
      actions={
        <Button size="sm" onClick={() => setUploadOpen(true)}>
          <Upload /> <span className="hidden sm:inline">Upload photos</span>
          <span className="sm:hidden">Upload</span>
        </Button>
      }
    >
      <div className="animate-fade-up pb-24">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Photos</h1>
        <p className="mt-1 text-muted-foreground">
          {loading ? (
            <Skeleton className="inline-block h-4 w-40 align-middle" />
          ) : (
            `${formatNumber(photos.length)} photos uploaded`
          )}
          {isAdmin && photos.length > 0 && ` · ${formatNumber(selectedIds.length)} selected`}
        </p>

        {/* Toolbar */}
        {!loading && photos.length > 0 && (
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
              <SelectTrigger className="w-[150px]" aria-label="Sort photos">
                <ArrowUpDown className="size-3.5 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest first</SelectItem>
                <SelectItem value="oldest">Oldest first</SelectItem>
                <SelectItem value="uploader">By uploader</SelectItem>
              </SelectContent>
            </Select>

            {isAdmin && (
              <Button variant="ghost" size="sm" onClick={() => selectVisible(true)}>
                <CheckSquare /> Select all shown
              </Button>
            )}
            {isAdmin && selectedIds.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => selectVisible(false)}>
                <Square /> Deselect shown
              </Button>
            )}
            {isAdmin && <span className="hidden sm:inline text-xs text-muted-foreground">Tip: hold Shift to select a range.</span>}
          </div>
        )}

        {/* Grid */}
        {loading ? (
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {Array.from({ length: 15 }).map((_, i) => (
              <Skeleton key={i} className={cn("rounded-lg", i % 3 === 0 ? "aspect-[3/4]" : i % 3 === 1 ? "aspect-[4/3]" : "aspect-square")} />
            ))}
          </div>
        ) : error ? (
          <EmptyState
            icon={X}
            title="Couldn't load photos"
            description={error}
            action={{ label: "Try again", onClick: () => void load() }}
            className="mt-6 rounded-xl border border-dashed"
          />
        ) : photos.length === 0 ? (
          <EmptyState
            icon={Images}
            title="No photos uploaded yet"
            description={
              isAdmin
                ? "Your team hasn't uploaded any photos to this event yet."
                : "Upload your first photos to this event."
            }
            action={{ label: "Upload photos", onClick: () => setUploadOpen(true) }}
            className="mt-6 rounded-xl border border-dashed"
          />
        ) : (
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {visible.map((photo) => (
              <PhotoCard
                key={photo.id}
                photo={photo}
                selected={photo.selected}
                onToggle={isAdmin ? togglePhoto : undefined}
              />
            ))}
          </div>
        )}
      </div>

      {/* Sticky selection toolbar (admin-only) */}
      {isAdmin && selectedIds.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 animate-fade-up lg:pl-60">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 md:px-6">
            <p className="text-sm font-medium">
              <span className="tabular-nums">{selectedIds.length}</span>{" "}
              {selectedIds.length === 1 ? "photo" : "photos"} selected
            </p>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setWizardOpen(true)}>
                <Sparkles /> Create gallery
              </Button>
              <Button variant="ghost" size="sm" onClick={() => selectVisible(false)}>
                <X /> Clear
              </Button>
            </div>
          </div>
        </div>
      )}

      <UploadModal
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        eventId={eventId}
        onUploaded={() => void load()}
      />

      {isAdmin && (
        <CreateGalleryWizard
          open={wizardOpen}
          onOpenChange={setWizardOpen}
          eventId={eventId}
          eventName={eventName}
          photos={photos}
        />
      )}
    </AppShell>
  );
}
