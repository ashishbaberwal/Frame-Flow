"use client";

import * as React from "react";
import { useAuth } from "@clerk/nextjs";
import { Loader2, Mail, UserPlus, MoreHorizontal, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { api, ApiError, type TeamMemberApi } from "@/lib/api/client";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

/**
 * Team Management panel (ADMIN only).
 * Lists application users, invites new members via Clerk invitations,
 * supports role changes and removal — all through the verified backend API.
 */
export function TeamManagement() {
  const { getToken } = useAuth();
  const [members, setMembers] = React.useState<TeamMemberApi[] | null>(null);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [inviting, setInviting] = React.useState(false);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const token = await getToken();
      const data = await api.listMembers(token);
      setMembers(data.members);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load team");
      setMembers([]);
    }
  }, [getToken]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = await getToken();
        const data = await api.listMembers(token);
        if (!cancelled) setMembers(data.members);
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : "Failed to load team");
          setMembers([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  async function onInvite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInviting(true);
    try {
      const token = await getToken();
      const data = await api.inviteMember(token, { name, email });
      if (data.invited && data.emailSent === false) {
        toast.success("Member added as pending", {
          description: `${data.member.name} must register with this email, then they will join your workspace.`,
        });
      } else if (data.invited === false) {
        toast.info(`${data.member.name} is already on your team.`);
      } else {
        toast.success("Invitation sent", {
          description: `${data.member.name} will receive a Clerk invite email.`,
        });
      }
      setName("");
      setEmail("");
      setInviteOpen(false);
      await load();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.status === 502
            ? "Unable to create the invitation. Please try again."
            : err.status === 403
              ? "You don't have permission to perform this action."
              : err.message
          : "Unable to connect to the server. Please try again.";
      setError(message);
    } finally {
      setInviting(false);
    }
  }

  async function onRoleChange(member: TeamMemberApi, role: "ADMIN" | "TEAM_MEMBER") {
    try {
      const token = await getToken();
      await api.setMemberRole(token, member.id, role);
      toast.success(`${member.name} is now ${role === "ADMIN" ? "an admin" : "a team member"}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to change role");
    }
  }

  async function onRemove(member: TeamMemberApi) {
    try {
      const token = await getToken();
      await api.removeMember(token, member.id);
      toast.success(`${member.name} removed`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove member");
    }
  }

  if (members === null) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
        <div>
          <h2 className="font-display text-sm font-semibold">Team members</h2>
          <p className="text-xs text-muted-foreground">
            Invited members receive a Clerk email invite — roles are stored server-side.
          </p>
        </div>
        <Button size="sm" onClick={() => setInviteOpen(true)}>
          <UserPlus /> Invite member
        </Button>
      </div>

      {members.length === 0 ? (
        <EmptyState
          icon={UserPlus}
          title="No team members yet"
          description="Invite your first photographer or editor — they'll get a Clerk invite by email."
          action={{ label: "Invite member", onClick: () => setInviteOpen(true) }}
        />
      ) : (
        <ul className="divide-y">
          {members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <Avatar className="size-9">
                <AvatarFallback className="text-xs">
                  {(m.name || m.email).split(" ").map((n) => n[0]).slice(0, 2).join("")}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {m.name || m.email}
                  {m.role === "ADMIN" && (
                    <Badge variant="info" className="ml-2">Admin</Badge>
                  )}
                  {m.pending && (
                    <Badge variant="secondary" className="ml-2">
                      <Mail className="mr-1 inline size-3" /> Invite pending
                    </Badge>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">{m.email}</p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={`Manage ${m.name}`}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {m.role === "TEAM_MEMBER" ? (
                    <DropdownMenuItem onClick={() => onRoleChange(m, "ADMIN")}>
                      <ShieldCheck /> Make admin
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onClick={() => onRoleChange(m, "TEAM_MEMBER")}>
                      <ShieldOff /> Demote to member
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() => onRemove(m)}
                  >
                    <Trash2 /> Remove
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}

      {/* Invite dialog */}
      <Dialog
        open={inviteOpen}
        onOpenChange={(o) => {
          if (!o) {
            setName("");
            setEmail("");
            setError(null);
          }
          setInviteOpen(o);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Invite team member</DialogTitle>
            <DialogDescription>
              They&apos;ll receive a Clerk invitation email. Once they sign in, their verified
              identity links to their account here with the Team member role.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onInvite} className="grid gap-4" noValidate>
            <div className="grid gap-1.5">
              <Label htmlFor="invite-name">Name</Label>
              <Input
                id="invite-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Priyanka Rao"
                required
                minLength={2}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="invite-email">Email</Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="invite-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@studio.com"
                  className="pl-8"
                  required
                />
              </div>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <DialogFooter className="mt-2">
              <Button type="button" variant="outline" onClick={() => setInviteOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={inviting || name.length < 2 || !email}>
                {inviting && <Loader2 className="animate-spin" />}
                Send invitation
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
