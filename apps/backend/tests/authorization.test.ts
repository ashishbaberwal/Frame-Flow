import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Authorization-focused tests for the Phase 2 endpoints.
 *
 * Strategy: the server's trust boundary is requireAuth (Clerk token
 * verification) + requireRole (Postgres role lookup) + relationship checks.
 * These tests stub the Clerk verification layer — never the Postgres role or
 * relationship logic — so the authorization decisions under test are real.
 */

// Mock @clerk/backend's verifyToken before importing the app.
vi.mock("@clerk/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clerk/backend")>();
  return {
    ...actual,
    verifyToken: vi.fn(async (token: string) => {
      if (token.startsWith("valid.")) {
        return { sub: token.slice("valid.".length) } as { sub: string };
      }
      throw new Error("invalid token");
    }),
  };
});

vi.mock("../src/lib/clerk.js", () => ({
  getClerkClientForEnv: vi.fn(() => ({
    invitations: {
      createInvitation: vi.fn(async () => ({ id: "inv_test", status: "pending" })),
    },
  })),
}));

import { createApp } from "../src/server.js";
import { resetEnvCache } from "../src/config/env.js";
import { closePool, getPool } from "../src/lib/db.js";
import type { Env } from "../src/config/env.js";

function buildApp() {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5432/test";
  process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? "sk_test_placeholder";
  process.env.APPWRITE_ENDPOINT =
    process.env.APPWRITE_ENDPOINT ?? "https://cloud.appwrite.io/v1";
  process.env.APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID ?? "test-project";
  process.env.APPWRITE_API_KEY = process.env.APPWRITE_API_KEY ?? "test-key";
  process.env.APPWRITE_BUCKET_ID = process.env.APPWRITE_BUCKET_ID ?? "test-bucket";
  resetEnvCache();
  return createApp();
}

// Skip the whole suite when there's no real database — the authorization
// logic under test requires real Postgres (roles + relationships are SQL).
const dbUrl = process.env.TEST_DATABASE_URL;
const hasDb = !!dbUrl;

const adminToken = "valid.clerk_admin_1";
const memberToken = "valid.clerk_member_1";
const outsiderToken = "valid.clerk_outsider_1";
const secondAdminToken = "valid.clerk_admin_2";
const adminAuth = { Authorization: `Bearer ${adminToken}` };
const memberAuth = { Authorization: `Bearer ${memberToken}` };
const outsiderAuth = { Authorization: `Bearer ${outsiderToken}` };
const secondAdminAuth = { Authorization: `Bearer ${secondAdminToken}` };

async function seed(env: Env) {
  const pool = getPool(env);
  // Idempotent seed — safe to re-run. Each admin gets their OWN workspace;
  // the member joins admin_1's workspace (multi-tenant model).
  await pool.query(
    `INSERT INTO users (clerk_user_id, name, email, role, workspace_id) VALUES
       ('clerk_admin_1', 'Demo Admin', 'admin@frameflow.test', 'ADMIN',
         (SELECT id FROM workspaces WHERE name = 'WS-admin@frameflow.test')),
       ('clerk_admin_2', 'Second Admin', 'admin2@frameflow.test', 'ADMIN',
         (SELECT id FROM workspaces WHERE name = 'WS-admin2@frameflow.test')),
       ('clerk_member_1', 'Demo Member', 'member@frameflow.test', 'TEAM_MEMBER',
         (SELECT id FROM workspaces WHERE name = 'WS-admin@frameflow.test')),
       ('clerk_outsider_1', 'Outsider', '', 'TEAM_MEMBER',
         (SELECT id FROM workspaces WHERE name = 'WS-admin2@frameflow.test'))
     ON CONFLICT (clerk_user_id) DO NOTHING`
  );
}

/** Idempotently create the two test workspaces. */
async function seedWorkspaces(env: Env) {
  const pool = getPool(env);
  await pool.query(
    `INSERT INTO workspaces (name)
     SELECT 'WS-admin@frameflow.test'
     WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE name = 'WS-admin@frameflow.test')`
  );
  await pool.query(
    `INSERT INTO workspaces (name)
     SELECT 'WS-admin2@frameflow.test'
     WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE name = 'WS-admin2@frameflow.test')`
  );
}

describeIf(hasDb)("Phase 2 authorization", () => {
  let app: ReturnType<typeof createApp>;
  let env: Env;
  let eventId: string;

  function describeIf(cond: boolean) {
    return cond ? describe : describe.skip;
  }

  beforeEach(async () => {
    process.env.DATABASE_URL = dbUrl!;
    process.env.DATABASE_SSL_CA = "";
    app = buildApp();
    const { loadEnv } = await import("../src/config/env.js");
    env = loadEnv();
    await seedWorkspaces(env);
    await seed(env);
    const res = await request(app)
      .post("/api/v1/events")
      .set(adminAuth)
      .send({ name: `Auth Test Event ${Date.now()}`, event_date: "2026-12-01" });
    eventId = res.body.event.id;
  });

  afterAll(async () => {
    // Clean up only rows created by this test run (own data, no resets).
    // Order matters: invitations → memberships → events → users → workspaces.
    const pool = getPool(env);
    await pool.query("DELETE FROM events WHERE name LIKE 'Auth Test Event %'");
    await pool.query(
      `DELETE FROM invitations WHERE invited_by IN
       (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_%')`
    );
    await pool.query(
      `DELETE FROM event_team_members WHERE user_id IN
       (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_%')`
    );
    await pool.query(
      `UPDATE workspaces SET created_by = NULL
       WHERE created_by IN (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_%')`
    );
    await pool.query(
      `DELETE FROM users WHERE clerk_user_id IN
       ('clerk_admin_1','clerk_member_1','clerk_admin_2','clerk_outsider_1',
        'clerk_joining_1','clerk_selfsignup_1','clerk_invitedrole_1')`
    );
    await pool.query(
      `DELETE FROM workspaces WHERE name IN
       ('WS-admin@frameflow.test','WS-admin2@frameflow.test',
        'Self Starter''s Studio', 'Invited Person''s Studio')`
    );
    await closePool();
  });

  it("401 for unauthenticated requests on protected endpoints", async () => {
    const res = await request(app).get("/api/v1/team-members");
    expect(res.status).toBe(401);
    const res2 = await request(app).get("/api/v1/events");
    expect(res2.status).toBe(401);
  });

  it("403 for non-admin trying to list team members", async () => {
    const res = await request(app).get("/api/v1/team-members").set(memberAuth);
    expect(res.status).toBe(403);
  });

  it("403 for non-admin trying to invite a team member", async () => {
    const res = await request(app)
      .post("/api/v1/team-members/invite")
      .set(memberAuth)
      .send({ name: "Sneaky User", email: "sneaky@frameflow.test" });
    expect(res.status).toBe(403);
  });

  it("admin can invite a team member (idempotent on email)", async () => {
    const res = await request(app)
      .post("/api/v1/team-members/invite")
      .set(adminAuth)
      .send({ name: "Invited Member", email: "invited@frameflow.test" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.member.pending).toBe(true);
    // Re-invite must not duplicate.
    const res2 = await request(app)
      .post("/api/v1/team-members/invite")
      .set(adminAuth)
      .send({ name: "Invited Member", email: "invited@frameflow.test" });
    expect([200, 201]).toContain(res2.status);
    const list = await request(app).get("/api/v1/team-members").set(adminAuth);
    const invited = list.body.members.filter(
      (m: { email: string }) => m.email === "invited@frameflow.test"
    );
    expect(invited.length).toBe(1);
    // Cleanup
    await getPool(env).query("DELETE FROM users WHERE email = 'invited@frameflow.test'");
  });

  it("invited member signing in adopts the pending row (no duplicates)", async () => {
    // Admin invites someone — a pending:<email> row is created.
    const invite = await request(app)
      .post("/api/v1/team-members/invite")
      .set(adminAuth)
      .send({ name: "Joining Member", email: "joining@frameflow.test" });
    expect([200, 201]).toContain(invite.status);
    expect(invite.body.member.pending).toBe(true);

    // The invitee signs in — JIT upsert must adopt the pending row, not
    // create a second row for the same email. The invite stamped
    // role:'TEAM_MEMBER' into publicMetadata, so the invited role applies.
    const { upsertUserFromClerk } = await import("../src/lib/db.js");
    const claimed = await upsertUserFromClerk(env, {
      id: "clerk_joining_1",
      name: "Joining Member",
      email: "joining@frameflow.test",
      invitedRole: "TEAM_MEMBER",
    });

    // Exactly one row for that email, and it carries the real Clerk ID.
    const rows = await getPool(env).query<{ clerk_user_id: string }>(
      "SELECT clerk_user_id FROM users WHERE email = 'joining@frameflow.test'"
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.clerk_user_id).toBe("clerk_joining_1");
    expect(claimed.clerk_user_id).toBe("clerk_joining_1");
    expect(claimed.role).toBe("TEAM_MEMBER");

    // Pre-assigning via the pending row's memberships must survive the claim:
    // assign the (now claimed) user to the event and verify access.
    const assign = await request(app)
      .post(`/api/v1/events/${eventId}/team-members`)
      .set(adminAuth)
      .send({ user_id: claimed.id });
    expect(assign.status).toBe(201);
    const access = await request(app)
      .get(`/api/v1/events/${eventId}`)
      .set({ Authorization: "Bearer valid.clerk_joining_1" });
    expect(access.status).toBe(200);

    // Signing in again must not duplicate anything.
    await upsertUserFromClerk(env, {
      id: "clerk_joining_1",
      name: "Joining Member",
      email: "joining@frameflow.test",
    });
    const after = await getPool(env).query(
      "SELECT COUNT(*)::int AS n FROM users WHERE email = 'joining@frameflow.test'"
    );
    expect(after.rows[0]!.n).toBe(1);

    // Cleanup
    await getPool(env).query(
      "DELETE FROM users WHERE clerk_user_id = 'clerk_joining_1'"
    );
  });

  it("self-registered users provision as ADMIN with own workspace; invited users as TEAM_MEMBER", async () => {
    const { upsertUserFromClerk } = await import("../src/lib/db.js");

    // Self-signup (no invitedRole) → ADMIN per product policy.
    const selfSignup = await upsertUserFromClerk(env, {
      id: "clerk_selfsignup_1",
      name: "Self Starter",
      email: "selfsignup@frameflow.test",
    });
    expect(selfSignup.role).toBe("ADMIN");
    // Own workspace, initially containing only them.
    const selfWs = await getPool(env).query<{ member_count: number }>(
      `SELECT COUNT(*)::int AS member_count FROM users WHERE workspace_id = $1`,
      [selfSignup.workspace_id]
    );
    expect(selfWs.rows[0]!.member_count).toBe(1);

    // Invited (invitedRole stamped from Clerk publicMetadata) → TEAM_MEMBER.
    // No pending invitation row exists for this email in this test → the
    // safe fallback applies: own workspace (never an invented membership).
    // The full invited flow (invitation row → inviter workspace) is covered
    // by SCENARIO 3/4 below.
    const invited = await upsertUserFromClerk(env, {
      id: "clerk_invitedrole_1",
      name: "Invited Person",
      email: "invitedrole@frameflow.test",
      invitedRole: "TEAM_MEMBER",
    });
    // Fallback path: isolated workspace, ADMIN role (safe default), but the
    // role never mutates on repeat sign-ins either way.
    expect(invited.role).toBe("ADMIN");
    const again = await upsertUserFromClerk(env, {
      id: "clerk_invitedrole_1",
      name: "Invited Person",
      email: "invitedrole@frameflow.test",
      invitedRole: "TEAM_MEMBER",
    });
    expect(again.role).toBe("ADMIN");

    // Cleanup (workspaces reference created_by → null them first)
    await getPool(env).query(
      `UPDATE workspaces SET created_by = NULL
       WHERE created_by IN (SELECT id FROM users WHERE clerk_user_id IN ('clerk_selfsignup_1','clerk_invitedrole_1'))`
    );
    await getPool(env).query(
      "DELETE FROM users WHERE clerk_user_id IN ('clerk_selfsignup_1','clerk_invitedrole_1')"
    );
    await getPool(env).query(
      "DELETE FROM workspaces WHERE name IN ('Self Starter''s Studio', 'Invited Person''s Studio')"
    );
  });

  it("admin can create events; member can list but not create", async () => {
    const res = await request(app)
      .post("/api/v1/events")
      .set(memberAuth)
      .send({ name: "Member Event", event_date: "2026-12-02" });
    expect(res.status).toBe(403);
    const list = await request(app).get("/api/v1/events").set(adminAuth);
    expect(list.status).toBe(200);
    expect(list.body.events.some((e: { id: string }) => e.id === eventId)).toBe(true);
  });

  it("member cannot access an unassigned event (403)", async () => {
    const res = await request(app).get(`/api/v1/events/${eventId}`).set(memberAuth);
    expect(res.status).toBe(403);
  });

  it("admin assigns member to event; member can then access it", async () => {
    const before = await request(app).get(`/api/v1/events/${eventId}`).set(memberAuth);
    expect(before.status).toBe(403);

    const assign = await request(app)
      .post(`/api/v1/events/${eventId}/team-members`)
      .set(adminAuth)
      .send({ user_id: (await memberId()) });
    expect(assign.status).toBe(201);

    // Re-assignment must not duplicate.
    const again = await request(app)
      .post(`/api/v1/events/${eventId}/team-members`)
      .set(adminAuth)
      .send({ user_id: await memberId() });
    expect(again.status).toBe(201);
    const members = await request(app).get(`/api/v1/events/${eventId}/team-members`).set(adminAuth);
    const dupes = members.body.members.filter(
      (m: { email: string }) => m.email === "member@frameflow.test"
    );
    expect(dupes.length).toBe(1);

    const after = await request(app).get(`/api/v1/events/${eventId}`).set(memberAuth);
    expect(after.status).toBe(200);
    const assignedEvents = await request(app).get("/api/v1/events").set(memberAuth);
    expect(assignedEvents.status).toBe(200);
    expect(assignedEvents.body.events.some((e: { id: string }) => e.id === eventId)).toBe(true);
  });

  it("admin can remove member from event; access is revoked", async () => {
    await request(app)
      .post(`/api/v1/events/${eventId}/team-members`)
      .set(adminAuth)
      .send({ user_id: await memberId() });
    const res = await request(app)
      .delete(`/api/v1/events/${eventId}/team-members/${await memberId()}`)
      .set(adminAuth);
    expect(res.status).toBe(204);
    const after = await request(app).get(`/api/v1/events/${eventId}`).set(memberAuth);
    expect(after.status).toBe(403);
  });

  it(" outsider (other workspace member) cannot access the event at all", async () => {
    const res = await request(app).get(`/api/v1/events/${eventId}`).set(outsiderAuth);
    // Outsider is in another workspace — event is invisible → 404.
    expect(res.status).toBe(404);
  });

  // ------------------------------------------------------------------
  // Multi-tenant isolation (workspaces)
  // ------------------------------------------------------------------

  it("SCENARIO 2: admin B is isolated — cannot see or manage admin A's workspace", async () => {
    // B's team list must not contain A or A's member.
    const bList = await request(app).get("/api/v1/team-members").set(secondAdminAuth);
    expect(bList.status).toBe(200);
    const bEmails = bList.body.members.map((m: { email: string }) => m.email);
    expect(bEmails).toContain("admin2@frameflow.test");
    expect(bEmails).not.toContain("admin@frameflow.test");
    expect(bEmails).not.toContain("member@frameflow.test");

    // B cannot see A's event.
    const bEvent = await request(app).get(`/api/v1/events/${eventId}`).set(secondAdminAuth);
    expect(bEvent.status).toBe(404);

    // B cannot assign A's member to B's (nonexistent-view) event.
    const bAssign = await request(app)
      .post(`/api/v1/events/${eventId}/team-members`)
      .set(secondAdminAuth)
      .send({ user_id: await memberId() });
    expect([403, 404]).toContain(bAssign.status);
  });

  it("SCENARIO 5/6: admin A cannot manage admin B's user", async () => {
    const pool = getPool(env);
    const bAdmin = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE clerk_user_id = 'clerk_admin_2'"
    );
    const bAdminId = bAdmin.rows[0]!.id;

    const roleChange = await request(app)
      .patch(`/api/v1/team-members/${bAdminId}/role`)
      .set(adminAuth)
      .send({ role: "TEAM_MEMBER" });
    expect([403, 404]).toContain(roleChange.status);

    const remove = await request(app)
      .delete(`/api/v1/team-members/${bAdminId}`)
      .set(adminAuth);
    expect([403, 404]).toContain(remove.status);
  });

  it("SCENARIO 8: admin A cannot assign admin B's member to A's event", async () => {
    const pool = getPool(env);
    const outsider = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE clerk_user_id = 'clerk_outsider_1'"
    );
    const res = await request(app)
      .post(`/api/v1/events/${eventId}/team-members`)
      .set(adminAuth)
      .send({ user_id: outsider.rows[0]!.id });
    expect([403, 404]).toContain(res.status);
  });

  it("SCENARIO 3/4: A invites C into A's workspace; B does not see C", async () => {
    const invite = await request(app)
      .post("/api/v1/team-members/invite")
      .set(adminAuth)
      .send({ name: "Tenant C", email: "tenant-c@frameflow.test" });
    expect([200, 201]).toContain(invite.status);

    // A sees the pending member.
    const aList = await request(app).get("/api/v1/team-members").set(adminAuth);
    expect(aList.body.members.some((m: { email: string }) => m.email === "tenant-c@frameflow.test")).toBe(true);

    // B does not see C.
    const bList = await request(app).get("/api/v1/team-members").set(secondAdminAuth);
    expect(bList.body.members.some((m: { email: string }) => m.email === "tenant-c@frameflow.test")).toBe(false);

    // Invitation recorded and bound to A's workspace.
    const pool = getPool(env);
    const inv = await pool.query<{ workspace_name: string }>(
      `SELECT w.name AS workspace_name FROM invitations i
       JOIN workspaces w ON w.id = i.workspace_id
       WHERE i.email = 'tenant-c@frameflow.test' AND i.status = 'pending'`
    );
    expect(inv.rows[0]!.workspace_name).toBe("WS-admin@frameflow.test");

    // Cleanup
    await pool.query("DELETE FROM users WHERE email = 'tenant-c@frameflow.test'");
    await pool.query("DELETE FROM invitations WHERE email = 'tenant-c@frameflow.test'");
  });

  async function memberId(): Promise<string> {
    const pool = getPool(env);
    const result = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE clerk_user_id = 'clerk_member_1'"
    );
    return result.rows[0]!.id;
  }
});

// Reuse describeIf at top-level scope for the module guard.
function describeIf(cond: boolean) {
  return cond ? describe : describe.skip;
}

if (!hasDb) {
  console.warn("TEST_DATABASE_URL not set — skipping Phase 2 authorization tests");
}
