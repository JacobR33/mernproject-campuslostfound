# UCF Lost & Found

Independent student project using MongoDB/Mongoose, Express, React and Node.js. Phases 1-9 provide authentication, posts/items, claims, consent-gated real-time chat, lost-post conversation requests, and a responsive UCF-themed React client. Reporting, admin moderation and account deletion are implemented. TOTP MFA and single-use backup codes are available in Settings. The older `campus-lost-found/` prototype is preserved and is not part of the new npm workspaces.

## Setup

1. Install Node.js 22.12+ and MongoDB locally as a replica set (no paid services required; see below).
2. Run `npm ci` at the repository root.
3. Copy `server/.env.example` to `server/.env`, and `client/.env.example` to `client/.env`.
4. Generate two independent secrets with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Use one for `JWT_SECRET` and one for `MFA_ENCRYPTION_KEY`. Keep them private. Only `VITE_` public configuration belongs in the client.
5. Start MongoDB, then run `npm run dev:server` and `npm run dev:client` in separate terminals. Open **`https://localhost:5173`**. The API defaults to loopback proxy target port 4000; `GET /api/health` is a process health check, not a database readiness check.

Configuration is loaded from `server/.env` because the server workspace is the script working directory. Startup refuses invalid configuration before connecting to MongoDB. HTTPS is required for the production client origin. All authentication cookies use Secure and the `__Host-` prefix in every environment. The client now uses local HTTPS by default; Vite generates a development-only self-signed certificate in its ignored cache. Trust that certificate locally or accept the browser's localhost development warning; never use it for production. The client forwards same-origin `/api` requests to the local Express API, preserving the browser's Origin. Keep `VITE_API_ORIGIN` empty, `DEV_API_TARGET=http://127.0.0.1:4000`, and server `CLIENT_ORIGIN=https://localhost:5173` for this setup. The browser should use localhost consistently, not interchange it with 127.0.0.1. No cookie flags are weakened.

`DEV_HTTPS=false` supports public HTTP-only UI inspection, but authenticated browser behavior requires HTTPS. An explicit `VITE_API_ORIGIN` must be a bare HTTP(S) origin (HTTP allowed only for local development; production builds require HTTPS). Keep client/API same-site for SameSite=Strict cookies. Production deployment must provide trusted TLS, SPA route fallback, `/api` forwarding and the client security headers described in SECURITY.md. The Vite development proxy accepts only local HTTP(S) targets. Its filesystem allowlist excludes server sources, tests and certificate files. For a local production-build preview, use `npm run preview --workspace client`, open `https://localhost:4173`, and set/restart the API with matching `CLIENT_ORIGIN`; the preview proxy remains local development tooling, not a production server.

Development email delivery defaults to `server/.mail/*.json`, written by a background worker. These files contain verification/reset links and private recipient addresses: keep the directory private, delete messages when finished, and never serve or commit it. POSIX modes are requested; Windows users must keep restrictive inherited filesystem ACLs. Production requires `MAIL_TRANSPORT=smtp`, `SMTP_HOST`, and HTTPS `CLIENT_ORIGIN`. Set `SMTP_SECURE=true` for implicit TLS or leave false for required STARTTLS. Certificates are always validated. SMTP can use a self-hosted server; no paid provider is required. Optional SMTP credentials must be supplied as a pair. Mail is queued encrypted in MongoDB; the worker retries transient delivery failures. Protect and back up the encryption key: changing it makes existing queued mail unreadable.

## Checks

- `npm test`: server Jest/Supertest tests followed by client Jest/React Testing Library tests. A temporary real MongoDB process is started by `mongodb-memory-server`; no running database or external email server is required. Its first installation/run downloads a MongoDB binary, so it needs network access and permission to launch a local subprocess.
- `npm run test:server` / `npm run test:client`: individual suites.
- `npm run test:e2e`: real HTTPS browser scenarios, including axe WCAG A/AA checks, against a disposable replica set and real API. Uses installed Microsoft Edge by default. For Chromium, install it with `npx playwright install chromium` from `client/` and set `PW_CHANNEL=chromium`. Ports 5473/5474 must be free. No existing database or SMTP server is used. Test mail, control signals, screenshots and traces are ignored artifacts; browser traces can contain disposable fixture credentials. The test harness explicitly shuts its owned services down.
- `npm run test:e2e:production`: builds the React client and runs all browser flows under the preview CSP, including a real inline-script blocking check. Uses the same disposable ports/database/mail fixtures; it is not a production hosting command.
- `npm run build`: production React build. Run this after the production browser suite to replace its disposable localhost API build configuration.
- `npm run audit:production`: fails on any reported production dependency vulnerability.
- `npm audit`: dependency vulnerability review.

Integration tests verify uniqueness, projections, expiry checks, concurrent token consumption/rotation, persistent throttles and encrypted mail leasing against MongoDB. Production disables automatic index creation: run `npm run db:indexes --workspace server` as a controlled deployment step before starting the server. This creates declared indexes without dropping unrelated indexes. Production startup refuses traffic if the unique email index is absent. Clean up duplicate legacy data before provisioning that index.

Phase 3 adds multi-document transactions. A standalone MongoDB server now fails startup; use a local single-node replica set or a replica set/sharded cluster in production. For a new local database, create a private data directory, start `mongod --replSet rs0 --bind_ip 127.0.0.1 --port 27017 --dbpath <your-data-directory>`, then initialize it once in `mongosh` with `rs.initiate({_id: 'rs0', members: [{_id: 0, host: '127.0.0.1:27017'}]})`. Wait for the node to become primary. The example URI includes `?replicaSet=rs0`. Adapt this to an existing installation rather than starting a second server on its port. Bind local development databases to loopback; production requires database authentication, TLS and private network access.

Before upgrading an existing database, run the index command again. Production checks the unique email index, the unique `Post.item` index, and a text index containing only item `title` and `publicDescription`. Existing duplicate item references or incompatible text indexes must be resolved before deployment; the script never drops indexes automatically.

Phase 4 also requires unique `(post, claimant)` claims, sparse unique `Conversation.claim` references, and deduplicated notification-event indexes. Re-run `npm run db:indexes --workspace server` before starting the updated production API; startup checks these constraints. No new environment variables or dependencies are needed for this phase.

For Phase 6, run `npm ci` and the index command again. Socket.IO/server/client 4.8.4 are pinned in the lockfile. Production startup additionally checks lost-request uniqueness, conversation-to-request uniqueness and the message idempotency index. The Express entrypoint now attaches Socket.IO to the same HTTP server. No new secrets or environment variables are needed.

## Authentication API (Phase 2)

First `GET /api/auth/csrf` with credentials included. Retain its `csrfToken` response in memory. For every POST below, include the cookie jar, `Origin` matching `CLIENT_ORIGIN`, `Content-Type: application/json`, and `X-CSRF-Token` matching that response. The corresponding CSRF cookie is HttpOnly. Fetch a fresh CSRF token after one hour; concurrent tabs should fetch again if another tab replaces the CSRF cookie. Never put credentials or tokens into localStorage.

| Method/path | JSON body | Result |
| --- | --- | --- |
| GET `/api/auth/csrf` | None | Signed CSRF token and Secure cookie |
| POST `/api/auth/register` | `email`, `password`, `displayName` | Generic 202; sends verification if eligible |
| POST `/api/auth/resend-verification` | `email` | Generic 202; replaces unexpired or expired verification link |
| POST `/api/auth/verify-email` | `token` | One-use email verification; no automatic login |
| POST `/api/auth/login` | `email`, `password` | Public user DTO and access/refresh cookies |
| POST `/api/auth/refresh` | `{}` | Rotated refresh token and renewed access cookie |
| POST `/api/auth/logout` | `{}` | Revokes that session family, clears session cookies, 204 |
| POST `/api/auth/forgot-password` | `email` | Generic 202; sends reset if eligible |
| POST `/api/auth/reset-password` | `token`, `password` | Consumes token, changes password, invalidates all sessions |
| GET `/api/auth/me` | None | Authenticated public user DTO, excluding email |

Only exact `@ucf.edu` addresses are accepted, case-normalized. Passwords require at least 12 Unicode codepoints, at most 72 UTF-8 bytes, and must avoid the basic common-password denylist, numeric-only and repeated-character patterns. Bcrypt cost is 12. Verification expires after 24 hours; reset expires after 30 minutes. Links carry tokens in URL fragments, which the client immediately removes before rendering. A user explicitly confirms verification or submits a new password; tokens are sent only in the JSON body and are kept only in memory. Invalid/expired links offer a new-link request. Routes do not return tokens or email addresses.

Access cookies expire in at most 15 minutes. Refresh families expire absolutely after seven days, rotate on every use, and retain consumed hashes for replay detection. The client uses an in-tab single-flight promise and the browser's same-origin Web Locks API to coordinate rotation across tabs; an in-lock session probe avoids rotating again when another tab already renewed the shared cookies. Browsers without Web Locks can sign in, but expired sessions require signing in again rather than risking refresh replay. Concurrent token reuse is still rejected by the server. A maximum of 1,000 rotations requires a new login. Logout revokes one family immediately; password reset invalidates every family and access JWT. There is no Bearer-token or local/sessionStorage authentication path.

Limits are independent Mongo-backed fixed windows per direct client IP: login 30, registration 10, reset request 10, reset confirmation 10, verification 20, verification resend 20, refresh 120, logout 30, and CSRF bootstrap 120 per 15 minutes. Five failed verified-account logins lock the account for one minute, doubling on later failures up to one hour. Correct credentials cannot bypass an active lock. Proxy headers are deliberately untrusted; a reverse-proxy deployment currently shares conservative limits by proxy IP. Configure deployment topology and review trusted proxies before changing this behavior. Keep MongoDB available: rate-limit storage failures reject requests.

## Posts and images API (Phase 3)

Public reads are unauthenticated and always omit private details, all answer material and emails. Owner reads use separate authenticated URLs. All mutations require the existing Secure session cookies, CSRF header/cookie and exact Origin. JSON remains mandatory except for the single upload endpoint, which accepts multipart after CSRF and authentication checks.

| Method/path | Body/query | Result |
| --- | --- | --- |
| POST `/api/uploads` | Multipart with exactly one `image` file, no text fields | Staged image ID and owner preview URL, 201 |
| GET `/api/uploads/:id/preview` | None; owner authentication required | Unexpired staged image only |
| GET `/api/uploads/:id` | None | Image only when attached to a live public post |
| DELETE `/api/uploads/:id` | JSON `{}`; owner authentication required | Discards an unattached staged image, 204 |
| POST `/api/posts` | Creation JSON below | Created post and owner details, 201 |
| GET `/api/posts` | Search/filter/pagination query | Public posts and pagination counts |
| GET `/api/posts/mine` | Same query; owner authentication required | Current user's active posts with private details |
| GET `/api/posts/:id` | None | Public detail, even when the caller is the owner |
| GET `/api/posts/:id/manage` | None; owner authentication required | Owner detail including private details |
| PATCH `/api/posts/:id` | Current `revision` plus whitelisted changes | Updated owner detail; stale revision returns 409 |
| DELETE `/api/posts/:id` | JSON `{ "revision": <current revision> }` | Immediately hides post and images, 204; cleanup follows |

Creation JSON uses `type` (`lost`/`found`), `category`, `title`, `publicDescription`, optional `privateDetails`, optional `images` (an array of previously staged upload IDs), `location` (`campusArea`, optional `buildingName`, optional `[longitude, latitude]` coordinates), and `dateFoundOrLost` (ISO datetime with timezone). Categories are `electronics`, `keys`, `wallets`, `bags`, `clothing`, `books`, `jewelry`, `ids`, and `other`. Lost posts accept 0–4 images; found posts require 1–4 and `verificationQuestions`, an array of 2–3 `{ "question": "...", "answer": "..." }` objects. Authoritative answers are normalized and salted/hashed at intake; no endpoint returns their hashes/salts or recovers those original answers, including owner endpoints. Question IDs and text are public. Claimants' separate submitted answers are available only in finder review, as described below.

To publish images, upload each separately, then submit their IDs with post creation or editing. Only the uploader can attach them, and a file can belong to only one post. Uploads accept JPEG, PNG and static WebP up to **5 MiB each**, verify declared MIME against magic bytes and the decoder, reject animation and images exceeding 20 million pixels, and produce JPEGs no larger than 1600×1600 with EXIF/GPS/ICC/XMP removed. Original filenames are discarded. All post images are public: keep distinguishing secrets, student IDs, contact information and personal documents out of public photos and descriptions. Optional coordinates are explicit public location data, not EXIF data.

PATCH accepts only `revision`, `category`, `title`, `publicDescription`, `privateDetails`, `images`, `location`, `dateFoundOrLost`, and `status` (`open`/`closed`). Post type, author, item reference, expiry and verification challenges are immutable. Empty updates are rejected; `claim_pending`/`returned` posts cannot be edited. Found posts must retain an image. To clear private details send an empty string. Image arrays replace the existing array, so include any images being retained. Removing an image immediately disables its URL, then cleanup deletes the bytes. Admin removal is a separate Phase 7 moderation feature, not an owner-route bypass.

Browse queries accept `q` (public title/description full-text search, max 100 characters), `type`, `category`, `location` (exact building/campus-area match), `from`/`to` (inclusive ISO datetimes on the item date), `status`, `page` (1–10000, default 1) and `limit` (1–50, default 20). Unknown fields, duplicate query keys, operator/dotted keys and invalid date ranges are rejected. Responses contain `posts` and `pagination: { page, limit, total, pages }`, with deterministic newest-first ordering by creation time then ID. Queries have a five-second database budget. Closed/returned posts remain visible until deleted/expired; the status filter can restrict results.

Expiry is server-controlled by `POST_RETENTION_DAYS` (default 90). Every read checks visibility before background cleanup, including image delivery. The cleanup worker runs at startup and every `CLEANUP_INTERVAL_SECONDS` (default 60), processing up to 50 expired/deleted posts and 50 pending files per pass. It transactionally removes related item, claim, notification, conversation and message records, then deletes GridFS files/chunks using a persistent upload ledger. Failed storage deletions stay queued for retry. Unattached uploads expire after 24 hours; interrupted writes after one hour. A reconciliation sweep removes up to 50 ledger-less GridFS files or incomplete chunk groups older than a day, preserving recent/journaled writes. Post deletion hides content immediately but physical erasure is asynchronous and depends on worker/database/storage health. Monitor sanitized `post_cleanup_failed`/`upload_cleanup_deferred` events.

Phase 3 limits are separate Mongo-backed per-IP 15-minute windows: 20 uploads, 30 post mutations, and 300 public browse/detail reads. At most two uploads are buffered/processed concurrently per API process; excess work returns 503 with Retry-After. GridFS writes have a 30-second deadline. Uploads and JSON post creation are deliberately separate so failed post transactions can roll back attachments without relying on unsupported GridFS transactions.

## Claims and notifications API (Phase 4)

All routes below require a verified, non-banned authenticated user. Mutations use the same CSRF cookie/header, exact Origin and JSON requirements as authentication. Found-post claims and lost-post matching use separate consent flows; Phase 6 routes are below.

| Method/path | Body/query | Result |
| --- | --- | --- |
| POST `/api/posts/:postId/claims` | `{ "answers": [{ "questionId": "...", "answer": "..." }, ...] }` | Generic pending claim summary, 202 |
| GET `/api/claims/mine` | `page`, `limit`, optional `status` | Claimant's own claim summaries |
| GET `/api/claims/:claimId` | None | Claimant's own summary, excluding submitted answers and verification result |
| GET `/api/posts/:postId/my-claim` | None | Current claimant's own summary for this live post, or null; no other user's claim |
| GET `/api/posts/:postId/claims` | `page`, `limit`, optional `status`; finder only | Finder review list with latest submitted answers and overall verification result |
| GET `/api/posts/:postId/claims/:claimId` | None; finder only | Single finder review |
| POST `/api/posts/:postId/claims/:claimId/decision` | `{ "decision": "approve" or "deny", "attemptCount": <reviewed count> }`; finder only | Decision summary and current `postRevision` |
| POST `/api/posts/:postId/return` | `{ "revision": <current post revision> }`; finder only | Confirms physical return after approval, 204 |
| GET `/api/notifications` | `page`, `limit`, optional `unread=true` | Recipient-only in-app inbox |
| PATCH `/api/notifications/:notificationId/read` | `{}` | Recipient-only idempotent read acknowledgement, 204 |

Use the public question IDs from post detail and include exactly one nonblank answer per question. Order is irrelevant; IDs are checked against that post and answers are reordered server-side. Answers allow up to 500 characters each. Both correct and incorrect submissions receive the same pending response: only the finder sees an overall `verificationPassed` value, never per-question match feedback or authoritative hashes/salts. Submitted answers are deliberately returned only by finder review, along with public claimant ID/display name. Claimants and other users cannot use that review route; admins have no override for another user's post. No endpoint exposes account email addresses or item private details to claimants.

There is one claim per user/post and a **lifetime maximum of three valid submissions**, including resubmissions while pending or after denial. The latest submission replaces the previous answer text; attempt counts never reset. Unknown/duplicate question IDs, missing answers and invalid bodies do not consume an attempt. Valid mismatches do consume an attempt and enter finder review. The fourth valid submission returns 429; waiting does not reset this per-post allowance. A separate 15-minute IP rate limit can also return 429. The client should use its own claim's count to explain the distinction.

Finders must review the latest attempt and echo its `attemptCount` in the decision. A changed attempt, duplicate decision or stale state returns 409. All answers must match before approval is allowed, but matching alone never creates a conversation. Approval atomically reserves the post, approves the claim, creates one conversation with server-selected `[finder, claimant]` participants, notifies the approved claimant, and denies competing pending claims. Competing claimants see the denied status in My Claims; there is no separate notification fanout for automatic competing denials. Explicit finder denial notifies that claimant and reopens the post when no pending/reserved claim remains. Denial does not restore attempts.

Approval keeps the post `claim_pending` while handoff is arranged. Public post DTOs expose an `acceptingClaims` boolean, not the selected claim/conversation reference. The finder confirms actual return through the separate revisioned return endpoint, which requires an approved claim and its conversation. Both participants can now open the approved conversation from Campus Chat. Submitted verification answers remain finder-only even after approval and are never copied automatically into chat.

Each submission and explicit decision creates an answer-free notification in the same database transaction. The client polls its badge/inbox once a minute while visible; no real-time notification transport is claimed yet. Notification clicks fetch the separately authorized review/detail routes. Reads exclude expired/deleted posts and banned authors; post cleanup also removes notification records. Defaults are page 1/limit 20; limits are 1–50 and page numbers 1–10000. Read queries have a five-second database budget. `unread=false` means all notifications, not only read ones.

Additional per-IP 15-minute limits: 20 claim submissions, 60 decisions/return confirmations, 120 claim reads, 120 notification reads, and 60 read acknowledgements. They use shared MongoDB counters and retain the existing untrusted-proxy behavior. Every valid submission/decision locks the post inside a MongoDB transaction, coordinating with edits, deletion and expiry cleanup. Failed notification or conversation writes roll the entire change back. Audit records contain actor/post/claim IDs, attempt count, request ID and outcome, with no answers, match results, hashes, salts, tokens or emails.

## React client (Phase 5)

Routes include `/` (sign-in required, then browse/search/filter/pagination), `/browse` (public browse), `/posts/:id`, `/found/new`, `/lost/new`, `/posts/:id/edit`, `/posts/:id/claim`, `/posts/:id/review`, `/my-posts`, `/my-claims`, `/notifications`, `/login`, `/register`, `/verify-email`, `/resend-verification`, `/forgot-password`, `/reset-password`, and `/settings`. Phase 6 adds `/chat`, `/chat/:conversationId`, and `/posts/:id/match`. Admin provides the role-protected report queue and account moderation. Settings provides password-confirmed account deletion; Settings also supports TOTP enrollment and backup-code management.

The client supports staged photo uploads, safe public descriptions, owner-only private fields, locked verification questions on edit, revisioned deletion/return confirmations, finder review with stale-attempt protection, and claim counts loaded from the new claimant-scoped per-post lookup. Disabled/busy submit controls prevent rapid duplicate clicks. Submitted HTML is rendered as literal React text. Layouts are mobile-first with black headers/footers, gold buttons with black text, white surfaces, labeled forms, image alt text, visible keyboard focus, a skip link, native dialogs, status announcements and reduced-motion support. Automated axe checks passed for the exercised desktop/mobile/auth/claim/review pages; they are not a complete assistive-technology certification.

API requests always include cookies, refuse redirects, and attach memory-only CSRF tokens to mutations. Multipart boundaries are browser-generated. Confirmed CSRF rejection can refresh the CSRF token and retry once; confirmed pre-controller 401 responses can renew the session and retry once. Network/timeout/409 failures never automatically replay a mutation. Private reads are discarded if session identity changes; BroadcastChannel messages carry only a session-change signal, with account state rechecked from the API. Sensitive pages remount when identity changes. Login return destinations are limited to known internal routes. Image URLs are restricted to expected API upload paths. No token, password, question answer or private item detail is placed into browser storage or navigation state.

Production static hosting must serve the SPA entry for client routes and preserve API routes. The Vite preview supplies a strict self-only CSP (plus an explicitly configured API origin for images/connections), nosniff, no-referrer and DENY framing headers; configure equivalent headers on the real production host. Development HMR has different requirements and is not a production security boundary. Browser QA artifacts are in `.tools/previews/phase5-desktop.png` and `.tools/previews/phase5-mobile.png`, using disposable fixture data only.

## Chat and lost-post consent (Phase 6)

Campus Chat opens a found-post conversation only after a matching claim is explicitly approved. For lost posts, another verified user clicks **I think I found this** and requests a private conversation. The lost-post author reviews requests in Campus Chat and accepts or denies; no message can be sent before acceptance. One accepted request reserves the post and denies competitors. A denied request cannot be resubmitted. The author can confirm physical return through the existing revisioned `POST /api/posts/:postId/return` endpoint for either post type. Public lost-post DTOs expose `acceptingMatches`, without exposing the selected request.

All HTTP chat/request routes require the normal verified, non-banned cookie session. POST requests additionally require JSON, Origin and CSRF. Participants can read only conversations backed by their approved claim or accepted request, including on returned posts until expiry. Admins have no conversation override. Deleted/closed/expired posts or banned/unverified participants make the conversation unavailable; cleanup removes lost requests and messages with the post.

| Method/path | Body/query | Result |
| --- | --- | --- |
| GET `/api/conversations` | `page`, `limit` | Participant-only eligible conversation inbox |
| GET `/api/conversations/:conversationId` | None | Safe post title and public participant names/IDs |
| GET `/api/conversations/:conversationId/messages` | `limit` (1–50, default 20), optional positive `before` sequence | Chronological page of persisted messages; `nextBefore` cursor or null |
| POST `/api/posts/:postId/matches` | `{}` | Pending lost-post request, 201; existing pending request returns 200 |
| GET `/api/matches/incoming` | `page`, `limit` | Requests on the caller's own lost posts |
| GET `/api/matches/mine` | `page`, `limit` | Caller’s own requests |
| POST `/api/posts/:postId/matches/:requestId/decision` | `{ "decision": "accept" or "deny" }` | Author-only decision; acceptance atomically creates the linked conversation |

Inbox/request pages default to page 1/limit 20, with limit at most 50 and page at most 10000. History uses a stable conversation sequence cursor rather than offsets; the message model now includes `sequence` and `clientMessageId`. Message DTOs contain only ID, conversation ID, sender's public ID/display name, text, sequence, client message ID and timestamp. No email, verification proof or private item fields are joined into history.

Socket.IO is WebSocket-only at `/socket.io/`. The browser automatically sends HttpOnly cookies; JavaScript supplies only a signed CSRF token in the namespace auth payload: `{ csrfToken }`. Tokens are never URL parameters or bearer payloads. The handshake requires the exact configured Origin, valid CSRF/cookie pair and current session. The server rechecks current authentication on every application event and participant/consent access before joins, sends and each live recipient delivery. Sockets close at their original access JWT expiry; idle revocation checks also run every 15 seconds. Click **Reconnect** to renew through the existing Web Locks coordination and open a fresh socket with current cookies. Logout/account changes close the client socket; the server independently rejects revoked sessions.

| Socket event | Client payload | Acknowledgement |
| --- | --- | --- |
| `conversation:join` | `{ conversationId }` | `{ ok: true, conversation }` or `{ ok: false, status }` |
| `conversation:leave` | `{}` | `{ ok: true }` |
| `message:send` | `{ conversationId, clientMessageId: <UUID>, body }` | `{ ok: true, message }` or `{ ok: false, status }` |
| Server `message:new` | None | Authorized current-conversation message DTO |
| Server `session:expired` | None | Client displays reconnect guidance |

All event payloads are strict Zod objects. Messages are trimmed, nonblank text up to 2,000 characters, excluding NUL and unsupported control characters. Sender, timestamps and sequence are server-selected. The unique `(conversation, sender, clientMessageId)` index makes a repeated identical draft return its existing message; changed text under the same ID returns 409. Post/conversation/message changes run transactionally, sharing a post write lock with deletion/cleanup. Public post revisions are not bumped for chat traffic.

Socket.IO normally has [at-most-once delivery](https://socket.io/docs/v4/delivery-guarantees/). This client uses acknowledged sends without automatic mutation replay, discards offline buffering, and preserves a failed draft's UUID for an explicit retry. History is the durable source of truth: reconnect reloads it, and ID/sequence merging removes replay duplicates. A database commit can succeed even when an acknowledgement is lost, so check history or retry the same draft rather than creating a new copy. **Edit draft** after an uncertain send creates a new message identity on the next attempt. Drafts remain memory-only and disappear on page close or logout.

Limits: 30 handshake attempts/IP/minute; 5 live sockets/user/API process; 100 application events/socket/minute; 2 concurrent event handlers/socket; 60 joins/user/minute; 60 sends/user/minute and 20 sends/user/conversation/minute. The transport rejects frames over 16 KiB, disables compression, and times out incomplete namespace connections after 10 seconds. Persistent MongoDB counters back handshake/join/send budgets. HTTP limits per direct-IP/15 minutes are 120 conversation reads, 120 history reads, 10 lost requests, 120 request-list reads and 60 request decisions. Existing proxy/NAT caveats apply. Inbox/request polling is once a minute while visible; chat messages are live.

Deployment must forward WebSocket Upgrade traffic at `/socket.io/` to the **same Node API process**, in addition to `/api`. The local Vite dev/preview proxies already do this without rewriting Origin. Configure production CSP `connect-src` for the exact `wss://` socket origin; the local preview includes `wss://localhost:4173` by default or the configured API origin's WebSocket equivalent. Use trusted HTTPS/WSS in production.

**Deployment assumption:** live fanout currently uses one Node API process. MongoDB history works independently of the socket process, but multiple API processes need an authorized cross-process delivery adapter before real-time fanout is reliable. No Redis, paid broker, external chat provider, attachments or end-to-end encryption is added. Chat text is access-controlled and stored in MongoDB; protect database/backups. Do not enable raw Socket.IO packet debug logs, which may contain message text or credentials. The test chat screenshot is `.tools/previews/phase6-chat.png` and contains disposable fixture data only.

## Reporting, moderation and deletion (Phase 7)

Run `npm run db:indexes --workspace server` before a production restart to provision the unique report index and moderation/queued-mail indexes. Startup checks the required report uniqueness constraint. No new dependencies, secrets or environment variables are needed.

| Route | Purpose |
| --- | --- |
| POST /api/posts/:postId/reports | Verified students report another user's live post with a reason and private details |
| GET /api/admin/reports | Admin-only paginated queue, optionally filtered by open/resolved/dismissed status |
| PATCH /api/admin/reports/:reportId | Resolve or dismiss an open report with its current revision |
| DELETE /api/admin/posts/:postId | Admin removal of any live post; resolves its open reports |
| GET /api/admin/users/:userId | Admin-only account details, including email and verification/lock/MFA status; never credentials or tokens |
| GET /api/admin/users | Admin-only name/email search and verification/ban/lock/role filters |
| GET /api/admin/activity | Admin-only paginated audit activity |
| POST /api/admin/users/:userId/unban | Unban a non-admin account and revoke sessions |
| POST /api/admin/users/:userId/unlock | Clear login lock/failures and revoke sessions |
| POST /api/admin/users/:userId/revoke-sessions | Revoke all account sessions |
| POST /api/admin/users/:userId/email/:kind | Queue verification or password-reset email |
| DELETE /api/admin/users/:userId | Password/MFA-confirmed deletion of a non-admin account |
| POST /api/admin/users/:userId/ban | Ban a non-admin account and revoke its sessions |
| DELETE /api/account | Delete the authenticated account with current password and confirmation: DELETE (and a fresh factor if MFA is enabled) |

All mutations require JSON, exact Origin, CSRF and a verified cookie session. Reports accept `reason` (privacy/unsafe/spam/other) and 5?1,000 characters of `details`. One report per account/post is retained; repeats return the same generic acknowledgement without overwriting the first submission. Reports are visible only to admins, who see public post links, report text and public identities. There is no moderation override for private distinguishing details, verification answers or chat. Pagination defaults to 20, caps at 50, and uses a stable date/ID order. Separate IP limits per 15-minute window are report 10, admin reads 120, admin actions 60 and account deletion 5; these persist in MongoDB. Campus-wide NAT deployments should review these shared IP budgets.

The post detail has a report form and admin removal control. `/admin` includes report review, an account directory, account details, and an activity log. Administrators can search by name/email, inspect verification/lock/MFA status, queue verification or password-reset emails, clear temporary locks, revoke sessions, ban/unban, and permanently delete non-admin accounts. Administrator deletion requires the administrator's password and MFA if enabled, plus explicit DELETE confirmation. It reuses the transactional account cleanup and preserves moderation audit history. The account directory deliberately exposes email only to current administrators through explicit DTOs; password hashes, tokens, MFA secrets, private answers, and chats remain excluded.

Administrators cannot manage themselves or other admin accounts through these controls, and there is no role-assignment endpoint. Register and verify a real UCF account, then provision it using `npm run admin:grant --workspace server -- your-email@ucf.edu` from the repository root on the server. This operator command revokes existing sessions; sign in again. There is no default admin password. See [ADMIN.md](ADMIN.md) for setup, supported actions, and deployment steps.

Settings deletion requires the current password, typing DELETE, and a confirmation dialog. Success clears all three cookies, invalidates private client state and signs out other tabs. The account, session families, claims, lost requests, reports filed by the user, notifications and conversations involving the account (including both participants' messages) are erased transactionally. Surviving reserved posts reopen when their claimant deletes the account; returned posts retain returned status. Authored posts become immediately inaccessible tombstones. Their items and GridFS images are physically removed by the resumable cleanup worker; storage failures remain queued. Other users' unrelated records remain intact. Indexed pending authentication mail for the recipient is removed; new mail is serialized with deletion. A message already handed to SMTP cannot be recalled. Legacy queue rows without recipient metadata expire within their original 24-hour window.

Deletion is not a backup-wipe guarantee: operators must apply a documented backup retention/restore policy, expire delivered development mailbox files, and limit log access. The sanitized deletion event omits the account ID; previous security logs may retain pseudonymous IDs. Banned or otherwise inaccessible non-admin accounts can be deleted through the administrator panel after the appropriate identity checks; normal user sessions remain revoked. Large account deletion transactions are not yet load-tested; failure rolls back and leaves the account usable for a retry. These operational limits are tracked in SECURITY.md.

## Two-step verification (Phase 8)

TOTP is optional for students and administrators. Settings supports password-confirmed QR/manual enrollment, explicit six-digit confirmation, ten single-use backup codes, backup-code replacement, and disabling. The sign-in form always offers an optional authenticator/backup-code field, avoiding an account-specific pre-login challenge or MFA-status endpoint. For enabled accounts the password and a fresh factor must both validate before cookies are issued. Account deletion also requires a factor when enabled. Password reset preserves active MFA and never signs the user in.

| Route | Required proof / result |
| --- | --- |
| GET /api/mfa | Authenticated owner only: enabled flag and remaining backup-code count |
| POST /api/mfa/enrollment | Current password; returns a fresh seed, private PNG QR and enrollmentId, expiring in ten minutes |
| POST /api/mfa/confirm | Current password, enrollmentId and six-digit code; enables MFA and returns ten backup codes once |
| POST /api/mfa/backup-codes | Current password and fresh code; invalidates the old backup set and returns ten replacements once |
| POST /api/mfa/disable | Current password and fresh code; erases the secret and backup codes |

All mutations retain exact Origin, CSRF, strict JSON/Zod validation and verified-session checks. Management has persistent limits of 20/IP and 10/account per 15 minutes, shared across setup/confirmation/replacement/disable; status reads have a separate 120/IP limit. Login retains its existing IP limits and account lockout; missing and incorrect factors count as failed login attempts. No JWT or session is issued after password-only validation for an enabled account.

Enrollment uses OTPAuth 9.6.0 and locally generated QR PNGs from qrcode 1.5.4, pinned in the lockfile. There is no external QR, authenticator, analytics or recovery service. TOTP uses a random 160-bit secret, SHA-1, six digits and 30-second steps, accepting at most one adjacent step in either direction. The last accepted step is stored atomically; confirmation also spends its step. Wait for the next authenticator code if you just used one, or use a backup code. Keep server/device clocks synchronized. Tests include the SHA-1 vectors from [RFC 6238 Appendix B](https://www.rfc-editor.org/rfc/rfc6238.html#appendix-B), reduced to six digits.

Active and pending secrets are encrypted using AES-256-GCM, a fresh nonce, user/purpose-bound authenticated data, and an HKDF-derived key. Backup codes contain 80 random bits each and only user-bound HMAC-SHA-256 digests are stored. Codes accept case-insensitive hexadecimal with or without their grouping hyphens. Ten codes are shown only after successful confirmation/replacement; save them offline before dismissing the screen. Secrets, QR images and codes stay in memory, never URLs, browser storage, logs or ordinary API responses. A refresh/navigation can lose this one-time display. If a response is lost, reload Settings to check status; use the configured authenticator to replace codes if necessary.

Enabling/disabling/replacing codes increments the credential version and revokes every older family, including existing sockets. The initiating browser receives fresh Secure cookies; other tabs in that browser adopt the shared cookies, while other browser/device sessions must sign in again. An MFA-proven refresh family can renew normally until its original seven-day expiry; renewal does not demand another code. Password-only legacy families cannot authenticate an enabled account. Proof consumption and new-family creation commit together, so failed writes do not spend backup codes or partially change MFA.

Keep `MFA_ENCRYPTION_KEY` stable, private and backed up independently of MongoDB. It now protects active/pending MFA, backup-code digests and encrypted mail with separate derived keys. Losing/changing it without a migration makes these records unusable; do not simply regenerate it during deployment. No new environment variable is required. Run `npm run db:indexes --workspace server` to provision the pending-enrollment expiry index; cleanup unsets expired pending fields and never TTL-deletes an account. Existing non-MFA users/families need no migration; unproven families fail closed for enabled users. Client CSP adds `data:` only to img-src for strictly checked PNG QR content, never scripts.

Recovery assumes access to the authenticator or an unused backup code plus the password. Email reset cannot disable MFA. There is no automated operator recovery endpoint, trusted-device bypass, SMS or WebAuthn implementation. Losing the authenticator and every backup code requires an independently verified operator process; never disable MFA based only on an email request. TOTP can still be phished and is not a phishing-resistant authentication method. These operational limits remain in the Phase 9 review.

## Security review and deployment boundaries (Phase 9)

SECURITY.md contains the completed OWASP Top 10:2025 matrix, fixed findings, test evidence and remaining deployment obligations. This is a local source/test review, not a penetration-test certificate or proof that an unspecified deployment is secure.

Production startup now also requires the session, rate-bucket and mail-outbox TTL indexes, and refuses a partial/sparse email uniqueness index. Run `npm run db:indexes --workspace server` using a controlled database account before starting a production API. Use a separate least-privilege runtime MongoDB account, restrict database/API network access, and use authenticated/encrypted database connections and protected backups for the actual deployment. The local replica-set setup remains development tooling.

Proxy trust defaults to disabled. If a controlled reverse proxy terminates TLS, set server `TRUST_PROXY` to a comma-separated list of its exact IP addresses (for example, a local proxy at 127.0.0.1). Wildcards, hostnames, hop counts and CIDRs are rejected. Restrict direct access to the API and configure the proxy to replace or append the actual remote client address to X-Forwarded-For. HTTP and WebSocket limiters then use the same trust boundary and ignore attacker-supplied prefixes beyond the first untrusted hop. Never trust a shared/uncontrolled proxy. Campus NATs still share a public IP; test/tune rate budgets against the intended campus traffic and monitor 429/503 responses.

Node HTTP limits are 8 KiB headers, ten seconds for headers, thirty seconds for request bodies, five seconds idle keep-alive and 100 requests per reused connection. Database transactions have a fifteen-second total deadline and ten-second commit budget. Password hashing/comparison admits eight simultaneous operations per process; answer derivation admits two; overflow rejects with a generic 503 rather than queuing unbounded work. Upload admission remains two/process, with a five-second Sharp processing bound and existing byte/pixel limits. These are conservative local defaults, not distributed-DoS protection or a performance SLA. Keep one Node API process for live chat until a tested cross-process adapter is introduced.

Login state reset, MFA proof consumption and session creation now commit together. Password resets consume the token, change credentials and revoke families in one transaction. Client actions verify their account generation after asynchronous CSRF acquisition and before dispatch; stale actions and queued security changes cannot target a newly selected account. JSON is structurally bounded before recursive sanitization; prototype-related keys, excessive depth/width, compressed JSON and unsupported charsets are rejected. SMTP accepts only plain-text account-mail fields and disables URL/file attachment access.

Security audits now include request IDs for correlation. `security_account_lockout` records the pseudonymous account ID, count and request ID without credentials. Protect and durably collect structured stdout, route lockout/reuse/admin/error events to operator alerts, and monitor cleanup/mail failures. Rehearse account deletion, MFA recovery, encryption-key restoration, backup retention/restoration and rollback before accepting real campus data. No legal-retention, lost-all-factors recovery, high-load/failover or deployed SMTP/TLS test is implied.

A clean `npm ci` verifies the lockfile is installable. Production audit is required to be clean. Full audit still reports the documented Jest development dependency findings; compatible-only remediation was attempted, and npm's forced Jest downgrade was not used. Do not execute attacker-controlled test code or filesystem glob patterns; track compatible upstream fixes. Keep the runtime/OS patched independently of npm audit, which does not assess them. The legacy prototype is outside the new workspaces and this review; do not expose or deploy it.
## Phase plan

1. Scaffolding, config, middleware, models, errors, tests.
2. Authentication, rotation/reuse detection, verification/reset, lockout, CSRF.
3. Posts, uploads, authorization, search and coordinated expiry cleanup.
4. Claims and private verification answers.
5. React feature pages and accessible theme.
6. Authenticated conversation-scoped Socket.IO chat.
7. Moderation, reports, account deletion.
8. TOTP and backup codes.
9. OWASP review and dependency audit.

Each phase is separately tested and reviewed before continuing. See [SECURITY.md](SECURITY.md) for implemented controls and pending security work.
