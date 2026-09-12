"use client";

import * as React from "react";
import Link from "next/link";
import {
  FolderClosed,
  Images,
  Plus,
  UserRound,
  ImageIcon,
  Upload,
  Sparkles,
  FolderPlus,
} from "lucide-react";

import { coverFor, formatNumber, timeAgo } from "@/lib/utils";
import { api, ApiError } from "@/lib/api/client";
import { useAuth } from "@clerk/nextjs";
import { useCurrentUserState } from "@/lib/api/use-current-user";
import type { Event } from "@/types";
import { AppShell } from "@/components/dashboard/app-shell";
import { StatCard } from "@/components/dashboard/stat-card";
import { UploadActivityChart } from "@/components/dashboard/upload-activity-chart";
import { EventCard } from "@/components/events/event-card";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

type Stats = Awaited<ReturnType<typeof api.stats>>;

const activityIcons = {
  photo_uploaded: Upload,
  gallery_published: Sparkles,
  event_created: FolderPlus,
} as const;

export default function DashboardPage() {
  const { user } = useCurrentUserState();
  const isAdmin = user?.role === "admin";
  const { getToken } = useAuth();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [data, setData] = React.useState<Stats | null>(null);
  const [events, setEvents] = React.useState<Event[]>([]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const [statsData, eventsData] = await Promise.all([
        api.stats(token),
        api.listEvents(token),
      ]);
      setData(statsData);
      setEvents(
        eventsData.events.map((e) => ({
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
      setError(
        err instanceof ApiError && err.status === 403
          ? "You don't have permission to view this workspace."
          : "Unable to connect to the server. Please try again."
      );
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

  // The weekday is computed only after mount — a server-rendered date could
  // disagree with the viewer's timezone and trip hydration.
  const [today, setToday] = React.useState("");
  React.useEffect(() => {
    const id = requestAnimationFrame(() =>
      setToday(new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date()))
    );
    return () => cancelAnimationFrame(id);
  }, []);

  const stats = data?.stats;

  return (
    <AppShell
      title="Overview"
      crumbs={[{ label: "Overview" }]}
      actions={
        isAdmin ? (
          <Button size="sm" asChild className="hidden md:inline-flex">
            <Link href="/dashboard/events">
              <Plus /> New event
            </Link>
          </Button>
        ) : undefined
      }
    >
      <div className="animate-fade-up">
        <h1 className="font-display text-2xl font-semibold tracking-tight md:text-3xl">
          Good morning, {user?.name?.split(" ")[0] || "there"}
        </h1>
        <p className="mt-1 text-muted-foreground">
          {isAdmin
            ? today
              ? `Here's what's happening across your events this ${today.toLowerCase()}.`
              : "Here's what's happening across your events."
            : "Here are the events you've been assigned to."}
        </p>

        {error ? (
          <EmptyState
            icon={Images}
            title="Couldn't load your dashboard"
            description={error}
            action={{ label: "Try again", onClick: () => void load() }}
            className="mt-6 rounded-xl border border-dashed"
          />
        ) : (
          <>
            {/* Stats — every number comes from GET /api/v1/stats */}
            <div
              className={`mt-6 grid grid-cols-2 gap-4 ${isAdmin ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}
            >
              <StatCard
                label="Events"
                value={stats ? String(stats.events) : ""}
                loading={loading}
                icon={FolderClosed}
                hint={stats ? `${stats.active_events} active now` : ""}
              />
              <StatCard
                label="Total photos"
                value={stats ? formatNumber(stats.photos) : ""}
                loading={loading}
                icon={ImageIcon}
                hint={stats ? `across ${stats.events} ${stats.events === 1 ? "event" : "events"}` : ""}
              />
              <StatCard
                label="Published galleries"
                value={stats ? String(stats.published_galleries) : ""}
                loading={loading}
                icon={Images}
                hint="visible to your clients"
              />
              {isAdmin && (
                <StatCard
                  label="Team members"
                  value={stats?.team_members != null ? String(stats.team_members) : ""}
                  loading={loading}
                  icon={UserRound}
                  hint={
                    stats?.pending_invites
                      ? `${stats.pending_invites} ${stats.pending_invites === 1 ? "invite" : "invites"} pending`
                      : "in your workspace"
                  }
                />
              )}
            </div>

            <div className="mt-6 grid gap-6 lg:grid-cols-5">
              <section
                aria-labelledby="upload-activity-heading"
                className="rounded-xl border bg-card p-5 lg:col-span-3"
              >
                <div className="flex items-center justify-between">
                  <h2 id="upload-activity-heading" className="font-display text-base font-semibold">
                    Photos uploaded
                  </h2>
                  <span className="text-xs text-muted-foreground">Last 14 days</span>
                </div>
                {loading ? (
                  <Skeleton className="mt-4 h-56 w-full" />
                ) : (
                  <UploadActivityChart data={data?.uploads_per_day ?? []} />
                )}
              </section>

              <section
                aria-labelledby="recent-activity-heading"
                className="rounded-xl border bg-card p-5 lg:col-span-2"
              >
                <h2 id="recent-activity-heading" className="font-display text-base font-semibold">
                  Recent activity
                </h2>
                {loading ? (
                  <div className="mt-4 space-y-4">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <Skeleton className="size-8 rounded-full" />
                        <div className="flex-1 space-y-1.5">
                          <Skeleton className="h-3.5 w-3/4" />
                          <Skeleton className="h-3 w-1/4" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (data?.recent_activity.length ?? 0) === 0 ? (
                  <p className="mt-4 text-sm text-muted-foreground">
                    Nothing yet — upload photos or publish a gallery and it shows up here.
                  </p>
                ) : (
                  <ul className="mt-4 space-y-1">
                    {data!.recent_activity.map((item) => {
                      const Icon = activityIcons[item.type] ?? Upload;
                      const initials =
                        item.actor_name
                          .split(" ")
                          .map((n) => n[0])
                          .slice(0, 2)
                          .join("")
                          .toUpperCase() || "?";
                      return (
                        <li key={`${item.type}-${item.at}`} className="flex items-start gap-3 rounded-lg p-2 hover:bg-secondary/60">
                          <Avatar className="size-8">
                            <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm leading-snug">
                              <span className="font-medium">{item.actor_name}</span>{" "}
                              <span className="text-muted-foreground">
                                {item.detail}{" "}
                                <span className="font-medium text-foreground">{item.title}</span>
                              </span>
                            </p>
                            <p className="text-xs text-muted-foreground">{timeAgo(item.at)}</p>
                          </div>
                          <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>

            <section aria-labelledby="recent-events-heading" className="mt-6">
              <div className="flex items-center justify-between">
                <h2 id="recent-events-heading" className="font-display text-base font-semibold">
                  Recent events
                </h2>
                <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
                  <Link href="/dashboard/events">View all</Link>
                </Button>
              </div>
              {loading ? (
                <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="overflow-hidden rounded-xl border">
                      <Skeleton className="aspect-[3/2] rounded-none" />
                      <div className="space-y-2 p-4">
                        <Skeleton className="h-4 w-2/3" />
                        <Skeleton className="h-3 w-1/2" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : events.length === 0 ? (
                <EmptyState
                  icon={FolderClosed}
                  title={isAdmin ? "No events yet" : "No assignments yet"}
                  description={
                    isAdmin
                      ? "Create your first event and invite your team to start uploading."
                      : "Your admin will assign you to an event soon."
                  }
                  action={
                    isAdmin
                      ? { label: "Create event", href: "/dashboard/events" }
                      : undefined
                  }
                  className="mt-4 rounded-xl border border-dashed"
                />
              ) : (
                <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {events.slice(0, 3).map((event) => (
                    <EventCard key={event.id} event={event} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}
