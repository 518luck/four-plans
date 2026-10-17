import { useState, useMemo } from "react";
import {
  RotateCcw,
  CalendarX,
  Clock,
  Trash2,
  CalendarPlus,
  Calendar,
  CheckCircle2,
  AlertCircle,
  Bell,
  ArrowRight,
} from "lucide-react";
import type { Task, Bucket } from "./api";
import "./reschedule.css";

const bucketNames: Record<Bucket, string> = {
  today: "今天计划",
  three: "三天计划",
  week: "周计划",
  month: "月计划",
};

interface ReschedulePanelProps {
  carryovers: Task[];
  cancelled: Task[];
  anchor: string;
  busy: boolean;
  updatingTaskIds: Set<string>;
  onUpdate: (
    task: Task,
    change: Partial<Task>,
    message: string,
  ) => Promise<boolean>;
  onOpenEditor: (params: {
    bucket: Bucket;
    task: Task;
    reschedule?: boolean;
  }) => void;
  onDelete: (task: Task) => void;
  onBackToBoard?: () => void;
}

export default function ReschedulePanel({
  carryovers,
  cancelled,
  anchor,
  busy,
  updatingTaskIds,
  onUpdate,
  onOpenEditor,
  onDelete,
  onBackToBoard,
}: ReschedulePanelProps) {
  const [tab, setTab] = useState<"all" | "overdue" | "cancelled">("all");

  const totalCount = carryovers.length + cancelled.length;

  const displayList = useMemo(() => {
    if (tab === "overdue") return carryovers;
    if (tab === "cancelled") return cancelled;
    // 全部展示时：未按时完成优先，已取消紧随其后
    return [...carryovers, ...cancelled];
  }, [tab, carryovers, cancelled]);

  const handleContinueToday = async (task: Task) => {
    await onUpdate(
      task,
      { bucket: "today", date: anchor, cancelledAt: "" },
      task.cancelledAt ? "已重新激活并安排到今天" : "已重新选入今天继续执行",
    );
  };

  const handleCancelTask = async (task: Task) => {
    await onUpdate(
      task,
      { cancelledAt: new Date().toISOString() },
      "计划已取消，可在「已取消计划」中查看或重新激活",
    );
  };

  return (
    <div className="reschedule-panel">
      {/* 头部标题与类别切换 */}
      <header className="reschedule-header">
        <div className="reschedule-title-area">
          <div className="reschedule-title-row">
            <span className="reschedule-badge">
              <RotateCcw size={15} />
              待重新安排
            </span>
            <div className="reschedule-filter-tabs" role="tablist">
              <button
                type="button"
                className={`filter-tab ${tab === "all" ? "is-active" : ""}`}
                onClick={() => setTab("all")}
              >
                全部 <span className="tab-count">{totalCount}</span>
              </button>
              <button
                type="button"
                className={`filter-tab ${tab === "overdue" ? "is-active" : ""}`}
                onClick={() => setTab("overdue")}
              >
                未按时完成 <span className="tab-count">{carryovers.length}</span>
              </button>
              <button
                type="button"
                className={`filter-tab ${tab === "cancelled" ? "is-active" : ""}`}
                onClick={() => setTab("cancelled")}
              >
                已取消计划 <span className="tab-count">{cancelled.length}</span>
              </button>
            </div>
          </div>
          <p className="reschedule-subtitle">
            {tab === "overdue"
              ? `共有 ${carryovers.length} 项过去未按时完成的计划，您可以选择放入今天继续、重新改期或取消。`
              : tab === "cancelled"
                ? `共有 ${cancelled.length} 项主动取消的计划，您可以随时重新激活或彻底清理。`
                : `共 ${totalCount} 项待处理计划（${carryovers.length} 项未按时完成，${cancelled.length} 项已取消）。`}
          </p>
        </div>
      </header>

      {/* 列表主体 */}
      <section className="reschedule-content">
        {displayList.length === 0 ? (
          <div className="reschedule-empty">
            <CheckCircle2 size={40} className="empty-icon" />
            <h3>
              {tab === "overdue"
                ? "太棒了，没有未按时完成的遗留计划"
                : tab === "cancelled"
                  ? "没有已取消的计划"
                  : "当前没有任何需要重新安排的计划"}
            </h3>
            <p>所有的行动都已按时搞定，把注意力留给当下就好。</p>
            {onBackToBoard && (
              <button
                type="button"
                className="button secondary back-board-btn"
                onClick={onBackToBoard}
              >
                返回计划总览
                <ArrowRight size={14} />
              </button>
            )}
          </div>
        ) : (
          <div className="reschedule-list">
            {displayList.map((task) => {
              const isCancelled = !!task.cancelledAt;
              const isUpdating = updatingTaskIds.has(task.id);

              return (
                <article
                  key={task.id}
                  className={`reschedule-card ${isCancelled ? "is-cancelled" : "is-overdue"}`}
                >
                  <div className="card-main">
                    <div className="card-tags">
                      <span className={`bucket-tag ${task.bucket}`}>
                        {bucketNames[task.bucket] || task.bucket}
                      </span>
                      {isCancelled ? (
                        <span className="status-tag tag-cancelled">
                          <CalendarX size={12} />
                          已取消
                        </span>
                      ) : (
                        <span className="status-tag tag-overdue">
                          <Clock size={12} />
                          未按时完成
                        </span>
                      )}
                      <span className="date-info">原定于 {task.date}</span>
                      {task.reminderTime && (
                        <span className="reminder-info" title="曾配置提醒">
                          <Bell size={11} />
                          {task.reminderTime}
                        </span>
                      )}
                    </div>

                    <h3 className="card-title">{task.title}</h3>

                    {task.notes && <p className="card-notes">{task.notes}</p>}
                  </div>

                  <div className="card-actions">
                    <button
                      type="button"
                      className="button small primary"
                      disabled={busy || isUpdating}
                      onClick={() => void handleContinueToday(task)}
                      title="选入今天行动清单继续执行"
                    >
                      <CalendarPlus size={14} />
                      {isCancelled ? "重新放入今天" : "放入今天继续"}
                    </button>

                    <button
                      type="button"
                      className="button small secondary"
                      disabled={busy || isUpdating}
                      onClick={() =>
                        onOpenEditor({
                          bucket: task.bucket,
                          task,
                          reschedule: true,
                        })
                      }
                      title="修改日期与所属计划格"
                    >
                      <Calendar size={14} />
                      改期
                    </button>

                    {!isCancelled && (
                      <button
                        type="button"
                        className="button small ghost cancel-action-btn"
                        disabled={busy || isUpdating}
                        onClick={() => void handleCancelTask(task)}
                        title="取消此计划，移入已取消分类"
                      >
                        <CalendarX size={14} />
                        取消计划
                      </button>
                    )}

                    <button
                      type="button"
                      className="icon-button danger-hover"
                      disabled={busy || isUpdating}
                      onClick={() => onDelete(task)}
                      title="移入回收站"
                      aria-label={`移除计划：${task.title}`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
