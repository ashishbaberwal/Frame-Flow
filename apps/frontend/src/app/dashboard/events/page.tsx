"use client";

import * as React from "react";
import { Aperture, LayoutGrid, List, Plus, Search } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { cn, coverFor } from "@/lib/utils";
import { api, ApiError } from "@/lib/api/client";
import { useCurrentUserState } from "@/lib/api/use-current-user";
import type { Event, EventStatus } from "@/types";
import { useAuth } from "@clerk/nextjs";
import { AppShell } from "@/components/dashboard/app-shell";
import { EventCard } from "@/components/events/event-card";
import { CreateEventModal } from "@/components/events/create-event-modal";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SegmentedControl } from "@/components/ui/segmented";
import { fadeSlide, staggerContainer } from "@/lib/motion";

const STATUS_FILTERS: { value: EventStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "draft", label: "Draft" },
];

export default function EventsPage() {
  const { user } = useCurrentUserState();
  const isAdmin = user?.role === "admin";
  const { getToken } = useAuth();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [events, setEvents] = React.useState<Event[]>([]);
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState<EventStatus | "all">("all");
  const [view, setView] = React.useState<"grid" | "list">("grid");
  const [createOpen, setCreateOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const data = await api.listEvents(token);
      setEvents(
        data.events.map((e) => ({
          id: e.id,
          slug: e.id,
          name: e.name,
          description: e.description,
          date: e.date,
          location: e.location,
          coverUrl: coverFor(e.id),
          photoCount: e.photo_count,
          teamMemberCount: 0,
          status: e.status,
          lastActivity: e.createdAt,
          createdAt: e.createdAt,
        }))
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError("You don't have permission to view events.");
      } else {
        setError("Unable to connect to the server. Please try again.");
      }
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const filtered = events.filter((event) => {
    const matchesQuery =
      event.name.toLowerCase().includes(query.toLowerCase()) ||
      event.location.toLowerCase().includes(query.toLowerCase());
    const matchesStatus = status === "all" || event.status === status;
    return matchesQuery && matchesStatus;
  });

  // Real numbers for the masthead overline — nothing invented.
  const activeCount = events.filter((e) => e.status === "active").length;
  const photoTotal = events.reduce((sum, e) => sum + e.photoCount, 0);
  const isFiltered = query !== "" || status !== "all";

  return (
    <AppShell
      title="Events"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Events" }]}
    >
      <motion.div variants={staggerContainer(0.07)} initial="hidden" animate="show">
        {/* Masthead */}
        <motion.header variants={fadeSlide} className="flex flex-wrap items-end justify-between gap-6">
          <div className="min-w-0">
            <p className="overline-label text-muted-foreground">
              {isFiltered
                ? `${filtered.length} of ${events.length} events`
                : `${events.length} events · ${activeCount} active · ${photoTotal} photos`}
            </p>
            <h1 className="mt-3 font-display text-4xl font-medium tracking-tight text-balance sm:text-5xl">
              {isAdmin ? (
                <>
                  Every shoot, <em className="italic text-muted-foreground">in focus.</em>
                </>
              ) : (
                <>
                  Your <em className="italic text-muted-foreground">assignments.</em>
                </>
              )}
            </h1>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
              {isAdmin
                ? "The studio's calendar of record — upload together, curate, and deliver client galleries."
                : "Events you've been assigned to. Open one to upload and review photos."}
            </p>
          </div>
          {isAdmin && (
            <Button size="lg" onClick={() => setCreateOpen(true)} className="rounded-full">
              <Plus /> New event
            </Button>
          )}
        </motion.header>

        {/* Toolbar — hairline rules top and bottom, like a magazine folio */}
        <motion.div
          variants={fadeSlide}
          className="mt-10 flex flex-col gap-3 border-y py-4 sm:flex-row sm:items-center"
        >
          <div className="relative w-full sm:max-w-xs sm:flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or location"
              className="rounded-full border-transparent bg-secondary/70 pl-9 focus-visible:border-transparent"
              aria-label="Search events"
            />
          </div>
          <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 no-scrollbar sm:mx-0 sm:overflow-visible sm:px-0">
            <SegmentedControl
              value={status}
              onChange={(v) => setStatus(v)}
              options={STATUS_FILTERS}
              ariaLabel="Filter by status"
            />
            <SegmentedControl
              value={view}
              onChange={(v) => setView(v)}
              options={[
                {
                  value: "grid",
                  label: (
                    <>
                      <LayoutGrid className="size-3.5" aria-hidden="true" />
                      <span className="sr-only">Grid view</span>
                    </>
                  ),
                },
                {
                  value: "list",
                  label: (
                    <>
                      <List className="size-3.5" aria-hidden="true" />
                      <span className="sr-only">List view</span>
                    </>
                  ),
                },
              ]}
              ariaLabel="Layout"
            />
          </div>
        </motion.div>

        {/* Content */}
        {loading ? (
          view === "grid" ? (
            <div className="mt-8 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="overflow-hidden rounded-xl border">
                  <Skeleton className="skeleton-shimmer aspect-[3/2] rounded-none" />
                  <div className="space-y-2.5 p-4">
                    <Skeleton className="skeleton-shimmer h-5 w-2/3" />
                    <Skeleton className="skeleton-shimmer h-3.5 w-1/2" />
                    <Skeleton className="skeleton-shimmer mt-4 h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-6 border-b py-5">
                  <Skeleton className="skeleton-shimmer h-3.5 w-7" />
                  <div className="flex-1 space-y-2.5">
                    <Skeleton className="skeleton-shimmer h-6 w-1/3" />
                    <Skeleton className="skeleton-shimmer h-3.5 w-1/4" />
                  </div>
                  <Skeleton className="skeleton-shimmer h-3.5 w-16" />
                </div>
              ))}
            </div>
          )
        ) : error ? (
          <motion.div variants={fadeSlide} initial="hidden" animate="show">
            <EmptyState
              icon={Search}
              title="Couldn't load events"
              description={error}
              action={{ label: "Try again", onClick: () => void load() }}
              className="mt-8 rounded-xl border border-dashed"
            />
          </motion.div>
        ) : filtered.length === 0 ? (
          <motion.div variants={fadeSlide} initial="hidden" animate="show">
            <EmptyState
              icon={Aperture}
              title={query || status !== "all" ? "No events match your filters" : "No events yet"}
              description={
                query || status !== "all"
                  ? "Try a different search term or clear the status filter."
                  : isAdmin
                    ? "Create your first event and invite your team to start uploading."
                    : "You're not assigned to any events yet. Your admin will assign you soon."
              }
              action={
                isAdmin
                  ? { label: "Create event", onClick: () => setCreateOpen(true) }
                  : undefined
              }
              className="mt-8 rounded-xl border border-dashed"
            />
          </motion.div>
        ) : (
          <AnimatePresence mode="popLayout">
            {view === "grid" ? (
              <motion.div
                key="grid"
                variants={staggerContainer(0.05)}
                initial="hidden"
                animate="show"
                className="mt-8 grid gap-5 sm:grid-cols-2 xl:grid-cols-3"
              >
                {filtered.map((event, i) => (
                  <EventCard key={event.id} event={event} view="grid" index={i} />
                ))}
              </motion.div>
            ) : (
              <motion.div
                key="list"
                variants={staggerContainer(0.04)}
                initial="hidden"
                animate="show"
                className={cn("mt-2 border-t")}
              >
                {filtered.map((event, i) => (
                  <EventCard key={event.id} event={event} view="list" index={i} />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </motion.div>

      <CreateEventModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(event) => setEvents((prev) => [event, ...prev])}
      />
    </AppShell>
  );
}
