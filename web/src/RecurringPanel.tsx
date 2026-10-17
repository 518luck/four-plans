import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  type FormEvent,
  type MouseEvent,
  type CSSProperties,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  Plus,
  Pencil,
  Repeat2,
  Pause,
  Play,
  Square,
  ChevronLeft,
  Check,
  Flame,
  Trophy,
  AlertCircle,
  LoaderCircle,
  CalendarCheck,
} from "lucide-react";
import {
  addDays,
  today,
  dateLabel,
  getRecurringRecords,
  checkinRecurring,
  type RecurringPlan,
  type RecurringHistory,
  type RecurringRecord,
  type RecurringDayStatus,
} from "./api";
import "./recurring.css";

export default function RecurringPanel({
  plans,
  busy,
  loading,
  onSave,
  onBack,
  onReloadBoard,
}: {
  plans?: RecurringPlan[];
  busy: boolean;
  loading: boolean;
  onSave: (
    plan: RecurringPlan | null,
    input: Record<string, unknown>,
  ) => Promise<boolean>;
  onBack: () => void;
  onReloadBoard?: () => void;
}) {
  const reduced = useReducedMotion();
  const [editing, setEditing] = useState<RecurringPlan | null | undefined>(
    undefined,
  );
  const [stopping, setStopping] = useState<string | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);

  const date = today();

  // Keep selected plan valid
  const effectiveSelectedPlan =
    plans?.find((p) => p.id === selectedPlanId) ||
    (plans && plans.length > 0 ? plans[0] : null);

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
        <div className="recurring-layout-container">
          {/* 上层：持久任务有哪些 */}
          <section className="recurring-layer-top" aria-label="持久任务有哪些">
            <div className="recurring-layer-header">
              <div className="layer-title-group">
                <h2>持久任务列表</h2>
                <span className="layer-subtitle">
                  共 {plans.length} 个目标 · 点击卡片切换下方打卡墙
                </span>
              </div>
            </div>

            <div className="recurring-list">
              {plans.map((plan) => {
                const isSelected = effectiveSelectedPlan?.id === plan.id;
                const totalDays =
                  Math.round(
                    (Date.parse(plan.end) - Date.parse(plan.start)) / 86400000,
                  ) + 1;
                const completed = plan.completed || 0;
                const missed = plan.missed || 0;
                const completedPercent = Math.min(
                  100,
                  (completed * 100) / totalDays,
                );
                const missedPercent = Math.min(
                  100 - completedPercent,
                  (missed * 100) / totalDays,
                );

                return (
                  <article
                    className={`recurring-card ${isSelected ? "is-selected" : ""}`}
                    key={plan.id}
                    onClick={() => setSelectedPlanId(plan.id)}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedPlanId(plan.id);
                      }
                    }}
                  >
                    <header>
                      <span className="recurring-symbol">
                        <Repeat2 size={18} />
                      </span>
                      <div className="recurring-card-header-main">
                        <div className="recurring-card-title-row">
                          <h2>{plan.title}</h2>
                          {isSelected && (
                            <span className="selected-indicator-pill">
                              <Check size={11} strokeWidth={2.5} />
                              当前查看
                            </span>
                          )}
                        </div>
                        <span className="recurring-status">
                          {statusLabel(plan)}
                        </span>
                      </div>
                    </header>

                    {plan.notes && (
                      <p className="recurring-notes">{plan.notes}</p>
                    )}

                    <div className="recurring-dates">
                      {plan.start.replaceAll("-", "/")} —{" "}
                      {plan.end.replaceAll("-", "/")}
                      <span>{totalDays} 天</span>
                    </div>

                    <div className="recurring-progress-summary">
                      <div className="recurring-progress-stats">
                        <span className="stat-completed">
                          已完成 <strong>{completed}</strong> / {totalDays} 天
                        </span>
                        {missed > 0 ? (
                          <span className="stat-missed">
                            漏打卡 <strong>{missed}</strong> 天
                          </span>
                        ) : (
                          <span className="stat-all-good">暂无漏卡</span>
                        )}
                      </div>
                      <span className="stat-rate">
                        {Math.round(completedPercent)}%
                      </span>
                    </div>

                    {/* 双段进度条：展示已完成与漏卡对比 */}
                    <div
                      className="recurring-progress-track dual"
                      role="progressbar"
                      aria-label="目标进度"
                      aria-valuemin={0}
                      aria-valuemax={totalDays}
                      aria-valuenow={Math.min(completed, totalDays)}
                      aria-valuetext={`已完成 ${completed} 天，漏打卡 ${missed} 天`}
                    >
                      <i
                        className="progress-completed-bar"
                        style={{ width: `${completedPercent}%` }}
                        title={`已完成 ${completed} 天`}
                      />
                      <i
                        className="progress-missed-bar"
                        style={{ width: `${missedPercent}%` }}
                        title={`漏打卡 ${missed} 天`}
                      />
                    </div>

                    {plan.status !== "stopped" && (
                      <footer>
                        <button
                          disabled={busy}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditing(plan);
                          }}
                        >
                          <Pencil size={14} />
                          修改
                        </button>
                        {plan.end >= date && (
                          <button
                            disabled={busy}
                            onClick={(e) => {
                              e.stopPropagation();
                              void onSave(plan, {
                                status:
                                  plan.status === "paused"
                                    ? "active"
                                    : "paused",
                              });
                            }}
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
                          onClick={(e) => {
                            e.stopPropagation();
                            setStopping(plan.id);
                          }}
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
                        onClick={(e) => e.stopPropagation()}
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
          </section>

          {/* 下层：选中任务的打卡墙 / 活跃墙 */}
          {effectiveSelectedPlan && (
            <PunchInWallSection
              plan={effectiveSelectedPlan}
              onReloadBoard={onReloadBoard}
            />
          )}
        </div>
      )}
    </motion.section>
  );
}

// 模块级打卡记录缓存，实现切换计划时 0ms 无缝呈现与数据无感刷新
const recurringRecordsCache = new Map<string, RecurringHistory>();

// 根据计划起止日期精确计算周数列数，确保骨架屏与真实日历列数与尺寸 100% 吻合
function computeWeeksCount(start: string, end: string): number {
  try {
    const s = new Date(`${start}T12:00:00Z`);
    const e = new Date(`${end}T12:00:00Z`);
    const startDayOfWeek = (s.getUTCDay() + 6) % 7; // Mon=0, Sun=6
    const totalDays = Math.max(
      1,
      Math.round((e.getTime() - s.getTime()) / 86400000) + 1,
    );
    const totalCells = startDayOfWeek + totalDays;
    return Math.ceil(totalCells / 7);
  } catch {
    return 6;
  }
}

function PunchInWallSection({
  plan,
  onReloadBoard,
}: {
  plan: RecurringPlan;
  onReloadBoard?: () => void;
}) {
  const [historyState, setHistoryState] = useState<RecurringHistory | null>(
    () => {
      return recurringRecordsCache.get(plan.id) ?? null;
    },
  );
  const [isFetching, setIsFetching] = useState(false);
  const [checkingDate, setCheckingDate] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{
    record: RecurringRecord;
    x: number;
    y: number;
  } | null>(null);

  const todayDate = today();

  // 若当前 state 属于当前 plan，或者缓存中有当前 plan，立即使用；避免任何消失与抖动
  const history =
    (historyState?.planId === plan.id ? historyState : null) ??
    recurringRecordsCache.get(plan.id) ??
    null;

  useEffect(() => {
    setTooltip(null);
    setCheckingDate(null);

    const cached = recurringRecordsCache.get(plan.id);
    if (cached) {
      setHistoryState(cached);
    } else {
      setHistoryState(null);
    }

    let active = true;
    setIsFetching(true);
    void getRecurringRecords(plan.id)
      .then((res) => {
        if (!active) return;
        recurringRecordsCache.set(plan.id, res);
        setHistoryState(res);
      })
      .catch(() => {
        // 出错保留已有展示
      })
      .finally(() => {
        if (active) setIsFetching(false);
      });

    return () => {
      active = false;
    };
  }, [plan.id, plan.version]);

  const handleCheckin = async (record: RecurringRecord) => {
    if (record.status === "upcoming" || record.status === "paused") {
      return;
    }
    const nextDone = record.status !== "completed";
    setCheckingDate(record.date);
    try {
      const updated = await checkinRecurring(plan.id, record.date, nextDone);
      recurringRecordsCache.set(plan.id, updated);
      setHistoryState(updated);
      onReloadBoard?.();
    } catch {
      // Error handled by request
    } finally {
      setCheckingDate(null);
    }
  };

  const skeletonWeeksCount = useMemo(
    () => computeWeeksCount(plan.start, plan.end),
    [plan.start, plan.end],
  );

  // Build calendar matrix (Monday..Sunday rows, weeks columns)
  const calendarWeeks = (() => {
    if (!history || !history.records.length) return [];
    const records = history.records;
    const startUtc = new Date(`${records[0].date}T12:00:00Z`);
    // 0 is Mon, 6 is Sun
    const startDayOfWeek = (startUtc.getUTCDay() + 6) % 7;

    const allDays: (RecurringRecord | null)[] = [
      ...Array<null>(startDayOfWeek).fill(null),
      ...records,
    ];
    const trailingCount = (7 - (allDays.length % 7)) % 7;
    for (let i = 0; i < trailingCount; i++) {
      allDays.push(null);
    }

    const weeks: {
      weekIndex: number;
      days: (RecurringRecord | null)[];
    }[] = [];

    for (let i = 0; i < allDays.length; i += 7) {
      weeks.push({
        weekIndex: i / 7,
        days: allDays.slice(i, i + 7),
      });
    }
    return weeks;
  })();

  const months = calendarWeeks.flatMap((week) => {
    const day =
      week.days.find((day) => day?.date.endsWith("-01")) ||
      week.days.find((day) => day?.date === plan.start);
    return day
      ? [{ index: week.weekIndex, label: `${Number(day.date.slice(5, 7))}月` }]
      : [];
  });

  const completionRate = history
    ? history.passedDays > 0
      ? Math.round((history.completedDays / history.passedDays) * 100)
      : 0
    : 0;

  const handleCellMouseEnter = (
    e: MouseEvent<HTMLButtonElement>,
    record: RecurringRecord,
  ) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({
      record,
      x: rect.left + rect.width / 2,
      y: rect.top - 8,
    });
  };

  const handleCellMouseLeave = () => {
    setTooltip(null);
  };

  const statusName = (status: RecurringDayStatus) => {
    switch (status) {
      case "completed":
        return "已打卡";
      case "missed":
        return "漏打卡";
      case "pending":
        return "今日待打卡";
      case "upcoming":
        return "未开始";
      case "paused":
        return "暂停期";
    }
  };

  const actionHint = (record: RecurringRecord) => {
    if (record.status === "missed") return "点击直接补卡";
    if (record.status === "completed") return "点击取消打卡";
    if (record.status === "pending") return "点击完成今日打卡";
    if (record.status === "upcoming") return "未来日期，暂不可打卡";
    if (record.status === "paused") return "该日期处于暂停状态";
    return "";
  };

  return (
    <section className="recurring-layer-bottom" aria-label="打卡墙">
      <div className="punch-wall-card">
        {/* 打卡墙头部 */}
        <header className="punch-wall-header">
          <div className="punch-wall-title-area">
            <span className="punch-wall-badge">
              <CalendarCheck size={14} />
              打卡活跃墙
            </span>
            <div className="punch-wall-title-row">
              <h3>{plan.title}</h3>
              <span className="punch-wall-date-range">
                {plan.start.replaceAll("-", "/")} —{" "}
                {plan.end.replaceAll("-", "/")}
                {history && ` · 共 ${history.totalDays} 天`}
              </span>
              {isFetching && history && (
                <span
                  className="punch-wall-syncing"
                  title="正在静默校验最新打卡记录"
                >
                  <LoaderCircle size={12} className="spin" />
                  <span className="syncing-text">更新中</span>
                </span>
              )}
            </div>
          </div>
        </header>

        {history ? (
          <>
            {/* 指标统计栏 */}
            <div className="punch-wall-metrics">
              <div className="metric-box">
                <span className="metric-value">{completionRate}%</span>
                <span className="metric-label">达成率</span>
                <span className="metric-sub">
                  已过 {history.passedDays} / {history.totalDays} 天
                </span>
              </div>
              <div className="metric-box">
                <span className="metric-value">{history.completedDays}</span>
                <span className="metric-label">已打卡天数</span>
                <span className="metric-sub">
                  剩余 {Math.max(0, history.totalDays - history.completedDays)}{" "}
                  天
                </span>
              </div>
              <div
                className={`metric-box ${history.missedDays > 0 ? "has-missed" : ""}`}
              >
                <span className="metric-value">{history.missedDays}</span>
                <span className="metric-label">漏打卡天数</span>
                <span className="metric-sub">
                  {history.missedDays > 0 ? "点击格子可随时补卡" : "全勤无遗漏"}
                </span>
              </div>
              <div className="metric-box">
                <span className="metric-value">
                  {history.currentStreak}
                  <Flame size={15} className="metric-icon streak-flame" />
                </span>
                <span className="metric-label">当前连续</span>
                <span className="metric-sub">
                  {history.currentStreak > 0
                    ? "保持每日好势头"
                    : "今日打卡重启连续"}
                </span>
              </div>
              <div className="metric-box">
                <span className="metric-value">
                  {history.longestStreak}
                  <Trophy size={14} className="metric-icon streak-trophy" />
                </span>
                <span className="metric-label">最长连续</span>
                <span className="metric-sub">历史最高纪录</span>
              </div>
            </div>

            {/* 打卡热力日历网格 */}
            <div className="activity-scroller">
              <div
                className="activity-calendar"
                style={
                  {
                    "--activity-weeks": calendarWeeks.length,
                  } as CSSProperties
                }
              >
                <div
                  className="heatmap-columns"
                  role="group"
                  aria-label="按天完成热力图，左右方向键切换周，上下方向键切换天"
                >
                  {calendarWeeks.map((week) => (
                    <div className="heatmap-week" key={week.weekIndex}>
                      {week.days.map((day, dayIndex) => {
                        if (!day) {
                          return (
                            <span
                              key={`outside-${dayIndex}`}
                              className="heatmap-cell outside-range"
                              aria-hidden="true"
                            />
                          );
                        }

                        const isToday = day.date === todayDate;
                        const isChecking = checkingDate === day.date;
                        const isClickable =
                          day.status === "completed" ||
                          day.status === "missed" ||
                          day.status === "pending";

                        return (
                          <button
                            key={day.date}
                            type="button"
                            className={`heatmap-cell ${day.status} ${isToday ? "is-today" : ""} ${isChecking ? "is-checking" : ""}`}
                            data-status={day.status}
                            data-today={isToday ? "true" : undefined}
                            tabIndex={-1}
                            disabled={!isClickable || isChecking}
                            onClick={() => void handleCheckin(day)}
                            onMouseEnter={(e) => handleCellMouseEnter(e, day)}
                            onMouseLeave={handleCellMouseLeave}
                            aria-label={`${day.date}，${statusName(day.status)}`}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
                <div className="heatmap-months" aria-hidden="true">
                  {months.map((month) => (
                    <span
                      key={month.index}
                      style={{
                        gridColumn: `${month.index + 1} / span ${Math.min(2, calendarWeeks.length - month.index)}`,
                      }}
                    >
                      {month.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* 浮动提示框 */}
            {tooltip && (
              <div
                className="punch-tooltip"
                style={{
                  left: tooltip.x,
                  top: tooltip.y,
                }}
              >
                <div className="tooltip-date">
                  {dateLabel(tooltip.record.date, true)}
                </div>
                <div className="tooltip-status-row">
                  <span className={`status-pill ${tooltip.record.status}`}>
                    {statusName(tooltip.record.status)}
                  </span>
                  <span className="action-hint">
                    {actionHint(tooltip.record)}
                  </span>
                </div>
              </div>
            )}

            {/* 图例与操作提示 */}
            <footer className="punch-wall-footer">
              <div className="punch-legend">
                <span className="legend-item">
                  <i
                    className="heatmap-cell completed"
                    data-status="completed"
                  />
                  已打卡
                </span>
                <span className="legend-item">
                  <i className="heatmap-cell missed" data-status="missed" />
                  漏打卡（可补卡）
                </span>
                <span className="legend-item">
                  <i
                    className="heatmap-cell pending is-today"
                    data-status="pending"
                  />
                  今日待打卡
                </span>
                <span className="legend-item">
                  <i className="heatmap-cell upcoming" data-status="upcoming" />
                  未开始
                </span>
                {history.records.some((r) => r.status === "paused") && (
                  <span className="legend-item">
                    <i className="heatmap-cell paused" data-status="paused" />
                    暂停中
                  </span>
                )}
              </div>

              <div className="punch-tip">
                <AlertCircle size={13} />
                <span>
                  提示：点击任意<strong>漏打卡</strong>日期可立即补卡；点击
                  <strong>已打卡</strong>日期可取消。
                </span>
              </div>
            </footer>
          </>
        ) : (
          <>
            {/* 等高精密骨架屏：结构、网格列数与真实内容 1:1 吻合，彻底杜绝布局抖动 */}
            <div className="punch-wall-metrics skeleton">
              <div className="metric-box">
                <span className="metric-value">
                  <span className="metric-skeleton-val" />
                </span>
                <span className="metric-label">达成率</span>
                <span className="metric-sub">
                  <span className="metric-skeleton-sub" />
                </span>
              </div>
              <div className="metric-box">
                <span className="metric-value">
                  <span className="metric-skeleton-val" />
                </span>
                <span className="metric-label">已打卡天数</span>
                <span className="metric-sub">
                  <span className="metric-skeleton-sub" />
                </span>
              </div>
              <div className="metric-box">
                <span className="metric-value">
                  <span className="metric-skeleton-val" />
                </span>
                <span className="metric-label">漏打卡天数</span>
                <span className="metric-sub">
                  <span className="metric-skeleton-sub" />
                </span>
              </div>
              <div className="metric-box">
                <span className="metric-value">
                  <span className="metric-skeleton-val" />
                  <Flame
                    size={15}
                    className="metric-icon streak-flame"
                    style={{ opacity: 0.25 }}
                  />
                </span>
                <span className="metric-label">当前连续</span>
                <span className="metric-sub">
                  <span className="metric-skeleton-sub" />
                </span>
              </div>
              <div className="metric-box">
                <span className="metric-value">
                  <span className="metric-skeleton-val" />
                  <Trophy
                    size={14}
                    className="metric-icon streak-trophy"
                    style={{ opacity: 0.25 }}
                  />
                </span>
                <span className="metric-label">最长连续</span>
                <span className="metric-sub">
                  <span className="metric-skeleton-sub" />
                </span>
              </div>
            </div>

            <div className="activity-scroller">
              <div
                className="activity-calendar"
                style={
                  {
                    "--activity-weeks": skeletonWeeksCount,
                  } as CSSProperties
                }
              >
                <div className="heatmap-columns skeleton" aria-hidden="true">
                  {Array.from({ length: skeletonWeeksCount }).map((_, wIdx) => (
                    <div className="heatmap-week" key={wIdx}>
                      {Array.from({ length: 7 }).map((_, dIdx) => (
                        <span
                          key={dIdx}
                          className="heatmap-cell skeleton-cell"
                          aria-hidden="true"
                        />
                      ))}
                    </div>
                  ))}
                </div>
                <div
                  className="heatmap-months skeleton-months"
                  aria-hidden="true"
                >
                  <span style={{ gridColumn: "1 / span 2" }}>
                    {Number(plan.start.slice(5, 7))}月
                  </span>
                </div>
              </div>
            </div>

            <footer className="punch-wall-footer">
              <div className="punch-legend">
                <span className="legend-item">
                  <i
                    className="heatmap-cell completed"
                    data-status="completed"
                  />
                  已打卡
                </span>
                <span className="legend-item">
                  <i className="heatmap-cell missed" data-status="missed" />
                  漏打卡（可补卡）
                </span>
                <span className="legend-item">
                  <i
                    className="heatmap-cell pending is-today"
                    data-status="pending"
                  />
                  今日待打卡
                </span>
                <span className="legend-item">
                  <i className="heatmap-cell upcoming" data-status="upcoming" />
                  未开始
                </span>
              </div>
              <div className="punch-tip">
                <LoaderCircle size={13} className="spin" />
                <span>正在加载打卡记录…</span>
              </div>
            </footer>
          </>
        )}
      </div>
    </section>
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
