"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertCircle, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@clerk/nextjs";

import { api, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const addMemberSchema = z.object({
  name: z.string().min(2, "Enter the member's full name"),
  email: z.string().email("Enter a valid email address"),
  role: z.enum(["admin", "member"]),
});

type AddMemberValues = z.infer<typeof addMemberSchema>;

export function AddMemberModal({
  open,
  onOpenChange,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Kept by callers for context, but invitations are workspace-level: the
   * backend stamps workspace_id from the authenticated admin, so no event id
   * is sent. Add the member to a specific event via the event team panel.
   */
  eventId?: string;
  /** Called after a successful invite so the parent can refresh its list. */
  onInvited?: () => void;
}) {
  const { getToken } = useAuth();
  const [role, setRole] = React.useState<"admin" | "member">("member");
  const [serverError, setServerError] = React.useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<AddMemberValues>({
    resolver: zodResolver(addMemberSchema),
    defaultValues: { name: "", email: "", role: "member" },
  });

  async function onSubmit(values: AddMemberValues) {
    setServerError(null);
    try {
      const token = await getToken();
      // Real invitation: creates the workspace member + Clerk invite. This
      // modal previously wrote to an in-memory mock store, so it reported
      // success while persisting nothing.
      const result = await api.inviteMember(token, { name: values.name, email: values.email });
      toast.success(result.emailSent === false ? "Member added as pending" : "Invitation sent", {
        description:
          result.emailSent === false
            ? `${values.name} must register with this email, then they will join your workspace.`
            : `${values.name} will join this workspace once they accept.`,
      });
      reset();
      setRole("member");
      onOpenChange(false);
      onInvited?.();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.status === 403
            ? "You don't have permission to invite members."
            : err.message
          : "Unable to send the invitation. Please try again.";
      setServerError(message);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add member</DialogTitle>
          <DialogDescription>
            Invite a photographer or editor to this event. They&apos;ll receive upload access by email.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4" noValidate>
          <div className="grid gap-1.5">
            <Label htmlFor="member-name">Name</Label>
            <Input
              id="member-name"
              placeholder="e.g. Priyanka Rao"
              aria-invalid={!!errors.name}
              {...register("name")}
            />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="member-email">Email</Label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="member-email"
                type="email"
                placeholder="name@studio.com"
                className="pl-8"
                aria-invalid={!!errors.email}
                {...register("email")}
              />
            </div>
            {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label>Role</Label>
            <input type="hidden" {...register("role")} />
            <Select
              value={role}
              onValueChange={(v) => {
                setRole(v as "admin" | "member");
                setValue("role", v as "admin" | "member");
              }}
            >
              <SelectTrigger aria-label="Role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Team member — uploads photos</SelectItem>
                <SelectItem value="admin">Admin — manages event and team</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {serverError && (
            <p className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
              <AlertCircle className="size-3.5" /> {serverError}
            </p>
          )}
          <DialogFooter className="mt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="animate-spin" />}
              Add member
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
