import "dotenv/config";
import { prisma } from "./db.js";

const MAX_ATTEMPTS = 5;

async function processOne() {
  // Recover jobs left in PROCESSING if a worker crashed more than five minutes ago.
  await prisma.outboxJob.updateMany({
    where: { status: "PROCESSING", updatedAt: { lt: new Date(Date.now() - 5 * 60 * 1000) } },
    data: { status: "PENDING" }
  });
  const job = await prisma.outboxJob.findFirst({
    where: { status: "PENDING", runAfter: { lte: new Date() } },
    orderBy: { createdAt: "asc" }
  });
  if (!job) return;

  // Claim atomically so two worker processes do not handle the same pending row.
  const claimed = await prisma.outboxJob.updateMany({
    where: { id: job.id, status: "PENDING" },
    data: { status: "PROCESSING", attempts: { increment: 1 } }
  });
  if (claimed.count === 0) return;

  try {
    // MVP handler: this is the safe point to integrate email/chat notifications later.
    // It deliberately has no external side effect, so retrying is idempotent.
    console.log(`[outbox] processed ${job.type} (${job.id})`, job.payload);
    await prisma.outboxJob.update({
      where: { id: job.id },
      data: { status: "COMPLETED", processedAt: new Date(), lastError: null }
    });
  } catch (error) {
    const attempts = job.attempts + 1;
    const message = error instanceof Error ? error.message : "Unknown job error";
    if (attempts >= MAX_ATTEMPTS) {
      await prisma.outboxJob.update({
        where: { id: job.id },
        data: { status: "FAILED", lastError: message }
      });
    } else {
      const delayMs = Math.min(60_000, 1000 * 2 ** attempts);
      await prisma.outboxJob.update({
        where: { id: job.id },
        data: { status: "PENDING", runAfter: new Date(Date.now() + delayMs), lastError: message }
      });
    }
  }
}

async function run() {
  try { await processOne(); }
  catch (error) { console.error("[outbox] worker cycle failed", error); }
}

console.log("OpsPulse outbox worker started");
const timer = setInterval(() => { void run(); }, 1500);
void run();

async function shutdown() {
  clearInterval(timer);
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
