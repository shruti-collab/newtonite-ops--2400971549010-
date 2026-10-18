# OpsPulse — Operations Intelligence & Incident Control

OpsPulse is a full-stack operational work queue for teams handling incidents, payment issues, customer problems, compliance work, and tasks. It demonstrates team-scoped access control, workflow validation, activity history, optimistic concurrency, idempotent creation, and server-side filtering.

## Stack

- Frontend: React, TypeScript, Vite, TanStack Query
- API: Node.js, Express, TypeScript, Zod
- Database: PostgreSQL, Prisma
- Tests: Vitest + Supertest
- Local database: Docker Compose

## Prerequisites

Install Node.js 20 or newer, npm, Docker Desktop, and Git. Check with:

```bash
node --version
npm --version
docker --version
```

## Run locally (VS Code)

1. Open this folder in VS Code.
2. Start PostgreSQL:

   ```bash
   docker compose up -d db
   ```

3. Create the server environment file:

   **macOS/Linux**
   ```bash
   cp server/.env.example server/.env
   ```

   **Windows PowerShell**
   ```powershell
   Copy-Item server/.env.example server/.env
   ```

4. Install dependencies from the project root:

   ```bash
   npm install
   ```

5. Create the Prisma client, apply the development migration, and seed demo data:

   ```bash
   npm run db:generate -w server
   npm run db:migrate -w server
   npm run db:seed -w server
   ```

   When Prisma asks for a migration name, enter `init`.

6. Start the API, frontend, and outbox worker in separate VS Code terminals (or run `npm run dev` from the root to start all three):

   Terminal 1:
   ```bash
   npm run dev -w server
   ```

   Terminal 2:
   ```bash
   npm run dev -w client
   ```

7. Open <http://localhost:5173>. The API health endpoint is <http://localhost:4000/api/health>.

## Demo accounts

All seeded demo users use the password `DemoPass123!`.

| Role | Email |
|---|---|
| Admin | `admin@opspulse.local` |
| Lead | `lead@opspulse.local` |
| Member | `member@opspulse.local` |
| Viewer | `viewer@opspulse.local` |
| Customer Care Lead | `carelead@opspulse.local` |

These are local demo credentials only. Never use them for a public deployment.

## Run tests

Make sure the database is running, environment is configured, and migrations and seed have run. Then:

```bash
npm test
```

The API tests exercise idempotent creation, concurrent claiming, stale-update rejection, Viewer permissions, cross-team access, and invalid workflow transitions. The tests use the configured database and create test data.

## Main features

- Seeded login with JWT authentication
- Role per team: Viewer, Member, Lead, Admin
- Create and list operational work items
- Search, status/priority filters, team-scoped results, cursor pagination
- Dashboard counts for active work, urgent unassigned work, approvals, and overdue items
- Atomic claim operation
- Version-checked updates with `409 Conflict`
- Server-enforced workflow transitions and Lead/Admin approval
- Append-only activity events and comments
- Idempotency key for create requests
- Transactional outbox record on item creation
- Responsive dashboard and item detail drawer

## API quick reference

All endpoints except `/api/health` and `/api/auth/login` require `Authorization: Bearer <token>`.

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/auth/login` | Log in |
| `GET` | `/api/auth/me` | Current user and memberships |
| `GET` | `/api/teams` | Current user's teams |
| `GET` | `/api/dashboard/summary` | Dashboard counters |
| `GET` | `/api/items` | Filtered, paginated list |
| `POST` | `/api/items` | Create item; requires `Idempotency-Key` |
| `GET` | `/api/items/:id` | Item, comments, activity |
| `PATCH` | `/api/items/:id` | Version-checked edit |
| `POST` | `/api/items/:id/claim` | Atomic claim |
| `POST` | `/api/items/:id/transition` | Change workflow status |
| `POST` | `/api/items/:id/comments` | Add a comment |
| `GET` | `/api/items/:id/activity` | Activity history |

## Engineering notes

Read [ENGINEERING_DECISIONS.md](./ENGINEERING_DECISIONS.md) for design choices and trade-offs.

## Known limitations

- The outbox worker is included and processes database jobs with an atomic claim, retries, exponential backoff, and a maximum-attempt failure state. The demo handler logs the job instead of sending real notifications.
- Authentication uses seeded accounts and a simple JWT; there is no signup, password reset, refresh-token rotation, or SSO.
- There is no deployment pipeline, rate limiting, email delivery, attachment upload, or WebSocket push.
- List results are cursor-paginated but the UI currently displays the first 50 matching items; a load-more control is a reasonable next improvement.
- The current idempotency record stores the response and does not expire old keys. A production system should define key scope, retention, and request fingerprint rules.
- The sample seed creates a small dataset. For a scale demonstration, seed thousands of items and compare query plans with `EXPLAIN ANALYZE`.
- The app uses local demo users and a development JWT fallback only for convenience. Set a strong `JWT_SECRET` and secure deployment configuration before publishing.
- This starter has not been deployed or run against your local machine; follow the verification steps and fix any environment-specific issue before submitting.

## Before submitting

- [ ] Follow this README from a fresh checkout.
- [ ] Run `npm run build`.
- [ ] Run `npm test`.
- [ ] Confirm demo credentials and all role permissions.
- [ ] Review `.env` files and ensure secrets are not committed.
- [ ] Push incremental commits to your own GitHub repository.
- [ ] Make sure you can explain every feature and test during the discussion.
