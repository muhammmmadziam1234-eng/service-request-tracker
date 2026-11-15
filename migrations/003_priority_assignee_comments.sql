-- 003: priority, assignee and owner on requests; comments; who did what in the history.
-- Rows written by earlier versions get defaults, never invented values: Normal priority, no assignee,
-- no owner (so only agents and admins can see them), and their history entries get a kind derived from the old columns.
ALTER TABLE requests ADD COLUMN priority TEXT NOT NULL DEFAULT 'Normal' CHECK(priority IN ('Low','Normal','High','Urgent'));
ALTER TABLE requests ADD COLUMN assignee_id INTEGER REFERENCES users(id);
ALTER TABLE requests ADD COLUMN requester_id INTEGER REFERENCES users(id);
CREATE INDEX requests_requester ON requests(requester_id);
CREATE INDEX requests_assignee ON requests(assignee_id);

CREATE TABLE comments(
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX comments_request ON comments(request_id,id);

-- event, previous_status and status stay as the original program wrote them; new code reads kind, from_value and to_value.
ALTER TABLE activity ADD COLUMN kind TEXT NOT NULL DEFAULT 'status' CHECK(kind IN ('opened','status','assigned','priority','commented'));
ALTER TABLE activity ADD COLUMN actor_id INTEGER REFERENCES users(id);
ALTER TABLE activity ADD COLUMN from_value TEXT;
ALTER TABLE activity ADD COLUMN to_value TEXT;
UPDATE activity SET kind=CASE WHEN previous_status IS NULL THEN 'opened' ELSE 'status' END, from_value=previous_status, to_value=status;
