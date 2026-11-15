-- 002: accounts and sessions.
-- Sessions store only the SHA-256 of the cookie token. Times are epoch milliseconds so expiry is plain arithmetic.
CREATE TABLE users(
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK(length(username) BETWEEN 1 AND 64),
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('requester','agent','admin')),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
