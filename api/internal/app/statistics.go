package app

import (
	"github.com/gin-gonic/gin"
	"math"
	"sort"
	"strconv"
	"time"
)

type ActivityDay struct {
	Date       string `json:"date"`
	Count      int    `json:"count"`
	Cumulative int    `json:"cumulative"`
}

type Statistics struct {
	TotalPlans           int           `json:"totalPlans"`
	CompletedPlans       int           `json:"completedPlans"`
	CompletionRate       int           `json:"completionRate"`
	LongestStreak        int           `json:"longestStreak"`
	CurrentStreak        int           `json:"currentStreak"`
	EstimatedCompletions int           `json:"estimatedCompletions"`
	Start                string        `json:"start"`
	End                  string        `json:"end"`
	Years                []int         `json:"years"`
	Days                 []ActivityDay `json:"days"`
}

func calculateStatistics(tasks []Task, now time.Time, location *time.Location) Statistics {
	return calculateStatisticsRange(tasks, now, location, 0)
}

func calculateStatisticsRange(tasks []Task, now time.Time, location *time.Location, year int) Statistics {
	end, _ := time.ParseInLocation("2006-01-02", now.In(location).Format("2006-01-02"), location)
	actualToday := end
	start := end.AddDate(0, 0, -364)
	if year > 0 {
		start = time.Date(year, 1, 1, 0, 0, 0, 0, location)
		end = time.Date(year, 12, 31, 0, 0, 0, 0, location)
		if end.After(actualToday) {
			end = actualToday
		}
	}
	earliestYear := actualToday.Year()
	result := Statistics{Start: start.Format("2006-01-02"), End: end.Format("2006-01-02"), Days: make([]ActivityDay, 0, 365)}
	counts := map[string]int{}
	for _, task := range tasks {
		if task.DeletedAt != "" {
			continue
		}
		result.TotalPlans++
		if date, err := time.ParseInLocation("2006-01-02", task.Date, location); err == nil && date.Year() < earliestYear {
			earliestYear = date.Year()
		}
		if !task.Done {
			continue
		}
		result.CompletedPlans++
		if task.CompletionDateEstimated {
			result.EstimatedCompletions++
		}
		completed, err := time.Parse(time.RFC3339Nano, task.CompletedAt)
		if err != nil {
			continue
		}
		date := completed.In(location).Format("2006-01-02")
		if date <= actualToday.Format("2006-01-02") {
			if completed.In(location).Year() < earliestYear {
				earliestYear = completed.In(location).Year()
			}
			counts[date]++
		}
	}
	if result.TotalPlans > 0 {
		result.CompletionRate = int(math.Round(float64(result.CompletedPlans) * 100 / float64(result.TotalPlans)))
	}
	dates := make([]string, 0, len(counts))
	cumulative := 0
	for date, count := range counts {
		dates = append(dates, date)
		if date < result.Start {
			cumulative += count
		}
	}
	sort.Strings(dates)
	run := 0
	previous := ""
	for _, date := range dates {
		day, _ := time.ParseInLocation("2006-01-02", date, location)
		if previous == day.AddDate(0, 0, -1).Format("2006-01-02") {
			run++
		} else {
			run = 1
		}
		if run > result.LongestStreak {
			result.LongestStreak = run
		}
		previous = date
	}
	cursor := actualToday
	if counts[actualToday.Format("2006-01-02")] == 0 {
		cursor = cursor.AddDate(0, 0, -1)
	}
	for counts[cursor.Format("2006-01-02")] > 0 {
		result.CurrentStreak++
		cursor = cursor.AddDate(0, 0, -1)
	}
	for day := start; !day.After(end); day = day.AddDate(0, 0, 1) {
		date := day.Format("2006-01-02")
		cumulative += counts[date]
		result.Days = append(result.Days, ActivityDay{Date: date, Count: counts[date], Cumulative: cumulative})
	}
	for y := actualToday.Year(); y >= earliestYear; y-- {
		result.Years = append(result.Years, y)
	}
	return result
}

func (s *Server) statistics(c *gin.Context) {
	year := 0
	if value := c.Query("year"); value != "" {
		var err error
		year, err = strconv.Atoi(value)
		if err != nil || year < 1 || year > s.now().In(s.location).Year() {
			fail(c, 400, "请选择有效年份", "invalid")
			return
		}
	}
	if err := s.generateRecurring(c.Request.Context()); err != nil {
		s.internal(c, err)
		return
	}
	rows, err := s.db.QueryContext(c.Request.Context(), "SELECT "+taskColumns+" FROM tasks WHERE user_id=1")
	if err != nil {
		s.internal(c, err)
		return
	}
	tasks, err := readTasks(rows)
	if err != nil {
		s.internal(c, err)
		return
	}
	c.JSON(200, calculateStatisticsRange(tasks, s.now(), s.location, year))
}

type DayDetail struct {
	Date        string `json:"date"`
	Completed   []Task `json:"completed"`
	Uncompleted []Task `json:"uncompleted"`
	Total       int    `json:"total"`
	Rate        int    `json:"rate"`
}

func calculateDayDetail(tasks []Task, date string, location *time.Location) DayDetail {
	result := DayDetail{
		Date:        date,
		Completed:   make([]Task, 0),
		Uncompleted: make([]Task, 0),
	}

	for _, task := range tasks {
		if task.DeletedAt != "" {
			continue
		}

		var compDate string
		if task.Done {
			if task.CompletedAt != "" {
				if t, err := time.Parse(time.RFC3339Nano, task.CompletedAt); err == nil {
					compDate = t.In(location).Format("2006-01-02")
				}
			}
			if compDate == "" {
				compDate = task.Date
			}
		}

		if task.Done && compDate == date {
			finalTask := task
			if (task.Bucket == "three" && date == addDays(task.Date, 2)) ||
				(task.Bucket == "week" && date == addDays(task.Date, 6)) ||
				(task.Bucket == "month" && date == lastDayOfMonth(task.Date)) {
				finalTask.Bucket = "today"
				finalTask.Date = date
			}
			result.Completed = append(result.Completed, finalTask)
			continue
		}

		if !task.Done || (task.Done && compDate > date) {
			active := false
			finalTask := task
			switch task.Bucket {
			case "today":
				active = (task.Date == date)
			case "three":
				cycleEnd := addDays(task.Date, 2)
				if date == cycleEnd {
					active = true
					finalTask.Bucket = "today"
					finalTask.Date = date
				}
			case "week":
				sunday := addDays(task.Date, 6)
				if date == sunday {
					active = true
					finalTask.Bucket = "today"
					finalTask.Date = date
				}
			case "month":
				monthEnd := lastDayOfMonth(task.Date)
				if date == monthEnd {
					active = true
					finalTask.Bucket = "today"
					finalTask.Date = date
				}
			}
			if active {
				result.Uncompleted = append(result.Uncompleted, finalTask)
			}
		}
	}

	result.Total = len(result.Completed) + len(result.Uncompleted)
	if result.Total > 0 {
		result.Rate = int(math.Round(float64(len(result.Completed)) * 100 / float64(result.Total)))
	}
	return result
}

func (s *Server) dayStatistics(c *gin.Context) {
	date := c.DefaultQuery("date", s.now().In(s.location).Format("2006-01-02"))
	if _, err := time.ParseInLocation("2006-01-02", date, s.location); err != nil {
		fail(c, 400, "日期格式无效，请输入 YYYY-MM-DD", "invalid")
		return
	}
	if err := s.generateRecurring(c.Request.Context()); err != nil {
		s.internal(c, err)
		return
	}
	rows, err := s.db.QueryContext(c.Request.Context(), "SELECT "+taskColumns+" FROM tasks WHERE user_id=1 AND deleted_at IS NULL ORDER BY done, priority DESC, created_at, id")
	if err != nil {
		s.internal(c, err)
		return
	}
	tasks, err := readTasks(rows)
	if err != nil {
		s.internal(c, err)
		return
	}
	c.JSON(200, calculateDayDetail(tasks, date, s.location))
}
