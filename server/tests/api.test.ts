import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { app } from "../src/index.js";
import { prisma } from "../src/db.js";

let token = "";
let memberId = "";
let teamId = "";
let leadToken = "";
let viewerToken = "";

async function login(email: string) {
  const result = await request(app).post("/api/auth/login").send({ email, password: "DemoPass123!" });
  expect(result.status).toBe(200);
  return result.body.token as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("DemoPass123!", 4);
  const team = await prisma.team.upsert({ where: { name: "Test Ops" }, update: {}, create: { name: "Test Ops" } });
  teamId = team.id;
  const users = [
    { email: "test-member@opspulse.local", name: "Test Member", role: "MEMBER" as const },
    { email: "test-lead@opspulse.local", name: "Test Lead", role: "LEAD" as const },
    { email: "test-viewer@opspulse.local", name: "Test Viewer", role: "VIEWER" as const }
  ];
  for (const u of users) {
    const user = await prisma.user.upsert({ where: { email: u.email }, update: { passwordHash }, create: { email: u.email, name: u.name, passwordHash } });
    if (u.email === users[0].email) memberId = user.id;
    await prisma.membership.upsert({
      where: { userId_teamId: { userId: user.id, teamId } },
      update: { role: u.role }, create: { userId: user.id, teamId, role: u.role }
    });
  }
  token = await login(users[0].email);
  leadToken = await login(users[1].email);
  viewerToken = await login(users[2].email);
});

afterAll(async () => { await prisma.$disconnect(); });

async function createItem(extra: Record<string, unknown> = {}) {
  return request(app).post("/api/items")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", `test-${crypto.randomUUID()}`)
    .send({ title: "Test incident item", description: "Test description", type: "INCIDENT", priority: "HIGH", teamId, ...extra });
}

describe("OpsPulse API critical behavior", () => {
  it("creates once when the same idempotency key is retried", async () => {
    const key = `idem-${crypto.randomUUID()}`;
    const body = { title: "Single create test", description: "", type: "TASK", priority: "MEDIUM", teamId };
    const first = await request(app).post("/api/items").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send(body);
    const second = await request(app).post("/api/items").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.item.id).toBe(first.body.item.id);
  });

  it("allows only one of two concurrent claims", async () => {
    const created = await createItem();
    expect(created.status).toBe(201);
    const id = created.body.item.id;
    const claim = () => request(app).post(`/api/items/${id}/claim`).set("Authorization", `Bearer ${token}`).send({});
    const results = await Promise.all([claim(), claim()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it("rejects a stale update", async () => {
    const created = await createItem();
    const id = created.body.item.id;
    const version = created.body.item.version;
    const first = await request(app).patch(`/api/items/${id}`).set("Authorization", `Bearer ${token}`).send({ version, title: "Updated title" });
    expect(first.status).toBe(200);
    const stale = await request(app).patch(`/api/items/${id}`).set("Authorization", `Bearer ${token}`).send({ version, title: "Overwritten title" });
    expect(stale.status).toBe(409);
  });

  it("blocks viewers from creating items", async () => {
    const result = await request(app).post("/api/items").set("Authorization", `Bearer ${viewerToken}`)
      .set("Idempotency-Key", `viewer-${crypto.randomUUID()}`)
      .send({ title: "Viewer attempt", teamId, type: "TASK", priority: "LOW" });
    expect(result.status).toBe(403);
  });

  it("blocks users outside a team from reading its items", async () => {
    const otherTeam = await prisma.team.upsert({ where: { name: "Private Team" }, update: {}, create: { name: "Private Team" } });
    const foreign = await prisma.workItem.create({ data: { title: "Private item", description: "", teamId: otherTeam.id, createdById: memberId } });
    const result = await request(app).get(`/api/items/${foreign.id}`).set("Authorization", `Bearer ${token}`);
    expect(result.status).toBe(403);
  });

  it("requires a Lead to approve an item awaiting approval", async () => {
    const created = await createItem();
    const id = created.body.item.id;
    const started = await request(app).post(`/api/items/${id}/transition`)
      .set("Authorization", `Bearer ${token}`).send({ status: "IN_PROGRESS", version: created.body.item.version });
    expect(started.status).toBe(200);
    const awaiting = await request(app).post(`/api/items/${id}/transition`)
      .set("Authorization", `Bearer ${token}`).send({ status: "AWAITING_APPROVAL", version: started.body.item.version });
    expect(awaiting.status).toBe(200);
    const denied = await request(app).post(`/api/items/${id}/transition`)
      .set("Authorization", `Bearer ${token}`).send({ status: "RESOLVED", version: awaiting.body.item.version });
    expect(denied.status).toBe(403);
    const approved = await request(app).post(`/api/items/${id}/transition`)
      .set("Authorization", `Bearer ${leadToken}`).send({ status: "RESOLVED", version: awaiting.body.item.version });
    expect(approved.status).toBe(200);
  });

  it("rejects invalid workflow jumps", async () => {
    const created = await createItem();
    const result = await request(app).post(`/api/items/${created.body.item.id}/transition`)
      .set("Authorization", `Bearer ${token}`).send({ status: "CLOSED", version: created.body.item.version });
    expect(result.status).toBe(400);
  });
});
