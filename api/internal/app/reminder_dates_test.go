package app

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func reminderDateNotifications(t *testing.T, f *fixture) *atomic.Int32 {
	t.Helper()
	received := new(atomic.Int32)
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		received.Add(1)
		_, _ = w.Write([]byte(`{"code":0}`))
	}))
	t.Cleanup(mock.Close)
	expect(t, f.send(t, "PUT", "/api/settings/reminder", map[string]any{
		"enabled": true, "webhookUrl": mock.URL,
	}), 200)
	return received
}

func TestPeriodTasksKeepSelectedReminderDate(t *testing.T) {
	for _, item := range []struct{ bucket, normalized string }{
		{"week", "2026-10-12"},
		{"month", "2026-10-01"},
	} {
		t.Run(item.bucket, func(t *testing.T) {
			f := newFixture(t)
			f.setup(t)
			received := reminderDateNotifications(t, f)
			r := f.send(t, "POST", "/api/tasks", map[string]any{
				"title": "周期中的提醒", "bucket": item.bucket,
				"date": "2026-10-13", "reminderTime": "09:10",
			})
			expect(t, r, 201)
			task := decode[Task](t, r)
			if task.Date != item.normalized || task.ReminderDate != "2026-10-13" {
				t.Fatalf("period normalization changed the selected reminder date: %+v", task)
			}
			if err := f.server.CheckAndSendReminders(t.Context()); err != nil {
				t.Fatal(err)
			}
			if received.Load() != 0 {
				t.Fatal("reminder must wait until its selected time")
			}
			f.server.now = func() time.Time {
				return time.Date(2026, 10, 13, 9, 10, 0, 0, f.server.location)
			}
			for attempt := 0; attempt < 2; attempt++ {
				if err := f.server.CheckAndSendReminders(t.Context()); err != nil {
					t.Fatal(err)
				}
			}
			if received.Load() != 1 {
				t.Fatalf("expected one reminder on the selected day, got %d", received.Load())
			}
		})
	}
}

func TestReminderAdvanceCanCrossBeijingMidnight(t *testing.T) {
	f := newFixture(t)
	f.setup(t)
	received := reminderDateNotifications(t, f)
	r := f.send(t, "POST", "/api/tasks", map[string]any{
		"title": "跨日提前提醒", "bucket": "today", "date": "2026-10-14",
		"reminderTime": "00:10", "reminderAdvance": 30,
	})
	expect(t, r, 201)
	f.server.now = func() time.Time {
		return time.Date(2026, 10, 13, 23, 39, 0, 0, f.server.location)
	}
	if err := f.server.CheckAndSendReminders(t.Context()); err != nil {
		t.Fatal(err)
	}
	if received.Load() != 0 {
		t.Fatal("reminder must not fire before 23:40")
	}
	f.server.now = func() time.Time {
		return time.Date(2026, 10, 13, 23, 40, 0, 0, f.server.location)
	}
	if err := f.server.CheckAndSendReminders(t.Context()); err != nil {
		t.Fatal(err)
	}
	if received.Load() != 1 {
		t.Fatalf("tomorrow's reminder must fire today at 23:40, got %d", received.Load())
	}
	f.server.now = func() time.Time {
		return time.Date(2026, 10, 14, 0, 10, 0, 0, f.server.location)
	}
	if err := f.server.CheckAndSendReminders(t.Context()); err != nil {
		t.Fatal(err)
	}
	if received.Load() != 1 {
		t.Fatal("crossing midnight must not send the same reminder again")
	}
}

func TestReminderDateEditsPreserveIndependentSchedule(t *testing.T) {
	f := newFixture(t)
	f.setup(t)
	r := f.send(t, "POST", "/api/tasks", map[string]any{
		"title": "独立提醒日期", "bucket": "week", "date": "2026-10-13",
		"reminderDate": "2026-10-15", "reminderTime": "09:00",
	})
	expect(t, r, 201)
	task := decode[Task](t, r)
	if task.ReminderDate != "2026-10-15" {
		t.Fatalf("explicit reminder date must override task date: %+v", task)
	}

	patch := func(change map[string]any) Task {
		t.Helper()
		change["version"] = task.Version
		r := f.send(t, "PATCH", "/api/tasks/"+task.ID, change)
		expect(t, r, 200)
		task = decode[Task](t, r)
		return task
	}
	patch(map[string]any{"notes": "只改备注", "date": task.Date})
	if task.ReminderDate != "2026-10-15" {
		t.Fatal("resubmitting the normalized task date must preserve the independent reminder date")
	}
	patch(map[string]any{"date": "2026-10-16"})
	if task.Date != "2026-10-12" || task.ReminderDate != "2026-10-16" {
		t.Fatalf("moving within a period must preserve the newly selected reminder day: %+v", task)
	}
	patch(map[string]any{"date": "2026-10-21", "reminderDate": "2026-10-20"})
	if task.Date != "2026-10-19" || task.ReminderDate != "2026-10-20" {
		t.Fatalf("explicit reminder date must override the rescheduled task date: %+v", task)
	}
	patch(map[string]any{"reminderTime": ""})
	if task.ReminderDate != "" || task.ReminderAdvance != 0 {
		t.Fatalf("disabling a reminder must clear its date and advance: %+v", task)
	}
}

func TestKeepingReminderDateDoesNotRearmWhenMovingTask(t *testing.T) {
	f := newFixture(t)
	f.setup(t)
	received := reminderDateNotifications(t, f)
	r := f.send(t, "POST", "/api/tasks", map[string]any{
		"title": "移动但保留提醒", "bucket": "week", "date": "2026-10-13",
		"reminderDate": "2026-10-15", "reminderTime": "09:00",
	})
	expect(t, r, 201)
	task := decode[Task](t, r)
	f.advance(2)
	if err := f.server.CheckAndSendReminders(t.Context()); err != nil {
		t.Fatal(err)
	}
	if received.Load() != 1 {
		t.Fatal("expected the original reminder to be sent")
	}
	r = f.send(t, "PATCH", "/api/tasks/"+task.ID, map[string]any{
		"version": task.Version, "bucket": "today", "date": "2026-10-15",
		"reminderDate": "2026-10-15", "priority": true,
	})
	expect(t, r, 200)
	task = decode[Task](t, r)
	if task.ReminderDate != "2026-10-15" || task.RemindedAt == "" {
		t.Fatalf("moving the task must retain the unchanged reminder's acknowledgement: %+v", task)
	}
	if err := f.server.CheckAndSendReminders(t.Context()); err != nil {
		t.Fatal(err)
	}
	if received.Load() != 1 {
		t.Fatal("moving a task without changing the reminder must not send it again")
	}
}

func TestInFlightReminderCannotAcknowledgeRescheduledTask(t *testing.T) {
	f := newFixture(t)
	f.setup(t)
	var received atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if received.Add(1) == 1 {
			close(started)
			<-release
		}
		_, _ = w.Write([]byte(`{"code":0}`))
	}))
	defer mock.Close()
	defer unblock()
	expect(t, f.send(t, "PUT", "/api/settings/reminder", map[string]any{
		"enabled": true, "webhookUrl": mock.URL,
	}), 200)
	r := f.send(t, "POST", "/api/tasks", map[string]any{
		"title": "发送期间改期", "bucket": "today", "date": "2026-10-13", "reminderTime": "09:00",
	})
	expect(t, r, 201)
	task := decode[Task](t, r)
	finished := make(chan error, 1)
	go func() { finished <- f.server.CheckAndSendReminders(t.Context()) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("initial notification did not reach the local webhook")
	}
	r = f.send(t, "PATCH", "/api/tasks/"+task.ID, map[string]any{
		"version": task.Version, "date": "2026-10-14",
	})
	expect(t, r, 200)
	unblock()
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("initial reminder did not finish")
	}
	stored, err := scanTask(f.server.db.QueryRow("SELECT "+taskColumns+" FROM tasks WHERE id=?", task.ID))
	if err != nil {
		t.Fatal(err)
	}
	if stored.ReminderDate != "2026-10-14" || stored.RemindedAt != "" {
		t.Fatalf("old notification marked the new schedule as already sent: %+v", stored)
	}
	// Change the clock only after the in-flight scheduler has finished reading it.
	f.advance(1)
	for attempt := 0; attempt < 2; attempt++ {
		if err := f.server.CheckAndSendReminders(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	if received.Load() != 2 {
		t.Fatalf("expected one reminder for each schedule, got %d", received.Load())
	}
}

func TestReminderDateMigrationFromVersionFive(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "reminder-v5.db")
	db, err := OpenStore(filename)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`
INSERT INTO users(id,username,password_hash,created_at) VALUES(1,'fixture','hash','2026-10-01T01:00:00Z');
INSERT INTO tasks(id,user_id,title,bucket,scheduled_date,version,created_at,updated_at,reminder_time,reminder_advance,reminded_at)
VALUES('pending',1,'待提醒','week','2026-10-12',3,'2026-10-01T01:00:00Z','2026-10-13T01:00:00Z','09:10',15,''),
      ('sent',1,'已提醒','month','2026-10-01',7,'2026-10-01T01:00:00Z','2026-10-13T01:00:00Z','09:20',30,'2026-10-01T01:00:00Z'),
      ('disabled',1,'无提醒','today','2026-10-13',2,'2026-10-01T01:00:00Z','2026-10-13T01:00:00Z','',0,'');
DROP INDEX IF EXISTS tasks_reminder_date;
ALTER TABLE tasks DROP COLUMN reminder_date;
PRAGMA user_version=5;
`)
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
		for _, item := range []struct {
			id, date, reminderDate, remindedAt string
			version, advance                   int
		}{
			{"pending", "2026-10-12", "2026-10-12", "", 3, 15},
			{"sent", "2026-10-01", "2026-10-01", "2026-10-01T01:00:00Z", 7, 30},
			{"disabled", "2026-10-13", "", "", 2, 0},
		} {
			task, err := scanTask(db.QueryRow("SELECT "+taskColumns+" FROM tasks WHERE id=?", item.id))
			if err != nil || task.Date != item.date || task.ReminderDate != item.reminderDate || task.RemindedAt != item.remindedAt || task.Version != item.version || task.ReminderAdvance != item.advance {
				db.Close()
				t.Fatalf("migration changed legacy reminder state: %+v err=%v", task, err)
			}
		}
		var version int
		if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 6 {
			db.Close()
			t.Fatalf("reminder-date migration version not persisted: %d err=%v", version, err)
		}
		db.Close()
	}
}
