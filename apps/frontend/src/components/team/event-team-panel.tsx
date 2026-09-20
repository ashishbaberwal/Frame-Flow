"use client";

import * as React from "react";
import { useAuth } from "@clerk/nextjs";
import { Loader2, UserPlus, X } from "lucide-react";
import { toast } from "sonner";

import { api, type TeamMemberApi } from "@/lib/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

/**
 * Event team panel — lists members assigned to an event and lets an ADMIN
 * assign/remove members. Assignment is relationship-based and enforced by
 * the backend (event_team_members), not by the client.
 */
export function EventTeamPanel({ eventId, isAdmin }: { eventId: string; isAdmin: boolean }) {
  const { getToken } = useAuth();
  const [members, setMembers] = React.useState<TeamMemberApi[] | null>(null);
  const [assignOpen, setAssignOpen] = React.useState(false);
  const [candidates, setCandidates] = React.useState<TeamMemberApi[]>([]);
  const [selectedId, setSelectedId] = React.useState<string>("");
  const [submitting, setSubmitting] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const token = await getToken();
      const data = await api.listEventMembers(token, eventId);
      setMembers(data.members);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load event team");
      setMembers([]);
    }
  }, [eventId, getToken]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = await getToken();
        const data = await api.listEventMembers(token, eventId);
        if (!cancelled) setMembers(data.members);
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : "Failed to load event team");
          setMembers([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, getToken]);

  async function openAssign() {
    setAssignOpen(true);
    try {
      const token = await getToken();
      const data = await api.listMembers(token);
      // Only offer active (non-pending) members not already on this event.
      const assigned = new Set((members ?? []).map((m) => m.id));
      setCandidates(
        data.members.filter(
          (m) => m.role === "TEAM_MEMBER" && !m.pending && !assigned.has(m.id)
        )
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load members");
      setAssignOpen(false);
    }
  }

  async function onAssign() {
    if (!selectedId) return;
    setSubmitting(true);
    try {
      const token = await getToken();
      await api.assignEventMember(token, eventId, selectedId);
      const target = candidates.find((c) => c.id === selectedId);
      toast.success(`${target?.name ?? "Member"} added to this event`);
      setSelectedId("");
      setAssignOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to assign member");
    } finally {
      setSubmitting(false);
    }
  }

  async function onRemove(member: TeamMemberApi) {
    try {
      const token = await getToken();
      await api.removeEventMember(token, eventId, member.id);
      toast.success(`${member.name || member.email} removed from this event`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove member");
    }
  }

  if (members === null) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-center justify-between border-b px-5 py-3.5">
        <h2 className="font-display text-sm font-semibold">Event team</h2>
        {isAdmin && (
          <Button size="sm" variant="outline" onClick={openAssign}>
            <UserPlus /> Assign member
          </Button>
        )}
      </div>

      {members.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          No members assigned to this event yet.
          {isAdmin && " Use “Assign member” to add your team."}
        </p>
      ) : (
        <ul className="divide-y">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-5 py-3">
              <Avatar className="size-9">
                <AvatarFallback className="text-xs">
                  {(m.name || m.email).split(" ").map((n) => n[0]).slice(0, 2).join("")}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {m.name || m.email}
                  {m.role === "ADMIN" && <Badge variant="info" className="ml-2">Admin</Badge>}
                </p>
                <p className="truncate text-xs text-muted-foreground">{m.email}</p>
              </div>
              {isAdmin && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${m.name}`}
                  onClick={() => onRemove(m)}
                >
                  <X />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Assign dialog */}
      <Dialog open={assignOpen} onOpenChange={(o) => { if (!o) setSelectedId(""); setAssignOpen(o); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Assign member to event</DialogTitle>
            <DialogDescription>
              Assigned members can view this event and upload photos to it.
            </DialogDescription>
          </DialogHeader>
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active team members available. Add and activate members from the Team page first.
            </p>
          ) : (
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">Member</label>
              <Select value={selectedId} onValueChange={setSelectedId}>
                <SelectTrigger aria-label="Member">
                  <SelectValue placeholder="Choose a member…" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name || c.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <DialogFooter className="mt-2">
            <Button type="button" variant="outline" onClick={() => setAssignOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={!selectedId || submitting} onClick={onAssign}>
              {submitting && <Loader2 className="animate-spin" />}
              Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
