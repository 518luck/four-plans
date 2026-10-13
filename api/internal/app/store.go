package app

import (
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

func OpenStore(filename string) (*sql.DB, error) {
	absolute, err := filepath.Abs(filename)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0700); err != nil {
		return nil, err
	}
	uri := url.URL{Scheme: "file", Path: absolute}
	db, err := sql.Open("sqlite", uri.String()+"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	schema := `
 CREATE TABLE IF NOT EXISTS users (
   id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL UNIQUE,
   password_hash TEXT NOT NULL, created_at TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS sessions (
   token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS tasks (
   id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
   title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
   bucket TEXT NOT NULL CHECK (bucket IN ('today','three','week','month')),
   scheduled_date TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
   priority INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
   created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
   completed_at TEXT, completion_date_estimated INTEGER NOT NULL DEFAULT 0
 );
 CREATE INDEX IF NOT EXISTS tasks_period ON tasks(user_id, bucket, scheduled_date, deleted_at);
 CREATE UNIQUE INDEX IF NOT EXISTS one_focus_per_day ON tasks(user_id, scheduled_date)
   WHERE priority = 1 AND bucket = 'today' AND done = 0 AND deleted_at IS NULL;
 `
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize database: %w", err)
	}
	if err := migrateCompletionDates(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate completion dates: %w", err)
	}
	if err := migrateRecurring(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate recurring plans: %w", err)
	}
	if err := os.Chmod(absolute, 0600); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func migrateCompletionDates(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var version int
	if err := tx.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version >= 2 {
		return tx.Commit()
	}
	rows, err := tx.Query("PRAGMA table_info(tasks)")
	if err != nil {
		return err
	}
	columns := map[string]bool{}
	for rows.Next() {
		var id, notNull, primaryKey int
		var name, columnType string
		var defaultValue sql.NullString
		if err := rows.Scan(&id, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			rows.Close()
			return err
		}
		columns[name] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if !columns["completed_at"] {
		if _, err := tx.Exec("ALTER TABLE tasks ADD COLUMN completed_at TEXT"); err != nil {
			return err
		}
	}
	if !columns["completion_date_estimated"] {
		if _, err := tx.Exec("ALTER TABLE tasks ADD COLUMN completion_date_estimated INTEGER NOT NULL DEFAULT 0"); err != nil {
			return err
		}
	}
	if _, err := tx.Exec("UPDATE tasks SET completed_at=updated_at,completion_date_estimated=1 WHERE done=1 AND completed_at IS NULL"); err != nil {
		return err
	}
	if _, err := tx.Exec("PRAGMA user_version = 2"); err != nil {
		return err
	}
	return tx.Commit()
}

func migrateRecurring(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var version int
	if err := tx.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version >= 3 {
		return tx.Commit()
	}
	_, err = tx.Exec(`
 ALTER TABLE tasks ADD COLUMN recurring_id TEXT NOT NULL DEFAULT '';
 CREATE TABLE recurring_plans (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
 title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', start_date TEXT NOT NULL, end_date TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','paused','stopped')), effective_date TEXT NOT NULL,
 generated_until TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
 );
 CREATE TABLE recurring_revisions (
 plan_id TEXT NOT NULL REFERENCES recurring_plans(id), effective_date TEXT NOT NULL,
 title TEXT NOT NULL, notes TEXT NOT NULL, end_date TEXT NOT NULL, status TEXT NOT NULL,
 PRIMARY KEY(plan_id,effective_date)
 );
 CREATE TABLE recurring_occurrences (
 plan_id TEXT NOT NULL REFERENCES recurring_plans(id), scheduled_date TEXT NOT NULL, task_id TEXT NOT NULL,
 PRIMARY KEY(plan_id,scheduled_date)
 );
 CREATE INDEX tasks_recurring ON tasks(recurring_id);
 CREATE TABLE daily_quotes (date TEXT PRIMARY KEY, text TEXT NOT NULL, author TEXT NOT NULL, source TEXT NOT NULL, fallback INTEGER NOT NULL);
 PRAGMA user_version = 3;
 `)
	if err != nil {
		return err
	}
	return tx.Commit()
}
