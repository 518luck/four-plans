package app

import (
	"slices"
	"testing"
	"time"
)

func TestProjectionUsesBeijingOperationDate(t *testing.T) {
	location, _ := time.LoadLocation("Asia/Shanghai")
	for _, bucket := range []string{"week", "month"} {
		date, scheduled := "2026-10-18", "2026-10-12"
		if bucket == "month" {
			date, scheduled = "2026-10-31", "2026-10-01"
		}
		bounds, _ := periods(date, location)
		day, _ := time.ParseInLocation("2006-01-02", date, location)
		for _, hour := range []int{0, 1, 7, 8, 23} {
			for _, operation := range []string{"create", "move"} {
				task := Task{Bucket: bucket, Date: scheduled, CreatedAt: "2026-10-01T01:00:00Z", UpdatedAt: stamp(day.Add(time.Duration(hour) * time.Hour))}
				if operation == "create" {
					task.CreatedAt = task.UpdatedAt
				}
				_, placement := projectTask(task, date, bounds, location)
				if placement != bucket {
					t.Fatalf("%s %s at Beijing %02d:00 moved to %s", operation, bucket, hour, placement)
				}
			}
		}
	}
}

func TestExplicitWeekAndMonthMoveAtBeijingMidnight(t *testing.T) {
	for _, item := range []struct{ bucket, date string }{{"week", "2026-10-18"}, {"month", "2026-10-31"}} {
		t.Run(item.bucket, func(t *testing.T) {
			f := newFixture(t)
			f.setup(t)
			task := f.create(t, "today", item.date, "凌晨主动移动", false)
			day, _ := time.ParseInLocation("2006-01-02", item.date, f.server.location)
			f.server.now = func() time.Time { return day.Add(time.Hour) }
			r := f.send(t, "PATCH", "/api/tasks/"+task.ID, map[string]any{"version": task.Version, "bucket": item.bucket, "date": item.date})
			expect(t, r, 200)
			b := f.board(t, item.date)
			if len(b.Buckets[item.bucket]) != 1 || b.Buckets[item.bucket][0].ID != task.ID {
				t.Fatalf("explicit move must survive refresh: %+v", b.Buckets)
			}
		})
	}
}

func TestDayDetailMatchesBoardPromotion(t *testing.T) {
	for _, date := range []string{"2026-10-16", "2026-10-18", "2026-10-25", "2026-10-31"} {
		t.Run(date, func(t *testing.T) {
			f := newFixture(t)
			f.setup(t)
			f.create(t, "today", date, "今天行动", false)
			f.create(t, "three", addDays(date, -2), "三天收尾", false)
			f.create(t, "week", date, "本周目标", false)
			f.create(t, "month", date, "本月目标", false)
			day, _ := time.ParseInLocation("2006-01-02", date, f.server.location)
			f.server.now = func() time.Time { return day.Add(9 * time.Hour) }
			b := f.board(t, date)
			r := f.send(t, "GET", "/api/statistics/day?date="+date, nil)
			expect(t, r, 200)
			detail := decode[DayDetail](t, r)
			var want, got []string
			for _, task := range b.Buckets["today"] {
				want = append(want, task.ID)
			}
			for _, task := range detail.Uncompleted {
				got = append(got, task.ID)
				if task.Bucket != "today" || task.Date != date {
					t.Fatalf("incorrect daily projection: %+v", task)
				}
			}
			slices.Sort(want)
			slices.Sort(got)
			if !slices.Equal(got, want) || detail.Total != len(want) {
				t.Fatalf("board and day detail disagree: today=%v detail=%+v", want, detail)
			}
		})
	}
}

func TestDayDetailKeepsCompletedTaskBucketAndHistoricalCompletion(t *testing.T) {
	location, _ := time.LoadLocation("Asia/Shanghai")
	completed := Task{ID: "week", Bucket: "week", Date: "2026-10-12", Done: true, CompletedAt: "2026-10-18T01:00:00Z"}
	detail := calculateDayDetail([]Task{completed}, "2026-10-18", location)
	if len(detail.Completed) != 1 || detail.Completed[0].Bucket != "week" {
		t.Fatalf("completed goals must keep their original bucket: %+v", detail)
	}
	completed = Task{ID: "three", Bucket: "three", Date: "2026-10-16", Done: true, CompletedAt: "2026-10-19T01:00:00Z"}
	detail = calculateDayDetail([]Task{completed}, "2026-10-18", location)
	if len(detail.Uncompleted) != 1 || detail.Uncompleted[0].Bucket != "today" {
		t.Fatalf("later completion must remain unfinished in historical detail: %+v", detail)
	}
}
