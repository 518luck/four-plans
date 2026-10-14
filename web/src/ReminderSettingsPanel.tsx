import { useState, type FormEvent } from "react";
import { Bell, Check, LoaderCircle, Send } from "lucide-react";
import { jsonBody, request, type ReminderSettings } from "./api";

export default function ReminderSettingsPanel({
  initialSettings,
  onSaved,
  onNotify,
}: {
  initialSettings?: ReminderSettings;
  onSaved: (settings: ReminderSettings) => void;
  onNotify: (msg: string) => void;
}) {
  const [enabled, setEnabled] = useState(initialSettings?.enabled ?? false);
  const [webhookUrl, setWebhookUrl] = useState(
    initialSettings?.webhookUrl ?? "",
  );
  const [webhookSecret, setWebhookSecret] = useState(
    initialSettings?.webhookSecret ?? "",
  );
  const [defaultAdvance, setDefaultAdvance] = useState(
    initialSettings?.defaultAdvance ?? 0,
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (enabled && !webhookUrl.trim()) {
      onNotify("开启提醒时需填写飞书 Webhook 地址");
      return;
    }
    setSaving(true);
    try {
      const saved = await request<ReminderSettings>("/api/settings/reminder", {
        method: "PUT",
        body: jsonBody({
          enabled,
          webhookUrl: webhookUrl.trim(),
          webhookSecret: webhookSecret.trim(),
          defaultAdvance,
        }),
      });
      onSaved(saved);
      onNotify("飞书提醒偏好已保存");
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "保存设置失败");
    } finally {
      setSaving(false);
    }
  }

  async function testWebhook() {
    if (!webhookUrl.trim()) {
      onNotify("请先输入飞书 Webhook 地址");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await request<{ status: string; message: string }>(
        "/api/settings/reminder/test",
        {
          method: "POST",
          body: jsonBody({
            webhookUrl: webhookUrl.trim(),
            webhookSecret: webhookSecret.trim(),
          }),
        },
      );
      setTestResult({ ok: true, msg: res.message || "测试消息发送成功！" });
    } catch (err) {
      setTestResult({
        ok: false,
        msg: err instanceof Error ? err.message : "发送失败，请检查配置",
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="reminder-settings-section">
      <div className="settings-section-title">
        <Bell size={15} />
        <span>飞书机器人提醒偏好</span>
      </div>
      <label className="settings-row">
        <span>
          启用飞书定时提醒<small>到达设定时间后推送到飞书自定义机器人</small>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
      </label>
      {enabled && (
        <form className="settings-field-group" onSubmit={handleSave}>
          <label>
            默认提前提醒偏好
            <select
              value={defaultAdvance}
              onChange={(e) => setDefaultAdvance(Number(e.target.value))}
            >
              <option value={0}>准时提醒</option>
              <option value={5}>提前 5 分钟</option>
              <option value={15}>提前 15 分钟</option>
              <option value={30}>提前 30 分钟</option>
            </select>
          </label>
          <label>
            飞书自定义机器人 Webhook 地址
            <input
              type="url"
              placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              required={enabled}
            />
          </label>
          <label>
            签名密钥 Secret <span className="optional">可选</span>
            <input
              type="password"
              placeholder="若机器人开启了安全设置中的签名校验请填写"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
            />
          </label>
          <div className="settings-reminder-actions">
            <button
              type="button"
              className="button secondary"
              disabled={testing || !webhookUrl.trim()}
              onClick={testWebhook}
            >
              {testing ? (
                <LoaderCircle className="spin" size={13} />
              ) : (
                <Send size={13} />
              )}
              发送测试消息
            </button>
            <button type="submit" className="button primary" disabled={saving}>
              {saving ? (
                <LoaderCircle className="spin" size={13} />
              ) : (
                <Check size={13} />
              )}
              保存设置
            </button>
          </div>
          {testResult && (
            <div
              className={`reminder-test-status ${testResult.ok ? "success" : "error"}`}
            >
              {testResult.msg}
            </div>
          )}
        </form>
      )}
    </div>
  );
}
