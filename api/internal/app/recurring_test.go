package app

import (
	"context"
	"sync"
	"testing"
	"time"
)

func (f *fixture) recurring(t *testing.T, start, end string) RecurringPlan {
	t.Helper()
	r := f.send(t, "POST", "/api/recurring", map[string]any{"title": "每天读书", "notes": "30分钟", "start": start, "end": end})
	expect(t, r, 201)
	return decode[RecurringPlan](t, r)
}
func (f *fixture) advance(days int) {
	now := f.server.now()
	f.server.now = func() time.Time { return now.AddDate(0, 0, days) }
}
func TestRecurringDailyHistoryAndStatistics(t *testing.T) {
	f := newFixture(t)
	f.setup(t)
	p := f.recurring(t, "2026-10-13", "2026-10-16")
	b := f.board(t, "2026-10-13")
	if len(b.Buckets["today"]) != 1 || b.Statistics.TotalPlans != 1 {
		t.Fatal("only arrived dates count")
	}
	first := b.Buckets["today"][0]
	if first.RecurringID != p.ID {
		t.Fatal("missing goal association")
	}
	r := f.send(t, "PATCH", "/api/tasks/"+first.ID, map[string]any{"version": first.Version, "done": true})
	expect(t, r, 200)
	f.advance(3)
	b = f.board(t, "2026-10-16")
	if len(b.Buckets["today"]) != 1 || len(b.Carryovers) != 0 || b.Statistics.TotalPlans != 4 || b.Statistics.CompletedPlans != 1 || b.Statistics.CompletionRate != 25 {
		t.Fatalf("daily completion or catch-up incorrect: %+v", b)
	}
	missed := f.board(t, "2026-10-14")
	if len(missed.Buckets["today"]) != 1 || missed.Buckets["today"][0].Done {
		t.Fatal("missed days remain independent pending records")
	}
	f.advance(3)
	b = f.board(t, "2026-10-19")
	if len(b.Buckets["today"]) != 0 || b.Statistics.TotalPlans != 4 {
		t.Fatal("inclusive deadline must stop generation")
	}
	// Reading a future board must not create future instances or inflate statistics.
	f.recurring(t, "2026-10-21", "2026-10-25")
	if f.board(t, "2026-10-24").Statistics.TotalPlans != 4 {
		t.Fatal("future viewing generated tasks")
	}
}
func TestRecurringRevisionsPauseStopAndConflict(t *testing.T) {
	f := newFixture(t)
	f.setup(t)
	p := f.recurring(t, "2026-10-13", "2026-10-30")
	f.advance(2)
	r := f.send(t, "PATCH", "/api/recurring/"+p.ID, map[string]any{"version": p.Version, "title": "每天写作"})
	expect(t, r, 200)
	oldVersion := p.Version
	p = decode[RecurringPlan](t, r)
	expect(t, f.send(t, "PATCH", "/api/recurring/"+p.ID, map[string]any{"version": oldVersion, "status": "paused"}), 409)
	if f.board(t, "2026-10-15").Buckets["today"][0].Title != "每天读书" {
		t.Fatal("revision rewrote today's instance")
	}
	f.advance(1)
	if f.board(t, "2026-10-16").Buckets["today"][0].Title != "每天写作" {
		t.Fatal("next-day revision did not take effect")
	}
	r = f.send(t, "PATCH", "/api/recurring/"+p.ID, map[string]any{"version": p.Version, "status": "paused"})
	expect(t, r, 200)
	p = decode[RecurringPlan](t, r)
	f.advance(3)
	if b := f.board(t, "2026-10-19"); len(b.Buckets["today"]) != 0 || b.Statistics.TotalPlans != 4 {
		t.Fatal("paused dates should not generate, history should remain")
	}
	r = f.send(t, "PATCH", "/api/recurring/"+p.ID, map[string]any{"version": p.Version, "status": "active"})
	expect(t, r, 200)
	p = decode[RecurringPlan](t, r)
	if len(f.board(t, "2026-10-19").Buckets["today"]) != 0 {
		t.Fatal("resuming must start tomorrow")
	}
	f.advance(1)
	if len(f.board(t, "2026-10-20").Buckets["today"]) != 1 {
		t.Fatal("resume missing")
	}
	r = f.send(t, "PATCH", "/api/recurring/"+p.ID, map[string]any{"version": p.Version, "status": "stopped"})
	expect(t, r, 200)
	p = decode[RecurringPlan](t, r)
	f.advance(2)
	if f.board(t, "2026-10-22").Statistics.TotalPlans != 5 {
		t.Fatal("stopping erased history or generated more")
	}
	expect(t, f.send(t, "PATCH", "/api/recurring/"+p.ID, map[string]any{"version": p.Version, "status": "active"}), 409)
}
func TestRecurringDeletionNeverRegeneratesAndConcurrentReads(t *testing.T) {
	f := newFixture(t)
	f.setup(t)
	f.recurring(t, "2026-10-13", "2026-10-20")
	task := f.board(t, "2026-10-13").Buckets["today"][0]
	expect(t, f.send(t, "DELETE", "/api/tasks/"+task.ID, map[string]any{"version": task.Version}), 204)
	b := f.board(t, "2026-10-13")
	if len(b.Buckets["today"]) != 0 || len(b.Trash) != 1 {
		t.Fatal("soft delete regenerated task")
	}
	expect(t, f.send(t, "POST", "/api/trash/"+task.ID+"/restore", map[string]any{"version": b.Trash[0].Version}), 204)
	task = f.board(t, "2026-10-13").Buckets["today"][0]
	expect(t, f.send(t, "DELETE", "/api/tasks/"+task.ID, map[string]any{"version": task.Version}), 204)
	b = f.board(t, "2026-10-13")
	expect(t, f.send(t, "DELETE", "/api/trash/"+task.ID, map[string]any{"version": b.Trash[0].Version}), 204)
	// Force a rescan to exercise durable occurrence tombstones independently of cursor optimization.
	if _, err := f.server.db.Exec("UPDATE recurring_plans SET generated_until='' "); err != nil {
		t.Fatal(err)
	}
	if len(f.board(t, "2026-10-13").Buckets["today"]) != 0 {
		t.Fatal("hard-deleted occurrence resurrected")
	}
	f.advance(2)
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- f.server.generateRecurring(context.Background()) }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if f.board(t, "2026-10-15").Statistics.TotalPlans != 2 {
		t.Fatal("concurrent refresh duplicated occurrences")
	}
}
func TestRecurringAuthenticationAndValidation(t *testing.T) {
	f := newFixture(t)
	for _, path := range []string{"/api/recurring", "/api/statistics?year=2024", "/api/quote"} {
		expect(t, f.send(t, "GET", path, nil), 401)
	}
	expect(t, f.send(t, "POST", "/api/recurring", map[string]any{}), 401)
	f.setup(t)
	for _, data := range []map[string]any{{"title": "x", "start": "2026-10-12", "end": "2026-10-30"}, {"title": "x", "start": "2026-10-13", "end": "2026-02-30"}, {"title": "x", "start": "2026-10-15", "end": "2026-10-14"}, {"title": " ", "start": "2026-10-13", "end": "2026-10-30"}} {
		expect(t, f.send(t, "POST", "/api/recurring", data), 400)
	}
	p := f.recurring(t, "2026-10-13", "2026-10-20")
	expect(t, f.send(t, "PATCH", "/api/recurring/"+p.ID, map[string]any{"version": p.Version, "end": "2026-10-13"}), 400)
}

func TestRecurringSurvivesRestartWithMissedRevisions(t *testing.T) {
	f := newFixture(t)
	f.setup(t)
	p := f.recurring(t, "2026-10-13", "2026-10-30")
	r := f.send(t, "PATCH", "/api/recurring/"+p.ID, map[string]any{"version": p.Version, "title": "更新后的目标"})
	expect(t, r, 200)
	// Close and reopen SQLite to verify persisted rules and cursors across a restart.
	var sequence int
	var name, filename string
	if err := f.server.db.QueryRow("PRAGMA database_list").Scan(&sequence, &name, &filename); err != nil {
		t.Fatal(err)
	}
	if err := f.server.db.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(filename)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { reopened.Close() })
	now := f.server.now().AddDate(0, 0, 3)
	restarted := NewServer(reopened, Config{})
	restarted.now = func() time.Time { return now }
	f.server = restarted
	f.handler = restarted.Router()
	b := f.board(t, "2026-10-16")
	if b.Statistics.TotalPlans != 4 || b.Buckets["today"][0].Title != "更新后的目标" || f.board(t, "2026-10-13").Buckets["today"][0].Title != "每天读书" {
		t.Fatal("restart must catch up using persisted revisions without rewriting history")
	}
}
