package app

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

func TestStatisticsCalendarAndStreaks(t *testing.T) {
	f := newFixture(t)
	tasks := []Task{{ID: "pending"}}
	for i, date := range []string{"2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-13", "2024-02-29"} {
		day, _ := time.ParseInLocation("2006-01-02", date, f.server.location)
		tasks = append(tasks, Task{ID: date, Done: true, CompletedAt: stamp(day.Add(30 * time.Minute)), CompletionDateEstimated: i == 8})
	}
	tasks = append(tasks, Task{Done: true, CompletedAt: stamp(f.server.now()), DeletedAt: stamp(f.server.now())})
	result := calculateStatistics(tasks, f.server.now(), f.server.location)
	if result.TotalPlans != 10 || result.CompletedPlans != 9 || result.CompletionRate != 90 || result.LongestStreak != 4 || result.CurrentStreak != 3 || result.EstimatedCompletions != 1 {
		t.Fatalf("unexpected headline metrics: %+v", result)
	}
	if len(result.Days) != 365 || result.Start != "2025-10-14" || result.End != "2026-10-13" || result.Days[0].Cumulative != 1 || result.Days[364].Count != 2 || result.Days[364].Cumulative != 9 {
		t.Fatal("heatmap must include timezone-correct dates, one cell per day, and older cumulative completions")
	}
	tomorrow := calculateStatistics(tasks, f.server.now().AddDate(0, 0, 1), f.server.location)
	if tomorrow.CurrentStreak != 3 {
		t.Fatal("today without completion must preserve yesterday's streak")
	}
	afterGap := calculateStatistics(tasks, f.server.now().AddDate(0, 0, 2), f.server.location)
	if afterGap.CurrentStreak != 0 {
		t.Fatal("missing a whole day must break the current streak")
	}
	empty := calculateStatistics(nil, f.server.now(), f.server.location)
	if empty.TotalPlans != 0 || empty.CompletionRate != 0 || empty.CurrentStreak != 0 || len(empty.Days) != 365 {
		t.Fatal("empty statistics must be valid and zero-valued")
	}
	leap := calculateStatistics([]Task{{Done: true, CompletedAt: "2024-02-28T16:30:00Z"}, {Done: true, CompletedAt: "2024-02-29T16:30:00Z"}}, time.Date(2024, 3, 1, 9, 0, 0, 0, f.server.location), f.server.location)
	if leap.CurrentStreak != 2 || leap.LongestStreak != 2 || leap.Days[363].Date != "2024-02-29" || leap.Days[363].Count != 1 || leap.Days[364].Count != 1 {
		t.Fatal("Beijing midnight and leap day must not lose or duplicate activity")
	}
}

func TestCompletionDateAndStatisticsLifecycle(t *testing.T) {
	f := newFixture(t)
	f.setup(t)
	task := f.create(t, "today", "2026-10-20", "完成活动统计", false)
	response := f.send(t, "PATCH", "/api/tasks/"+task.ID, map[string]any{"version": task.Version, "done": true})
	expect(t, response, 200)
	task = decode[Task](t, response)
	completedAt := task.CompletedAt
	if completedAt != stamp(f.server.now()) || task.CompletionDateEstimated {
		t.Fatal("completion must record the actual timestamp")
	}
	stats := f.board(t, "2026-10-20").Statistics
	if stats.CompletedPlans != 1 || stats.Days[364].Date != "2026-10-13" || stats.Days[364].Count != 1 {
		t.Fatal("scheduled and selected dates must not alter the actual completion date")
	}
	now := f.server.now()
	f.server.now = func() time.Time { return now.AddDate(0, 0, 3) }
	response = f.send(t, "PATCH", "/api/tasks/"+task.ID, map[string]any{"version": task.Version, "notes": "后来修改备注", "bucket": "week", "date": "2026-10-16", "done": true})
	expect(t, response, 200)
	task = decode[Task](t, response)
	if task.CompletedAt != completedAt {
		t.Fatal("editing, moving and repeating done=true must preserve completion date")
	}
	if f.board(t, "2026-10-16").Statistics.CurrentStreak != 0 {
		t.Fatal("an edit must not count as a new completion")
	}
	expect(t, f.send(t, "DELETE", "/api/tasks/"+task.ID, map[string]any{"version": task.Version}), 204)
	b := f.board(t, "2026-10-16")
	if b.Statistics.TotalPlans != 0 || b.Statistics.CompletedPlans != 0 {
		t.Fatal("trash must be excluded from statistics")
	}
	expect(t, f.send(t, "POST", "/api/trash/"+task.ID+"/restore", map[string]any{"version": b.Trash[0].Version}), 204)
	b = f.board(t, "2026-10-16")
	task = b.Buckets["week"][0]
	if task.CompletedAt != completedAt || b.Statistics.CompletedPlans != 1 || b.Statistics.Days[361].Count != 1 {
		t.Fatal("restore must keep the original completion activity")
	}
	staleVersion := task.Version
	response = f.send(t, "PATCH", "/api/tasks/"+task.ID, map[string]any{"version": task.Version, "done": false})
	expect(t, response, 200)
	task = decode[Task](t, response)
	if task.CompletedAt != "" || task.CompletionDateEstimated || f.board(t, "2026-10-16").Statistics.CompletedPlans != 0 {
		t.Fatal("undo must clear completion and activity")
	}
	expect(t, f.send(t, "PATCH", "/api/tasks/"+task.ID, map[string]any{"version": staleVersion, "done": true}), 409)
	f.server.now = func() time.Time { return now.AddDate(0, 0, 4) }
	response = f.send(t, "PATCH", "/api/tasks/"+task.ID, map[string]any{"version": task.Version, "done": true})
	expect(t, response, 200)
	task = decode[Task](t, response)
	stats = f.board(t, "2026-10-17").Statistics
	if task.CompletedAt != stamp(f.server.now()) || stats.Days[364].Count != 1 || stats.Days[360].Count != 0 || stats.CurrentStreak != 1 {
		t.Fatal("re-completion must use the new date without counting the old one")
	}
	expect(t, f.send(t, "DELETE", "/api/tasks/"+task.ID, map[string]any{"version": task.Version}), 204)
	b = f.board(t, "2026-10-17")
	expect(t, f.send(t, "DELETE", "/api/trash/"+task.ID, map[string]any{"version": b.Trash[0].Version}), 204)
	if f.board(t, "2026-10-17").Statistics.TotalPlans != 0 {
		t.Fatal("permanent deletion must leave no statistical task record")
	}
}

func TestLegacyCompletionDateMigration(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "legacy.db")
	db, err := sql.Open("sqlite", filename)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT, created_at TEXT);
 CREATE TABLE tasks (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', bucket TEXT NOT NULL, scheduled_date TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
 INSERT INTO users VALUES(1,'历史用户','hash','2026-10-01T00:00:00Z');
 INSERT INTO tasks VALUES('legacy',1,'历史完成','备注','today','2026-10-13',1,0,7,'2026-10-01T00:00:00Z','2026-10-12T16:30:00Z',NULL);
 INSERT INTO tasks VALUES('pending',1,'历史待办','','today','2026-10-13',0,0,3,'2026-10-01T00:00:00Z','2026-10-13T01:00:00Z',NULL);
 PRAGMA user_version=1;`)
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	db.Close()
	for attempt := 0; attempt < 2; attempt++ {
		db, err = OpenStore(filename)
		if err != nil {
			t.Fatal(err)
		}
		task, err := scanTask(db.QueryRow("SELECT " + taskColumns + " FROM tasks WHERE id='legacy'"))
		if err != nil || task.CompletedAt != "2026-10-12T16:30:00Z" || !task.CompletionDateEstimated || task.Version != 7 || task.Notes != "备注" {
			db.Close()
			t.Fatalf("migration must preserve records and mark estimates: %+v err=%v", task, err)
		}
		pending, err := scanTask(db.QueryRow("SELECT " + taskColumns + " FROM tasks WHERE id='pending'"))
		if err != nil || pending.CompletedAt != "" || pending.CompletionDateEstimated || pending.Version != 3 {
			db.Close()
			t.Fatal("migration must not complete a pending plan")
		}
		var version int
		if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 4 {
			db.Close()
			t.Fatal("migration version must be durable")
		}
		db.Close()
	}
}

func TestStatisticsYearWindowAndGlobalMetrics(t *testing.T) {
	f := newFixture(t)
	tasks := []Task{{Date: "2024-02-29", Done: true, CompletedAt: "2024-02-29T01:00:00Z"}, {Date: "2026-10-12", Done: true, CompletedAt: "2026-10-12T01:00:00Z"}, {Date: "2026-10-13", Done: true, CompletedAt: "2026-10-13T01:00:00Z"}}
	r := calculateStatisticsRange(tasks, f.server.now(), f.server.location, 2024)
	if len(r.Days) != 366 || r.Start != "2024-01-01" || r.End != "2024-12-31" || r.Days[59].Count != 1 || r.CompletedPlans != 3 || r.CurrentStreak != 2 || r.LongestStreak != 2 || len(r.Years) != 3 {
		t.Fatalf("year window must not limit headline metrics: %+v", r)
	}
	current := calculateStatisticsRange(tasks, f.server.now(), f.server.location, 2026)
	if current.Start != "2026-01-01" || current.End != "2026-10-13" || current.Days[0].Cumulative != 1 {
		t.Fatal("current year should end today and retain old cumulative totals")
	}
	f.setup(t)
	expect(t, f.send(t, "GET", "/api/statistics?year=2024", nil), 200)
	for _, year := range []string{"no", "0", "10000", "2027"} {
		expect(t, f.send(t, "GET", "/api/statistics?year="+year, nil), 400)
	}
}
