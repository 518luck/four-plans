package app

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestFeishuSignatureGeneration(t *testing.T) {
	timestamp := int64(1700000000)
	secret := "test-secret"
	sign, err := generateFeishuSign(timestamp, secret)
	if err != nil {
		t.Fatalf("signature generation failed: %v", err)
	}
	if sign == "" {
		t.Fatal("expected non-empty signature")
	}
}

func TestReminderSettingsAPI(t *testing.T) {
	f := newFixture(t)
	f.setup(t)

	// Default reminder settings
	res := f.send(t, "GET", "/api/settings/reminder", nil)
	expect(t, res, 200)
	var settings ReminderSettings
	if err := json.Unmarshal(res.Body.Bytes(), &settings); err != nil {
		t.Fatal(err)
	}
	if settings.Enabled {
		t.Fatal("expected reminders to be disabled by default")
	}

	// Update settings
	updateBody := map[string]any{
		"enabled":        true,
		"webhookUrl":     "https://open.feishu.cn/open-apis/bot/v2/hook/test",
		"webhookSecret":  "sec123",
		"defaultAdvance": 15,
	}
	res = f.send(t, "PUT", "/api/settings/reminder", updateBody)
	expect(t, res, 200)

	// Fetch again to verify persistence
	res = f.send(t, "GET", "/api/settings/reminder", nil)
	expect(t, res, 200)
	if err := json.Unmarshal(res.Body.Bytes(), &settings); err != nil {
		t.Fatal(err)
	}
	if !settings.Enabled || settings.WebhookURL != "https://open.feishu.cn/open-apis/bot/v2/hook/test" || settings.DefaultAdvance != 15 {
		t.Fatalf("unexpected settings: %+v", settings)
	}
}

func TestTaskReminderWorkflowAndNotification(t *testing.T) {
	f := newFixture(t)
	f.setup(t)

	var receivedCount int32
	var lastReceivedBody string
	mockFeishu := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&receivedCount, 1)
		bodyBytes, _ := io.ReadAll(r.Body)
		lastReceivedBody = string(bodyBytes)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"msg":"success"}`))
	}))
	defer mockFeishu.Close()

	// Enable reminders with mock feishu server
	updateBody := map[string]any{
		"enabled":        true,
		"webhookUrl":     mockFeishu.URL,
		"webhookSecret":  "sec_test",
		"defaultAdvance": 5,
	}
	expect(t, f.send(t, "PUT", "/api/settings/reminder", updateBody), 200)

	// Create task scheduled for today with reminder at 09:10, advance 5 min (trigger at 09:05)
	// Current fixture time is 09:00:00
	taskBody := map[string]any{
		"title":           "定时提醒测试计划",
		"bucket":          "today",
		"date":            "2026-10-13",
		"priority":        true,
		"reminderTime":    "09:10",
		"reminderAdvance": 5,
	}
	res := f.send(t, "POST", "/api/tasks", taskBody)
	expect(t, res, 201)
	var task Task
	if err := json.Unmarshal(res.Body.Bytes(), &task); err != nil {
		t.Fatal(err)
	}
	if task.ReminderTime != "09:10" || task.ReminderAdvance != 5 {
		t.Fatalf("unexpected task reminder fields: %+v", task)
	}

	// At 09:00, trigger time 09:05 is not yet reached
	if err := f.server.CheckAndSendReminders(t.Context()); err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&receivedCount) != 0 {
		t.Fatal("should not trigger reminder before trigger time")
	}

	// Advance time to 09:06 (past 09:05 trigger time)
	f.server.now = func() time.Time {
		return time.Date(2026, 10, 13, 9, 6, 0, 0, f.server.location)
	}
	if err := f.server.CheckAndSendReminders(t.Context()); err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&receivedCount) != 1 {
		t.Fatalf("expected 1 notification received, got %d", atomic.LoadInt32(&receivedCount))
	}
	if !strings.Contains(lastReceivedBody, "定时提醒测试计划") || !strings.Contains(lastReceivedBody, "09:10") {
		t.Fatalf("payload should include task title and reminder time: %s", lastReceivedBody)
	}

	// Running check again should not send duplicate notification
	if err := f.server.CheckAndSendReminders(t.Context()); err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&receivedCount) != 1 {
		t.Fatal("should not duplicate notification")
	}

	// Updating reminder time resets reminded_at
	updateTaskBody := map[string]any{
		"version":      task.Version,
		"reminderTime": "09:20",
	}
	res = f.send(t, "PATCH", "/api/tasks/"+task.ID, updateTaskBody)
	expect(t, res, 200)
	var updatedTask Task
	if err := json.Unmarshal(res.Body.Bytes(), &updatedTask); err != nil {
		t.Fatal(err)
	}
	if updatedTask.RemindedAt != "" {
		t.Fatal("remindedAt should be reset after updating reminderTime")
	}
}
