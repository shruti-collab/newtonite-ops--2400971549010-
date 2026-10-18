# Engineering Decisions

This document records the current MVP choices and their trade-offs.

## 1. PostgreSQL and a relational data model

**Context:** Work items, users, teams, memberships, comments, and events have explicit relationships and consistency requirements.

**Options considered:** A document database, SQLite, or PostgreSQL.

**Choice:** PostgreSQL with Prisma migrations and relational foreign keys.

**Trade-off:** PostgreSQL and Docker require a little more setup than a single-file database, but they support transactions, indexes, constraints, and the concurrency patterns this assessment is designed to test.

## 2. Team-scoped authorization on the server

**Context:** A user may have different roles in different teams, and hiding a UI action is not authorization.

**Options considered:** Frontend-only controls, global roles, or per-team membership roles enforced by API middleware/service checks.

**Choice:** Memberships associate each user with a team and a role. Every item read or write checks membership in the item's team; write and approval operations check the role.

**Trade-off:** The checks add code to the API, but prevent a client from bypassing permissions by calling endpoints directly. For a larger application, the authorization checks should be consolidated further into a dedicated policy/service layer.

## 3. Atomic claim and optimistic concurrency

**Context:** Two people may claim an unassigned item, or one person may overwrite another person's newer edit.

**Options considered:** Read-then-write logic, pessimistic locks, or conditional writes.

**Choice:** Claim uses a conditional database update where the assignee is still null. Edits include a version and update only when that version matches; successful edits increment the version.

**Trade-off:** A losing client receives `409 Conflict` and must refresh rather than silently overwrite data. Conditional writes are simple to reason about and work well for this MVP.

## 4. Idempotent create requests

**Context:** Double-clicks and network retries can accidentally create duplicate items.

**Options considered:** Trust the UI to disable the button, or have the API record and replay a response for an idempotency key.

**Choice:** The create endpoint requires an `Idempotency-Key` and stores the response with a unique key in the same transaction as the item.

**Trade-off:** This prevents duplicate creation for a repeated key, but production use should scope keys by user and operation, validate request fingerprints, and expire old records. The current implementation scopes replay by user and does not yet implement retention.

## 5. Transactional activity history and outbox

**Context:** Audit history must not disagree with the current work item. Asynchronous follow-up work should not be lost if the process stops after saving an item.

**Options considered:** Write history after the update in a separate request, send an external notification synchronously, or save history/outbox records in the same database transaction.

**Choice:** Important item mutations write an activity event in the same transaction. Item creation also inserts an outbox job row transactionally.

**Trade-off:** The database is consistent, and a small worker atomically claims jobs, retries failures with backoff, and marks exhausted jobs failed. The demo handler logs jobs rather than calling an external notification provider; production use would add provider integration, monitoring, and dead-letter review.

## 6. Cursor pagination and database filtering

**Context:** The assessment anticipates tens of thousands of items and growing history.

**Options considered:** Load all rows and filter in the browser, offset pagination only, or server-side filtering with a cursor.

**Choice:** Filters and search run in PostgreSQL, results are ordered consistently and cursor-paginated, and common team/status/assignee/date columns have indexes.

**Trade-off:** Cursor pagination is less convenient for jumping to an arbitrary page number, but it avoids sending the entire dataset and behaves better as data grows.

## Deliberately not built

Email delivery, attachments, SSO, WebSockets, a mobile app, and a production deployment pipeline are outside the first vertical slice. The next priority would be a real outbox worker with retries, load-more pagination, stronger production auth hardening, and broader integration tests.
