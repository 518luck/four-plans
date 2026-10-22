package app

import "time"

func calendarDate(timestamp string, location *time.Location) string {
	value, err := time.Parse(time.RFC3339Nano, timestamp)
	if err != nil {
		return ""
	}
	return value.In(location).Format("2006-01-02")
}

// projectTask applies one promotion step. Both the board and daily statistics
// use this placement so a week/month goal cannot skip directly into today.
// An empty placement means the task is outside the visible periods.
func projectTask(task Task, date string, bounds map[string]Period, location *time.Location) (Task, string) {
	createdDate := ""
	activeToday := false
	if task.Bucket == "week" || task.Bucket == "month" {
		createdDate = calendarDate(task.CreatedAt, location)
		activeToday = createdDate == date || calendarDate(task.UpdatedAt, location) == date
	}
	end := task.Date
	switch task.Bucket {
	case "today":
		if task.Date == date {
			return task, "today"
		}
	case "three":
		end = addDays(task.Date, 2)
		if date == end && !task.Done {
			task.Bucket, task.Date = "today", date
			return task, "today"
		}
		if (task.Date <= date && date <= end) || (task.Date >= bounds["three"].Start && task.Date <= bounds["three"].End) {
			return task, "three"
		}
	case "week":
		friday := addDays(task.Date, 4)
		end = addDays(task.Date, 6)
		if !task.Done && !activeToday && date >= friday && date <= end && (createdDate < friday || date > createdDate) {
			task.Bucket, task.Date = "three", friday
			return task, "three"
		}
		if (task.Date <= date && date <= end) || (task.Date >= bounds["week"].Start && task.Date <= bounds["week"].End) {
			return task, "week"
		}
	case "month":
		end = lastDayOfMonth(task.Date)
		if !task.Done && !activeToday && date >= addDays(end, -6) && date <= end {
			task.Bucket, task.Date = "week", bounds["week"].Start
			return task, "week"
		}
		if (task.Date <= date && date <= end) || (task.Date >= bounds["month"].Start && task.Date <= bounds["month"].End) {
			return task, "month"
		}
	}
	if date > end && !task.Done && task.RecurringID == "" {
		return task, "carryover"
	}
	return task, ""
}
