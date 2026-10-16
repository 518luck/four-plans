package app

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	_ "time/tzdata"
)

type Config struct {
	StaticDir     string
	SecureCookies bool
}
type loginAttempt struct {
	Failures int
	Expires  time.Time
}
type Server struct {
	db            *sql.DB
	config        Config
	now           func() time.Time
	location      *time.Location
	quoteMu       sync.Mutex
	quoteClient   *http.Client
	quoteURL      string
	loginMu       sync.Mutex
	loginAttempts map[string]loginAttempt
}

func NewServer(db *sql.DB, config Config) *Server {
	location, _ := time.LoadLocation("Asia/Shanghai")
	return &Server{db: db, config: config, now: time.Now, location: location, loginAttempts: make(map[string]loginAttempt), quoteClient: &http.Client{Timeout: 3 * time.Second}, quoteURL: "https://api.vsaa.cn/api/quote/index.php?type=%E9%BC%93%E5%8A%B1"}
}

func (s *Server) Router() *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Recovery(), s.headers)
	_ = router.SetTrustedProxies(nil)
	router.GET("/api/health", func(c *gin.Context) {
		if err := s.db.PingContext(c.Request.Context()); err != nil {
			fail(c, 503, "服务暂时不可用", "unavailable")
			return
		}
		c.JSON(200, gin.H{"status": "ok"})
	})
	router.GET("/api/session", s.session)
	router.POST("/api/setup", s.setup)
	router.POST("/api/login", s.login)
	protected := router.Group("/api")
	protected.Use(s.requireUser)
	protected.POST("/logout", s.logout)
	protected.GET("/board", s.board)
	protected.GET("/resources", s.resources)
	protected.GET("/recurring", s.listRecurring)
	protected.POST("/recurring", s.createRecurring)
	protected.PATCH("/recurring/:id", s.updateRecurring)
	protected.GET("/recurring/:id/records", s.getRecurringRecords)
	protected.POST("/recurring/:id/checkin", s.checkinRecurring)
	protected.GET("/statistics", s.statistics)
	protected.GET("/statistics/day", s.dayStatistics)
	protected.GET("/quote", s.quote)
	protected.POST("/tasks", s.createTask)
	protected.PATCH("/tasks/:id", s.updateTask)
	protected.DELETE("/tasks/:id", s.deleteTask)
	protected.POST("/trash/:id/restore", s.restoreTask)
	protected.DELETE("/trash/:id", s.purgeTask)
	protected.GET("/export", s.export)
	protected.GET("/settings/reminder", s.getReminderSettings)
	protected.PUT("/settings/reminder", s.updateReminderSettings)
	protected.POST("/settings/reminder/test", s.testReminderWebhook)
	router.NoRoute(s.serveFrontend)
	return router
}

func fail(c *gin.Context, status int, message, code string) {
	c.AbortWithStatusJSON(status, gin.H{"error": message, "code": code})
}
func (s *Server) internal(c *gin.Context, err error) {
	log.Printf("request failed: %v", err)
	fail(c, 500, "暂时无法保存，请稍后重试", "internal")
}
func stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000000000Z") }

func (s *Server) headers(c *gin.Context) {
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Referrer-Policy", "same-origin")
	c.Header("X-Frame-Options", "DENY")
	if strings.HasPrefix(c.Request.URL.Path, "/api/") {
		c.Header("Cache-Control", "no-store")
	}
	if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
		if origin := c.GetHeader("Origin"); origin != "" {
			parsed, err := url.Parse(origin)
			if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || !strings.EqualFold(parsed.Host, c.Request.Host) {
				fail(c, 403, "请求来源无效，请刷新页面", "origin")
				return
			}
		}
		if site := c.GetHeader("Sec-Fetch-Site"); site == "cross-site" {
			fail(c, 403, "请求来源无效", "origin")
			return
		}
	}
	c.Next()
}

func bind(c *gin.Context, value any) bool {
	media, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err != nil || media != "application/json" {
		fail(c, 415, "请使用 JSON 提交数据", "invalid")
		return false
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16*1024)
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		fail(c, 400, "提交的数据格式不正确", "invalid")
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		fail(c, 400, "提交的数据格式不正确", "invalid")
		return false
	}
	return true
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func newToken() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}
func (s *Server) cookie(c *gin.Context, token string, age int) {
	http.SetCookie(c.Writer, &http.Cookie{Name: "four_plans_session", Value: token, Path: "/", MaxAge: age, HttpOnly: true, Secure: s.config.SecureCookies, SameSite: http.SameSiteStrictMode})
}
func (s *Server) newSession(c *gin.Context) error {
	token, err := newToken()
	if err != nil {
		return err
	}
	expiry := stamp(s.now().Add(30 * 24 * time.Hour))
	if _, err = s.db.ExecContext(c.Request.Context(), "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,1,?)", tokenHash(token), expiry); err != nil {
		return err
	}
	_, _ = s.db.ExecContext(c.Request.Context(), "DELETE FROM sessions WHERE expires_at <= ?", stamp(s.now()))
	s.cookie(c, token, 30*24*60*60)
	return nil
}
func (s *Server) currentUser(c *gin.Context) (string, error) {
	token, err := c.Cookie("four_plans_session")
	if err != nil {
		return "", sql.ErrNoRows
	}
	var username string
	err = s.db.QueryRowContext(c.Request.Context(), `SELECT users.username FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?`, tokenHash(token), stamp(s.now())).Scan(&username)
	return username, err
}
func (s *Server) requireUser(c *gin.Context) {
	username, err := s.currentUser(c)
	if errors.Is(err, sql.ErrNoRows) {
		fail(c, 401, "请先登录", "unauthorized")
		return
	}
	if err != nil {
		s.internal(c, err)
		return
	}
	c.Set("username", username)
	c.Next()
}
func (s *Server) session(c *gin.Context) {
	var count int
	if err := s.db.QueryRowContext(c.Request.Context(), "SELECT COUNT(*) FROM users").Scan(&count); err != nil {
		s.internal(c, err)
		return
	}
	username, err := s.currentUser(c)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		s.internal(c, err)
		return
	}
	var user any
	if username != "" {
		user = gin.H{"username": username}
	}
	c.JSON(200, gin.H{"configured": count > 0, "user": user})
}

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) setup(c *gin.Context) {
	var input credentials
	if !bind(c, &input) {
		return
	}
	input.Username = strings.TrimSpace(input.Username)
	if len([]rune(input.Username)) < 1 || len([]rune(input.Username)) > 32 || len(input.Password) < 8 || len(input.Password) > 72 {
		fail(c, 400, "昵称需要 1–32 个字，密码需要 8–72 个字节", "invalid")
		return
	}
	var count int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM users").Scan(&count); err != nil {
		s.internal(c, err)
		return
	}
	if count != 0 {
		fail(c, 409, "账号已经设置，请直接登录", "configured")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
	if err != nil {
		s.internal(c, err)
		return
	}
	if _, err = s.db.ExecContext(c.Request.Context(), "INSERT INTO users(id,username,password_hash,created_at) VALUES(1,?,?,?)", input.Username, string(hash), stamp(s.now())); err != nil {
		var exists int
		if s.db.QueryRow("SELECT COUNT(*) FROM users").Scan(&exists) == nil && exists > 0 {
			fail(c, 409, "账号已经设置，请直接登录", "configured")
			return
		}
		s.internal(c, err)
		return
	}
	if err := s.newSession(c); err != nil {
		s.internal(c, err)
		return
	}
	c.JSON(201, gin.H{"username": input.Username})
}
func (s *Server) login(c *gin.Context) {
	ip := c.ClientIP()
	s.loginMu.Lock()
	attempt := s.loginAttempts[ip]
	if !attempt.Expires.After(s.now()) {
		attempt = loginAttempt{Expires: s.now().Add(15 * time.Minute)}
	}
	limited := attempt.Failures >= 10
	s.loginMu.Unlock()
	if limited {
		fail(c, 429, "尝试次数过多，请 15 分钟后再试", "rate_limit")
		return
	}
	var input credentials
	if !bind(c, &input) {
		return
	}
	var username, hash string
	err := s.db.QueryRowContext(c.Request.Context(), "SELECT username,password_hash FROM users WHERE id=1").Scan(&username, &hash)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		s.internal(c, err)
		return
	}
	valid := err == nil && strings.TrimSpace(input.Username) == username && bcrypt.CompareHashAndPassword([]byte(hash), []byte(input.Password)) == nil
	if !valid {
		s.loginMu.Lock()
		attempt = s.loginAttempts[ip]
		if !attempt.Expires.After(s.now()) {
			attempt = loginAttempt{Expires: s.now().Add(15 * time.Minute)}
		}
		attempt.Failures++
		s.loginAttempts[ip] = attempt
		for key, item := range s.loginAttempts {
			if !item.Expires.After(s.now()) {
				delete(s.loginAttempts, key)
			}
		}
		s.loginMu.Unlock()
		fail(c, 401, "昵称或密码不正确", "credentials")
		return
	}
	s.loginMu.Lock()
	delete(s.loginAttempts, ip)
	s.loginMu.Unlock()
	if err := s.newSession(c); err != nil {
		s.internal(c, err)
		return
	}
	c.JSON(200, gin.H{"username": username})
}
func (s *Server) logout(c *gin.Context) {
	token, _ := c.Cookie("four_plans_session")
	if _, err := s.db.ExecContext(c.Request.Context(), "DELETE FROM sessions WHERE token_hash=?", tokenHash(token)); err != nil {
		s.internal(c, err)
		return
	}
	s.cookie(c, "", -1)
	c.Status(204)
}

func (s *Server) board(c *gin.Context) {
	date := c.DefaultQuery("date", s.now().In(s.location).Format("2006-01-02"))
	bounds, err := periods(date, s.location)
	if err != nil {
		fail(c, 400, err.Error(), "invalid")
		return
	}
	if err := s.generateRecurring(c.Request.Context()); err != nil {
		s.internal(c, err)
		return
	}
	rows, err := s.db.QueryContext(c.Request.Context(), "SELECT "+taskColumns+" FROM tasks WHERE user_id=1 ORDER BY deleted_at DESC, done, priority DESC, created_at, id")
	if err != nil {
		s.internal(c, err)
		return
	}
	tasks, err := readTasks(rows)
	if err != nil {
		s.internal(c, err)
		return
	}
	buckets := map[string][]Task{"today": {}, "three": {}, "week": {}, "month": {}}
	carryovers := make([]Task, 0)
	trash := make([]Task, 0)
	for _, task := range tasks {
		if task.DeletedAt != "" {
			trash = append(trash, task)
			continue
		}
		switch task.Bucket {
		case "today":
			if task.Date == date {
				buckets["today"] = append(buckets["today"], task)
			} else if task.Date < date && !task.Done && task.RecurringID == "" {
				carryovers = append(carryovers, task)
			}
		case "three":
			cycleEnd := addDays(task.Date, 2)
			if date == cycleEnd {
				if !task.Done {
					promoted := task
					promoted.Bucket = "today"
					promoted.Date = date
					buckets["today"] = append(buckets["today"], promoted)
				} else {
					buckets["three"] = append(buckets["three"], task)
				}
			} else if task.Date <= date && date < cycleEnd {
				buckets["three"] = append(buckets["three"], task)
			} else if task.Date >= bounds["three"].Start && task.Date <= bounds["three"].End {
				buckets["three"] = append(buckets["three"], task)
			} else if date > cycleEnd && !task.Done && task.RecurringID == "" {
				carryovers = append(carryovers, task)
			}
		case "week":
			createdDate := task.CreatedAt
			if len(createdDate) >= 10 {
				createdDate = createdDate[:10]
			}
			friday := addDays(task.Date, 4)
			sunday := addDays(task.Date, 6)
			if date == sunday && (createdDate < sunday || date > createdDate) {
				if !task.Done {
					promoted := task
					promoted.Bucket = "today"
					promoted.Date = date
					buckets["today"] = append(buckets["today"], promoted)
				} else {
					buckets["week"] = append(buckets["week"], task)
				}
			} else if date >= friday && date < sunday && (createdDate < friday || date > createdDate) {
				if !task.Done {
					promoted := task
					promoted.Bucket = "three"
					promoted.Date = friday
					buckets["three"] = append(buckets["three"], promoted)
				} else {
					buckets["week"] = append(buckets["week"], task)
				}
			} else if (task.Date <= date && date <= sunday) || (task.Date >= bounds["week"].Start && task.Date <= bounds["week"].End) {
				buckets["week"] = append(buckets["week"], task)
			} else if date > sunday && !task.Done && task.RecurringID == "" {
				carryovers = append(carryovers, task)
			}
		case "month":
			monthEnd := lastDayOfMonth(task.Date)
			sprintStart := addDays(monthEnd, -6)
			if date >= sprintStart && date <= monthEnd {
				if !task.Done {
					promoted := task
					promoted.Bucket = "week"
					promoted.Date = bounds["week"].Start
					buckets["week"] = append(buckets["week"], promoted)
				} else {
					buckets["month"] = append(buckets["month"], task)
				}
			} else if (date >= task.Date && date <= monthEnd) || (task.Date >= bounds["month"].Start && task.Date <= bounds["month"].End) {
				buckets["month"] = append(buckets["month"], task)
			} else if date > monthEnd && !task.Done && task.RecurringID == "" {
				carryovers = append(carryovers, task)
			}
		}
	}
	plans, err := s.readRecurring(c.Request.Context())
	if err != nil {
		s.internal(c, err)
		return
	}
	reminderSettings, _ := s.loadReminderSettings(c.Request.Context())
	c.JSON(200, gin.H{"recurringPlans": plans, "date": date, "periods": bounds, "buckets": buckets, "carryovers": carryovers, "trash": trash, "statistics": calculateStatistics(tasks, s.now(), s.location), "reminderSettings": reminderSettings, "syncedAt": stamp(s.now())})
}

func (s *Server) createTask(c *gin.Context) {
	var input struct {
		Title           string `json:"title"`
		Notes           string `json:"notes"`
		Bucket          string `json:"bucket"`
		Date            string `json:"date"`
		Priority        bool   `json:"priority"`
		ReminderTime    string `json:"reminderTime"`
		ReminderAdvance int    `json:"reminderAdvance"`
	}
	if !bind(c, &input) {
		return
	}
	task := Task{Title: input.Title, Notes: input.Notes, Bucket: input.Bucket, Date: input.Date, Priority: input.Priority, ReminderTime: input.ReminderTime, ReminderAdvance: input.ReminderAdvance, Version: 1, CreatedAt: stamp(s.now()), UpdatedAt: stamp(s.now())}
	if err := validateTask(&task, s.location); err != nil {
		fail(c, 400, err.Error(), "invalid")
		return
	}
	id, err := newToken()
	if err != nil {
		s.internal(c, err)
		return
	}
	task.ID = id[:24]
	tx, err := s.db.BeginTx(c.Request.Context(), nil)
	if err != nil {
		s.internal(c, err)
		return
	}
	defer tx.Rollback()
	if task.Priority {
		if _, err = tx.Exec("UPDATE tasks SET priority=0,version=version+1,updated_at=? WHERE user_id=1 AND bucket='today' AND scheduled_date=? AND priority=1 AND deleted_at IS NULL", task.UpdatedAt, task.Date); err != nil {
			s.internal(c, err)
			return
		}
	}
	_, err = tx.ExecContext(c.Request.Context(), `INSERT INTO tasks(id,user_id,title,notes,bucket,scheduled_date,priority,version,created_at,updated_at,reminder_time,reminder_advance) VALUES(?,1,?,?,?,?,?,?,?,?,?,?)`, task.ID, task.Title, task.Notes, task.Bucket, task.Date, task.Priority, task.Version, task.CreatedAt, task.UpdatedAt, task.ReminderTime, task.ReminderAdvance)
	if err != nil {
		s.internal(c, err)
		return
	}
	if err := tx.Commit(); err != nil {
		s.internal(c, err)
		return
	}
	c.JSON(201, task)
}

func (s *Server) updateTask(c *gin.Context) {
	var input struct {
		Version         int     `json:"version"`
		Title           *string `json:"title"`
		Notes           *string `json:"notes"`
		Bucket          *string `json:"bucket"`
		Date            *string `json:"date"`
		Done            *bool   `json:"done"`
		Priority        *bool   `json:"priority"`
		ReminderTime    *string `json:"reminderTime"`
		ReminderAdvance *int    `json:"reminderAdvance"`
	}
	if !bind(c, &input) {
		return
	}
	if input.Version < 1 {
		fail(c, 400, "缺少计划版本，请刷新页面", "invalid")
		return
	}
	tx, err := s.db.BeginTx(c.Request.Context(), nil)
	if err != nil {
		s.internal(c, err)
		return
	}
	defer tx.Rollback()
	task, err := scanTask(tx.QueryRowContext(c.Request.Context(), "SELECT "+taskColumns+" FROM tasks WHERE id=? AND user_id=1 AND deleted_at IS NULL", c.Param("id")))
	if errors.Is(err, sql.ErrNoRows) {
		fail(c, 404, "这项计划已被移除", "not_found")
		return
	}
	if err != nil {
		s.internal(c, err)
		return
	}
	if task.Version != input.Version {
		fail(c, 409, "计划已在其他窗口更新，请重新操作", "conflict")
		return
	}
	wasDone := task.Done
	if input.Title != nil {
		task.Title = *input.Title
	}
	if input.Notes != nil {
		task.Notes = *input.Notes
	}
	if input.Bucket != nil {
		task.Bucket = *input.Bucket
	}
	if input.Date != nil {
		task.Date = *input.Date
	}
	if input.Done != nil {
		task.Done = *input.Done
	}
	if input.Priority != nil {
		task.Priority = *input.Priority
	}
	if input.ReminderTime != nil {
		if task.ReminderTime != *input.ReminderTime {
			task.RemindedAt = ""
		}
		task.ReminderTime = *input.ReminderTime
	}
	if input.ReminderAdvance != nil {
		if task.ReminderAdvance != *input.ReminderAdvance {
			task.RemindedAt = ""
		}
		task.ReminderAdvance = *input.ReminderAdvance
	}
	if err := validateTask(&task, s.location); err != nil {
		fail(c, 400, err.Error(), "invalid")
		return
	}
	task.UpdatedAt = stamp(s.now())
	if task.Done && !wasDone {
		task.CompletedAt = task.UpdatedAt
		task.CompletionDateEstimated = false
	} else if !task.Done {
		task.CompletedAt = ""
		task.CompletionDateEstimated = false
	}
	task.Version++
	if task.Priority {
		if _, err = tx.Exec("UPDATE tasks SET priority=0,version=version+1,updated_at=? WHERE user_id=1 AND bucket='today' AND scheduled_date=? AND priority=1 AND id<>? AND deleted_at IS NULL", task.UpdatedAt, task.Date, task.ID); err != nil {
			s.internal(c, err)
			return
		}
	}
	_, err = tx.ExecContext(c.Request.Context(), `UPDATE tasks SET title=?,notes=?,bucket=?,scheduled_date=?,done=?,priority=?,version=?,updated_at=?,completed_at=NULLIF(?,''),completion_date_estimated=?,reminder_time=?,reminder_advance=?,reminded_at=? WHERE id=? AND user_id=1`, task.Title, task.Notes, task.Bucket, task.Date, task.Done, task.Priority, task.Version, task.UpdatedAt, task.CompletedAt, task.CompletionDateEstimated, task.ReminderTime, task.ReminderAdvance, task.RemindedAt, task.ID)
	if err != nil {
		s.internal(c, err)
		return
	}
	if err := tx.Commit(); err != nil {
		s.internal(c, err)
		return
	}
	c.JSON(200, task)
}

func (s *Server) deleteTask(c *gin.Context) {
	now := stamp(s.now())
	s.changeTaskRemoval(c, "UPDATE tasks SET deleted_at=?,updated_at=?,priority=0,version=version+1 WHERE id=? AND user_id=1 AND version=? AND deleted_at IS NULL", now, now)
}

func (s *Server) restoreTask(c *gin.Context) {
	s.changeTaskRemoval(c, "UPDATE tasks SET deleted_at=NULL,updated_at=?,priority=0,version=version+1 WHERE id=? AND user_id=1 AND version=? AND deleted_at IS NOT NULL", stamp(s.now()))
}

func (s *Server) purgeTask(c *gin.Context) {
	s.changeTaskRemoval(c, "DELETE FROM tasks WHERE id=? AND user_id=1 AND version=? AND deleted_at IS NOT NULL")
}

func (s *Server) changeTaskRemoval(c *gin.Context, query string, args ...any) {
	var input struct {
		Version int `json:"version"`
	}
	if !bind(c, &input) {
		return
	}
	if input.Version < 1 {
		fail(c, 400, "缺少计划版本", "invalid")
		return
	}
	args = append(args, c.Param("id"), input.Version)
	result, err := s.db.ExecContext(c.Request.Context(), query, args...)
	if err != nil {
		s.internal(c, err)
		return
	}
	count, err := result.RowsAffected()
	if err != nil {
		s.internal(c, err)
		return
	}
	if count == 0 {
		fail(c, 409, "计划已更新、恢复或删除，请刷新后重试", "conflict")
		return
	}
	c.Status(204)
}
func (s *Server) export(c *gin.Context) {
	if err := s.generateRecurring(c.Request.Context()); err != nil {
		s.internal(c, err)
		return
	}
	rows, err := s.db.QueryContext(c.Request.Context(), "SELECT "+taskColumns+" FROM tasks WHERE user_id=1 AND deleted_at IS NULL ORDER BY created_at,id")
	if err != nil {
		s.internal(c, err)
		return
	}
	tasks, err := readTasks(rows)
	if err != nil {
		s.internal(c, err)
		return
	}
	c.Header("Content-Disposition", `attachment; filename="four-plans.json"`)
	plans, err := s.readRecurring(c.Request.Context())
	if err != nil {
		s.internal(c, err)
		return
	}
	c.JSON(200, gin.H{"formatVersion": 2, "exportedAt": stamp(s.now()), "tasks": tasks, "recurringPlans": plans})
}
func (s *Server) serveFrontend(c *gin.Context) {
	if strings.HasPrefix(c.Request.URL.Path, "/api") {
		fail(c, 404, "接口不存在", "not_found")
		return
	}
	if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
		c.Status(404)
		return
	}
	clean := filepath.Clean("/" + c.Request.URL.Path)
	filename := filepath.Join(s.config.StaticDir, strings.TrimPrefix(clean, "/"))
	if info, err := os.Stat(filename); err == nil && !info.IsDir() {
		c.File(filename)
		return
	}
	if filepath.Ext(clean) != "" {
		c.Status(404)
		return
	}
	index := filepath.Join(s.config.StaticDir, "index.html")
	if _, err := os.Stat(index); err != nil {
		c.String(404, "前端尚未构建，请从开发地址打开，或先运行 pnpm build。")
		return
	}
	c.Header("Cache-Control", "no-cache")
	c.File(index)
}
