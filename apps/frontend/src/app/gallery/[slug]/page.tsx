"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  CloudOff,
  FileQuestion,
  Images,
  Loader2,
  LockKeyhole,
  Share2,
} from "lucide-react";
import { motion } from "motion/react";
import { toast } from "sonner";

import {
  api,
  ApiError,
  getOrCreateVisitorId,
  rememberVisitorId,
  resolveAssetUrl,
  type PublicGalleryApi,
  type PublicPhotoApi,
} from "@/lib/api/client";
import { formatDate, formatNumber } from "@/lib/utils";
import type { Photo } from "@/types";
import { PinInput } from "@/components/gallery/pin-input";
import { PhotoLightbox } from "@/components/photos/photo-lightbox";
import { Skeleton } from "@/components/ui/skeleton";
import { fadeSlide, staggerContainer, riseItem } from "@/lib/motion";

/*
 * The customer gallery is always light — warm gallery paper, ink, one
 * ultramarine accent — regardless of the signed-in app's theme. These are
 * the Editorial Studio tokens pinned as literals so `.dark` never flips
 * a client-facing page.
 */

/** Metadata the customer sees before and after unlocking — served by the backend. */
type GalleryMeta = {
  name: string;
  description: string;
  slug: string;
  eventName: string;
  eventDate: string | null;
  publishedAt: string | null;
  photoCount: number;
};

type Gate =
  | { state: "loading" }
  | { state: "pin"; meta: GalleryMeta }
  | {
      state: "viewing";
      meta: GalleryMeta;
      photos: Photo[];
      session: { accessToken: string; visitorId: string | null; correlationId: string };
    }
  | { state: "not-found" }
  | { state: "unavailable" }
  | { state: "empty"; meta: GalleryMeta };

function toMeta(g: PublicGalleryApi): GalleryMeta {
  return {
    name: g.name,
    description: g.description,
    slug: g.slug,
    eventName: g.event_name ?? g.name,
    eventDate: g.event_date,
    publishedAt: g.published_at,
    photoCount: g.photo_count,
  };
}

function toPublicPhoto(p: PublicPhotoApi): Photo {
  // Photo bytes are proxied by the backend behind a signed token —
  // resolveAssetUrl prepends the API origin to the relative path.
  // Grids prefer the large thumbnail once READY, with the full proxied
  // original as the fallback and the lightbox source.
  const thumb = p.thumbnails?.thumb_large ?? p.thumbnails?.thumb_small ?? null;
  const gridUrl = thumb ?? p.url;
  return {
    id: p.id,
    eventId: "",
    url: resolveAssetUrl(gridUrl),
    fullUrl: resolveAssetUrl(p.url),
    downloadUrl: resolveAssetUrl(p.download_url),
    filename: p.filename,
    width: 0,
    height: 0,
    // The public surface deliberately carries no uploader attribution.
    uploaderName: "",
    uploaderRole: "member",
    uploadedAt: p.created_at,
    selected: false,
  };
}

export default function CustomerGalleryPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug ?? null;
  const [gate, setGate] = React.useState<Gate>({ state: "loading" });
  const [pin, setPin] = React.useState("");
  const [verifying, setVerifying] = React.useState(false);
  const [pinError, setPinError] = React.useState(false);
  const [pinMessage, setPinMessage] = React.useState<string | null>(null);
  const [shakeKey, setShakeKey] = React.useState(0);
  const [lightboxIndex, setLightboxIndex] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    api.getPublicGallery(slug).then(
      (res) => {
        if (cancelled) return;
        setGate({ state: "pin", meta: toMeta(res.gallery) });
      },
      (err: unknown) => {
        if (cancelled) return;
        // Unknown or unpublished slugs 404; anything else is a reachability problem.
        setGate({
          state: err instanceof ApiError && err.status === 404 ? "not-found" : "unavailable",
        });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function verifyPin(code: string) {
    if (gate.state !== "pin" || code.length !== 6 || !slug) return;
    setVerifying(true);
    setPinMessage(null);
    try {
      const visitorId = getOrCreateVisitorId();
      const res = await api.unlockGallery(slug, code, { visitorId });
      // Persist the backend-minted id when the client had none, and carry
      // the session's correlation id through follow-up pages for stitching.
      rememberVisitorId(res.visitor_id);
      const session = {
        visitorId: res.visitor_id ?? visitorId,
        correlationId: res.correlation_id,
      };
      // Unlock returns the first page; large galleries page behind the
      // signed session token with no re-PIN. UI behavior is unchanged —
      // pages are appended before the first render of the grid.
      const all = [...res.photos];
      let cursor = res.pagination?.next_cursor ?? null;
      let hasMore = res.pagination?.has_more ?? false;
      while (hasMore && cursor) {
        const next = await api.listPublicPhotos(slug, res.access_token, {
          cursor,
          visitorId: session.visitorId,
          correlationId: session.correlationId,
        });
        all.push(...next.photos);
        hasMore = next.pagination.has_more;
        cursor = next.pagination.next_cursor;
      }
      if (all.length === 0) {
        setGate({ state: "empty", meta: toMeta(res.gallery) });
      } else {
        setGate({
          state: "viewing",
          meta: toMeta(res.gallery),
          photos: all.map(toPublicPhoto),
          session: {
            accessToken: res.access_token,
            visitorId: session.visitorId,
            correlationId: session.correlationId,
          },
        });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setGate({ state: "not-found" });
      } else {
        // Wrong PIN (403), locked out (429), or a network failure — the
        // backend message is customer-safe either way.
        setPinMessage(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
        setPinError(true);
        setShakeKey((k) => k + 1);
        setPin("");
        const t = setTimeout(() => setPinError(false), 1800);
        void t;
      }
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="min-h-dvh bg-[#faf9f6] text-[#1c1917]">
      {gate.state === "loading" && (
        <div className="mx-auto flex min-h-dvh max-w-5xl items-center justify-center px-6">
          <div className="w-full">
            <Skeleton className="mx-auto h-9 w-56 bg-[#f0ede6]" />
            <div className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="skeleton-shimmer aspect-[4/3] rounded-xl bg-[#f0ede6]" />
              ))}
            </div>
          </div>
        </div>
      )}

      {gate.state === "pin" && (
        <PinGate
          meta={gate.meta}
          pin={pin}
          onPinChange={setPin}
          onComplete={verifyPin}
          verifying={verifying}
          error={pinError}
          message={pinMessage}
          shakeKey={shakeKey}
        />
      )}

      {gate.state === "viewing" && (
        <GalleryView
          meta={gate.meta}
          photos={gate.photos}
          session={gate.session}
          lightboxIndex={lightboxIndex}
          setLightboxIndex={setLightboxIndex}
        />
      )}

      {gate.state === "not-found" && (
        <GalleryMessage
          icon={FileQuestion}
          title="Gallery not found"
          description="This link doesn't match any published gallery. Check the link with your photographer, or head back to the FrameFlow site."
        />
      )}

      {gate.state === "unavailable" && (
        <GalleryMessage
          icon={CloudOff}
          title="Gallery unavailable"
          description="We couldn't reach the server just now. Check your connection and reload the page in a moment."
        />
      )}

      {gate.state === "empty" && (
        <GalleryMessage
          icon={Images}
          title="No photos yet"
          description="This gallery doesn't contain any photos yet. Check back shortly."
        />
      )}
    </div>
  );
}

/* ---------- PIN gate ---------- */

function PinGate({
  meta,
  pin,
  onPinChange,
  onComplete,
  verifying,
  error,
  message,
  shakeKey,
}: {
  meta: GalleryMeta;
  pin: string;
  onPinChange: (pin: string) => void;
  onComplete: (pin: string) => void;
  verifying: boolean;
  error: boolean;
  message: string | null;
  shakeKey: number;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6">
      <motion.div
        variants={fadeSlide}
        initial="hidden"
        animate="show"
        className="flex w-full max-w-sm flex-col items-center text-center"
      >
        <p className="font-display text-lg font-medium tracking-tight">FrameFlow</p>
        <span className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-[#e6e1d6] bg-white px-3 py-1 shadow-hairline">
          <LockKeyhole className="size-3 text-[#3d53d6]" aria-hidden="true" />
          <span className="overline-label text-[#7a736a]">Private gallery</span>
        </span>
        <h1 className="mt-7 font-display text-4xl font-medium tracking-tight text-balance sm:text-[2.75rem]">
          {meta.eventName}
        </h1>
        <p className="mt-3 text-sm text-[#7a736a]">
          Enter the PIN provided by your photographer.
        </p>

        <div className="mt-9">
          <PinInput
            value={pin}
            onValueChange={onPinChange}
            onComplete={onComplete}
            error={error}
            disabled={verifying}
            errorShakeKey={shakeKey}
          />
        </div>

        <p aria-live="assertive" className="mt-4 min-h-5 text-sm">
          {error ? (
            <span className="text-[#b3271b]">{message ?? "Incorrect PIN. Please try again."}</span>
          ) : verifying ? (
            <span className="inline-flex items-center gap-2 text-[#7a736a]">
              <Loader2 className="size-3.5 animate-spin" /> Verifying…
            </span>
          ) : null}
        </p>

        <button
          type="button"
          disabled={pin.length !== 6 || verifying}
          onClick={() => onComplete(pin)}
          className="mt-3 inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-[#1c1917] text-sm font-medium text-[#faf9f6] transition-colors hover:bg-[#1c1917]/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3d53d6] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {verifying ? <Loader2 className="size-4 animate-spin" /> : null}
          View gallery
        </button>

        <p className="mt-9 text-xs leading-relaxed text-[#7a736a]">
          Photos stay private — only people with this link and PIN can see them.
        </p>
      </motion.div>
    </div>
  );
}

/* ---------- Gallery view ---------- */

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="overline-label text-[#7a736a]">{label}</p>
      <p className="mt-2 font-display text-2xl font-medium tracking-tight tabular-nums sm:text-3xl">
        {value}
      </p>
    </div>
  );
}

function GalleryView({
  meta,
  photos,
  session,
  lightboxIndex,
  setLightboxIndex,
}: {
  meta: GalleryMeta;
  photos: Photo[];
  session: { accessToken: string; visitorId: string | null; correlationId: string };
  lightboxIndex: number | null;
  setLightboxIndex: (i: number | null) => void;
}) {
  // One in-flight share report at a time and never a retry: every stored
  // event counts, so a failed report is dropped, not repeated.
  const shareSent = React.useRef(false);
  function share() {
    const url = window.location.href;
    const channel = typeof navigator.share === "function" ? ("native" as const) : ("clipboard" as const);
    if (navigator.share) {
      navigator.share({ title: meta.name, url }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(url).then(
        () => toast.success("Link copied"),
        () => toast.error("Couldn't copy link")
      );
    }
    if (!shareSent.current) {
      shareSent.current = true;
      void api
        .recordShareClick(meta.slug, session.accessToken, {
          channel,
          visitorId: session.visitorId,
          correlationId: session.correlationId,
        })
        .catch(() => undefined);
    }
  }

  return (
    <motion.div variants={staggerContainer(0.08)} initial="hidden" animate="show">
      <motion.header
        variants={fadeSlide}
        className="sticky top-0 z-20 border-b border-[#e6e1d6] bg-[#faf9f6]/90 backdrop-blur"
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3.5 md:px-6">
          <div className="min-w-0 flex-1">
            <p className="overline-label truncate text-[#7a736a]">{meta.eventName}</p>
            <p className="mt-0.5 truncate font-display text-lg font-medium leading-tight tracking-tight">
              {meta.name}
            </p>
          </div>
          <button
            type="button"
            onClick={share}
            className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-full bg-[#1c1917] px-4 text-sm font-medium text-[#faf9f6] transition-colors hover:bg-[#1c1917]/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3d53d6]"
          >
            <Share2 className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Share</span>
          </button>
        </div>
      </motion.header>

      {/* Stats — the editorial numerals row */}
      <motion.section
        variants={fadeSlide}
        aria-label="Gallery details"
        className="mx-auto max-w-6xl border-b border-[#e6e1d6] px-4 py-7 md:px-6"
      >
        <div className="grid grid-cols-3 gap-4 sm:gap-10">
          <Stat label="Photos" value={formatNumber(meta.photoCount)} />
          <Stat label="Event" value={meta.eventDate ? formatDate(meta.eventDate) : "—"} />
          <Stat label="Published" value={meta.publishedAt ? formatDate(meta.publishedAt) : "—"} />
        </div>
      </motion.section>

      {meta.description && (
        <motion.p
          variants={fadeSlide}
          className="mx-auto max-w-6xl px-4 pt-6 text-sm leading-relaxed text-[#7a736a] md:px-6"
        >
          {meta.description}
        </motion.p>
      )}

      {/* Photographs — rounded mosaic, generous gutters */}
      <motion.div
        variants={staggerContainer(0.04, 0.1)}
        className="mx-auto max-w-6xl px-4 pb-24 pt-7 md:px-6"
      >
        <div className="columns-2 gap-4 [column-fill:_balance] sm:columns-3 lg:columns-4">
          {photos.map((photo, index) => (
            <motion.div key={photo.id} variants={riseItem} className="mb-4 break-inside-avoid">
              <button
                type="button"
                onClick={() => setLightboxIndex(index)}
                className="group block w-full cursor-pointer overflow-hidden rounded-xl bg-[#f0ede6] shadow-hairline transition-shadow duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3d53d6] hover:shadow-lift"
                aria-label={`Open photo ${index + 1} of ${photos.length}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.url}
                  alt={`${meta.eventName} — photo ${index + 1} of ${photos.length}`}
                  width={photo.width || undefined}
                  height={photo.height || undefined}
                  loading="lazy"
                  className="w-full transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.03]"
                />
              </button>
            </motion.div>
          ))}
        </div>
      </motion.div>

      <PhotoLightbox
        photos={photos}
        index={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onNavigate={(i) => setLightboxIndex(i)}
        downloadEnabled
        title={meta.name}
      />
    </motion.div>
  );
}

/* ---------- Message states ---------- */

function GalleryMessage({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <motion.div
        variants={fadeSlide}
        initial="hidden"
        animate="show"
        className="flex flex-col items-center"
      >
        <div className="flex size-14 items-center justify-center rounded-full border border-[#e6e1d6] bg-white shadow-hairline">
          <Icon className="size-6 text-[#7a736a]" aria-hidden="true" />
        </div>
        <h1 className="mt-5 font-display text-3xl font-medium tracking-tight">{title}</h1>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-[#7a736a]">{description}</p>
        <Link
          href="/"
          className="mt-8 inline-flex items-center gap-1.5 rounded-full border border-[#e6e1d6] bg-white px-5 py-2.5 text-sm font-medium shadow-hairline transition-colors hover:bg-[#f0ede6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3d53d6]"
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Go to FrameFlow
        </Link>
      </motion.div>
    </div>
  );
}
