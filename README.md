# SwipeMatch

A mobile-first swipe-to-vote web app for CMPE 285.

## Voting theme — Speed-dating profiles

**SwipeMatch is a Tinder-style "date-or-pass" feed.** Every item on the deck is a fictional person — a name with an age, a short two-sentence bio that mixes a personality trait, a job, a couple of hobbies and a conversation-starter prompt, and a friendly DiceBear avatar. The binary decision is *"Would you go on a date with this person?"* — swipe right for yes, left for no, pull down (or tap the Results tab) to see how the rest of the userbase voted on each profile.

The theme was picked because:

1. **It maps cleanly to a single binary question per card**, which is what the brief asks for.
2. **It justifies user accounts and per-user state** — "My Matches" only means something when each user has their own private yes-list.
3. **It motivates the user-published-profile feature** — once you've voted on the seeded crowd, you can add *yourself* to the deck and see how others vote on you, which makes the multi-user demo immediately interesting.
4. **The brief explicitly lists "speed dating profiles" as an example theme**, and the wireframe ("Pug Puppy 92% yes") is structurally identical to what we render.

The 100 seeded profiles are generated deterministically from in-file word lists (see `server/seed.js`) so re-running the seed produces the same content and the same DiceBear avatar URLs. No real people are depicted, no images are bundled — the brief's "do not submit images of real people without their permission" rule is satisfied by construction.

## Quick start

```bash
./setup.sh   # installs deps + seeds 100 profiles into SQLite
./start.sh   # launches http://localhost:3000
```

Windows PowerShell equivalent:

```powershell
npm install
npm run seed
npm start
```

Open <http://localhost:3000> in a mobile-sized window (Chrome devtools → iPhone 14 / 390×844). Register one account, then open an **incognito window**, register a second account, and you'll see the aggregate `yes` / `no` counts shift in real time as both users vote.

## Architecture (1-minute version)

- **Frontend** — vanilla HTML/CSS/JS in `public/`, no build step. Mobile-first; layout was developed against the brief's **390 × 844 (iPhone-class) target viewport** and has no horizontal overflow or layout shift at that size. Swipe gestures use the Pointer Events API so the same handlers drive touch on mobile and mouse drag on desktop. A global `error`-capture handler swaps any failed `<img>` to an inline-SVG silhouette, so an offline DiceBear CDN can never produce a broken-image icon. Three top-level UI states: auth screen → deck view → results view.
- **Backend** — Node + Express in `server/server.js`. Auth is a username/password sign-up flow with bcrypt-hashed passwords and opaque session tokens stored in SQLite; tokens are passed by the client in an `Authorization: Bearer …` header and persisted in `localStorage`. (The brief's example payload for `POST /vote` lists a client-supplied `sessionId`; we intentionally went further and put the session in a server-validated Bearer token instead, so the user identity on each write can't be spoofed by a hostile client.)
- **Persistence** — SQLite via `better-sqlite3` at `data/swipematch.db` (auto-created on first run; ships with prebuilt binaries so no compiler toolchain is required). Tables: `users`, `sessions`, `items`, `votes`. Foreign keys are on; `votes` has `PRIMARY KEY (user_id, item_id)` so a duplicate vote is impossible at the schema level, and the writer uses `INSERT … ON CONFLICT DO UPDATE` so re-voting on the same item is treated as "change your mind" (the row is updated, never duplicated). This is the project's idempotency / dedup story end-to-end.
- **Why SQLite over Postgres/Mongo or a JSON file** — zero-admin, one file, transactional, fine through millions of votes. JSON-with-locking would have meant either losing votes to lost-update races or hand-rolling fsync-style write locks I can't defend on a 7-day timeline. Easy to swap for Postgres later (the only thing that touches the store is `db.js` and the prepared statements in `server.js`).
- **Input validation** — every write endpoint type-checks and bounds-checks its payload before the DB sees it: `register` enforces `^[a-zA-Z0-9_-]{3,24}$` usernames + 4-char-min passwords; `vote` rejects unknown ids, non-string `itemId`, `choice ∉ {yes,no}`, self-votes, and clamps `decisionMs` to `[0, 3 600 000] ms`; `profile` caps name at 40 chars, bio at 240 chars, and only accepts `imageUrl` matching `^https://api\.dicebear\.com/…$`. `express.json` has an 8 KB body limit as a coarse DoS guard. The client is never trusted to compute aggregates — `/api/results` rebuilds them from the `votes` table on every call.

### Endpoints

| Method | Path                    | Auth   | What it does                                                    |
|--------|-------------------------|--------|-----------------------------------------------------------------|
| POST   | `/api/register`         | —      | Create user + log in, returns `{ token, username }`             |
| POST   | `/api/login`            | —      | Verify password, returns `{ token, username }`                  |
| POST   | `/api/logout`           | Bearer | Invalidates the current token                                   |
| GET    | `/api/me`               | Bearer | Current user info (used to validate token on reload)            |
| GET    | `/api/items`            | —      | All 100 items                                                   |
| POST   | `/api/vote`             | Bearer | `{ itemId, choice }` — UPSERT one vote per (user, item)         |
| POST   | `/api/undo`             | Bearer | Deletes the session user's most recent vote                     |
| GET    | `/api/my-votes`         | Bearer | Item ids the current user has already voted on                  |
| GET    | `/api/results?sort=…`   | Opt.   | Aggregate; `top` · `divisive` · `skipped` · `matches` (auth)    |
| GET    | `/api/stats`            | —      | `{ totalVotes, totalSessions, totalUsers, totalItems, avgDecisionMs }` |
| GET    | `/api/profile`          | Bearer | Logged-in user's own profile item, or `null`                    |
| POST   | `/api/profile`          | Bearer | Create or update the user's own profile (`u<userId>`)           |
| DELETE | `/api/profile`          | Bearer | Remove the user's profile (cascades to votes on it)             |
| POST   | `/api/wave`             | Bearer | `{ itemId }` — send a wave to that profile's owner over WS      |
| GET    | `/api/chats`            | Bearer | Conversation list — one row per partner with last-message preview and unread count |
| GET    | `/api/chats/:userId`    | Bearer | Full transcript with that user; flips their messages to read    |
| POST   | `/api/chats/:userId`    | Bearer | `{ body }` — send a message; live-delivered over WS             |
| GET    | `/api/chats-unread`     | Bearer | `{ n }` — total unread messages, used by the topbar badge       |
| WS     | `/ws?token=…`           | Bearer | Live channel — emits `profile:updated`, `profile:deleted`, `wave`, `message`, `message:read` |

## Item data and image source

100 seed profiles generated from `server/seed.js`. Each item has a stable id (`p001`–`p100`), a display label (`"Alice, 28"`), a 1–2 sentence description, and a deterministic image URL pointing at [DiceBear](https://www.dicebear.com/) — `lorelei` style, seeded by name. User-published profiles are inserted as additional rows with id `u<userId>` and the same data shape. The DB is the source of truth; the items table is what the API serves.

**Image credit / license:** DiceBear avatars are open-source under CC0 / MIT — see <https://www.dicebear.com/licenses/>. Nothing is uploaded; the `<img>` tags fetch SVGs from the DiceBear CDN at view time.

## Requirements completed

**Core (Section 3.1)**

- [x] Voting theme picked and documented
- [x] 100 distinct items, each with image + label + description
- [x] Swipe-card UI: right = yes, left = no, with visible buttons as fallback
- [x] Visual feedback during drag (tilt, YES/NO badges, green/red tint)
- [x] Smooth transition + animated card exit
- [x] Results view via tab **and** downward pull, with four sort filters
- [x] Backend SQLite is the source of truth
- [x] End-of-deck state ("You've voted on everything")

**Stretch (Section 3.2)**

- [x] **Proper sign-in** — username + bcrypt-hashed password, opaque session tokens, persistent across reloads (beyond the "anonymous session id" the brief asked for)
- [x] **User-published profiles** — any logged-in user can publish a profile (display name, bio, DiceBear avatar of their choice) that other users see in their deck. Backend filters the creator's own profile out of their `/api/items` and rejects self-votes with 400.
- [x] **Tappable detail view** — clicking any row in the Results list opens a modal with the full description, global stats, the viewer's own vote, and a "send a wave" gesture
- [x] Undo last swipe
- [x] "My Matches" view (yes votes whose global yes-rate ≥ 60%)
- [x] **Admin / seed script** — `npm run seed` re-seeds the 100 base profiles, and additionally reads `data/extra-items.json` if present so new items can be added with **zero code changes**. Format: `[{ "id": "x001", "name": "Mystery Box, ??", "description": "...", "imageUrl": "https://api.dicebear.com/…" }]`. Re-running the seed is idempotent (UPSERT by id).
- [x] **Basic analytics** — `/api/stats` returns total swipes, total login sessions, total users, total items, and `avgDecisionMs` (mean time between a card landing on top of the deck and the user committing yes/no). All five values render on the Results header.
- [x] **Live results & notifications** — websocket layer at `ws://host/ws?token=…`, authenticated via the same Bearer token used for HTTP. The server broadcasts `profile:updated` / `profile:deleted` to every other connected client whenever someone publishes or removes their profile, so both the deck *and* the open Results list refresh in real time without a page reload. Waves are routed point-to-point (`POST /api/wave` → `sendToUser(item.createdBy)`) and the recipient sees a tappable slide-in toast. Aggregate counts on the Results view still poll every 30 seconds as a backstop so users with a flaky network still see fresh numbers.
- [x] **One-to-one chat** — every wave is the start of a conversation. The recipient can tap the toast to open a chat sheet with the sender, and any user can tap the new "Send message 💬" button in a profile's detail modal to start a thread with that profile's owner. Messages persist in a `messages` table (`id`, `from_user_id`, `to_user_id`, `body`, `created_at`, `read_at`) and are live-delivered over the same WS channel (`message` event); read receipts also propagate (`message:read`) so the sender's badge clears when the other party opens the thread. The topbar has a "Messages" button with a global unread badge, opening a conversation-list sheet with previews and per-thread unread counters.

## Technical requirements (Section 5) — where each one is met

### 5.1 Frontend

- **Mobile web app, correct at 390 × 844** — `public/style.css` is mobile-first with a `max-width: 480px` shell and uses flexbox so nothing overflows or shifts at the iPhone-14 viewport. Verified in Chrome devtools' device emulator.
- **Framework choice** — vanilla HTML/CSS/JS. No build step, no transpiler, no node_modules in the served bundle. Picked because the AI assistant ships better ungeneralized DOM code than React boilerplate at this scale.
- **Touch + mouse** — `public/app.js` binds Pointer Events (`pointerdown`/`pointermove`/`pointerup`/`pointercancel`) once per top card. The same code path handles a finger drag on iOS Safari and a left-click drag on desktop Chrome.
- **No layout shift / overflow / broken images** — fixed-aspect card wrapper prevents reflow when avatars load; sticky results header doesn't displace its container; all `<img>` tags fall back to an inline-SVG silhouette via a global capture-phase `error` handler, so a flaky CDN can't produce a broken-image icon.

### 5.2 Backend

- **Required, aggregates across users** — Node + Express in `server/server.js`, persistence in SQLite. `localStorage` only caches the auth token and a UI-local "have I voted on this id" set; the source of truth is always the DB.
- **Stack choice** — Node + Express. Justified because the swipe deck is JS-heavy on the client and matching the languages eliminates context-switch tax.
- **Endpoints** — the brief's three illustrative endpoints are all present (`GET /api/items`, `POST /api/vote`, `GET /api/results`), plus the auth + profile + analytics extensions documented in the Endpoints table above. The vote payload uses a server-validated Bearer token in lieu of a client-supplied `sessionId`, which is strictly stricter than the brief.
- **Idempotency / dedup** — `votes` has a composite `PRIMARY KEY (user_id, item_id)`, and the writer uses `INSERT … ON CONFLICT(user_id, item_id) DO UPDATE SET choice = excluded.choice, …`. So a user who swipes right then changes their mind and swipes left replaces (never duplicates) their row, and a buggy client retrying the same `POST /api/vote` lands exactly once.
- **Persistence + justification** — SQLite via `better-sqlite3`; rationale is in the Architecture section above.

### 5.3 Data

- **≥ 100 items via a script** — `server/seed.js` deterministically generates 100 speed-dating profiles and UPSERTs them into the `items` table. `data/extra-items.json` is an optional admin hook for adding more without editing code.
- **Stable id, label, image URL** — every item has a `p###`-style id, a `"Name, Age"` label, and an `https://api.dicebear.com/…` URL.
- **Credit** — DiceBear (`lorelei` style) is open-source under CC0 / MIT (<https://www.dicebear.com/licenses/>); credit + license link is in the *Item data and image source* section above.

### 5.4 Quality bar

- **Readable, organized code** — separated into `server/db.js` (schema + migrations), `server/server.js` (HTTP layer), `server/seed.js` (data generator), and three small files under `public/`. Prepared statements live in one `q` object; auth middleware is two small functions.
- **Committed in logical chunks** — six commits by subsystem: scaffolding · SQLite data layer · Express API · HTML + CSS shell · client JS · docs. Run `git log --oneline` to see them.
- **README explains run + architecture + trade-offs** — *Quick start*, *Architecture*, and *Known gaps* sections above.
- **No console errors on the happy path** — verified by hand on login → 20 swipes → undo → results → modal → profile edit → logout, both as a fresh user and as a returning user. The only network calls that can `console.error` are intentional ones logging unexpected vote/undo failures.
- **Basic input validation on the backend** — covered in the Architecture section's "Input validation" bullet.

## Multi-user demo

1. `./setup.sh && ./start.sh`
2. Browser tab 1 → `http://localhost:3000` → Sign up as `alice` / anything
3. Vote on a handful of profiles
4. Open an incognito tab → `http://localhost:3000` → Sign up as `bob` / anything
5. Vote on the same profiles in different directions
6. Both tabs → Results → "Most Divisive" — you'll see the items you disagreed on
7. Each user's "My Matches" tab is private and reflects only their own yes votes

## Known gaps / trade-offs

- Tokens never expire and there is no rate-limiting on `/api/login`. Fine for a local demo; a production deploy would add expiry and a brute-force guard.
- The websocket layer is in-memory only — restart the server and connected clients reconnect cleanly but any in-flight waves are lost. A production deploy would either persist waves or use a pub/sub bus (Redis, NATS) so multiple Node instances can share the broadcast.
- Avatars are fetched from the DiceBear CDN. The inline-SVG fallback prevents broken-image icons offline, but you'd want a bundled fixture set for a true air-gapped demo.

## Project layout

```
.
├── server/
│   ├── db.js       # SQLite open + schema (users / sessions / items / votes)
│   ├── server.js   # Express API + auth middleware + static host
│   └── seed.js     # generates 100 items into the DB (idempotent UPSERT)
├── public/
│   ├── index.html  # single page: auth view + main app
│   ├── style.css   # mobile-first, 480px max
│   └── app.js      # auth flow + swipe + view logic
├── data/           # created on first run; holds swipematch.db
├── setup.sh
├── start.sh
├── package.json
├── README.md
└── AI_NOTES.md
```

See `AI_NOTES.md` for the required AI-usage write-up.
