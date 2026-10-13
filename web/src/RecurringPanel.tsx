import { useState, type FormEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  Plus,
  Pencil,
  Repeat2,
  Pause,
  Play,
  Square,
  ChevronLeft,
} from "lucide-react";
import { addDays, today, type RecurringPlan } from "./api";
import "./recurring.css";

export default function RecurringPanel({
  plans,
  busy,
  loading,
  onSave,
  onBack,
}: {
  plans?: RecurringPlan[];
  busy: boolean;
  loading: boolean;
  onSave: (
    plan: RecurringPlan | null,
    input: Record<string, unknown>,
  ) => Promise<boolean>;
  onBack: () => void;
}) {
  const reduced = useReducedMotion();
  const [editing, setEditing] = useState<RecurringPlan | null | undefined>(
    undefined,
  );
  const [stopping, setStopping] = useState<string | null>(null);
  const date = today();
  const statusLabel = (plan: RecurringPlan) => {
    if (plan.end < date) return "已到期";
    if (plan.status === "stopped")
      return plan.effectiveDate > date ? "明日起停止" : "已停止";
    if (plan.status === "paused")
      return plan.effectiveDate > date ? "明日起暂停" : "已暂停";
    if (plan.start > date) return "尚未开始";
    if (plan.effectiveDate > date) return "明日起更新";
    return "进行中";
  };
  return (
    <motion.section
      className="recurring-page"
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <button className="statistics-back" onClick={onBack}>
        <ChevronLeft size={14} />
        返回计划
      </button>
      <header className="recurring-heading">
        <div>
          <div className="eyebrow">ONE GOAL, EVERY DAY</div>
          <h1>持久计划</h1>
        </div>
        <button
          className="button primary"
          disabled={busy || !plans}
          onClick={() => setEditing(null)}
        >
          <Plus size={16} />
          新建目标
        </button>
      </header>
      {editing !== undefined && (
        <RecurringEditor
          key={editing?.id || "new"}
          plan={editing}
          busy={busy}
          onCancel={() => setEditing(undefined)}
          onSave={async (input) => {
            if (await onSave(editing, input)) setEditing(undefined);
          }}
        />
      )}
      {!plans ? (
        <div className="recurring-empty">
          {loading ? "正在读取目标…" : "暂时无法读取目标，请返回计划后重试。"}
        </div>
      ) : !plans.length && editing === undefined ? (
        <div className="recurring-empty">
          <Repeat2 size={28} />
          <h2>从一个小目标开始</h2>
          <button className="button secondary" onClick={() => setEditing(null)}>
            新建持久计划
          </button>
        </div>
      ) : (
        <div className="recurring-list">
          {plans.map((plan) => {
            const totalDays =
              Math.round(
                (Date.parse(plan.end) - Date.parse(plan.start)) / 86400000,
              ) + 1;
            const progress = Math.min(100, (plan.completed * 100) / totalDays);
            return (
              <article className="recurring-card" key={plan.id}>
                <header>
                  <span className="recurring-symbol">
                    <Repeat2 size={20} />
                  </span>
                  <div>
                    <h2>{plan.title}</h2>
                    <span className="recurring-status">
                      {statusLabel(plan)}
                    </span>
                  </div>
                </header>
                {plan.notes && <p className="recurring-notes">{plan.notes}</p>}
                <div className="recurring-dates">
                  {plan.start.replaceAll("-", "/")} —{" "}
                  {plan.end.replaceAll("-", "/")}
                  <span>{totalDays} 天</span>
                </div>
                <div className="recurring-progress">
                  <span>
                    已完成 {plan.completed} / {totalDays} 天
                  </span>
                  <span>{Math.round(progress)}%</span>
                </div>
                <div
                  className="recurring-progress-track"
                  role="progressbar"
                  aria-label="目标进度"
                  aria-valuemin={0}
                  aria-valuemax={totalDays}
                  aria-valuenow={Math.min(plan.completed, totalDays)}
                  aria-valuetext={`已完成 ${plan.completed} / ${totalDays} 天`}
                >
                  <i
                    style={{
                      width: `${progress}%`,
                    }}
                  />
                </div>
                {plan.status !== "stopped" && (
                  <footer>
                    <button disabled={busy} onClick={() => setEditing(plan)}>
                      <Pencil size={14} />
                      修改
                    </button>
                    {plan.end >= date && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void onSave(plan, {
                            status:
                              plan.status === "paused" ? "active" : "paused",
                          })
                        }
                      >
                        {plan.status === "paused" ? (
                          <Play size={14} />
                        ) : (
                          <Pause size={14} />
                        )}{" "}
                        {plan.status === "paused" ? "恢复" : "暂停"}
                      </button>
                    )}
                    <button
                      disabled={busy}
                      onClick={() => setStopping(plan.id)}
                    >
                      <Square size={13} />
                      停止
                    </button>
                  </footer>
                )}
                {stopping === plan.id && (
                  <div
                    className="recurring-confirm"
                    role="group"
                    aria-label="确认停止目标"
                  >
                    <p>停止生成任务，保留历史记录？</p>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => setStopping(null)}
                    >
                      取消
                    </button>
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={async () => {
                        if (await onSave(plan, { status: "stopped" }))
                          setStopping(null);
                      }}
                    >
                      确认停止
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </motion.section>
  );
}

function RecurringEditor({
  plan,
  busy,
  onCancel,
  onSave,
}: {
  plan: RecurringPlan | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (input: Record<string, unknown>) => Promise<void>;
}) {
  const [title, setTitle] = useState(plan?.title || "");
  const [notes, setNotes] = useState(plan?.notes || "");
  const [start, setStart] = useState(plan?.start || today());
  const [mode, setMode] = useState("days");
  const [days, setDays] = useState(
    plan
      ? Math.round((Date.parse(plan.end) - Date.parse(plan.start)) / 86400000) +
          1
      : 30,
  );
  const [end, setEnd] = useState(plan?.end || addDays(today(), 29));
  const selectedEnd =
    mode === "days" && Number.isInteger(days) && days >= 1 && days <= 3651
      ? addDays(start, days - 1)
      : end;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const startValue = String(values.get("start") || start);
    const deadline =
      mode === "days"
        ? addDays(startValue, Number(values.get("days")) - 1)
        : String(values.get("end"));
    await onSave(
      plan
        ? { title, notes, end: deadline }
        : { title, notes, start: startValue, end: deadline },
    );
  }
  return (
    <form className="recurring-editor" onSubmit={(event) => void submit(event)}>
      <h2>{plan ? "修改目标 · 明日起生效" : "新建持久目标"}</h2>
      <fieldset disabled={busy}>
        <label>
          目标
          <input
            autoFocus
            name="title"
            required
            maxLength={160}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：每天读书 30 分钟"
          />
        </label>
        <label>
          备注
          <textarea
            maxLength={1000}
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <div className="recurring-form-row">
          <label>
            开始日期
            <input
              type="date"
              name="start"
              required
              min={today()}
              max="9999-12-31"
              disabled={!!plan}
              value={start}
              onInput={(e) => {
                if (e.currentTarget.value) setStart(e.currentTarget.value);
              }}
              onChange={(e) => {
                if (e.target.value) setStart(e.target.value);
              }}
            />
          </label>
          <label>
            持续方式
            <select
              value={mode}
              onChange={(e) => {
                if (e.target.value === "days")
                  setDays(
                    Math.round(
                      (Date.parse(end) - Date.parse(start)) / 86400000,
                    ) + 1,
                  );
                else setEnd(selectedEnd);
                setMode(e.target.value);
              }}
            >
              <option value="days">坚持多少天</option>
              <option value="date">坚持到某天</option>
            </select>
          </label>
        </div>
        {mode === "days" ? (
          <label>
            坚持天数
            <input
              type="number"
              name="days"
              required
              min={1}
              max={3651}
              step={1}
              value={days || ""}
              onChange={(e) => setDays(Number(e.target.value))}
            />
          </label>
        ) : (
          <label>
            截止日期
            <input
              type="date"
              name="end"
              required
              min={plan ? addDays(today(), 1) : start}
              max={addDays(start, 3650)}
              value={end}
              onInput={(e) => setEnd(e.currentTarget.value)}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
        )}
        <div className="recurring-editor-footer">
          <span>截至 {selectedEnd}（含当天）</span>
          <div>
            <button
              type="button"
              className="button secondary"
              onClick={onCancel}
            >
              取消
            </button>
            <button className="button primary" type="submit">
              {busy ? "正在保存…" : "保存目标"}
            </button>
          </div>
        </div>
      </fieldset>
    </form>
  );
}
