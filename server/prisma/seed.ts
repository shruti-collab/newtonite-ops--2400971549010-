import { PrismaClient, TeamRole, Priority, WorkStatus, WorkType } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("DemoPass123!", 10);
  const teams = await Promise.all([
    prisma.team.upsert({ where: { name: "Payments" }, update: {}, create: { name: "Payments" } }),
    prisma.team.upsert({ where: { name: "Customer Care" }, update: {}, create: { name: "Customer Care" } }),
    prisma.team.upsert({ where: { name: "Compliance" }, update: {}, create: { name: "Compliance" } })
  ]);

  const definitions = [
    { name: "Avery Admin", email: "admin@opspulse.local", role: TeamRole.ADMIN, team: teams[0] },
    { name: "Lena Lead", email: "lead@opspulse.local", role: TeamRole.LEAD, team: teams[0] },
    { name: "Mika Member", email: "member@opspulse.local", role: TeamRole.MEMBER, team: teams[0] },
    { name: "Ravi Viewer", email: "viewer@opspulse.local", role: TeamRole.VIEWER, team: teams[0] },
    { name: "Casey Care Lead", email: "carelead@opspulse.local", role: TeamRole.LEAD, team: teams[1] }
  ];
  const users: Record<string, { id: string; name: string; email: string }> = {};
  for (const d of definitions) {
    const user = await prisma.user.upsert({
      where: { email: d.email },
      update: { passwordHash, name: d.name },
      create: { name: d.name, email: d.email, passwordHash }
    });
    users[d.email] = user;
    await prisma.membership.upsert({
      where: { userId_teamId: { userId: user.id, teamId: d.team.id } },
      update: { role: d.role },
      create: { userId: user.id, teamId: d.team.id, role: d.role }
    });
  }
  for (const team of teams.slice(1)) {
    await prisma.membership.upsert({
      where: { userId_teamId: { userId: users["admin@opspulse.local"].id, teamId: team.id } },
      update: { role: TeamRole.ADMIN },
      create: { userId: users["admin@opspulse.local"].id, teamId: team.id, role: TeamRole.ADMIN }
    });
  }

  const count = await prisma.workItem.count();
  if (count === 0) {
    const samples = [
      { title: "Card settlement delay", description: "Investigate a delayed settlement batch reported by the finance team.", type: WorkType.PAYMENT, priority: Priority.URGENT, status: WorkStatus.OPEN, teamId: teams[0].id, assigneeId: null, dueDate: new Date(Date.now() + 2 * 60 * 60 * 1000) },
      { title: "Repeated checkout failures", description: "Review elevated checkout failures in the afternoon traffic window.", type: WorkType.INCIDENT, priority: Priority.HIGH, status: WorkStatus.IN_PROGRESS, teamId: teams[0].id, assigneeId: users["member@opspulse.local"].id, dueDate: new Date(Date.now() + 8 * 60 * 60 * 1000) },
      { title: "Refund status mismatch", description: "Customer portal status does not match the refund ledger.", type: WorkType.CUSTOMER_ISSUE, priority: Priority.MEDIUM, status: WorkStatus.AWAITING_APPROVAL, teamId: teams[1].id, assigneeId: null, dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000) },
      { title: "Quarterly policy review", description: "Collect approvals for the quarterly policy review.", type: WorkType.COMPLIANCE, priority: Priority.LOW, status: WorkStatus.OPEN, teamId: teams[2].id, assigneeId: null, dueDate: null }
    ];
    for (const sample of samples) {
      const item = await prisma.workItem.create({
        data: { ...sample, createdById: users["admin@opspulse.local"].id }
      });
      await prisma.activityEvent.create({
        data: { itemId: item.id, actorId: users["admin@opspulse.local"].id, action: "CREATED", details: "Seeded demo work item" }
      });
    }
  }
  console.log("Seed complete. Demo password for all users: DemoPass123!");
}

main().finally(() => prisma.$disconnect());
