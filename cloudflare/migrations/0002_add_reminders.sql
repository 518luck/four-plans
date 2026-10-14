ALTER TABLE tasks ADD COLUMN reminder_time TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN reminder_advance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN reminded_at TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_reminder ON tasks(scheduled_date, reminder_time);
