# Digital Library Management System

A Node.js library management API. It tracks books and their physical copies, reports availability, handles checkouts, returns, renewals and a reservation queue, and sends email and SMS notifications for due dates, overdue items and reservations.

**Stack:** Node.js · Express · MySQL 8 (mysql2) · Nodemailer (SMTP) · Twilio REST API (SMS)

## Dashboard

Open **http://localhost:3000** for the staff dashboard. It's a single-page app served by the same Express server, built with Bootstrap 5 and plain JavaScript, and it runs entirely on the REST API below.

- **Catalog:** search by title, author or ISBN, filter by genre or "available now", and add or edit books.
- **Book page:** availability stats, the copies with their status and location (mark copies lost, in maintenance or available again, move them), and the reservation queue (reserve for a member, cancel).
- **Circulation desk:** barcode-driven checkout (with member autocomplete) and check-in. The return panel shows any late fine and tells staff when a copy goes on the **hold shelf** instead of back to the stacks. It also lists open, overdue and returned loans, with renew and return buttons.
- **Members:** search, add and edit members, including their email/SMS preferences and suspension. Each member's page shows their loans (overdue items highlighted, with fines so far), reservations with queue position, fines with a button to record a payment, loan history, and every notification sent to them.
- **Notifications:** the full email/SMS log, filtered by status or channel. It shows delivery errors, lets you retry failed messages, and has a **Run reminders now** button.

When `API_KEY` is set, the dashboard asks for it once. The key is kept in `sessionStorage` for that browser tab, and the public catalog stays browsable without it.

## Features

- **Inventory:** books (with ISBN-10/13 checksum validation) and individually barcoded copies. Each copy has a status: `available`, `on_loan`, `on_hold`, `maintenance` or `lost`, plus a shelf location.
- **Availability:** a public catalog search (title, author, ISBN, genre, "available now") and a per-book availability endpoint. It returns copy counts by status, the length of the reservation queue, and the next due date.
- **Circulation:** checkout and check-in by barcode. Lending rules are configurable: loan length, maximum items out, maximum renewals, and a fine limit that blocks borrowing. Late fines are charged per started day, with a cap. Renewals are refused when the item is overdue or when others are waiting for it.
- **Reservations:** a first-come, first-served queue per book. Reserving a book that has a copy on the shelf puts that copy on hold right away. When a copy is returned it goes straight to the next person waiting, and only that member can check it out. Holds that aren't picked up within `HOLD_DAYS` expire and pass to the next person. Cancelling a hold does the same.
- **Automated notifications:**
  | Event | Trigger |
  |---|---|
  | Reservation confirmed (with queue position) | Member joins the queue |
  | Ready for pickup (with hold expiry date) | A copy is held for the member |
  | Hold expired | Scheduler: hold not collected in time |
  | Due soon | Scheduler: `DUE_SOON_HOURS` before the due date (sent again after a renewal) |
  | Overdue (days late, fines so far) | Scheduler: every `OVERDUE_REPEAT_DAYS` until the item is returned |

  Each member chooses email, SMS (which needs an E.164 phone number) or both.

## How notifications work

Notifications use the **transactional outbox** pattern. The event (a return, a hold, an overdue scan) and its notification rows are written in the **same MySQL transaction**. This means a member is never told about a hold that was rolled back, and a committed hold always gets its notification.

A background **dispatcher** delivers pending rows in batches:

- It claims rows with `SELECT … FOR UPDATE SKIP LOCKED` and a lease, so you can run several app instances without sending anything twice.
- Temporary failures are retried with exponential backoff and jitter. These are SMTP 4xx replies, Twilio 429/5xx responses, and network errors.
- Permanent failures are marked `failed` straight away: SMTP 5xx replies, and Twilio 4xx responses such as an invalid number. You can list failed notifications and retry them through the API.
- Scheduled jobs are idempotent. Every notification has a unique `dedupe_key` (for example `loan:42:overdue:2`), so running the jobs twice or on two instances doesn't cause duplicate messages.

If `SMTP_HOST` or the Twilio credentials aren't set, that channel runs in **simulated** mode: messages are built in full and logged to the console instead of being sent.

## Getting started

```bash
npm install
cp .env.example .env
docker compose up -d mysql     # MySQL 8.4 on 127.0.0.1:3307
npm run seed                   # creates the schema plus sample books, copies and members
npm run dev                    # dashboard at http://localhost:3000
```

The schema is created automatically on startup (`src/db/schema.sql`). Run `npm run migrate` to apply it without starting the server.

To run everything in Docker, use `docker compose up -d --build`. The container runs with `NODE_ENV=production`, so set `API_KEY` in `.env` first.

## API

Staff endpoints need an `X-API-Key: $API_KEY` header. If `API_KEY` is unset, auth is off (for development only). In production (`NODE_ENV=production`) the app won't start unless `API_KEY` is at least 24 characters long. Errors come back as `{ "error": { "code", "message" } }`, with 400 for validation errors, 401, 404, and 409 for rule conflicts such as `copy_on_hold`, `loan_limit` or `fines_owed`.

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/books?q=&author=&genre=&available=&page=&limit=` | public | Search the catalog |
| `GET /api/books/:id` | public | Book details with copy counts |
| `GET /api/books/:id/availability` | public | Counts by status, queue length, next due date |
| `POST /api/books` · `PATCH /api/books/:id` · `DELETE /api/books/:id` | staff | Manage books |
| `GET /api/books/:id/copies` · `POST /api/books/:id/copies` | staff | List copies (with due and hold info), add a copy |
| `PATCH /api/copies/:id` | staff | `{ status: available\|lost\|maintenance, location }` |
| `GET /api/books/:id/reservations` | staff | Hold queue in pickup order |
| `POST /api/loans` | staff | Checkout: `{ memberId, barcode \| copyId }` |
| `POST /api/returns` | staff | Check-in: `{ barcode \| copyId }` → fine, and `heldFor` if the copy goes to the hold shelf |
| `POST /api/loans/:id/renew` | staff | Renew a loan |
| `GET /api/loans?status=open\|overdue\|returned` | staff | Circulation lists |
| `POST /api/reservations` · `DELETE /api/reservations/:id` | staff | Reserve `{ bookId, memberId }`, cancel |
| `GET/POST /api/members` · `GET/PATCH /api/members/:id` | staff | Members and their notification preferences |
| `GET /api/members/:id/account` | staff | Open loans, reservations with queue position, fines |
| `GET /api/members/:id/history` · `/notifications` | staff | Loan history, notification log |
| `POST /api/members/:id/fines/pay` | staff | Settle returned-item fines |
| `GET /api/notifications?status=&channel=&type=` | staff | Notification log |
| `POST /api/notifications/:id/retry` | staff | Requeue a failed notification |
| `POST /api/jobs/run` | staff | Run the reminder, overdue and hold-expiry jobs now, then send the notifications |
| `GET /api/info` | public | Library name, lending policy, notification modes, whether auth is on |
| `GET /healthz` | public | Liveness check, including the database connection |

Example:

```bash
curl -X POST localhost:3000/api/loans -H 'Content-Type: application/json' \
  -d '{"memberId": 2, "barcode": "LIB-373320-1"}'
```

## Deployment (Docker on the VPS)

Live at **https://library.helloworlds.co.in**. The staff pages require the `API_KEY` from the server's `.env`; the catalog is public.

- The app and MySQL run as Docker Compose services in `/opt/digital-library` on the VPS. MySQL data lives in the `digital-library_mysql-data` volume, and MySQL is published only on `127.0.0.1:3307`.
- The app container is published only on the docker0 bridge (`172.17.0.1:3110`), so it can't be reached directly from the internet.
- The k3s `ingress-nginx` routes the hostname to that address (`deploy/k8s-ingress.yaml`: a Service without a selector, plus Endpoints and an Ingress). cert-manager (`letsencrypt-prod`) issues the TLS certificate.
- Production secrets (`API_KEY`, `DB_PASSWORD`, `DB_ROOT_PASSWORD`) were generated on the server and exist only in `/opt/digital-library/.env`. To see the API key: `ssh vps 'grep ^API_KEY /opt/digital-library/.env'`.
- Notifications run in simulated mode (logged only) until `SMTP_*` / `TWILIO_*` are added to that `.env`.

Redeploy after making changes:

```bash
rsync -az --delete --exclude node_modules --exclude .env --exclude test --exclude .git ./ vps:/opt/digital-library/
ssh vps 'cd /opt/digital-library && docker compose up -d --build'
```

Logs: `ssh vps 'docker logs -f digital-library'`

## Tests

```bash
docker compose up -d mysql
npm test
```

The unit tests cover validation, fine calculation, templates, and how Twilio errors are classified. The integration tests start the app against a throwaway MySQL database and cover:

- catalog CRUD and auth
- checkout and return with fines
- the reservation queue and hold hand-off
- hold expiry and cancellation
- deduplicated reminders
- borrowing limits
- dispatcher retries and permanent failures
- copy status changes
- concurrent checkouts of the same copy

If MySQL isn't reachable, the integration tests are skipped. Set `TEST_DB_HOST/PORT/USER/PASSWORD` to use another server; the user needs permission to create databases.

## Project layout

```
src/
  server.js            startup: migrate, dispatcher, scheduler, HTTP server
  app.js               Express app and error handling
  config.js            environment-based configuration
  policy.js            due dates and fine rules
  validate.js          input validation (ISBN, E.164 phone numbers, email, paging)
  scheduler.js         periodic reminder, overdue and hold-expiry jobs
  db/                  schema.sql, pool and transaction helpers, migrate and seed scripts
  services/            catalog, members, circulation (loans, reservations, jobs)
  notify/              templates, outbox, dispatcher, SMTP and Twilio transports
  routes/              REST endpoints
public/                staff dashboard (index.html, js/app.js, css/app.css)
test/                  node:test unit and integration tests
```
