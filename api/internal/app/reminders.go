package app

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func generateFeishuSign(timestamp int64, secret string) (string, error) {
	stringToSign := fmt.Sprintf("%d\n%s", timestamp, secret)
	mac := hmac.New(sha256.New, []byte(stringToSign))
	_, err := mac.Write([]byte(""))
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(mac.Sum(nil)), nil
}

func sendFeishuNotification(client *http.Client, webhookURL, secret, title, text string) error {
	payload := map[string]any{
		"msg_type": "post",
		"content": map[string]any{
			"post": map[string]any{
				"zh_cn": map[string]any{
					"title": title,
					"content": [][]map[string]string{
						{
							{"tag": "text", "text": text},
						},
					},
				},
			},
		},
	}
	if secret != "" {
		timestamp := time.Now().Unix()
		sign, err := generateFeishuSign(timestamp, secret)
		if err != nil {
			return err
		}
		payload["timestamp"] = strconv.FormatInt(timestamp, 10)
		payload["sign"] = sign
	}

	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest("POST", webhookURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("飞书服务响应错误 (HTTP %d): %s", resp.StatusCode, string(respBody))
	}
	var res struct {
		Code       int    `json:"code"`
		Msg        string `json:"msg"`
		StatusCode int    `json:"StatusCode"`
	}
	if err := json.Unmarshal(respBody, &res); err == nil {
		if res.Code != 0 {
			return fmt.Errorf("飞书推送失败 (%d): %s", res.Code, res.Msg)
		}
		if res.StatusCode != 0 {
			return fmt.Errorf("飞书推送失败 (%d): %s", res.StatusCode, res.Msg)
		}
	}
	return nil
}

func (s *Server) loadReminderSettings(ctx context.Context) (ReminderSettings, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT key, value FROM settings WHERE key IN ('reminder_enabled', 'feishu_webhook_url', 'feishu_webhook_secret', 'default_reminder_advance')")
	if err != nil {
		return ReminderSettings{}, err
	}
	defer rows.Close()
	settings := ReminderSettings{DefaultAdvance: 0}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return settings, err
		}
		switch key {
		case "reminder_enabled":
			settings.Enabled = value == "true"
		case "feishu_webhook_url":
			settings.WebhookURL = value
		case "feishu_webhook_secret":
			settings.WebhookSecret = value
		case "default_reminder_advance":
			advance, _ := strconv.Atoi(value)
			settings.DefaultAdvance = advance
		}
	}
	return settings, rows.Err()
}

func (s *Server) saveReminderSettings(ctx context.Context, settings ReminderSettings) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := stamp(s.now())
	upsert := func(key, value string) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, key, value, now)
		return err
	}
	enabledStr := "false"
	if settings.Enabled {
		enabledStr = "true"
	}
	if err := upsert("reminder_enabled", enabledStr); err != nil {
		return err
	}
	if err := upsert("feishu_webhook_url", settings.WebhookURL); err != nil {
		return err
	}
	if err := upsert("feishu_webhook_secret", settings.WebhookSecret); err != nil {
		return err
	}
	if err := upsert("default_reminder_advance", strconv.Itoa(settings.DefaultAdvance)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) getReminderSettings(c *gin.Context) {
	settings, err := s.loadReminderSettings(c.Request.Context())
	if err != nil && !errorsIsNoRows(err) {
		s.internal(c, err)
		return
	}
	c.JSON(200, settings)
}

func (s *Server) updateReminderSettings(c *gin.Context) {
	var input struct {
		Enabled        bool   `json:"enabled"`
		WebhookURL     string `json:"webhookUrl"`
		WebhookSecret  string `json:"webhookSecret"`
		DefaultAdvance int    `json:"defaultAdvance"`
	}
	if !bind(c, &input) {
		return
	}
	input.WebhookURL = strings.TrimSpace(input.WebhookURL)
	input.WebhookSecret = strings.TrimSpace(input.WebhookSecret)
	if input.Enabled && input.WebhookURL == "" {
		fail(c, 400, "开启提醒需填写飞书机器人 Webhook 地址", "invalid")
		return
	}
	if input.DefaultAdvance < 0 || input.DefaultAdvance > 120 {
		fail(c, 400, "提前时间无效", "invalid")
		return
	}
	settings := ReminderSettings{
		Enabled:        input.Enabled,
		WebhookURL:     input.WebhookURL,
		WebhookSecret:  input.WebhookSecret,
		DefaultAdvance: input.DefaultAdvance,
	}
	if err := s.saveReminderSettings(c.Request.Context(), settings); err != nil {
		s.internal(c, err)
		return
	}
	c.JSON(200, settings)
}

func (s *Server) testReminderWebhook(c *gin.Context) {
	var input struct {
		WebhookURL    string `json:"webhookUrl"`
		WebhookSecret string `json:"webhookSecret"`
	}
	if !bind(c, &input) {
		return
	}
	input.WebhookURL = strings.TrimSpace(input.WebhookURL)
	input.WebhookSecret = strings.TrimSpace(input.WebhookSecret)
	if input.WebhookURL == "" {
		settings, err := s.loadReminderSettings(c.Request.Context())
		if err == nil && settings.WebhookURL != "" {
			input.WebhookURL = settings.WebhookURL
			if input.WebhookSecret == "" {
				input.WebhookSecret = settings.WebhookSecret
			}
		}
	}
	if input.WebhookURL == "" {
		fail(c, 400, "请先填写飞书机器人 Webhook 地址", "invalid")
		return
	}

	now := s.now().In(s.location).Format("2006-01-02 15:04:05")
	testMsg := fmt.Sprintf("🎉 这是一条来自四格计划的测试通知！\n⏰ 发送时间：%s\n✅ 飞书自定义机器人连接成功，到点将为你推送计划提醒。", now)
	err := sendFeishuNotification(s.quoteClient, input.WebhookURL, input.WebhookSecret, "四格计划 · 测试提醒", testMsg)
	if err != nil {
		fail(c, 400, fmt.Sprintf("飞书推送测试失败：%v", err), "webhook_failed")
		return
	}
	c.JSON(200, gin.H{"status": "ok", "message": "测试提醒已发送，请检查飞书群聊或单聊消息"})
}

func (s *Server) CheckAndSendReminders(ctx context.Context) error {
	settings, err := s.loadReminderSettings(ctx)
	if err != nil || !settings.Enabled || settings.WebhookURL == "" {
		return nil
	}
	now := s.now().In(s.location)
	currentDate := now.Format("2006-01-02")

	rows, err := s.db.QueryContext(ctx, "SELECT "+taskColumns+" FROM tasks WHERE user_id=1 AND scheduled_date=? AND reminder_time!='' AND (reminded_at='' OR reminded_at IS NULL) AND done=0 AND deleted_at IS NULL", currentDate)
	if err != nil {
		return err
	}
	tasks, err := readTasks(rows)
	if err != nil {
		return err
	}

	for _, task := range tasks {
		taskTime, err := time.ParseInLocation("2006-01-02 15:04", currentDate+" "+task.ReminderTime, s.location)
		if err != nil {
			continue
		}
		triggerTime := taskTime.Add(-time.Duration(task.ReminderAdvance) * time.Minute)
		if now.Before(triggerTime) {
			continue
		}

		priorityTag := ""
		if task.Priority {
			priorityTag = " · 今日重点"
		}
		advanceText := "准时提醒"
		if task.ReminderAdvance > 0 {
			advanceText = fmt.Sprintf("提前 %d 分钟提醒", task.ReminderAdvance)
		}

		bucketName := map[string]string{"today": "今天", "three": "三天", "week": "本周", "month": "本月"}[task.Bucket]
		if bucketName == "" {
			bucketName = task.Bucket
		}

		var lines []string
		lines = append(lines, fmt.Sprintf("🎯 计划：%s", task.Title))
		lines = append(lines, fmt.Sprintf("⏰ 时间：%s (%s)", task.ReminderTime, advanceText))
		lines = append(lines, fmt.Sprintf("📌 类别：%s计划%s", bucketName, priorityTag))
		if task.Notes != "" {
			lines = append(lines, fmt.Sprintf("📝 备注：%s", task.Notes))
		}

		bodyText := strings.Join(lines, "\n")
		sendErr := sendFeishuNotification(s.quoteClient, settings.WebhookURL, settings.WebhookSecret, "四格计划 · 提醒", bodyText)
		if sendErr != nil {
			log.Printf("send feishu reminder failed for task %s: %v", task.ID, sendErr)
			continue
		}

		_, _ = s.db.ExecContext(ctx, "UPDATE tasks SET reminded_at=? WHERE id=? AND (reminded_at='' OR reminded_at IS NULL)", stamp(s.now()), task.ID)
	}
	return nil
}

func (s *Server) StartReminderTicker(stop context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-stop.Done():
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			_ = s.CheckAndSendReminders(ctx)
			cancel()
		}
	}
}

func errorsIsNoRows(err error) bool {
	return err == sql.ErrNoRows
}
