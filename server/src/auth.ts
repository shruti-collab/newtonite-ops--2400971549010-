import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "./db.js";

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  memberships: { teamId: string; role: string; team: { id: string; name: string } }[];
};
declare global {
  namespace Express {
    interface Request { user?: AuthUser }
  }
}

const secret = () => process.env.JWT_SECRET || "dev-only-change-me";

export function createToken(userId: string) {
  return jwt.sign({ sub: userId }, secret(), { expiresIn: "12h" });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Authentication required" });
  try {
    const payload = jwt.verify(header.slice(7), secret()) as jwt.JwtPayload;
    if (!payload.sub) return res.status(401).json({ error: "Invalid token" });
    const user = await prisma.user.findUnique({
      where: { id: String(payload.sub) },
      select: { id: true, name: true, email: true, memberships: { select: { teamId: true, role: true, team: { select: { id: true, name: true } } } } }
    });
    if (!user) return res.status(401).json({ error: "User no longer exists" });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function membershipFor(user: AuthUser, teamId: string) {
  return user.memberships.find((m) => m.teamId === teamId);
}

export function canEdit(role?: string) {
  return role === "MEMBER" || role === "LEAD" || role === "ADMIN";
}

export function canLead(role?: string) {
  return role === "LEAD" || role === "ADMIN";
}
