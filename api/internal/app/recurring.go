package app

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

type RecurringPlan struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	Notes         string `json:"notes"`
	Start         string `json:"start"`
	End           string `json:"end"`
	Status        string `json:"status"`
	EffectiveDate string `json:"effectiveDate"`
	Version       int    `json:"version"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
	Generated     int    `json:"generated"`
	Completed     int    `json:"completed"`
}

const recurringColumns = "id,title,notes,start_date,end_date,status,effective_date,version,created_at,updated_at"

func scanRecurring(row scanner) (RecurringPlan, error) {
	var p RecurringPlan
	err := row.Scan(&p.ID, &p.Title, &p.Notes, &p.Start, &p.End, &p.Status, &p.EffectiveDate, &p.Version, &p.CreatedAt, &p.UpdatedAt)
	return p, err
}
func (s *Server) readRecurring(ctx context.Context) ([]RecurringPlan, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+recurringColumns+" FROM recurring_plans WHERE user_id=1 ORDER BY created_at DESC,id")
	if err != nil {
		return nil, err
	}
	plans := make([]RecurringPlan, 0)
	for rows.Next() {
		p, e := scanRecurring(rows)
		if e != nil {
			rows.Close()
			return nil, e
		}
		plans = append(plans, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range plans {
		if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*),COALESCE(SUM(done),0) FROM tasks WHERE user_id=1 AND recurring_id=? AND deleted_at IS NULL", plans[i].ID).Scan(&plans[i].Generated, &plans[i].Completed); err != nil {
			return nil, err
		}
	}
	return plans, nil
}
func (s *Server) listRecurring(c *gin.Context) {
	if err := s.generateRecurring(c.Request.Context()); err != nil {
		s.internal(c, err)
		return
	}
	plans, err := s.readRecurring(c.Request.Context())
	if err != nil {
		s.internal(c, err)
		return
	}
	c.JSON(200, plans)
}
func (s *Server) validateRecurring(p *RecurringPlan) error {
	p.Title = strings.TrimSpace(p.Title)
	p.Notes = strings.TrimSpace(p.Notes)
	if p.Title == "" || utf8.RuneCountInString(p.Title) > 160 {
		return errors.New("目标需要 1–160 个字")
	}
	if utf8.RuneCountInString(p.Notes) > 1000 {
		return errors.New("备注最多 1000 个字")
	}
	start, err := time.ParseInLocation("2006-01-02", p.Start, s.location)
	if err != nil || start.Format("2006-01-02") != p.Start {
		return errors.New("请选择有效的开始日期")
	}
	end, err := time.ParseInLocation("2006-01-02", p.End, s.location)
	if err != nil || end.Format("2006-01-02") != p.End {
		return errors.New("请选择有效的截止日期")
	}
	if end.Before(start) || end.Sub(start) > 3650*24*time.Hour {
		return errors.New("持续时间需要在 1–3651 天之间")
	}
	if p.Status != "active" && p.Status != "paused" && p.Status != "stopped" {
		return errors.New("目标状态无效")
	}
	return nil
}
func (s *Server) createRecurring(c *gin.Context) {
	var in struct {
		Title string `json:"title"`
		Notes string `json:"notes"`
		Start string `json:"start"`
		End   string `json:"end"`
	}
	if !bind(c, &in) {
		return
	}
	now := s.now()
	date := now.In(s.location).Format("2006-01-02")
	p := RecurringPlan{Title: in.Title, Notes: in.Notes, Start: in.Start, End: in.End, Status: "active", EffectiveDate: date, Version: 1, CreatedAt: stamp(now), UpdatedAt: stamp(now)}
	if err := s.validateRecurring(&p); err != nil {
		fail(c, 400, err.Error(), "invalid")
		return
	}
	if p.Start < date {
		fail(c, 400, "开始日期不能早于今天", "invalid")
		return
	}
	token, err := newToken()
	if err != nil {
		s.internal(c, err)
		return
	}
	p.ID = token[:24]
	tx, err := s.db.BeginTx(c.Request.Context(), nil)
	if err != nil {
		s.internal(c, err)
		return
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(c.Request.Context(), "INSERT INTO recurring_plans(id,user_id,title,notes,start_date,end_date,status,effective_date,version,created_at,updated_at) VALUES(?,1,?,?,?,?,?,?,?,?,?)", p.ID, p.Title, p.Notes, p.Start, p.End, p.Status, p.EffectiveDate, p.Version, p.CreatedAt, p.UpdatedAt)
	if err == nil {
		_, err = tx.ExecContext(c.Request.Context(), "INSERT INTO recurring_revisions(plan_id,effective_date,title,notes,end_date,status) VALUES(?,?,?,?,?,?)", p.ID, p.EffectiveDate, p.Title, p.Notes, p.End, p.Status)
	}
	if err != nil {
		s.internal(c, err)
		return
	}
	if err = s.generateRecurringTx(c.Request.Context(), tx); err != nil {
		s.internal(c, err)
		return
	}
	if err = tx.Commit(); err != nil {
		s.internal(c, err)
		return
	}
	c.JSON(201, p)
}
func (s *Server) updateRecurring(c *gin.Context) {
	var in struct {
		Version int     `json:"version"`
		Title   *string `json:"title"`
		Notes   *string `json:"notes"`
		End     *string `json:"end"`
		Status  *string `json:"status"`
	}
	if !bind(c, &in) {
		return
	}
	if in.Version < 1 {
		fail(c, 400, "缺少目标版本", "invalid")
		return
	}
	// Materialize today's original task before a revision that starts tomorrow.
	if err := s.generateRecurring(c.Request.Context()); err != nil {
		s.internal(c, err)
		return
	}
	tx, err := s.db.BeginTx(c.Request.Context(), nil)
	if err != nil {
		s.internal(c, err)
		return
	}
	defer tx.Rollback()
	p, err := scanRecurring(tx.QueryRowContext(c.Request.Context(), "SELECT "+recurringColumns+" FROM recurring_plans WHERE id=? AND user_id=1", c.Param("id")))
	if errors.Is(err, sql.ErrNoRows) {
		fail(c, 404, "目标不存在", "not_found")
		return
	}
	if err != nil {
		s.internal(c, err)
		return
	}
	if p.Version != in.Version {
		fail(c, 409, "目标已在其他窗口更新，请重新操作", "conflict")
		return
	}
	if p.Status == "stopped" {
		fail(c, 409, "已停止的目标保留为历史，请新建目标", "stopped")
		return
	}
	if in.Title != nil {
		p.Title = *in.Title
	}
	if in.Notes != nil {
		p.Notes = *in.Notes
	}
	if in.End != nil {
		p.End = *in.End
	}
	if in.Status != nil {
		p.Status = *in.Status
	}
	if err := s.validateRecurring(&p); err != nil {
		fail(c, 400, err.Error(), "invalid")
		return
	}
	p.EffectiveDate = s.now().In(s.location).AddDate(0, 0, 1).Format("2006-01-02")
	p.UpdatedAt = stamp(s.now())
	p.Version++
	if in.End != nil && p.End < p.EffectiveDate {
		fail(c, 400, "新的截止日期不能早于明天", "invalid")
		return
	}
	_, err = tx.ExecContext(c.Request.Context(), "UPDATE recurring_plans SET title=?,notes=?,end_date=?,status=?,effective_date=?,updated_at=?,version=? WHERE id=? AND user_id=1", p.Title, p.Notes, p.End, p.Status, p.EffectiveDate, p.UpdatedAt, p.Version, p.ID)
	if err == nil {
		_, err = tx.ExecContext(c.Request.Context(), "INSERT INTO recurring_revisions(plan_id,effective_date,title,notes,end_date,status) VALUES(?,?,?,?,?,?) ON CONFLICT(plan_id,effective_date) DO UPDATE SET title=excluded.title,notes=excluded.notes,end_date=excluded.end_date,status=excluded.status", p.ID, p.EffectiveDate, p.Title, p.Notes, p.End, p.Status)
	}
	if err != nil {
		s.internal(c, err)
		return
	}
	if err = tx.Commit(); err != nil {
		s.internal(c, err)
		return
	}
	c.JSON(200, p)
}

type recurringRevision struct{ Date, Title, Notes, End, Status string }

func (s *Server) generateRecurring(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = s.generateRecurringTx(ctx, tx); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Server) generateRecurringTx(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, "SELECT id,start_date,generated_until FROM recurring_plans WHERE user_id=1")
	if err != nil {
		return err
	}
	type progress struct{ ID, Start, Until string }
	plans := []progress{}
	for rows.Next() {
		var p progress
		if err := rows.Scan(&p.ID, &p.Start, &p.Until); err != nil {
			rows.Close()
			return err
		}
		plans = append(plans, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	today := s.now().In(s.location).Format("2006-01-02")
	now := stamp(s.now())
	for _, p := range plans {
		if p.Start > today || p.Until >= today {
			continue
		}
		r, err := tx.QueryContext(ctx, "SELECT effective_date,title,notes,end_date,status FROM recurring_revisions WHERE plan_id=? ORDER BY effective_date", p.ID)
		if err != nil {
			return err
		}
		revisions := []recurringRevision{}
		for r.Next() {
			var v recurringRevision
			if err := r.Scan(&v.Date, &v.Title, &v.Notes, &v.End, &v.Status); err != nil {
				r.Close()
				return err
			}
			revisions = append(revisions, v)
		}
		err = r.Err()
		r.Close()
		if err != nil {
			return err
		}
		start, _ := time.ParseInLocation("2006-01-02", p.Start, s.location)
		if p.Until != "" {
			last, _ := time.ParseInLocation("2006-01-02", p.Until, s.location)
			start = last.AddDate(0, 0, 1)
		}
		index := -1
		for day := start; day.Format("2006-01-02") <= today; day = day.AddDate(0, 0, 1) {
			date := day.Format("2006-01-02")
			for index+1 < len(revisions) && revisions[index+1].Date <= date {
				index++
			}
			if index < 0 {
				continue
			}
			v := revisions[index]
			if v.Status != "active" || date > v.End {
				continue
			}
			token, err := newToken()
			if err != nil {
				return err
			}
			id := token[:24]
			result, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO recurring_occurrences(plan_id,scheduled_date,task_id) VALUES(?,?,?)", p.ID, date, id)
			if err != nil {
				return err
			}
			n, err := result.RowsAffected()
			if err != nil {
				return err
			}
			if n == 0 {
				continue
			}
			_, err = tx.ExecContext(ctx, "INSERT INTO tasks(id,user_id,title,notes,bucket,scheduled_date,created_at,updated_at,recurring_id) VALUES(?,1,?,?,'today',?,?,?,?)", id, v.Title, v.Notes, date, now, now, p.ID)
			if err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, "UPDATE recurring_plans SET generated_until=? WHERE id=?", today, p.ID); err != nil {
			return err
		}
	}
	return nil
}
