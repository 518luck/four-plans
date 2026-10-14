package app

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fixture struct {
	server  *Server
	handler http.Handler
	cookie  *http.Cookie
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	db, err := OpenStore(filepath.Join(t.TempDir(), "plans.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	server := NewServer(db, Config{})
	fixed := time.Date(2026, 10, 13, 9, 0, 0, 0, server.location)
	server.now = func() time.Time { return fixed }
	return &fixture{server: server, handler: server.Router()}
}
func (f *fixture) send(t *testing.T, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var encoded []byte
	if body != nil {
		var err error
		encoded, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, "http://example.test"+path, bytes.NewReader(encoded))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://example.test")
	if f.cookie != nil {
		req.AddCookie(f.cookie)
	}
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, req)
	return response
}
func expect(t *testing.T, response *httptest.ResponseRecorder, status int) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status=%d want %d; body=%s", response.Code, status, response.Body.String())
	}
}
func decode[T any](t *testing.T, response *httptest.ResponseRecorder) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	return value
}
func (f *fixture) setup(t *testing.T) {
	t.Helper()
	response := f.send(t, "POST", "/api/setup", credentials{Username: "测试空间", Password: "test-password-42"})
	expect(t, response, 201)
	cookies := response.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("expected a session cookie")
	}
	f.cookie = cookies[0]
}
func (f *fixture) create(t *testing.T, bucket, date, title string, priority bool) Task {
	t.Helper()
	response := f.send(t, "POST", "/api/tasks", map[string]any{"title": title, "bucket": bucket, "date": date, "priority": priority})
	expect(t, response, 201)
	return decode[Task](t, response)
}

type boardResponse struct {
	Date       string            `json:"date"`
	Periods    map[string]Period `json:"periods"`
	Buckets    map[string][]Task `json:"buckets"`
	Carryovers []Task            `json:"carryovers"`
	Trash      []Task            `json:"trash"`
	Statistics Statistics        `json:"statistics"`
}

func (f *fixture) board(t *testing.T, date string) boardResponse {
	t.Helper()
	response := f.send(t, "GET", "/api/board?date="+date, nil)
	expect(t, response, 200)
	return decode[boardResponse](t, response)
}

func TestAuthenticationAndSourceChecks(t *testing.T) {
	f := newFixture(t)
	expect(t, f.send(t, "GET", "/api/board", nil), 401)
	expect(t, f.send(t, "POST", "/api/setup", credentials{Username: "本人", Password: "short"}), 400)
	req := httptest.NewRequest("POST", "http://example.test/api/setup", strings.NewReader(`{"username":"本人","password":"password-42"}`))
	req.Header.Set("Origin", "https://different.test")
	req.Header.Set("Content-Type", "application/json")
	denied := httptest.NewRecorder()
	f.handler.ServeHTTP(denied, req)
	expect(t, denied, 403)
	f.setup(t)
	if !f.cookie.HttpOnly || f.cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("session cookie must be HttpOnly and SameSite Strict")
	}
	var stored string
	if err := f.server.db.QueryRow("SELECT token_hash FROM sessions").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == f.cookie.Value || stored != tokenHash(f.cookie.Value) {
		t.Fatal("session token must be stored hashed")
	}
	expect(t, f.send(t, "POST", "/api/setup", credentials{Username: "第二个", Password: "another-password"}), 409)
	expect(t, f.send(t, "POST", "/api/logout", nil), 204)
	expect(t, f.send(t, "GET", "/api/board", nil), 401)
	expect(t, f.send(t, "POST", "/api/login", credentials{Username: "测试空间", Password: "wrong-password"}), 401)
	response := f.send(t, "POST", "/api/login", credentials{Username: "测试空间", Password: "test-password-42"})
	expect(t, response, 200)
	f.cookie = response.Result().Cookies()[0]
	expect(t, f.send(t, "GET", "/api/board", nil), 200)
	loggedInAt := f.server.now()
	f.server.now = func() time.Time { return loggedInAt.Add(31 * 24 * time.Hour) }
	expect(t, f.send(t, "GET", "/api/board", nil), 401)
}

func TestPeriodsAndBeijingCalendar(t *testing.T) {
	f := newFixture(t)
	f.server.now = func() time.Time { return time.Date(2026, 12, 31, 16, 30, 0, 0, time.UTC) }
	f.setup(t)
	cases := []struct{ date, weekStart, weekEnd, monthEnd, threeEnd string }{
		{"2024-02-29", "2024-02-26", "2024-03-03", "2024-02-29", "2024-03-02"},
		{"2025-02-28", "2025-02-24", "2025-03-02", "2025-02-28", "2025-03-02"},
		{"2026-12-31", "2026-12-28", "2027-01-03", "2026-12-31", "2027-01-02"},
		{"2027-01-03", "2026-12-28", "2027-01-03", "2027-01-31", "2027-01-05"},
	}
	for _, item := range cases {
		t.Run(item.date, func(t *testing.T) {
			b := f.board(t, item.date)
			if b.Periods["week"].Start != item.weekStart || b.Periods["week"].End != item.weekEnd || b.Periods["month"].End != item.monthEnd || b.Periods["three"].End != item.threeEnd {
				t.Fatalf("unexpected bounds: %+v", b.Periods)
			}
		})
	}
	f.server.now = func() time.Time { return time.Date(2026, 12, 31, 16, 30, 0, 0, time.UTC) }
	response := f.send(t, "GET", "/api/board", nil)
	expect(t, response, 200)
	if decode[boardResponse](t, response).Date != "2027-01-01" {
		t.Fatal("default date must follow Beijing rather than UTC")
	}
	expect(t, f.send(t, "GET", "/api/board?date=2025-02-29", nil), 400)
}

func TestRollingWindowCarryoversAndMove(t *testing.T) {
	f := newFixture(t)
	f.setup(t)
	previous := f.create(t, "today", "2026-10-12", "昨天没做完的行动", false)
	soon := f.create(t, "three", "2026-10-15", "准备首页参考", false)
	f.create(t, "three", "2026-10-16", "更远的行动", false)
	week := f.create(t, "week", "2026-10-15", "完成首页", false)
	month := f.create(t, "month", "2026-10-29", "完成作品集", false)
	if week.Date != "2026-10-12" || month.Date != "2026-10-01" {
		t.Fatal("goals must normalize to calendar period start")
	}
	b := f.board(t, "2026-10-13")
	if len(b.Buckets["today"]) != 0 || len(b.Carryovers) != 1 || b.Carryovers[0].ID != previous.ID || len(b.Buckets["three"]) != 1 {
		t.Fatalf("carryover must remain unselected; board=%+v", b)
	}
	expect(t, f.send(t, "PATCH", "/api/tasks/"+soon.ID, map[string]any{"version": soon.Version, "bucket": "today", "date": "2026-10-13"}), 200)
	b = f.board(t, "2026-10-13")
	if len(b.Buckets["today"]) != 1 || len(b.Buckets["three"]) != 0 || len(b.Buckets["week"]) != 1 || len(b.Buckets["month"]) != 1 {
		t.Fatal("moving an action must not duplicate it or remove higher goals")
	}
	if len(f.board(t, "2026-10-14").Buckets["three"]) != 1 {
		t.Fatal("three-day window must roll forward")
	}
}

func TestAutoPromoteCascadingPipeline(t *testing.T) {
	f := newFixture(t)
	f.setup(t)

	// 1. 三天计划在第 2 天不应过期，在第 3 天应自动移入今天计划
	threeTask := f.create(t, "three", "2026-10-14", "工作：10 个智能体", false)

	// 10-15（第 2 天，已过 1 天）：仍在三天计划中，不能进入 carryovers
	b15 := f.board(t, "2026-10-15")
	if len(b15.Carryovers) != 0 {
		t.Fatalf("three-day task must not expire after 1 day: carryovers=%+v", b15.Carryovers)
	}
	if len(b15.Buckets["three"]) != 1 || b15.Buckets["three"][0].ID != threeTask.ID {
		t.Fatalf("three-day task must remain in three bucket on day 2: %+v", b15.Buckets["three"])
	}

	// 10-16（第 3 天，已过 2 天）：自动移入今天计划
	b16 := f.board(t, "2026-10-16")
	if len(b16.Buckets["today"]) != 1 || b16.Buckets["today"][0].ID != threeTask.ID {
		t.Fatalf("three-day task must promote to today on day 3: %+v", b16.Buckets["today"])
	}
	if len(b16.Buckets["three"]) != 0 {
		t.Fatalf("promoted task should leave three bucket: %+v", b16.Buckets["three"])
	}

	// 10-17（今天计划未完成，跨日后进入 carryovers）
	b17 := f.board(t, "2026-10-17")
	if len(b17.Carryovers) != 1 || b17.Carryovers[0].ID != threeTask.ID {
		t.Fatalf("uncompleted today task must enter carryovers: %+v", b17.Carryovers)
	}

	// 2. 周计划在已过 4 天（周五）应自动移入三天计划
	// 周一为 2026-10-12
	weekTask := f.create(t, "week", "2026-10-12", "周目标", false)
	// 周四 10-15（已过 3 天）：仍在周计划
	bThur := f.board(t, "2026-10-15")
	foundWeek := false
	for _, tsk := range bThur.Buckets["week"] {
		if tsk.ID == weekTask.ID {
			foundWeek = true
		}
	}
	if !foundWeek {
		t.Fatal("week task must stay in week on Thursday")
	}

	// 周五 10-16（已过 4 天）：自动移入三天计划
	bFri := f.board(t, "2026-10-16")
	foundInThree := false
	for _, tsk := range bFri.Buckets["three"] {
		if tsk.ID == weekTask.ID {
			foundInThree = true
		}
	}
	if !foundInThree {
		t.Fatal("week task must promote to three on Friday (after 4 days)")
	}

	// 3. 月计划在月末前 7 天（10-25）自动移入周计划
	monthTask := f.create(t, "month", "2026-10-01", "月度大目标", false)
	// 10-24（月末前 8 天）：仍在月计划
	b24 := f.board(t, "2026-10-24")
	foundInMonth := false
	for _, tsk := range b24.Buckets["month"] {
		if tsk.ID == monthTask.ID {
			foundInMonth = true
		}
	}
	if !foundInMonth {
		t.Fatal("month task must stay in month before the final 7 days")
	}

	// 10-25（月末前 7 天）：自动移入周计划
	b25 := f.board(t, "2026-10-25")
	foundInWeekPromoted := false
	for _, tsk := range b25.Buckets["week"] {
		if tsk.ID == monthTask.ID {
			foundInWeekPromoted = true
		}
	}
	if !foundInWeekPromoted {
		t.Fatal("month task must promote to week in final 7 days of the month")
	}
}

func TestFocusAndStaleWindowConflict(t *testing.T) {
	f := newFixture(t)
	f.setup(t)
	first := f.create(t, "today", "2026-10-13", "第一件事", true)
	second := f.create(t, "today", "2026-10-13", "第二件事", true)
	board := f.board(t, "2026-10-13")
	focuses := 0
	for _, task := range board.Buckets["today"] {
		if task.Priority {
			focuses++
			if task.ID != second.ID {
				t.Fatal("new focus must become the priority")
			}
		}
		if task.ID == first.ID && task.Version != 2 {
			t.Fatal("changing another task's focus must advance its version")
		}
	}
	if focuses != 1 {
		t.Fatal("a day must have only one focus")
	}
	expect(t, f.send(t, "PATCH", "/api/tasks/"+first.ID, map[string]any{"version": first.Version, "title": "旧窗口覆盖"}), 409)
	response := f.send(t, "PATCH", "/api/tasks/"+second.ID, map[string]any{"version": second.Version, "done": true})
	expect(t, response, 200)
	completed := decode[Task](t, response)
	if !completed.Done || completed.Priority {
		t.Fatal("completing the focus must remove its active priority")
	}
	expect(t, f.send(t, "PATCH", "/api/tasks/"+second.ID, map[string]any{"version": second.Version, "notes": "另一个旧窗口"}), 409)
	expect(t, f.send(t, "DELETE", "/api/tasks/"+second.ID, map[string]any{"version": second.Version}), 409)
	expect(t, f.send(t, "DELETE", "/api/tasks/"+second.ID, map[string]any{"version": completed.Version}), 204)
	export := f.send(t, "GET", "/api/export", nil)
	expect(t, export, 200)
	result := decode[struct {
		Tasks []Task `json:"tasks"`
	}](t, export)
	if len(result.Tasks) != 1 || result.Tasks[0].Title != "第一件事" {
		t.Fatal("stale updates and removed tasks must not enter exported data")
	}
}

func TestTrashRestoreAndPermanentDeletion(t *testing.T) {
	for _, bucket := range []string{"today", "three", "week", "month"} {
		for _, done := range []bool{false, true} {
			for _, date := range []string{"2026-10-13", "2026-09-01"} {
				t.Run(bucket+date+map[bool]string{false: "_pending", true: "_done"}[done], func(t *testing.T) {
					f := newFixture(t)
					f.setup(t)
					created := f.send(t, "POST", "/api/tasks", map[string]any{"title": "回收站计划", "notes": "保留备注\n第二行", "bucket": bucket, "date": date, "priority": bucket == "today"})
					expect(t, created, 201)
					task := decode[Task](t, created)
					if done {
						updated := f.send(t, "PATCH", "/api/tasks/"+task.ID, map[string]any{"version": task.Version, "done": true})
						expect(t, updated, 200)
						task = decode[Task](t, updated)
					}
					// Active plans cannot be restored or permanently deleted through trash routes.
					expect(t, f.send(t, "POST", "/api/trash/"+task.ID+"/restore", map[string]any{"version": task.Version}), 409)
					expect(t, f.send(t, "DELETE", "/api/trash/"+task.ID, map[string]any{"version": task.Version}), 409)
					expect(t, f.send(t, "DELETE", "/api/tasks/"+task.ID, map[string]any{"version": task.Version}), 204)
					b := f.board(t, "2026-10-13")
					if len(b.Trash) != 1 || len(b.Carryovers) != 0 || len(b.Buckets[bucket]) != 0 {
						t.Fatalf("deleted plan must appear only in trash: %+v", b)
					}
					removed := b.Trash[0]
					if removed.DeletedAt == "" || removed.Priority || removed.Version != task.Version+1 || removed.Notes != task.Notes || removed.Done != done || removed.Date != task.Date {
						t.Fatalf("trash must preserve plan content: %+v", removed)
					}
					exported := decode[struct {
						Tasks []Task `json:"tasks"`
					}](t, f.send(t, "GET", "/api/export", nil))
					if len(exported.Tasks) != 0 {
						t.Fatal("trash must be excluded from exports")
					}
					expect(t, f.send(t, "PATCH", "/api/tasks/"+task.ID, map[string]any{"version": removed.Version, "title": "不能编辑回收站计划"}), 404)
					expect(t, f.send(t, "POST", "/api/trash/"+task.ID+"/restore", map[string]any{"version": task.Version}), 409)
					expect(t, f.send(t, "POST", "/api/trash/"+task.ID+"/restore", map[string]any{"version": removed.Version}), 204)
					b = f.board(t, "2026-10-13")
					if len(b.Trash) != 0 || (date == "2026-09-01" && !done && len(b.Carryovers) != 1) {
						t.Fatalf("restored overdue pending plan must return to carryovers: %+v", b)
					}
					original := f.board(t, task.Date).Buckets[bucket]
					if len(original) != 1 || original[0].ID != task.ID || original[0].Notes != task.Notes || original[0].Done != done || original[0].Priority || original[0].Version != removed.Version+1 {
						t.Fatalf("restore must keep original period and completion: %+v", original)
					}
					// A stale window cannot purge the restored plan, or a later deletion of it.
					expect(t, f.send(t, "DELETE", "/api/trash/"+task.ID, map[string]any{"version": removed.Version}), 409)
					expect(t, f.send(t, "DELETE", "/api/tasks/"+task.ID, map[string]any{"version": original[0].Version}), 204)
					redeleted := f.board(t, "2026-10-13").Trash[0]
					expect(t, f.send(t, "DELETE", "/api/trash/"+task.ID, map[string]any{"version": removed.Version}), 409)
					expect(t, f.send(t, "DELETE", "/api/trash/"+task.ID, map[string]any{"version": redeleted.Version}), 204)
					var count int
					if err := f.server.db.QueryRow("SELECT COUNT(*) FROM tasks WHERE id=?", task.ID).Scan(&count); err != nil || count != 0 {
						t.Fatalf("permanent deletion must remove database row: count=%d err=%v", count, err)
					}
					expect(t, f.send(t, "POST", "/api/trash/"+task.ID+"/restore", map[string]any{"version": redeleted.Version}), 409)
					if len(f.board(t, "2026-10-13").Trash) != 0 {
						t.Fatal("purged plan must leave trash")
					}
				})
			}
		}
	}
}

func TestTrashAuthorizationAndFocusConflict(t *testing.T) {
	f := newFixture(t)
	for _, methodPath := range [][2]string{{"POST", "/api/trash/missing/restore"}, {"DELETE", "/api/trash/missing"}} {
		expect(t, f.send(t, methodPath[0], methodPath[1], map[string]any{"version": 1}), 401)
	}
	f.setup(t)
	first := f.create(t, "today", "2026-10-13", "原优先计划", true)
	expect(t, f.send(t, "DELETE", "/api/tasks/"+first.ID, map[string]any{"version": first.Version}), 204)
	second := f.create(t, "today", "2026-10-13", "新的优先计划", true)
	removed := f.board(t, "2026-10-13").Trash[0]
	for _, route := range [][2]string{{"POST", "/api/trash/" + first.ID + "/restore"}, {"DELETE", "/api/trash/" + first.ID}} {
		expect(t, f.send(t, route[0], route[1], map[string]any{}), 400)
		req := httptest.NewRequest(route[0], "http://example.test"+route[1], strings.NewReader(`{"version":2}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "https://different.test")
		req.AddCookie(f.cookie)
		denied := httptest.NewRecorder()
		f.handler.ServeHTTP(denied, req)
		expect(t, denied, 403)
	}
	expect(t, f.send(t, "POST", "/api/trash/"+first.ID+"/restore", map[string]any{"version": removed.Version}), 204)
	b := f.board(t, "2026-10-13")
	if len(b.Buckets["today"]) != 2 || !b.Buckets["today"][0].Priority || b.Buckets["today"][0].ID != second.ID {
		t.Fatalf("restoring previous focus must preserve current focus: %+v", b)
	}
}

func TestMoveBetweenEveryBucketPreservesTask(t *testing.T) {
	f := newFixture(t)
	f.setup(t)
	buckets := []string{"today", "three", "week", "month"}
	wantDates := map[string]string{"today": "2026-10-13", "three": "2026-10-14", "week": "2026-10-12", "month": "2026-10-01"}
	created := 0
	for _, source := range buckets {
		for _, target := range buckets {
			if source == target {
				continue
			}
			for _, done := range []bool{false, true} {
				t.Run(source+"_to_"+target+map[bool]string{false: "_pending", true: "_done"}[done], func(t *testing.T) {
					response := f.send(t, "POST", "/api/tasks", map[string]any{"title": "可自由移动的计划", "notes": "移动时保留这段备注", "bucket": source, "date": "2026-10-13", "priority": source == "today"})
					expect(t, response, 201)
					task := decode[Task](t, response)
					created++
					if done {
						response = f.send(t, "PATCH", "/api/tasks/"+task.ID, map[string]any{"version": task.Version, "done": true})
						expect(t, response, 200)
						task = decode[Task](t, response)
					}
					date := "2026-10-13"
					if target == "three" {
						date = "2026-10-14"
					}
					response = f.send(t, "PATCH", "/api/tasks/"+task.ID, map[string]any{"version": task.Version, "bucket": target, "date": date, "priority": false})
					expect(t, response, 200)
					moved := decode[Task](t, response)
					if moved.ID != task.ID || moved.Title != task.Title || moved.Notes != task.Notes || moved.Done != done || moved.CreatedAt != task.CreatedAt || moved.Priority || moved.Date != wantDates[target] || moved.Version != task.Version+1 {
						t.Fatalf("move changed task content or used the wrong period: %+v", moved)
					}
					board := f.board(t, "2026-10-13")
					found := 0
					for bucket, tasks := range board.Buckets {
						for _, item := range tasks {
							if item.ID == task.ID {
								found++
								if bucket != target {
									t.Fatal("moved task remained in the source bucket")
								}
							}
						}
					}
					if found != 1 {
						t.Fatal("moving must keep exactly one task on the board")
					}
					expect(t, f.send(t, "PATCH", "/api/tasks/"+task.ID, map[string]any{"version": task.Version, "bucket": source}), 409)
				})
			}
		}
	}
	response := f.send(t, "GET", "/api/export", nil)
	expect(t, response, 200)
	result := decode[struct {
		Tasks []Task `json:"tasks"`
	}](t, response)
	if len(result.Tasks) != created {
		t.Fatal("moving must not create copies in persisted data")
	}
}

func TestValidationAndRateLimit(t *testing.T) {
	f := newFixture(t)
	f.setup(t)
	for _, input := range []map[string]any{
		{"title": " ", "bucket": "today", "date": "2026-10-13"},
		{"title": "标题", "bucket": "unknown", "date": "2026-10-13"},
		{"title": "标题", "bucket": "today", "date": "2026-02-30"},
		{"title": strings.Repeat("字", 161), "bucket": "today", "date": "2026-10-13"},
		{"title": "标题", "bucket": "today", "date": "2026-10-13", "extra": true},
	} {
		expect(t, f.send(t, "POST", "/api/tasks", input), 400)
	}
	for i := 0; i < 10; i++ {
		expect(t, f.send(t, "POST", "/api/login", credentials{Username: "测试空间", Password: "incorrect"}), 401)
	}
	expect(t, f.send(t, "POST", "/api/login", credentials{Username: "测试空间", Password: "test-password-42"}), 429)
	previous := f.server.now()
	f.server.now = func() time.Time { return previous.Add(16 * time.Minute) }
	expect(t, f.send(t, "POST", "/api/login", credentials{Username: "测试空间", Password: "test-password-42"}), 200)
}

func TestDatabaseSurvivesRestart(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "persistent.db")
	db, err := OpenStore(filename)
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{server: NewServer(db, Config{})}
	f.handler = f.server.Router()
	f.setup(t)
	task := f.create(t, "today", "2026-10-13", "重启后也要保留", false)
	removed := f.create(t, "month", "2026-10-13", "重启后可恢复", false)
	expect(t, f.send(t, "DELETE", "/api/tasks/"+removed.ID, map[string]any{"version": removed.Version}), 204)
	purged := f.create(t, "three", "2026-10-14", "永久删除后不回来", false)
	expect(t, f.send(t, "DELETE", "/api/tasks/"+purged.ID, map[string]any{"version": purged.Version}), 204)
	expect(t, f.send(t, "DELETE", "/api/trash/"+purged.ID, map[string]any{"version": purged.Version + 1}), 204)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(filename)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	f.server = NewServer(reopened, Config{})
	f.handler = f.server.Router()
	b := f.board(t, "2026-10-13")
	if len(b.Buckets["today"]) != 1 || b.Buckets["today"][0].ID != task.ID {
		t.Fatal("tasks and sessions must survive server restart")
	}
	var deleted sql.NullString
	if err := reopened.QueryRow("SELECT deleted_at FROM tasks WHERE id=?", task.ID).Scan(&deleted); err != nil || deleted.Valid {
		t.Fatal("new task should remain active")
	}
	if len(b.Trash) != 1 || b.Trash[0].ID != removed.ID || b.Trash[0].DeletedAt == "" {
		t.Fatal("trash must survive restart, while permanently deleted plans must remain absent")
	}
	expect(t, f.send(t, "POST", "/api/trash/"+removed.ID+"/restore", map[string]any{"version": b.Trash[0].Version}), 204)
	if len(f.board(t, "2026-10-13").Buckets["month"]) != 1 {
		t.Fatal("trashed plans must be restorable after restart")
	}
}

func TestIndependentDevicesSharePlans(t *testing.T) {
	first := newFixture(t)
	first.setup(t)
	second := &fixture{server: first.server, handler: first.handler}
	login := second.send(t, "POST", "/api/login", credentials{Username: "测试空间", Password: "test-password-42"})
	expect(t, login, 200)
	second.cookie = login.Result().Cookies()[0]
	if first.cookie.Value == second.cookie.Value {
		t.Fatal("devices must have independent sessions")
	}
	task := first.create(t, "today", "2026-10-13", "在另一台设备上继续", false)
	otherBoard := second.board(t, "2026-10-13")
	if len(otherBoard.Buckets["today"]) != 1 || otherBoard.Buckets["today"][0].ID != task.ID {
		t.Fatal("another device must read the shared plan")
	}
	expect(t, second.send(t, "PATCH", "/api/tasks/"+task.ID, map[string]any{"version": task.Version, "done": true}), 200)
	expect(t, first.send(t, "PATCH", "/api/tasks/"+task.ID, map[string]any{"version": task.Version, "title": "较旧的编辑"}), 409)
	updated := first.board(t, "2026-10-13").Buckets["today"][0]
	if !updated.Done || updated.Version != task.Version+1 || updated.Title != task.Title {
		t.Fatal("refresh must preserve the latest update from the other device")
	}
}
