// server/server.js — Express API + static host, backed by SQLite.

const express   = require('express');
const bcrypt    = require('bcryptjs');
const crypto    = require('crypto');
const path      = require('path');
const http      = require('http');
const WebSocket = require('ws');
const db        = require('./db');

const app = express();
app.use(express.json({ limit: '8kb' }));

// --- Prepared statements ---------------------------------------------------
const q = {
  insertUser:     db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'),
  findUserByName: db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?'),
  findUserById:   db.prepare('SELECT id, username FROM users WHERE id = ?'),

  insertSession:  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)'),
  findSession:    db.prepare(`
    SELECT s.token, u.id AS user_id, u.username
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `),
  deleteSession:  db.prepare('DELETE FROM sessions WHERE token = ?'),

  allItems:       db.prepare('SELECT id, name, description, image_url AS imageUrl FROM items ORDER BY id'),
  // Same list but with the caller's own profile filtered out so they don't vote on themselves.
  itemsForUser:   db.prepare(`
    SELECT id, name, description, image_url AS imageUrl
    FROM items
    WHERE created_by IS NULL OR created_by != ?
    ORDER BY id
  `),
  itemExists:     db.prepare('SELECT 1 AS x FROM items WHERE id = ?'),
  itemOwner:      db.prepare('SELECT created_by FROM items WHERE id = ?'),
  itemById:       db.prepare('SELECT id, name, description, image_url AS imageUrl, created_by AS createdBy FROM items WHERE id = ?'),

  getProfile:     db.prepare(`
    SELECT id, name, description, image_url AS imageUrl
    FROM items WHERE created_by = ?
  `),
  upsertProfile:  db.prepare(`
    INSERT INTO items (id, name, description, image_url, created_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name        = excluded.name,
      description = excluded.description,
      image_url   = excluded.image_url
  `),
  deleteProfile:  db.prepare('DELETE FROM items WHERE id = ? AND created_by = ?'),

  upsertVote:     db.prepare(`
    INSERT INTO votes (user_id, item_id, choice, created_at, decision_ms)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, item_id) DO UPDATE SET
      choice      = excluded.choice,
      created_at  = excluded.created_at,
      decision_ms = excluded.decision_ms
  `),
  myVoteIds:      db.prepare('SELECT item_id FROM votes WHERE user_id = ?'),
  myVotes:        db.prepare('SELECT item_id AS itemId, choice FROM votes WHERE user_id = ?'),
  myYesVotes:     db.prepare("SELECT item_id FROM votes WHERE user_id = ? AND choice = 'yes'"),
  lastVote:       db.prepare('SELECT item_id, choice FROM votes WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'),
  deleteVote:     db.prepare('DELETE FROM votes WHERE user_id = ? AND item_id = ?'),

  aggregate:      db.prepare(`
    SELECT
      i.id, i.name, i.description, i.image_url AS imageUrl,
      COALESCE(SUM(CASE WHEN v.choice = 'yes' THEN 1 ELSE 0 END), 0) AS yes,
      COALESCE(SUM(CASE WHEN v.choice = 'no'  THEN 1 ELSE 0 END), 0) AS no,
      COALESCE(COUNT(v.choice), 0)                                  AS total
    FROM items i
    LEFT JOIN votes v ON v.item_id = i.id
    GROUP BY i.id
  `),

  stats:          db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM votes)    AS totalVotes,
      (SELECT COUNT(*) FROM users)    AS totalUsers,
      (SELECT COUNT(*) FROM sessions) AS totalSessions,
      (SELECT COUNT(*) FROM items)    AS totalItems,
      (SELECT AVG(decision_ms) FROM votes WHERE decision_ms IS NOT NULL) AS avgDecisionMs
  `),

  // --- Chat ---------------------------------------------------------------
  insertMessage:   db.prepare(`
    INSERT INTO messages (from_user_id, to_user_id, body, created_at)
    VALUES (?, ?, ?, ?)
  `),
  messageById:     db.prepare(`
    SELECT id, from_user_id AS fromUserId, to_user_id AS toUserId,
           body, created_at AS createdAt, read_at AS readAt
    FROM messages WHERE id = ?
  `),
  conversation:    db.prepare(`
    SELECT id, from_user_id AS fromUserId, to_user_id AS toUserId,
           body, created_at AS createdAt, read_at AS readAt
    FROM messages
    WHERE (from_user_id = ? AND to_user_id = ?)
       OR (from_user_id = ? AND to_user_id = ?)
    ORDER BY id ASC
    LIMIT ?
  `),
  markRead:        db.prepare(`
    UPDATE messages SET read_at = ?
    WHERE to_user_id = ? AND from_user_id = ? AND read_at IS NULL
  `),
  // Conversation list for the logged-in user: one row per other-party, with
  // the latest message preview, last activity timestamp, and unread count.
  conversationList: db.prepare(`
    WITH partners AS (
      SELECT CASE WHEN from_user_id = @me THEN to_user_id ELSE from_user_id END AS other_id,
             MAX(id) AS last_id
      FROM messages
      WHERE from_user_id = @me OR to_user_id = @me
      GROUP BY other_id
    )
    SELECT
      p.other_id                                                              AS otherUserId,
      u.username                                                              AS otherUsername,
      m.body                                                                  AS lastBody,
      m.from_user_id                                                          AS lastFromUserId,
      m.created_at                                                            AS lastAt,
      (SELECT COUNT(*) FROM messages
        WHERE to_user_id = @me AND from_user_id = p.other_id AND read_at IS NULL) AS unread,
      (SELECT image_url FROM items WHERE created_by = p.other_id LIMIT 1)     AS otherImageUrl,
      (SELECT name      FROM items WHERE created_by = p.other_id LIMIT 1)     AS otherName
    FROM partners p
    JOIN users u    ON u.id = p.other_id
    JOIN messages m ON m.id = p.last_id
    ORDER BY m.created_at DESC
  `),
  unreadCount:      db.prepare(`
    SELECT COUNT(*) AS n FROM messages WHERE to_user_id = ? AND read_at IS NULL
  `)
};

// --- Auth helpers ----------------------------------------------------------
function newToken() { return crypto.randomBytes(32).toString('hex'); }

function readToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function authRequired(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'auth required' });
  const session = q.findSession.get(token);
  if (!session) return res.status(401).json({ error: 'invalid or expired token' });
  req.user  = { id: session.user_id, username: session.username };
  req.token = token;
  next();
}

// Optional auth — populates req.user if a valid token is present, never rejects.
function authOptional(req, _res, next) {
  const token = readToken(req);
  if (token) {
    const session = q.findSession.get(token);
    if (session) {
      req.user  = { id: session.user_id, username: session.username };
      req.token = token;
    }
  }
  next();
}

function validUsername(s) {
  return typeof s === 'string' && s.length >= 3 && s.length <= 24 && /^[a-zA-Z0-9_-]+$/.test(s);
}

// --- Auth routes -----------------------------------------------------------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!validUsername(username))    return res.status(400).json({ error: 'username must be 3-24 chars, letters/digits/_/-' });
  if (typeof password !== 'string' || password.length < 4) return res.status(400).json({ error: 'password must be at least 4 characters' });
  if (q.findUserByName.get(username)) return res.status(409).json({ error: 'username already taken' });

  const hash  = bcrypt.hashSync(password, 10);
  const info  = q.insertUser.run(username, hash, Date.now());
  const token = newToken();
  q.insertSession.run(token, info.lastInsertRowid, Date.now());
  res.json({ token, username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'username and password required' });
  }
  const user = q.findUserByName.get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const token = newToken();
  q.insertSession.run(token, user.id, Date.now());
  res.json({ token, username: user.username });
});

app.post('/api/logout', authRequired, (req, res) => {
  q.deleteSession.run(req.token);
  res.json({ ok: true });
});

app.get('/api/me', authRequired, (req, res) => {
  res.json({ username: req.user.username });
});

// --- Items / votes ---------------------------------------------------------
app.get('/api/items', authOptional, (req, res) => {
  const items = req.user
    ? q.itemsForUser.all(req.user.id)
    : q.allItems.all();
  res.json({ items });
});

app.post('/api/vote', authRequired, (req, res) => {
  const { itemId, choice, decisionMs } = req.body || {};
  if (typeof itemId !== 'string')          return res.status(400).json({ error: 'itemId required' });
  const item = q.itemOwner.get(itemId);
  if (!item)                               return res.status(404).json({ error: 'unknown itemId' });
  if (item.created_by === req.user.id)     return res.status(400).json({ error: "you can't vote on your own profile" });
  if (choice !== 'yes' && choice !== 'no') return res.status(400).json({ error: "choice must be 'yes' or 'no'" });

  // Sanitize decision time: ignore anything not in [0, 1h]. Stored as nullable.
  const dms = (typeof decisionMs === 'number' && Number.isFinite(decisionMs) && decisionMs >= 0 && decisionMs <= 3_600_000)
    ? Math.round(decisionMs)
    : null;

  q.upsertVote.run(req.user.id, itemId, choice, Date.now(), dms);
  res.json({ ok: true });
});

// --- Profile (user-created item) ------------------------------------------
const DICEBEAR_URL = /^https:\/\/api\.dicebear\.com\/[\w.\-/?=&,%]+$/;

app.get('/api/profile', authRequired, (req, res) => {
  res.json({ profile: q.getProfile.get(req.user.id) || null });
});

app.post('/api/profile', authRequired, (req, res) => {
  const { name, description, imageUrl } = req.body || {};
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const trimmedDesc = typeof description === 'string' ? description.trim() : '';
  if (trimmedName.length < 1 || trimmedName.length > 40) {
    return res.status(400).json({ error: 'display name must be 1-40 chars' });
  }
  if (trimmedDesc.length > 240) {
    return res.status(400).json({ error: 'bio must be 240 chars or fewer' });
  }
  if (typeof imageUrl !== 'string' || !DICEBEAR_URL.test(imageUrl)) {
    return res.status(400).json({ error: 'imageUrl must be a DiceBear URL' });
  }
  const id = `u${req.user.id}`;
  q.upsertProfile.run(id, trimmedName, trimmedDesc, imageUrl, req.user.id);
  const profile = q.getProfile.get(req.user.id);
  // Live-broadcast so every OTHER client refreshes their deck without a reload.
  // The owner is excluded because their own POST response already updated them.
  broadcast('profile:updated', { item: { ...profile, createdBy: req.user.id } }, req.user.id);
  res.json({ ok: true, profile });
});

app.delete('/api/profile', authRequired, (req, res) => {
  const id   = `u${req.user.id}`;
  const info = q.deleteProfile.run(id, req.user.id);
  if (info.changes > 0) broadcast('profile:deleted', { id }, req.user.id);
  res.json({ ok: info.changes > 0 });
});

// Send a wave to the owner of a profile item. Pure ephemeral signal — nothing
// is persisted; if the recipient isn't connected right now they just miss it.
app.post('/api/wave', authRequired, (req, res) => {
  const { itemId } = req.body || {};
  if (typeof itemId !== 'string') return res.status(400).json({ error: 'itemId required' });
  const item = q.itemById.get(itemId);
  if (!item)                       return res.status(404).json({ error: 'unknown itemId' });
  if (!item.createdBy)             return res.status(400).json({ error: 'this profile has no owner to wave at' });
  if (item.createdBy === req.user.id) return res.status(400).json({ error: "you can't wave at yourself" });

  const delivered = sendToUser(item.createdBy, 'wave', {
    fromUserId:   req.user.id,
    fromUsername: req.user.username,
    itemId,
    itemName:     item.name
  });
  res.json({ ok: true, delivered });
});

// --- Chat -----------------------------------------------------------------
const MAX_MESSAGE_LEN = 500;

// List of conversations the logged-in user has had with anyone, newest first.
app.get('/api/chats', authRequired, (req, res) => {
  const rows = q.conversationList.all({ me: req.user.id });
  res.json({ conversations: rows });
});

// Fetch the full transcript between the logged-in user and `:otherUserId`.
// Side effect: every message in that conversation that's addressed to the
// caller and still unread is flipped to read in the same request.
app.get('/api/chats/:otherUserId', authRequired, (req, res) => {
  const other = parseInt(req.params.otherUserId, 10);
  if (!Number.isInteger(other) || other === req.user.id) return res.status(400).json({ error: 'bad otherUserId' });
  const otherUser = q.findUserById.get(other);
  if (!otherUser) return res.status(404).json({ error: 'unknown user' });

  const messages = q.conversation.all(req.user.id, other, other, req.user.id, 500);
  q.markRead.run(Date.now(), req.user.id, other);
  // Tell the other party (if connected) that we read their messages, so they
  // can update their unread badge live.
  sendToUser(other, 'message:read', { byUserId: req.user.id });

  // Bundle the partner's profile info so the client can render the chat header
  // without a separate lookup.
  const profile = q.getProfile.get(other);
  res.json({
    otherUser: {
      id:       other,
      username: otherUser.username,
      name:     profile ? profile.name     : otherUser.username,
      imageUrl: profile ? profile.imageUrl : null
    },
    messages
  });
});

// Send a message. Body is { body: "hi there" }. The recipient sees it live
// over their websocket as a 'message' event.
app.post('/api/chats/:otherUserId', authRequired, (req, res) => {
  const other = parseInt(req.params.otherUserId, 10);
  if (!Number.isInteger(other) || other === req.user.id) return res.status(400).json({ error: 'bad otherUserId' });
  if (!q.findUserById.get(other))                        return res.status(404).json({ error: 'unknown user' });

  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (body.length < 1)                       return res.status(400).json({ error: 'message body required' });
  if (body.length > MAX_MESSAGE_LEN)         return res.status(400).json({ error: `message too long (max ${MAX_MESSAGE_LEN} chars)` });

  const info    = q.insertMessage.run(req.user.id, other, body, Date.now());
  const message = q.messageById.get(info.lastInsertRowid);

  // Live-deliver. The sender's other tabs also get the message so the chat
  // window stays in sync across devices.
  const wirePayload = { ...message, fromUsername: req.user.username };
  sendToUser(other,        'message', wirePayload);
  sendToUser(req.user.id,  'message', wirePayload);
  res.json({ ok: true, message: wirePayload });
});

// Lightweight count used by the topbar unread badge.
app.get('/api/chats-unread', authRequired, (req, res) => {
  res.json(q.unreadCount.get(req.user.id));
});

app.post('/api/undo', authRequired, (req, res) => {
  const last = q.lastVote.get(req.user.id);
  if (!last) return res.json({ ok: false });
  q.deleteVote.run(req.user.id, last.item_id);
  res.json({ ok: true, removed: { itemId: last.item_id, choice: last.choice } });
});

app.get('/api/my-votes', authRequired, (req, res) => {
  const votes = q.myVotes.all(req.user.id);
  res.json({
    itemIds: votes.map(v => v.itemId),
    votes
  });
});

// Aggregate results — public by default; ?sort=matches requires auth.
app.get('/api/results', authOptional, (req, res) => {
  const sort = req.query.sort || 'top';

  const myYes = req.user
    ? new Set(q.myYesVotes.all(req.user.id).map(r => r.item_id))
    : new Set();

  let rows = q.aggregate.all().map(r => ({
    id:          r.id,
    name:        r.name,
    description: r.description || '',
    imageUrl:    r.imageUrl,
    yes:         r.yes,
    no:          r.no,
    total:       r.total,
    yesPct:      r.total === 0 ? 0 : Math.round((r.yes / r.total) * 100),
    mine:        myYes.has(r.id)
  }));

  switch (sort) {
    case 'divisive':
      rows.sort((a, b) => (Math.abs(50 - a.yesPct) - Math.abs(50 - b.yesPct)) || (b.total - a.total));
      break;
    case 'skipped':
      rows.sort((a, b) => a.total - b.total);
      break;
    case 'matches':
      if (!req.user) return res.status(401).json({ error: 'log in to see your matches' });
      rows = rows.filter(r => r.mine && r.yesPct >= 60).sort((a, b) => b.yesPct - a.yesPct);
      break;
    case 'top':
    default:
      rows.sort((a, b) => (b.yesPct - a.yesPct) || (b.total - a.total));
  }
  res.json({ sort, results: rows });
});

app.get('/api/stats', (_req, res) => {
  res.json(q.stats.get());
});

// --- Static frontend -------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- WebSocket layer -------------------------------------------------------
// One in-memory map: userId -> Set<WebSocket>. Multiple sockets per user is
// fine (e.g. browser + incognito both logged in as the same account).
const userSockets = new Map();
const wss = new WebSocket.Server({ noServer: true });

function broadcast(event, payload, exceptUserId) {
  const data = JSON.stringify({ event, payload });
  for (const [uid, set] of userSockets) {
    if (uid === exceptUserId) continue;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }
}

function sendToUser(userId, event, payload) {
  const set = userSockets.get(userId);
  if (!set || set.size === 0) return false;
  const data = JSON.stringify({ event, payload });
  let delivered = 0;
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) { ws.send(data); delivered++; }
  }
  return delivered > 0;
}

wss.on('connection', (ws) => {
  const uid = ws._userId;
  if (!userSockets.has(uid)) userSockets.set(uid, new Set());
  userSockets.get(uid).add(ws);

  // Cheap heartbeat — drop sockets that stopped responding to ping after 60s.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('close', () => {
    const set = userSockets.get(uid);
    if (set) {
      set.delete(ws);
      if (set.size === 0) userSockets.delete(uid);
    }
  });
});

setInterval(() => {
  for (const set of userSockets.values()) {
    for (const ws of set) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }
}, 30_000).unref();

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// Token-authenticated WS upgrade. Token rides as a query param because
// browsers can't set custom headers on the WebSocket constructor.
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
  const url     = new URL(req.url, 'http://localhost');
  const token   = url.searchParams.get('token');
  const session = token ? q.findSession.get(token) : null;
  if (!session) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws._userId   = session.user_id;
    ws._username = session.username;
    wss.emit('connection', ws, req);
  });
});

server.listen(PORT, () => {
  const s = q.stats.get();
  if (s.totalItems === 0) console.warn('No items in DB — run `npm run seed`.');
  console.log(`SwipeMatch running at http://localhost:${PORT} — ${s.totalUsers} users, ${s.totalItems} items, ${s.totalVotes} votes.`);
});
