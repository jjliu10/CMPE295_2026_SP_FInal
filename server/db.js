// server/db.js — opens (or creates) the SQLite database and applies the schema.
// Tables:
//   users    — registered accounts (username + bcrypt hash)
//   sessions — opaque login tokens, one row per active login
//   items    — the 100 things people vote on
//   votes    — one row per (user, item); PRIMARY KEY enforces dedup

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'swipematch.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL,
    password_hash TEXT    NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS items (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    image_url   TEXT NOT NULL,
    created_by  INTEGER REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS votes (
    user_id     INTEGER NOT NULL,
    item_id     TEXT    NOT NULL,
    choice      TEXT    NOT NULL CHECK(choice IN ('yes','no')),
    created_at  INTEGER NOT NULL,
    decision_ms INTEGER,
    PRIMARY KEY (user_id, item_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_votes_item ON votes(item_id);

  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER NOT NULL,
    to_user_id   INTEGER NOT NULL,
    body         TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    read_at      INTEGER,
    FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (to_user_id)   REFERENCES users(id) ON DELETE CASCADE
  );
  -- Composite index serves the "conversation between A and B in time order" query
  -- as well as the "unread for me from any sender" query.
  CREATE INDEX IF NOT EXISTS idx_messages_pair    ON messages(from_user_id, to_user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_to_read ON messages(to_user_id, read_at);
`);

// In-place migration for DBs created before items.created_by existed.
const itemCols = db.prepare(`PRAGMA table_info(items)`).all().map(c => c.name);
if (!itemCols.includes('created_by')) {
  db.exec('ALTER TABLE items ADD COLUMN created_by INTEGER REFERENCES users(id)');
}

// In-place migration for DBs created before votes.decision_ms existed.
const voteCols = db.prepare(`PRAGMA table_info(votes)`).all().map(c => c.name);
if (!voteCols.includes('decision_ms')) {
  db.exec('ALTER TABLE votes ADD COLUMN decision_ms INTEGER');
}

// Safe to create the index now that the column is guaranteed to exist.
db.exec('CREATE INDEX IF NOT EXISTS idx_items_created_by ON items(created_by)');

module.exports = db;
