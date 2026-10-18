import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "./db.js";
import { canEdit, canLead, createToken, membershipFor, requireAuth } from "./auth.js";

export const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "opspulse-api" }));

app.post("/api/auth/login", async (req, res) => {
  const parsed = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a valid email and password" });
  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email.toLowerCase() },
    include: { memberships: { include: { team: true } } }
  });
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    return res.status(401).json({ error: "Email or password is incorrect" });
  }
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return res.json({ token: createToken(user.id), user: safeUser });
});

app.use("/api", requireAuth);

app.get("/api/auth/me", (req, res) => res.json({ user: req.user }));

app.get("/api/teams", async (req, res) => {
  const ids = req.user!.memberships.map((m) => m.teamId);
  const teams = await prisma.team.findMany({ where: { id: { in: ids } }, orderBy: { name: "asc" } });
  res.json({ teams });
});

const listSchema = z.object({
  q: z.string().optional(),
  status: z.enum(["OPEN", "IN_PROGRESS", "AWAITING_APPROVAL", "RESOLVED", "CLOSED"]).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  assignee: z.string().optional(),
  teamId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

app.get("/api/items", async (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid filters", details: parsed.error.flatten() });
  const { q, status, priority, assignee, teamId, cursor, limit } = parsed.data;
  const allowedTeamIds = req.user!.memberships.map((m) => m.teamId);
  if (teamId && !allowedTeamIds.includes(teamId)) return res.status(403).json({ error: "You do not have access to this team" });
  const where: any = {
    teamId: teamId ? teamId : { in: allowedTeamIds },
    ...(status ? { status } : {}),
    ...(priority ? { priority } : {}),
    ...(assignee === "me" ? { assigneeId: req.user!.id } : assignee === "unassigned" ? { assigneeId: null } : assignee ? { assigneeId: assignee } : {}),
    ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { description: { contains: q, mode: "insensitive" } }] } : {})
  };
  const items = await prisma.workItem.findMany({
    where, take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { team: true, assignee: { select: { id: true, name: true, email: true } }, createdBy: { select: { id: true, name: true } } }
  });
  const hasMore = items.length > limit;
  if (hasMore) items.pop();
  res.json({ items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null });
});

app.get("/api/dashboard/summary", async (req, res) => {
  const teamIds = req.user!.memberships.map((m) => m.teamId);
  const base = { teamId: { in: teamIds } };
  const [totalOpen, urgentUnassigned, awaitingApproval, overdue, byStatus] = await Promise.all([
    prisma.workItem.count({ where: { ...base, status: { in: ["OPEN", "IN_PROGRESS", "AWAITING_APPROVAL"] } } }),
    prisma.workItem.count({ where: { ...base, priority: "URGENT", assigneeId: null, status: { notIn: ["RESOLVED", "CLOSED"] } } }),
    prisma.workItem.count({ where: { ...base, status: "AWAITING_APPROVAL" } }),
    prisma.workItem.count({ where: { ...base, dueDate: { lt: new Date() }, status: { notIn: ["RESOLVED", "CLOSED"] } } }),
    prisma.workItem.groupBy({ by: ["status"], where: base, _count: { _all: true } })
  ]);
  res.json({ totalOpen, urgentUnassigned, awaitingApproval, overdue, byStatus: byStatus.map((x) => ({ status: x.status, count: x._count._all })) });
});

const itemSchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(5000).default(""),
  type: z.enum(["INCIDENT", "CUSTOMER_ISSUE", "PAYMENT", "COMPLIANCE", "TASK"]).default("TASK"),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
  teamId: z.string().min(1),
  dueDate: z.string().datetime().nullable().optional()
});

app.post("/api/items", async (req, res) => {
  const parsed = itemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid work item", details: parsed.error.flatten() });
  const { teamId } = parsed.data;
  const membership = membershipFor(req.user!, teamId);
  if (!membership) return res.status(403).json({ error: "You do not have access to this team" });
  if (!canEdit(membership.role)) return res.status(403).json({ error: "Your role cannot create work items" });
  const key = req.header("Idempotency-Key");
  if (!key) return res.status(400).json({ error: "Idempotency-Key header is required" });
  const existing = await prisma.idempotencyRecord.findUnique({ where: { key } });
  if (existing) {
    if (existing.userId !== req.user!.id) return res.status(409).json({ error: "Idempotency key already belongs to another user" });
    return res.status(200).json(existing.response);
  }
  try {
    const response = await prisma.$transaction(async (tx) => {
      const item = await tx.workItem.create({
        data: {
          title: parsed.data.title, description: parsed.data.description, type: parsed.data.type,
          priority: parsed.data.priority, teamId, createdById: req.user!.id,
          dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null
        },
        include: { team: true, assignee: true, createdBy: { select: { id: true, name: true } } }
      });
      await tx.activityEvent.create({ data: { itemId: item.id, actorId: req.user!.id, action: "CREATED", details: `Created ${item.type.toLowerCase()} work item` } });
      await tx.outboxJob.create({ data: { type: "WORK_ITEM_CREATED", payload: { itemId: item.id, teamId } } });
      const body = { item };
      // Prisma JSON fields cannot store Date objects directly; persist the exact JSON response.
      const storedBody = JSON.parse(JSON.stringify(body));
      await tx.idempotencyRecord.create({ data: { key, userId: req.user!.id, response: storedBody } });
      return body;
    });
    return res.status(201).json(response);
  } catch (error: any) {
    if (error?.code === "P2002") {
      const existingRecord = await prisma.idempotencyRecord.findUnique({ where: { key } });
      if (existingRecord?.userId === req.user!.id) return res.status(200).json(existingRecord.response);
    }
    throw error;
  }
});

app.get("/api/items/:id", async (req, res) => {
  const item = await prisma.workItem.findUnique({
    where: { id: req.params.id },
    include: {
      team: true, assignee: { select: { id: true, name: true, email: true } },
      createdBy: { select: { id: true, name: true } },
      comments: { include: { author: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } },
      events: { include: { actor: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" }, take: 50 }
    }
  });
  if (!item) return res.status(404).json({ error: "Work item not found" });
  if (!membershipFor(req.user!, item.teamId)) return res.status(403).json({ error: "You do not have access to this work item" });
  res.json({ item });
});

const patchSchema = z.object({
  version: z.number().int().positive(),
  title: z.string().trim().min(3).max(160).optional(),
  description: z.string().max(5000).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional()
}).refine((v) => Object.keys(v).some((k) => k !== "version"), { message: "Provide at least one field to update" });

app.patch("/api/items/:id", async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid update", details: parsed.error.flatten() });
  const item = await prisma.workItem.findUnique({ where: { id: req.params.id } });
  if (!item) return res.status(404).json({ error: "Work item not found" });
  const membership = membershipFor(req.user!, item.teamId);
  if (!membership) return res.status(403).json({ error: "You do not have access to this work item" });
  if (!canEdit(membership.role)) return res.status(403).json({ error: "Your role cannot edit work items" });
  const data = parsed.data;
  if (data.assigneeId) {
    const assigneeMembership = await prisma.membership.findUnique({ where: { userId_teamId: { userId: data.assigneeId, teamId: item.teamId } } });
    if (!assigneeMembership) return res.status(400).json({ error: "Assignee must belong to the item's team" });
  }
  const changes: { field: string; oldValue: string | null; newValue: string | null }[] = [];
  for (const field of ["title", "description", "priority", "assigneeId", "dueDate"] as const) {
    if (data[field] !== undefined) {
      const oldRaw: any = item[field];
      const newRaw: any = data[field];
      const oldValue = oldRaw instanceof Date ? oldRaw.toISOString() : oldRaw == null ? null : String(oldRaw);
      const newValue = field === "dueDate" ? (newRaw == null ? null : new Date(newRaw).toISOString()) : newRaw == null ? null : String(newRaw);
      if (oldValue !== newValue) changes.push({ field, oldValue, newValue });
    }
  }
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.workItem.updateMany({
        where: { id: item.id, version: data.version },
        data: {
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.priority !== undefined ? { priority: data.priority } : {}),
          ...(data.assigneeId !== undefined ? { assigneeId: data.assigneeId } : {}),
          ...(data.dueDate !== undefined ? { dueDate: data.dueDate ? new Date(data.dueDate) : null } : {}),
          version: { increment: 1 }
        }
      });
      if (result.count === 0) throw new Error("VERSION_CONFLICT");
      for (const c of changes) {
        await tx.activityEvent.create({ data: { itemId: item.id, actorId: req.user!.id, action: "UPDATED", field: c.field, oldValue: c.oldValue, newValue: c.newValue } });
      }
      return tx.workItem.findUnique({ where: { id: item.id }, include: { team: true, assignee: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } } } });
    });
    return res.json({ item: updated });
  } catch (error: any) {
    if (error.message === "VERSION_CONFLICT") {
      const latest = await prisma.workItem.findUnique({ where: { id: item.id } });
      return res.status(409).json({ error: "This item changed since you opened it. Reload and try again.", latest });
    }
    throw error;
  }
});

app.post("/api/items/:id/claim", async (req, res) => {
  const item = await prisma.workItem.findUnique({ where: { id: req.params.id } });
  if (!item) return res.status(404).json({ error: "Work item not found" });
  const membership = membershipFor(req.user!, item.teamId);
  if (!membership) return res.status(403).json({ error: "You do not have access to this work item" });
  if (!canEdit(membership.role)) return res.status(403).json({ error: "Your role cannot claim work items" });
  const result = await prisma.$transaction(async (tx) => {
    const changed = await tx.workItem.updateMany({
      where: { id: item.id, assigneeId: null, status: { notIn: ["RESOLVED", "CLOSED"] } },
      data: { assigneeId: req.user!.id, version: { increment: 1 } }
    });
    if (changed.count === 0) return false;
    await tx.activityEvent.create({ data: { itemId: item.id, actorId: req.user!.id, action: "CLAIMED", field: "assigneeId", oldValue: null, newValue: req.user!.id } });
    return true;
  });
  if (!result) return res.status(409).json({ error: "This item has already been claimed or is no longer claimable" });
  const latest = await prisma.workItem.findUnique({ where: { id: item.id }, include: { assignee: { select: { id: true, name: true } } } });
  res.json({ item: latest });
});

const transitions: Record<string, string[]> = {
  OPEN: ["IN_PROGRESS"],
  IN_PROGRESS: ["AWAITING_APPROVAL"],
  AWAITING_APPROVAL: ["IN_PROGRESS", "RESOLVED"],
  RESOLVED: ["CLOSED", "IN_PROGRESS"],
  CLOSED: []
};

app.post("/api/items/:id/transition", async (req, res) => {
  const parsed = z.object({ status: z.enum(["OPEN", "IN_PROGRESS", "AWAITING_APPROVAL", "RESOLVED", "CLOSED"]), version: z.number().int().positive() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Provide a valid status and version" });
  const item = await prisma.workItem.findUnique({ where: { id: req.params.id } });
  if (!item) return res.status(404).json({ error: "Work item not found" });
  const membership = membershipFor(req.user!, item.teamId);
  if (!membership) return res.status(403).json({ error: "You do not have access to this work item" });
  if (!canEdit(membership.role)) return res.status(403).json({ error: "Your role cannot change workflow status" });
  if (!transitions[item.status].includes(parsed.data.status)) return res.status(400).json({ error: `Transition from ${item.status} to ${parsed.data.status} is not allowed` });
  if (parsed.data.status === "RESOLVED" && item.status === "AWAITING_APPROVAL" && !canLead(membership.role)) {
    return res.status(403).json({ error: "Only a team Lead or Admin can approve this item" });
  }
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.workItem.updateMany({
        where: { id: item.id, version: parsed.data.version },
        data: { status: parsed.data.status, version: { increment: 1 } }
      });
      if (changed.count === 0) throw new Error("VERSION_CONFLICT");
      await tx.activityEvent.create({
        data: { itemId: item.id, actorId: req.user!.id, action: "STATUS_CHANGED", field: "status", oldValue: item.status, newValue: parsed.data.status }
      });
      return tx.workItem.findUnique({ where: { id: item.id } });
    });
    res.json({ item: updated });
  } catch (error: any) {
    if (error.message === "VERSION_CONFLICT") return res.status(409).json({ error: "This item changed since you opened it. Reload and try again." });
    throw error;
  }
});

app.post("/api/items/:id/comments", async (req, res) => {
  const parsed = z.object({ body: z.string().trim().min(1).max(2000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Comment must be between 1 and 2000 characters" });
  const item = await prisma.workItem.findUnique({ where: { id: req.params.id } });
  if (!item) return res.status(404).json({ error: "Work item not found" });
  if (!membershipFor(req.user!, item.teamId)) return res.status(403).json({ error: "You do not have access to this work item" });
  const comment = await prisma.$transaction(async (tx) => {
    const c = await tx.comment.create({ data: { itemId: item.id, authorId: req.user!.id, body: parsed.data.body }, include: { author: { select: { id: true, name: true } } } });
    await tx.activityEvent.create({ data: { itemId: item.id, actorId: req.user!.id, action: "COMMENTED", details: parsed.data.body.slice(0, 160) } });
    return c;
  });
  res.status(201).json({ comment });
});

app.get("/api/items/:id/activity", async (req, res) => {
  const item = await prisma.workItem.findUnique({ where: { id: req.params.id } });
  if (!item) return res.status(404).json({ error: "Work item not found" });
  if (!membershipFor(req.user!, item.teamId)) return res.status(403).json({ error: "You do not have access to this work item" });
  const events = await prisma.activityEvent.findMany({ where: { itemId: item.id }, orderBy: { createdAt: "desc" }, take: 100, include: { actor: { select: { id: true, name: true } } } });
  res.json({ events });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Unexpected server error" });
});

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT || 4000);
  app.listen(port, () => console.log(`OpsPulse API listening on http://localhost:${port}`));
}
