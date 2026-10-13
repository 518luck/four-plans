package app

import (
	"database/sql"
	"errors"
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
}

type Period struct {
	Start string `json:"start"`
	End   string `json:"end"`
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

func validateTask(task *Task, location *time.Location) error {
	task.Title = strings.TrimSpace(task.Title)
	task.Notes = strings.TrimSpace(task.Notes)
	if task.Title == "" || utf8.RuneCountInString(task.Title) > 160 {
		return errors.New("计划标题需要 1–160 个字")
	}
	if utf8.RuneCountInString(task.Notes) > 1000 {
		return errors.New("备注最多 1000 个字")
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

const taskColumns = "id,title,notes,bucket,scheduled_date,done,priority,version,created_at,updated_at,COALESCE(deleted_at,''),COALESCE(completed_at,''),completion_date_estimated,recurring_id"

type scanner interface{ Scan(...any) error }

func scanTask(row scanner) (Task, error) {
	var task Task
	err := row.Scan(&task.ID, &task.Title, &task.Notes, &task.Bucket, &task.Date, &task.Done, &task.Priority, &task.Version, &task.CreatedAt, &task.UpdatedAt, &task.DeletedAt, &task.CompletedAt, &task.CompletionDateEstimated, &task.RecurringID)
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
