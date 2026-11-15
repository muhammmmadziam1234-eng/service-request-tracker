-- 001: the schema of the original Relay Desk (version 1), which never set user_version.
-- Every statement is idempotent, so a version-1 database adopts this migration unchanged.
CREATE TABLE IF NOT EXISTS requests(
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, requester TEXT NOT NULL, team TEXT NOT NULL,
  description TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('Open','Assigned','In progress','Completed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS activity(
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id),
  event TEXT NOT NULL, previous_status TEXT, status TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS activity_request ON activity(request_id,id);
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY);
