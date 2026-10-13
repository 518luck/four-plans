CREATE TABLE users (
 id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires_at TEXT NOT NULL);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE tasks(
 id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),title TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',
 bucket TEXT NOT NULL CHECK(bucket IN ('today','three','week','month')),scheduled_date TEXT NOT NULL,
 done INTEGER NOT NULL DEFAULT 0,priority INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,completed_at TEXT,completion_date_estimated INTEGER NOT NULL DEFAULT 0,recurring_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX tasks_period ON tasks(user_id,bucket,scheduled_date,deleted_at);
CREATE UNIQUE INDEX one_focus_per_day ON tasks(user_id,scheduled_date) WHERE priority=1 AND bucket='today' AND done=0 AND deleted_at IS NULL;
CREATE TABLE recurring_plans(
 id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),title TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',
 start_date TEXT NOT NULL,end_date TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','paused','stopped')),
 effective_date TEXT NOT NULL,generated_until TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE TABLE recurring_revisions(
 plan_id TEXT NOT NULL REFERENCES recurring_plans(id),effective_date TEXT NOT NULL,title TEXT NOT NULL,notes TEXT NOT NULL,end_date TEXT NOT NULL,status TEXT NOT NULL,
 PRIMARY KEY(plan_id,effective_date)
);
CREATE TABLE recurring_occurrences(
 plan_id TEXT NOT NULL REFERENCES recurring_plans(id),scheduled_date TEXT NOT NULL,task_id TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(plan_id,scheduled_date)
);
CREATE INDEX tasks_recurring ON tasks(recurring_id);
CREATE TABLE daily_quotes(date TEXT PRIMARY KEY,text TEXT NOT NULL,author TEXT NOT NULL,source TEXT NOT NULL,fallback INTEGER NOT NULL);
CREATE TABLE login_attempts(ip_hash TEXT PRIMARY KEY,failures INTEGER NOT NULL,expires_at TEXT NOT NULL);
-- All focus updates and goal revisions are atomic, including across concurrent Worker isolates.
CREATE TRIGGER tasks_focus_insert BEFORE INSERT ON tasks WHEN NEW.priority=1
BEGIN
 UPDATE tasks SET priority=0,version=version+1,updated_at=NEW.updated_at WHERE user_id=NEW.user_id AND bucket='today' AND scheduled_date=NEW.scheduled_date AND priority=1 AND deleted_at IS NULL;
END;
CREATE TRIGGER tasks_focus_update BEFORE UPDATE OF priority,scheduled_date ON tasks WHEN NEW.priority=1
BEGIN
 UPDATE tasks SET priority=0,version=version+1,updated_at=NEW.updated_at WHERE user_id=NEW.user_id AND bucket='today' AND scheduled_date=NEW.scheduled_date AND priority=1 AND id<>NEW.id AND deleted_at IS NULL;
END;
CREATE TRIGGER recurring_revision_insert AFTER INSERT ON recurring_plans
BEGIN
 INSERT INTO recurring_revisions(plan_id,effective_date,title,notes,end_date,status) VALUES(NEW.id,NEW.effective_date,NEW.title,NEW.notes,NEW.end_date,NEW.status);
END;
CREATE TRIGGER recurring_revision_update AFTER UPDATE OF version ON recurring_plans
BEGIN
 INSERT INTO recurring_revisions(plan_id,effective_date,title,notes,end_date,status) VALUES(NEW.id,NEW.effective_date,NEW.title,NEW.notes,NEW.end_date,NEW.status)
 ON CONFLICT(plan_id,effective_date) DO UPDATE SET title=excluded.title,notes=excluded.notes,end_date=excluded.end_date,status=excluded.status;
END;
CREATE TRIGGER recurring_task_insert AFTER INSERT ON recurring_occurrences
BEGIN
 INSERT INTO tasks(id,user_id,title,notes,bucket,scheduled_date,created_at,updated_at,recurring_id)
 SELECT NEW.task_id,1,title,notes,'today',NEW.scheduled_date,NEW.created_at,NEW.created_at,NEW.plan_id
 FROM recurring_revisions WHERE plan_id=NEW.plan_id AND effective_date<=NEW.scheduled_date ORDER BY effective_date DESC LIMIT 1;
END;
