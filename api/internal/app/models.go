package app

import (
	"database/sql"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

type Task struct {
	RecurringID             string `json:"recurringId,omitempty"`
	ID                      string `json:"id"`
	Title                   string `json:"title"`
	Notes                   string `json:"notes"`
	Bucket                  string `json:"bucket"`
	Date                    string `json:"date"`
	Done                    bool   `json:"done"`
	Priority                bool   `json:"priority"`
	Version                 int    `json:"version"`
	CreatedAt               string `json:"createdAt"`
	UpdatedAt               string `json:"updatedAt"`
	DeletedAt               string `json:"deletedAt,omitempty"`
	CompletedAt             string `json:"completedAt,omitempty"`
	CompletionDateEstimated bool   `json:"completionDateEstimated,omitempty"`
	ReminderTime            string `json:"reminderTime,omitempty"`
	ReminderAdvance         int    `json:"reminderAdvance"`
	RemindedAt              string `json:"remindedAt,omitempty"`
	CancelledAt             string `json:"cancelledAt,omitempty"`
}

type ReminderSettings struct {
	Enabled        bool   `json:"enabled"`
	WebhookURL     string `json:"webhookUrl"`
	WebhookSecret  string `json:"webhookSecret,omitempty"`
	DefaultAdvance int    `json:"defaultAdvance"`
}

type Period struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

func addDays(date string, days int) string {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return date
	}
	return t.AddDate(0, 0, days).Format("2006-01-02")
}

func lastDayOfMonth(date string) string {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return date
	}
	first := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
	return first.AddDate(0, 1, -1).Format("2006-01-02")
}

func periods(date string, location *time.Location) (map[string]Period, error) {
	day, err := time.ParseInLocation("2006-01-02", date, location)
	if err != nil || day.Format("2006-01-02") != date {
		return nil, errors.New("请选择有效的日期")
	}
	monday := day.AddDate(0, 0, -(int(day.Weekday())+6)%7)
	month := time.Date(day.Year(), day.Month(), 1, 0, 0, 0, 0, location)
	format := func(t time.Time) string { return t.Format("2006-01-02") }
	return map[string]Period{
		"today": {date, date}, "three": {date, format(day.AddDate(0, 0, 2))},
		"week":  {format(monday), format(monday.AddDate(0, 0, 6))},
		"month": {format(month), format(month.AddDate(0, 1, -1))},
	}, nil
}

var timeRegex = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)

func validateTask(task *Task, location *time.Location) error {
	task.Title = strings.TrimSpace(task.Title)
	task.Notes = strings.TrimSpace(task.Notes)
	task.ReminderTime = strings.TrimSpace(task.ReminderTime)
	if task.Title == "" || utf8.RuneCountInString(task.Title) > 160 {
		return errors.New("计划标题需要 1–160 个字")
	}
	if utf8.RuneCountInString(task.Notes) > 1000 {
		return errors.New("备注最多 1000 个字")
	}
	if task.ReminderTime != "" {
		if !timeRegex.MatchString(task.ReminderTime) {
			return errors.New("提醒时间格式无效，请输入 HH:mm")
		}
		if task.ReminderAdvance < 0 || task.ReminderAdvance > 120 {
			return errors.New("提醒提前时间无效")
		}
	} else {
		task.ReminderAdvance = 0
	}
	ranges, err := periods(task.Date, location)
	if err != nil {
		return err
	}
	period, exists := ranges[task.Bucket]
	if !exists {
		return errors.New("计划类型无效")
	}
	if task.Bucket == "week" || task.Bucket == "month" {
		task.Date = period.Start
	}
	if task.Bucket != "today" || task.Done {
		task.Priority = false
	}
	return nil
}

const taskColumns = "id,title,notes,bucket,scheduled_date,done,priority,version,created_at,updated_at,COALESCE(deleted_at,''),COALESCE(completed_at,''),completion_date_estimated,recurring_id,COALESCE(reminder_time,''),COALESCE(reminder_advance,0),COALESCE(reminded_at,''),COALESCE(cancelled_at,'')"

type scanner interface{ Scan(...any) error }

func scanTask(row scanner) (Task, error) {
	var task Task
	err := row.Scan(&task.ID, &task.Title, &task.Notes, &task.Bucket, &task.Date, &task.Done, &task.Priority, &task.Version, &task.CreatedAt, &task.UpdatedAt, &task.DeletedAt, &task.CompletedAt, &task.CompletionDateEstimated, &task.RecurringID, &task.ReminderTime, &task.ReminderAdvance, &task.RemindedAt, &task.CancelledAt)
	return task, err
}

func readTasks(rows *sql.Rows) ([]Task, error) {
	defer rows.Close()
	tasks := make([]Task, 0)
	for rows.Next() {
		task, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}
