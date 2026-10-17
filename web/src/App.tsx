import {
  useCallback,
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  CalendarX,
  Repeat2,
  Settings2,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CloudOff,
  Eye,
  EyeOff,
  GripVertical,
  MoveRight,
  LoaderCircle,
  LogOut,
  Star,
  X,
  Bell,
  Send,
  Monitor,
} from "lucide-react";
import {
  ArrowDownToLine,
  ChartColumnIncreasing,
  ArrowRight,
  BookOpen,
  Clock3,
  Flag,
  Focus,
  LayoutGrid,
  Maximize2,
  Minimize2,
  Moon,
  Pencil,
  Plus,
  RotateCcw,
  Sun,
  Target,
  Trash2,
} from "./icons";
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useReducedMotion,
} from "motion/react";
import {
  ApiError,
  addDays,
  dateLabel,
  jsonBody,
  request,
  today,
  type Board,
  type Bucket,
  type Session,
  type Task,
  type DailyQuote,
  type ReminderSettings,
} from "./api";
import { BoardUpdates } from "./boardUpdates";
import StarSea from "./StarSea";
import ResourcePanel from "./ResourcePanel";
import RecurringPanel from "./RecurringPanel";
import ReschedulePanel from "./ReschedulePanel";
import ReminderSettingsPanel from "./ReminderSettingsPanel";

const definitions = {
  today: {
    title: "今天计划",
    subtitle: "把最重要的事，落在今天",
    empty: "今天，先做好一件重要的事",
    hint: "写下可以直接开始的行动",
    action: "添加今天的行动",
    icon: Focus,
    number: "01",
  },
  three: {
    title: "三天计划",
    subtitle: "为接下来的行动，留一点余地",
    empty: "给接下来的三天留个方向",
    hint: "放入近期行动，准备好后移到今天",
    action: "添加近期行动",
    icon: Clock3,
    number: "02",
  },
  week: {
    title: "周计划",
    subtitle: "用阶段成果，记录这一周",
    empty: "这一周，你想完成什么？",
    hint: "写下 1–3 个希望达成的成果",
    action: "添加本周成果",
    icon: Flag,
    number: "03",
  },
  month: {
    title: "月计划",
    subtitle: "看远一点，让每一步有方向",
    empty: "这个月，把精力放在哪里？",
    hint: "确定 1–3 个最重要的目标",
    action: "添加本月目标",
    icon: Target,
    number: "04",
  },
} as const;
const order: Bucket[] = ["today", "three", "week", "month"];
const StatisticsPanel = lazy(() => import("./StatisticsPanel"));
type Theme = "light" | "dark";
type ThemeMode = "light" | "dark" | "system";

function ThemeToggle({
  mode,
  onChange,
  floating = false,
}: {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
  floating?: boolean;
}) {
  const options: {
    mode: ThemeMode;
    label: string;
    icon: React.ComponentType<{ size?: number | string; className?: string }>;
  }[] = [
    { mode: "light", label: "浅色模式", icon: Sun },
    { mode: "dark", label: "深色模式", icon: Moon },
    { mode: "system", label: "根据系统", icon: Monitor },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="外观主题"
      className={`theme-toggle-group${floating ? " floating-theme-toggle" : ""}`}
    >
      {options.map((item) => {
        const Icon = item.icon;
        const isActive = mode === item.mode;
        return (
          <button
            key={item.mode}
            type="button"
            role="radio"
            aria-checked={isActive}
            className={`theme-toggle-btn${isActive ? " is-active" : ""}`}
            aria-label={item.label}
            title={item.label}
            onClick={() => onChange(item.mode)}
          >
            <Icon size={14} className="theme-toggle-icon" />
          </button>
        );
      })}
    </div>
  );
}
type Editor = {
  bucket: Bucket;
  task?: Task;
  source?: Task;
  reschedule?: boolean;
};

function moveDate(task: Task, bucket: Bucket, anchor: string): string {
  if (bucket !== "three") return anchor;
  return task.date > anchor && task.date <= addDays(anchor, 2)
    ? task.date
    : addDays(anchor, 1);
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <div>
        <strong>四格计划</strong>
        {!compact && <small>把计划落在今天</small>}
      </div>
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => {
      const first =
        panel.current?.querySelector<HTMLElement>(
          'input[name="title"], input[name="username"]',
        ) ||
        panel.current?.querySelector<HTMLElement>(
          "input, textarea, select, button",
        );
      first?.focus();
    }, 0);
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key !== "Tab") return;
      const items = Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]',
        ) || [],
      );
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handle);
    return () => {
      clearTimeout(timer);
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", handle);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
      >
        <header className="modal-header">
          <h2 id={id}>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="关闭弹窗"
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function AuthScreen({
  configured,
  bootstrapRequired = false,
  onSuccess,
}: {
  configured: boolean;
  bootstrapRequired?: boolean;
  onSuccess: (username: string) => void;
}) {
  const [username, setUsername] = useState(configured ? "" : "我的计划");
  const [password, setPassword] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hasAccount, setHasAccount] = useState(configured);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const user = await request<{ username: string }>(
        hasAccount ? "/api/login" : "/api/setup",
        {
          method: "POST",
          body: jsonBody({
            username,
            password,
            ...(!hasAccount && bootstrapRequired ? { accessKey } : {}),
          }),
        },
      );
      onSuccess(user.username);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409)
        setHasAccount(true);
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <section className="auth-intro">
        <Brand />
        <div className="auth-copy">
          <span className="eyebrow">A LITTLE FOCUS, EVERY DAY</span>
          <h1>
            看见远处的目标，
            <br />
            做好今天的事情。
          </h1>
          <p>
            从月到周，从三天到今天。
            <br />
            让每一份计划，都有一个可以开始的地方。
          </p>
          <div className="auth-grid">
            {order.map((bucket) => {
              const Icon = definitions[bucket].icon;
              return (
                <div className={`auth-mini ${bucket}`} key={bucket}>
                  <Icon size={22} />
                  <strong>{definitions[bucket].title}</strong>
                  <small>
                    {bucket === "today"
                      ? "具体行动"
                      : bucket === "three"
                        ? "近期候选"
                        : bucket === "week"
                          ? "阶段成果"
                          : "重点目标"}
                  </small>
                </div>
              );
            })}
          </div>
        </div>
        <span className="auth-foot">少量重点 · 每天重选 · 稳步向前</span>
      </section>
      <section className="auth-form-area">
        <form className="auth-form" onSubmit={submit}>
          <span className="form-symbol">
            <LayoutGrid size={25} />
          </span>
          <h2>{hasAccount ? "欢迎回来" : "开启你的四格计划"}</h2>
          <p>
            {hasAccount
              ? "登录后，继续推进你的计划。"
              : "先设置一个个人账号，保存你的计划。"}
          </p>
          <label>
            昵称
            <input
              name="username"
              autoComplete="username"
              required
              maxLength={32}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="输入你的昵称"
            />
          </label>
          <label>
            密码
            <div className="password-field">
              <input
                name="password"
                autoComplete={hasAccount ? "current-password" : "new-password"}
                type={visible ? "text" : "password"}
                required
                minLength={8}
                maxLength={72}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={hasAccount ? "输入密码" : "设置至少 8 位的密码"}
              />
              <button
                type="button"
                aria-label={visible ? "隐藏密码" : "显示密码"}
                onClick={() => setVisible(!visible)}
              >
                {visible ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </label>
          {!hasAccount && bootstrapRequired && (
            <label>
              初始化密钥
              <input
                type="password"
                autoComplete="off"
                required
                value={accessKey}
                onChange={(event) => setAccessKey(event.target.value)}
                placeholder="由部署者提供，只在首次创建账号时使用"
              />
            </label>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="button primary auth-submit" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <ArrowRight size={18} />
            )}
            {hasAccount ? "登录我的计划" : "创建账号，开始计划"}
          </button>
          <small className="auth-note">
            同一个账号，在连接到同一服务的设备上使用。
          </small>
        </form>
      </section>
    </div>
  );
}

function TaskEditor({
  editor,
  anchor,
  defaultReminderAdvance = 0,
  busy,
  onClose,
  onSave,
  onCancel,
}: {
  editor: Editor;
  anchor: string;
  defaultReminderAdvance?: number;
  busy: boolean;
  onClose: () => void;
  onCancel?: () => void;
  onSave: (input: {
    title: string;
    notes: string;
    bucket: Bucket;
    date: string;
    priority: boolean;
    reminderTime?: string;
    reminderAdvance?: number;
  }) => Promise<boolean>;
}) {
  const [bucket, setBucket] = useState<Bucket>(
    editor.reschedule ? "three" : editor.bucket,
  );
  const [title, setTitle] = useState(editor.task?.title || "");
  const [notes, setNotes] = useState(
    editor.task?.notes ||
      (editor.source ? `推进目标：${editor.source.title}` : ""),
  );
  const [date, setDate] = useState(
    editor.reschedule ? addDays(anchor, 1) : editor.task?.date || anchor,
  );
  const [priority, setPriority] = useState(editor.task?.priority || false);
  const [hasReminder, setHasReminder] = useState(
    Boolean(editor.task?.reminderTime),
  );
  const [reminderTime, setReminderTime] = useState(
    editor.task?.reminderTime || "09:00",
  );
  const [reminderAdvance, setReminderAdvance] = useState(
    editor.task?.reminderAdvance ?? defaultReminderAdvance ?? 0,
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      await onSave({
        title,
        notes,
        bucket,
        date,
        priority,
        reminderTime: hasReminder ? reminderTime : "",
        reminderAdvance: hasReminder ? reminderAdvance : 0,
      })
    )
      onClose();
  }
  return (
    <Modal
      title={
        editor.task
          ? "编辑计划"
          : editor.source
            ? "把目标拆成行动"
            : definitions[bucket].action
      }
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="editor-form" onSubmit={submit}>
        {editor.source && (
          <div className="source-goal">
            <Target size={17} />
            <span>正在推进：{editor.source.title}</span>
          </div>
        )}
        <label>
          放在哪一格
          <select
            value={bucket}
            onChange={(event) => setBucket(event.target.value as Bucket)}
          >
            {order.map((value) => (
              <option key={value} value={value}>
                {definitions[value].title}
              </option>
            ))}
          </select>
        </label>
        <label>
          {bucket === "today" || bucket === "three"
            ? "具体行动"
            : "希望达成的成果"}
          <input
            name="title"
            placeholder={
              bucket === "today"
                ? "例如：画出首页草图"
                : bucket === "three"
                  ? "例如：整理首页设计参考"
                  : bucket === "week"
                    ? "例如：完成作品集首页"
                    : "例如：完成个人作品集"
            }
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            maxLength={160}
            autoFocus
          />
        </label>
        <label>
          {bucket === "week"
            ? "所属周（选择这一周的任意一天）"
            : bucket === "month"
              ? "所属月（选择这个月的任意一天）"
              : "计划日期"}
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            required
            min="0001-01-01"
            max="9999-12-31"
          />
        </label>
        {bucket === "three" && (
          <p className="field-hint">
            三天格显示当前看板日期起的三天；更远的行动会在日期临近时出现。
          </p>
        )}
        <label>
          备注 <span className="optional">可选</span>
          <textarea
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={1000}
            placeholder="补充下一步、完成标准或目标关联…"
          />
        </label>
        {bucket === "today" && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={priority}
              onChange={(event) => setPriority(event.target.checked)}
            />
            <Star size={16} />
            设为这一天的优先事项
          </label>
        )}
        <div className="reminder-editor-group">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={hasReminder}
              onChange={(event) => setHasReminder(event.target.checked)}
            />
            <Bell size={16} />
            设置飞书提醒
          </label>
          {hasReminder && (
            <div className="reminder-inputs">
              <label>
                提醒时间
                <input
                  type="time"
                  value={reminderTime}
                  onChange={(event) => setReminderTime(event.target.value)}
                  required
                />
              </label>
              <label>
                提醒偏好
                <select
                  value={reminderAdvance}
                  onChange={(event) =>
                    setReminderAdvance(Number(event.target.value))
                  }
                >
                  <option value={0}>准时提醒</option>
                  <option value={5}>提前 5 分钟</option>
                  <option value={15}>提前 15 分钟</option>
                  <option value={30}>提前 30 分钟</option>
                </select>
              </label>
            </div>
          )}
        </div>
        <div className="modal-footer">
          {editor.task && !editor.task.done && onCancel && (
            <button
              type="button"
              className="button secondary"
              style={{ marginRight: "auto" }}
              disabled={busy}
              onClick={() => {
                onCancel();
                onClose();
              }}
            >
              <CalendarX size={15} />
              取消此计划
            </button>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button className="button primary" disabled={busy || !title.trim()}>
            {busy ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <Check size={17} />
            )}
            保存计划
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TaskRow({
  task,
  busy,
  onToggle,
  onFocus,
  onEdit,
  onDelete,
  onCancel,
  onBreakdown,
  dragging,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  task: Task;
  busy: boolean;
  onToggle: () => void;
  onFocus: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCancel?: () => void;
  onBreakdown: () => void;
  dragging: boolean;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: () => void;
}) {
  return (
    <div
      className={`task-row ${task.done ? "done" : ""} ${task.priority ? "priority" : ""} ${dragging ? "dragging" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    >
      <span className="task-grip" aria-hidden="true" title="拖到任意计划格">
        <GripVertical size={15} />
      </span>
      <button
        className="task-check"
        aria-label={`${task.done ? "撤销完成" : "完成"}：${task.title}`}
        aria-pressed={task.done}
        disabled={busy}
        onClick={onToggle}
      >
        {task.done && <Check size={14} strokeWidth={3} />}
      </button>
      <div className="task-body">
        <button className="task-title" onClick={onEdit}>
          {task.title}
        </button>
        {task.recurringId && (
          <span className="task-recurring">
            <Repeat2 size={11} />
            每日目标
          </span>
        )}
        {task.notes && <p className="task-notes">{task.notes}</p>}
        <div className="task-meta">
          {task.done && (
            <button
              className="inline-action undo-completion"
              aria-label={`撤销完成并恢复任务：${task.title}`}
              disabled={busy}
              onClick={onToggle}
            >
              <RotateCcw size={12} />
              撤销完成
            </button>
          )}
          {task.priority && (
            <span className="focus-tag">
              <Star size={11} fill="currentColor" />
              先做这个
            </span>
          )}
          {task.reminderTime && (
            <span
              className={`task-reminder-tag ${task.remindedAt ? "reminded" : ""}`}
              title={
                task.remindedAt
                  ? `已于 ${task.remindedAt.slice(11, 16)} 提醒`
                  : task.reminderAdvance
                    ? `将在 ${task.reminderTime} 提前 ${task.reminderAdvance} 分钟提醒`
                    : `将在 ${task.reminderTime} 准时提醒`
              }
            >
              <Bell size={11} />
              {task.reminderTime}
              {task.reminderAdvance ? ` (-${task.reminderAdvance}m)` : ""}
            </span>
          )}
          {task.bucket === "three" && (
            <span>
              <CalendarDays size={11} />
              {dateLabel(task.date)}
            </span>
          )}
          {!task.done &&
            (task.bucket === "week" || task.bucket === "month") && (
              <button
                className="inline-action"
                disabled={busy}
                onClick={onBreakdown}
              >
                拆成今日行动
                <ArrowRight size={12} />
              </button>
            )}
        </div>
      </div>
      <div className="task-actions">
        {task.bucket === "today" && !task.done && (
          <button
            className={`icon-button ${task.priority ? "selected-star" : ""}`}
            aria-label={`${task.priority ? "取消优先" : "设为优先"}：${task.title}`}
            disabled={busy}
            onClick={onFocus}
          >
            <Star size={15} fill={task.priority ? "currentColor" : "none"} />
          </button>
        )}
        {!task.done && onCancel && (
          <button
            className="icon-button cancel-hover"
            aria-label={`取消计划：${task.title}`}
            title="取消计划"
            disabled={busy}
            onClick={onCancel}
          >
            <CalendarX size={14} />
          </button>
        )}
        <button
          className="icon-button"
          aria-label={`编辑：${task.title}`}
          disabled={busy}
          onClick={onEdit}
        >
          <Pencil size={14} />
        </button>
        <button
          className="icon-button danger-hover"
          aria-label={`移除：${task.title}`}
          disabled={busy}
          onClick={onDelete}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const reduceMotion = useReducedMotion();
  const [view, setView] = useState<
    "board" | "statistics" | "recurring" | "reschedule"
  >("board");
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [view]);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try {
      const saved = localStorage.getItem("four-plans-theme");
      if (saved === "light" || saved === "dark" || saved === "system") {
        return saved;
      }
    } catch {
      // Ignore
    }
    return "system";
  });
  const [systemTheme, setSystemTheme] = useState<Theme>(() =>
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
  );
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? "dark" : "light");
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  const theme: Theme = themeMode === "system" ? systemTheme : themeMode;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themeMode = themeMode;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#0a0a0a" : "#fafafa");
    try {
      localStorage.setItem("four-plans-theme", themeMode);
    } catch {
      // The current page can still switch themes without saving a preference.
    }
  }, [theme, themeMode]);
  useEffect(() => {
    const syncTheme = (event: StorageEvent) => {
      if (
        event.key === "four-plans-theme" &&
        (event.newValue === "light" ||
          event.newValue === "dark" ||
          event.newValue === "system")
      )
        setThemeMode(event.newValue);
    };
    window.addEventListener("storage", syncTheme);
    return () => window.removeEventListener("storage", syncTheme);
  }, []);
  const themeToggle = (floating = false) => (
    <ThemeToggle mode={themeMode} onChange={setThemeMode} floating={floating} />
  );
  const [session, setSession] = useState<Session | null>(null);
  const [initialError, setInitialError] = useState("");
  const [anchor, setAnchor] = useState(today);
  const [board, setBoard] = useState<Board | null>(null);
  const boardUpdates = useRef(new BoardUpdates());
  const sessionGeneration = useRef(0);
  const [expandedBucket, setExpandedBucket] = useState<Bucket | null>(null);
  const boardGrid = useRef<HTMLElement>(null);
  const revealFrame = useRef<number | null>(null);
  const revealTimer = useRef<number | undefined>(undefined);
  const [sync, setSync] = useState<"loading" | "saving" | "synced" | "offline">(
    "loading",
  );
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const sequence = useRef(0);
  const lastBoardSequence = useRef(0);
  const realDate = useRef(today());
  const [editor, setEditor] = useState<Editor | null>(null);
  const draggedTaskRef = useRef<Task | null>(null);
  const updatingTaskIdsRef = useRef<Set<string>>(new Set());
  const [updatingTaskIds, setUpdatingTaskIds] = useState<Set<string>>(
    () => new Set(),
  );
  const boardRef = useRef<Board | null>(null);
  boardRef.current = board;
  function displayBoard() {
    const next = boardUpdates.current.snapshot();
    boardRef.current = next;
    setBoard(next);
  }
  function clearBoard() {
    ++sessionGeneration.current;
    ++sequence.current;
    boardUpdates.current.clear();
    updatingTaskIdsRef.current.clear();
    setUpdatingTaskIds(new Set());
    busyRef.current = false;
    setBusy(false);
    displayBoard();
  }
  const pointerDragRef = useRef<{
    task: Task;
    pointerId: number;
    startX: number;
    startY: number;
    anchor: string;
    active: boolean;
  } | null>(null);
  const dragPositionRef = useRef({ x: 0, y: 0 });
  const [dragPosition, setDragPosition] = useState({ x: 0, y: 0 });
  const [draggedTask, setDraggedTask] = useState<Task | null>(null);
  const [dropBucket, setDropBucket] = useState<Bucket | null>(null);
  const [remove, setRemove] = useState<Task | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [purge, setPurge] = useState<Task | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [dailyQuote, setDailyQuote] = useState<DailyQuote | null>(null);
  const [autoRipple, setAutoRipple] = useState(() => {
    try {
      return localStorage.getItem("four-plans-auto-ripple") !== "off";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("four-plans-auto-ripple", autoRipple ? "on" : "off");
    } catch {}
  }, [autoRipple]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === "four-plans-auto-ripple")
        setAutoRipple(event.newValue !== "off");
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const [completedExpanded, setCompletedExpanded] = useState<
    Record<Bucket, boolean>
  >({ today: true, three: true, week: true, month: true });
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
    null,
  );
  const toastTimer = useRef<number | undefined>(undefined);
  const notify = useCallback((text: string, error = false) => {
    clearTimeout(toastTimer.current);
    setToast({ text, error });
    toastTimer.current = window.setTimeout(
      () => setToast(null),
      error ? 6500 : 3500,
    );
  }, []);
  const bootstrap = useCallback(async () => {
    setInitialError("");
    try {
      setSession(await request<Session>("/api/session"));
    } catch (error) {
      setInitialError((error as Error).message);
    }
  }, []);
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  function revealExpandedCard() {
    window.clearTimeout(revealTimer.current);
    revealTimer.current = undefined;
    if (revealFrame.current !== null) cancelAnimationFrame(revealFrame.current);
    // Read after projection transforms have been cleared on the whole layout tree.
    revealFrame.current = requestAnimationFrame(() => {
      revealFrame.current = requestAnimationFrame(() => {
        revealFrame.current = null;
        const card =
          boardGrid.current?.querySelector<HTMLElement>(".is-expanded");
        if (!card) return;
        const top = card.getBoundingClientRect().top;
        if (top < 0 || top >= window.innerHeight - 80)
          window.scrollTo({
            top: Math.max(0, top + window.scrollY - 16),
            behavior: reduceMotion ? "auto" : "smooth",
          });
      });
    });
  }
  useEffect(
    () => () => {
      if (revealFrame.current !== null)
        cancelAnimationFrame(revealFrame.current);
    },
    [],
  );
  useEffect(() => {
    if (!expandedBucket) return;
    if (reduceMotion) {
      revealExpandedCard();
      return;
    }
    // Motion may skip layout animations during a viewport resize.
    const timer = window.setTimeout(revealExpandedCard, 550);
    revealTimer.current = timer;
    return () => window.clearTimeout(timer);
  }, [expandedBucket, reduceMotion]);
  useEffect(() => {
    if (!draggedTask) return;
    let frame: number;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") endDrag();
    };
    window.addEventListener("keydown", cancel);
    window.addEventListener("blur", endDrag);
    const scroll = () => {
      const { x, y } = dragPositionRef.current;
      const amount = y < 70 ? -10 : y > window.innerHeight - 70 ? 10 : 0;
      if (amount) {
        window.scrollBy(0, amount);
        const bucket = document
          .elementFromPoint(x, y)
          ?.closest<HTMLElement>("[data-plan-bucket]")?.dataset.planBucket as
          Bucket | undefined;
        setDropBucket(bucket && bucket !== draggedTask.bucket ? bucket : null);
      }
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", cancel);
      window.removeEventListener("blur", endDrag);
    };
  }, [draggedTask]);
  const username = session?.user?.username;
  const quoteDate = today();
  useEffect(() => {
    if (!username) {
      setDailyQuote(null);
      return;
    }
    const controller = new AbortController();
    let active = true;
    void request<DailyQuote>("/api/quote", {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
    })
      .then((q) => {
        if (active) setDailyQuote(q);
      })
      .catch(() => {
        if (active)
          setDailyQuote({
            date: quoteDate,
            text: "每天向前一点，也是一种坚持。",
            author: "",
            source: "内置文案",
            fallback: true,
          });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [username, quoteDate]);

  const loadBoard = useCallback(async () => {
    if (!username) return false;
    const current = ++sequence.current;
    try {
      const data = await request<Board>(`/api/board?date=${anchor}`);
      if (current !== sequence.current)
        return lastBoardSequence.current > current;
      lastBoardSequence.current = current;
      boardUpdates.current.replace(data);
      displayBoard();
      setSync(updatingTaskIdsRef.current.size ? "saving" : "synced");
      return true;
    } catch (error) {
      if (current !== sequence.current)
        return lastBoardSequence.current > current;
      if (error instanceof ApiError && error.status === 401) {
        setSession({ configured: true, user: null });
        clearBoard();
        notify("登录已过期，请重新登录", true);
      } else setSync("offline");
      return false;
    }
  }, [anchor, username, notify]);
  const loadBoardRef = useRef(loadBoard);
  loadBoardRef.current = loadBoard;

  useEffect(() => {
    if (!username) return;
    setSync("loading");
    void loadBoard();
    const refresh = () => {
      if (draggedTaskRef.current) return;
      const date = today();
      if (!busyRef.current && date !== realDate.current) {
        if (anchor === realDate.current) setAnchor(date);
        realDate.current = date;
        if (anchor !== date) return;
      }
      if (
        !busyRef.current &&
        updatingTaskIdsRef.current.size === 0 &&
        document.visibilityState === "visible"
      )
        void loadBoard();
    };
    const interval = window.setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      ++sequence.current;
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [anchor, loadBoard, username]);

  async function mutate(
    operation: () => Promise<unknown>,
    message: string,
  ): Promise<boolean> {
    if (busyRef.current) return false;
    const generation = sessionGeneration.current;
    ++sequence.current;
    busyRef.current = true;
    setBusy(true);
    setSync("saving");
    try {
      await operation();
      if (generation !== sessionGeneration.current) return false;
      const refreshed = await loadBoardRef.current();
      if (generation !== sessionGeneration.current) return false;
      notify(
        refreshed ? message : "已保存；暂时无法刷新，请稍后重试",
        !refreshed,
      );
      return true;
    } catch (error) {
      if (generation !== sessionGeneration.current) return false;
      if (error instanceof ApiError && error.status === 401) {
        setSession({ configured: true, user: null });
        clearBoard();
      } else await loadBoardRef.current();
      if (generation === sessionGeneration.current)
        notify((error as Error).message, true);
      return false;
    } finally {
      if (generation === sessionGeneration.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  async function update(
    task: Task,
    change: Partial<Task>,
    message: string,
  ): Promise<boolean> {
    if (updatingTaskIdsRef.current.has(task.id)) return false;

    if (change.done === true) {
      const words = [
        "又向前走了一步。",
        "今天的努力，已经留下了记录。",
        "小小的完成，也值得肯定。",
      ];
      message = `已完成 · ${words[(boardRef.current?.statistics.completedPlans || 0) % words.length]}`;
      const targetBucket = change.bucket || task.bucket;
      setCompletedExpanded((exp) =>
        exp[targetBucket] ? exp : { ...exp, [targetBucket]: true },
      );
    }

    // A refresh started before this write must not overwrite its local state.
    ++sequence.current;
    const generation = sessionGeneration.current;
    boardUpdates.current.begin(task, change);
    displayBoard();
    setSync("saving");
    updatingTaskIdsRef.current.add(task.id);
    setUpdatingTaskIds(new Set(updatingTaskIdsRef.current));

    let saved = false;
    let failure: Error | undefined;
    try {
      const serverTask = await request<Task>(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: jsonBody({ version: task.version, ...change }),
      });
      if (generation !== sessionGeneration.current) return false;
      ++sequence.current;
      boardUpdates.current.finish(task.id, serverTask);
      saved = true;
    } catch (error) {
      if (generation !== sessionGeneration.current) return false;
      ++sequence.current;
      boardUpdates.current.finish(task.id);
      failure = error as Error;
      if (error instanceof ApiError && error.status === 401) {
        setSession({ configured: true, user: null });
        clearBoard();
        notify(failure.message, true);
        return false;
      }
    }
    displayBoard();

    // The server owns date ranges, automatic promotion, statistics and versions
    // of other tasks whose priority was cleared. Reconcile after every write.
    const refreshed = await loadBoardRef.current();
    if (generation !== sessionGeneration.current) return false;
    updatingTaskIdsRef.current.delete(task.id);
    setUpdatingTaskIds(new Set(updatingTaskIdsRef.current));
    setSync(
      updatingTaskIdsRef.current.size
        ? "saving"
        : refreshed
          ? "synced"
          : "offline",
    );
    if (failure) {
      notify(failure.message, true);
    } else {
      const refreshingElsewhere = updatingTaskIdsRef.current.size > 0;
      notify(
        refreshed || refreshingElsewhere
          ? message
          : "已保存；暂时无法刷新，请稍后重试",
        !refreshed && !refreshingElsewhere,
      );
    }
    return saved;
  }
  async function moveTask(task: Task, bucket: Bucket, date: string) {
    if (task.bucket === bucket) return false;
    const saved = await update(
      task,
      { bucket, date, priority: false },
      `已移到${definitions[bucket].title}`,
    );
    if (saved && task.done)
      setCompletedExpanded((expanded) => ({ ...expanded, [bucket]: true }));
    return saved;
  }
  function endDrag() {
    pointerDragRef.current = null;
    draggedTaskRef.current = null;
    setDraggedTask(null);
    setDropBucket(null);
  }
  async function exportPlans() {
    try {
      const data = await request<unknown>("/api/export");
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `四格计划-${today()}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("计划已导出");
    } catch (error) {
      notify((error as Error).message, true);
    }
  }
  async function logout() {
    try {
      await request("/api/logout", { method: "POST" });
      ++sequence.current;
      setSession({ configured: true, user: null });
      clearBoard();
      setEditor(null);
      setExpandedBucket(null);
      endDrag();
      setRemove(null);
      setShowTrash(false);
      setShowSettings(false);
      setDailyQuote(null);
      setPurge(null);
      setView("board");
    } catch (error) {
      notify((error as Error).message, true);
    }
  }
  if (!session)
    return (
      <div className="loading-page">
        {themeToggle(true)}
        <Brand />
        {initialError ? (
          <>
            <p role="alert">{initialError}</p>
            <button className="button primary" onClick={() => void bootstrap()}>
              重新连接
            </button>
          </>
        ) : (
          <>
            <LoaderCircle className="spin" />
            <p>正在打开你的计划…</p>
          </>
        )}
      </div>
    );
  if (!session.user)
    return (
      <>
        {themeToggle(true)}
        <AuthScreen
          key={String(session.configured)}
          configured={session.configured}
          bootstrapRequired={session.bootstrapRequired}
          onSuccess={(username) =>
            setSession({ configured: true, user: { username } })
          }
        />
        {toast && (
          <div className={`toast ${toast.error ? "error" : ""}`} role="status">
            {toast.text}
          </div>
        )}
      </>
    );

  const currentBoard = board?.date === anchor ? board : null;
  const todayTasks = currentBoard?.buckets.today || [];
  const pendingToday = todayTasks.filter((task) => !task.done);
  const focusTask = pendingToday.find((task) => task.priority);
  const completedToday = todayTasks.filter((task) => task.done).length;
  const ratio = todayTasks.length
    ? Math.round((completedToday / todayTasks.length) * 100)
    : 0;
  const carryovers = currentBoard?.carryovers || [];
  const cancelled = currentBoard?.cancelled || [];
  const rescheduleCount = carryovers.length + cancelled.length;
  const trash = currentBoard?.trash || [];
  const syncIcon =
    sync === "offline" ? (
      <CloudOff size={14} />
    ) : sync === "synced" ? (
      <CircleCheck size={14} />
    ) : (
      <LoaderCircle className="spin" size={14} />
    );
  const row = (task: Task) => {
    const isTaskUpdating = updatingTaskIds.has(task.id);
    return (
      <TaskRow
        key={task.id}
        task={task}
        busy={busy || isTaskUpdating}
        onToggle={() =>
          void update(
            task,
            { done: !task.done },
            task.done ? "已恢复为未完成" : "又完成了一步",
          )
        }
        onFocus={() =>
          void update(
            task,
            { priority: !task.priority, bucket: task.bucket, date: task.date },
            task.priority ? "已取消优先标记" : "今天先做这件事",
          )
        }
        onEdit={() => setEditor({ bucket: task.bucket, task })}
        onDelete={() => setRemove(task)}
        onCancel={() =>
          void update(
            task,
            { cancelledAt: new Date().toISOString() },
            "计划已取消",
          )
        }
        onBreakdown={() => setEditor({ bucket: "today", source: task })}
        dragging={draggedTask?.id === task.id}
        onPointerDown={(event) => {
          const target = event.target as HTMLElement;
          if (
            busyRef.current ||
            isTaskUpdating ||
            !currentBoard ||
            !event.isPrimary ||
            event.button !== 0 ||
            target.closest("button, input, textarea, select, a") ||
            (event.pointerType !== "mouse" && !target.closest(".task-grip"))
          )
            return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          pointerDragRef.current = {
            task,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            anchor,
            active: false,
          };
        }}
        onPointerMove={(event) => {
          const drag = pointerDragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          if (
            !drag.active &&
            Math.hypot(
              event.clientX - drag.startX,
              event.clientY - drag.startY,
            ) < 6
          )
            return;
          event.preventDefault();
          if (!drag.active) {
            drag.active = true;
            draggedTaskRef.current = drag.task;
            setDraggedTask(drag.task);
          }
          dragPositionRef.current = { x: event.clientX, y: event.clientY };
          setDragPosition(dragPositionRef.current);
          const bucket = document
            .elementFromPoint(event.clientX, event.clientY)
            ?.closest<HTMLElement>("[data-plan-bucket]")?.dataset.planBucket as
            Bucket | undefined;
          setDropBucket(bucket && bucket !== drag.task.bucket ? bucket : null);
        }}
        onPointerUp={(event) => {
          const drag = pointerDragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const bucket = document
            .elementFromPoint(event.clientX, event.clientY)
            ?.closest<HTMLElement>("[data-plan-bucket]")?.dataset.planBucket as
            Bucket | undefined;
          endDrag();
          if (
            drag.active &&
            bucket &&
            bucket !== drag.task.bucket &&
            !busyRef.current &&
            !updatingTaskIdsRef.current.has(drag.task.id) &&
            currentBoard
          )
            void moveTask(
              drag.task,
              bucket,
              moveDate(drag.task, bucket, drag.anchor),
            );
        }}
        onPointerCancel={endDrag}
      />
    );
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="sidebar-section-label">我的空间</div>
        <nav aria-label="主导航">
          <button
            className={`nav-item${view === "board" ? " active" : ""}`}
            onClick={() => setView("board")}
          >
            <LayoutGrid size={18} />
            计划总览
            {view === "board" && <span className="nav-active-dot" />}
          </button>
          <button
            className={`nav-item${view === "statistics" ? " active" : ""}`}
            onClick={() => setView("statistics")}
          >
            <ChartColumnIncreasing size={18} />
            计划统计
            {view === "statistics" && <span className="nav-active-dot" />}
          </button>
          <button
            className={`nav-item${view === "recurring" ? " active" : ""}`}
            onClick={() => setView("recurring")}
          >
            <Repeat2 size={18} />
            持久计划
            {view === "recurring" && <span className="nav-active-dot" />}
          </button>
          <button
            className={`nav-item${view === "reschedule" ? " active" : ""}`}
            onClick={() => setView("reschedule")}
          >
            <RotateCcw size={18} />
            待重新安排
            {view === "reschedule" && <span className="nav-active-dot" />}
          </button>
          <button className="nav-item" onClick={() => setShowTrash(true)}>
            <Trash2 size={18} />
            回收站
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setShowRules(true)}>
            <BookOpen size={17} />
            使用规则
          </button>
          <button className="nav-item" onClick={() => void exportPlans()}>
            <ArrowDownToLine size={17} />
            导出计划
          </button>
          <div className="user-profile">
            <button
              className="profile-open"
              aria-label="打开个人设置"
              onClick={() => setShowSettings(true)}
            >
              <span className="avatar">{username?.slice(0, 1)}</span>
              <div>
                <strong>{username}</strong>
                <small>个人计划空间</small>
              </div>
            </button>
            <button
              className="icon-button"
              aria-label="退出登录"
              onClick={() => void logout()}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="page-header">
          <div className="breadcrumb">
            <LayoutGrid size={14} />
            <span>我的空间</span>
            <ChevronRight size={13} />
            <strong>
              {view === "statistics"
                ? "计划统计"
                : view === "recurring"
                  ? "持久计划"
                  : view === "reschedule"
                    ? "待重新安排"
                    : "计划总览"}
            </strong>
          </div>
          <div className="header-actions">
            <button
              className="icon-button mobile-utility"
              aria-label="打开持久计划"
              onClick={() => setView("recurring")}
            >
              <Repeat2 size={16} />
            </button>
            <div
              className={`sync-status ${sync}`}
              title={
                currentBoard
                  ? `最近保存检查：${new Date(currentBoard.syncedAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" })}`
                  : undefined
              }
            >
              {syncIcon}
              <span>
                {sync === "offline"
                  ? "连接中断"
                  : sync === "saving"
                    ? "正在保存"
                    : sync === "loading"
                      ? "正在同步"
                      : "已同步"}
              </span>
            </div>
            <button
              className="icon-button mobile-utility"
              aria-label="打开回收站"
              onClick={() => setShowTrash(true)}
            >
              <Trash2 size={16} />
            </button>
            <button
              className="icon-button mobile-utility"
              aria-label="查看使用规则"
              onClick={() => setShowRules(true)}
            >
              <BookOpen size={16} />
            </button>
            <button
              className="icon-button mobile-utility"
              aria-label="导出全部计划"
              onClick={() => void exportPlans()}
            >
              <ArrowDownToLine size={16} />
            </button>
          </div>
        </header>
        {view === "recurring" ? (
          <RecurringPanel
            plans={board?.recurringPlans}
            busy={busy}
            loading={sync === "loading"}
            onBack={() => setView("board")}
            onReloadBoard={() => void loadBoard()}
            onSave={(plan, input) =>
              mutate(
                () =>
                  request(
                    plan ? `/api/recurring/${plan.id}` : "/api/recurring",
                    {
                      method: plan ? "PATCH" : "POST",
                      body: jsonBody(
                        plan ? { version: plan.version, ...input } : input,
                      ),
                    },
                  ),
                plan ? "目标已更新，明日起生效" : "持久目标已创建",
              )
            }
          />
        ) : view === "statistics" ? (
          <Suspense
            fallback={
              <div className="statistics-loading" role="status">
                <LoaderCircle className="spin" size={22} />
                正在打开统计…
              </div>
            }
          >
            <StatisticsPanel
              statistics={board?.statistics}
              autoRipple={autoRipple}
              loading={sync === "loading"}
              onRetry={() => void loadBoard()}
              onBack={() => setView("board")}
              onNavigateToDay={(targetDate) => {
                setAnchor(targetDate);
                setView("board");
              }}
            />
          </Suspense>
        ) : view === "reschedule" ? (
          <ReschedulePanel
            carryovers={carryovers}
            cancelled={cancelled}
            anchor={anchor}
            busy={busy}
            updatingTaskIds={updatingTaskIds}
            onUpdate={update}
            onOpenEditor={setEditor}
            onDelete={(task: Task) => setRemove(task)}
            onBackToBoard={() => setView("board")}
          />
        ) : (
          <>
            <section className="heading-row">
              <div>
                <div className="eyebrow">YOUR PLANS, AT A GLANCE</div>
                <h1>
                  让每一天，都有方向<span className="heading-dot">.</span>
                </h1>
                <p>看清今天的重点，也记得远处的目标。</p>
              </div>
              <div className="date-controls">
                <button
                  className="icon-button"
                  aria-label="前一天"
                  disabled={busy}
                  onClick={() => setAnchor(addDays(anchor, -1))}
                >
                  <ChevronLeft size={18} />
                </button>
                <label className="date-picker">
                  <CalendarDays size={16} />
                  <input
                    aria-label="查看日期"
                    type="date"
                    value={anchor}
                    disabled={busy}
                    min="0001-01-01"
                    max="9999-12-31"
                    onChange={(event) => {
                      if (event.target.value) setAnchor(event.target.value);
                    }}
                  />
                </label>
                <button
                  className="icon-button"
                  aria-label="后一天"
                  disabled={busy}
                  onClick={() => setAnchor(addDays(anchor, 1))}
                >
                  <ChevronRight size={18} />
                </button>
                {anchor !== today() && (
                  <button
                    className="today-button"
                    disabled={busy}
                    onClick={() => setAnchor(today())}
                  >
                    回到今天
                  </button>
                )}
              </div>
            </section>
            {sync === "offline" && (
              <div className="connection-banner" role="alert">
                <CloudOff size={17} />
                <span>
                  暂时连接不上服务，已显示的计划仍然保留。请重试后再操作。
                </span>
                <button onClick={() => void loadBoard()}>重新连接</button>
              </div>
            )}
            <section className="day-overview">
              <StarSea theme={theme} />
              <div className="focus-summary">
                <div>
                  <span className="overview-label">
                    {anchor === today() ? "今天" : "这一天"}，先做这个
                  </span>
                  {focusTask ? (
                    <button
                      onClick={() =>
                        setEditor({ bucket: "today", task: focusTask })
                      }
                    >
                      {focusTask.title}
                      <ArrowRight size={16} />
                    </button>
                  ) : (
                    <button
                      onClick={() =>
                        pendingToday.length
                          ? notify("点击今天计划里的星标，选择一件优先事项")
                          : setEditor({ bucket: "today" })
                      }
                    >
                      选一件最重要的事
                      <ArrowRight size={16} />
                    </button>
                  )}
                </div>
              </div>
              <div className="overview-divider" />
              <div className="day-progress">
                <div>
                  <span className="overview-label">
                    {anchor === today() ? "今日进度" : "当日进度"}
                  </span>
                  <strong>
                    {completedToday}
                    <small> / {todayTasks.length} 项</small>
                  </strong>
                </div>
                <div
                  className="progress-ring"
                  style={{ "--progress": `${ratio}%` } as CSSProperties}
                >
                  <span>
                    {ratio}
                    <small>%</small>
                  </span>
                </div>
              </div>
              <div className="overview-divider second" />
              <div className="day-date">
                <span className="overview-label">
                  {dateLabel(anchor, true)}
                </span>
                <p>
                  {pendingToday.length > 3
                    ? "今天的事情有点多，试着选出 3 个重点。"
                    : "把有限的精力，留给真正重要的事。"}
                </p>
              </div>
            </section>
            {dailyQuote?.date === quoteDate && anchor === quoteDate && (
              <div className="daily-quote">
                <p>{dailyQuote.text}</p>
                {!dailyQuote.fallback && (
                  <a
                    className="quote-credit"
                    href="https://api.vsaa.cn/detail/19"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {dailyQuote.author ? `${dailyQuote.author} · ` : ""}万象语录
                  </a>
                )}
              </div>
            )}
            <div className="board-toolbar">
              <span>
                <i className="legend-dot" />
                四个时间尺度，一份清晰的计划
              </span>
              <div className="board-toolbar-actions">
                <button
                  className="review-button"
                  onClick={() => setView("statistics")}
                >
                  <ChartColumnIncreasing size={14} />
                  计划统计
                </button>
                <button
                  className="review-button"
                  onClick={() => setView("reschedule")}
                >
                  <RotateCcw size={14} />
                  待重新安排
                  {rescheduleCount > 0 && <b>{rescheduleCount}</b>}
                </button>
              </div>
            </div>
            <LayoutGroup>
              <motion.section
                ref={boardGrid}
                layout={!reduceMotion}
                layoutDependency={expandedBucket}
                onLayoutAnimationComplete={revealExpandedCard}
                className={`board-grid${expandedBucket ? " is-focused" : ""}`}
                aria-label="计划四宫格"
                aria-busy={sync === "loading"}
              >
                {order.map((bucket) => {
                  const definition = definitions[bucket],
                    Icon = definition.icon;
                  const tasks = currentBoard?.buckets[bucket] || [],
                    pending = tasks.filter((task) => !task.done),
                    completed = tasks.filter((task) => task.done);
                  const period = currentBoard?.periods[bucket];
                  const range = period
                    ? bucket === "today"
                      ? dateLabel(period.start, true)
                      : bucket === "month"
                        ? `${period.start.slice(0, 4)} 年 ${Number(period.start.slice(5, 7))} 月`
                        : `${dateLabel(period.start)} — ${dateLabel(period.end)}`
                    : "正在加载…";
                  return (
                    <motion.article
                      layout={!reduceMotion}
                      layoutDependency={expandedBucket}
                      initial={false}
                      style={{
                        borderRadius: 13,
                        zIndex: expandedBucket === bucket ? 2 : 1,
                      }}
                      onLayoutAnimationComplete={() => {
                        if (expandedBucket === bucket) revealExpandedCard();
                      }}
                      className={`plan-card ${bucket} ${expandedBucket === bucket ? "is-expanded" : expandedBucket ? "is-condensed" : ""} ${draggedTask && draggedTask.bucket !== bucket ? "drop-ready" : ""} ${dropBucket === bucket ? "drop-active" : ""}`}
                      key={bucket}
                      data-plan-bucket={bucket}
                    >
                      {dropBucket === bucket && (
                        <div className="drop-prompt" aria-hidden="true">
                          <MoveRight size={19} />
                          松手，移到{definition.title}
                        </div>
                      )}
                      <motion.header
                        layout={!reduceMotion}
                        layoutDependency={expandedBucket}
                        className="card-header"
                      >
                        <motion.div
                          layout={reduceMotion ? false : "position"}
                          layoutDependency={expandedBucket}
                          className="card-heading"
                        >
                          <span className="card-icon">
                            <Icon size={21} />
                          </span>
                          <div>
                            <h2>
                              {definition.title}
                              <span className="task-count">{tasks.length}</span>
                            </h2>
                            <span className="card-range">{range}</span>
                          </div>
                        </motion.div>
                        <motion.div
                          layout={reduceMotion ? false : "position"}
                          layoutDependency={expandedBucket}
                          className="card-toolbar"
                        >
                          <button
                            className="icon-button card-expand"
                            aria-label={`${expandedBucket === bucket ? "还原" : "放大"}${definition.title}`}
                            aria-pressed={expandedBucket === bucket}
                            title={
                              expandedBucket === bucket
                                ? "还原四宫格"
                                : "放大这一格"
                            }
                            onClick={() =>
                              setExpandedBucket((current) =>
                                current === bucket ? null : bucket,
                              )
                            }
                            disabled={!!draggedTask}
                          >
                            {expandedBucket === bucket ? (
                              <Minimize2 size={16} />
                            ) : (
                              <Maximize2 size={16} />
                            )}
                          </button>
                          <button
                            className="icon-button card-add"
                            aria-label={definition.action}
                            onClick={() => setEditor({ bucket })}
                            disabled={busy || !currentBoard}
                          >
                            <Plus size={20} />
                          </button>
                        </motion.div>
                      </motion.header>
                      <motion.p
                        layout={reduceMotion ? false : "position"}
                        layoutDependency={expandedBucket}
                        className="card-subtitle"
                      >
                        {definition.subtitle}
                      </motion.p>
                      <motion.div
                        layout={reduceMotion ? false : "position"}
                        layoutDependency={expandedBucket}
                        layoutScroll
                        className="card-content"
                      >
                        {!currentBoard && sync === "loading" ? (
                          <div className="empty-state">
                            <LoaderCircle className="spin" size={24} />
                            <strong>正在读取计划</strong>
                          </div>
                        ) : pending.length ? (
                          <div className="task-list">{pending.map(row)}</div>
                        ) : (
                          <div className="empty-state">
                            <span className="empty-illustration">
                              <Icon size={27} strokeWidth={1.4} />
                              <span className="empty-spark">+</span>
                            </span>
                            <strong>
                              {completed.length
                                ? "这一格的计划都完成了"
                                : definition.empty}
                            </strong>
                            <p>
                              {completed.length
                                ? "需要继续做？可在下方撤销完成。"
                                : definition.hint}
                            </p>
                          </div>
                        )}
                        {completed.length > 0 && (
                          <div className="completed-group">
                            <button
                              className="completed-toggle"
                              aria-expanded={completedExpanded[bucket]}
                              aria-controls={`completed-${bucket}`}
                              onClick={() =>
                                setCompletedExpanded((expanded) => ({
                                  ...expanded,
                                  [bucket]: !expanded[bucket],
                                }))
                              }
                            >
                              <ChevronDown size={13} />
                              已完成 {completed.length} 项
                            </button>
                            <div
                              id={`completed-${bucket}`}
                              hidden={!completedExpanded[bucket]}
                            >
                              {completed.map(row)}
                            </div>
                          </div>
                        )}
                      </motion.div>
                      <motion.footer
                        layout={!reduceMotion}
                        layoutDependency={expandedBucket}
                        className="card-footer"
                      >
                        <motion.div
                          className="card-footer-content"
                          layout={reduceMotion ? false : "position"}
                          layoutDependency={expandedBucket}
                        >
                          <button
                            className="add-task-button"
                            onClick={() => setEditor({ bucket })}
                            disabled={busy || !currentBoard}
                          >
                            <Plus size={16} />
                            {definition.action}
                          </button>
                          <span>{definition.number}</span>
                        </motion.div>
                      </motion.footer>
                    </motion.article>
                  );
                })}
              </motion.section>
              <motion.footer
                layout={reduceMotion ? false : "position"}
                layoutDependency={expandedBucket}
                className="page-footer"
              >
                <span>每天重选 · 三天滚动 · 周一开启新一周</span>
                <button onClick={() => setShowRules(true)}>
                  怎样使用四格
                  <ArrowRight size={12} />
                </button>
              </motion.footer>
            </LayoutGroup>
          </>
        )}
      </main>
      {draggedTask && (
        <div
          className="drag-preview"
          aria-hidden="true"
          style={{
            left: Math.min(
              dragPosition.x + 14,
              Math.max(8, window.innerWidth - 296),
            ),
            top: Math.min(
              dragPosition.y + 14,
              Math.max(8, window.innerHeight - 60),
            ),
          }}
        >
          <GripVertical size={16} />
          <span>{draggedTask.title}</span>
        </div>
      )}
      {editor && (
        <TaskEditor
          editor={editor}
          anchor={anchor}
          defaultReminderAdvance={board?.reminderSettings?.defaultAdvance ?? 0}
          busy={busy}
          onClose={() => setEditor(null)}
          onCancel={
            editor.task && !editor.task.done
              ? () => {
                  void update(
                    editor.task!,
                    { cancelledAt: new Date().toISOString() },
                    "计划已取消",
                  );
                }
              : undefined
          }
          onSave={(input) =>
            editor.task
              ? update(
                  editor.task,
                  editor.reschedule ? { ...input, cancelledAt: "" } : input,
                  "计划已更新",
                )
              : mutate(
                  () =>
                    request("/api/tasks", {
                      method: "POST",
                      body: jsonBody(input),
                    }),
                  "计划已添加",
                )
          }
        />
      )}
      {remove && (
        <Modal
          title="将这项计划移入回收站？"
          onClose={() => {
            if (!busy) setRemove(null);
          }}
        >
          <div className="delete-copy">
            <p>「{remove.title}」将从计划列表中移除，保留在回收站。</p>
            <small>
              可在回收站恢复；如果只是晚一点做，也可以编辑计划日期。
            </small>
          </div>
          <div className="modal-footer">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setRemove(null)}
            >
              保留计划
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                if (
                  await mutate(
                    () =>
                      request(`/api/tasks/${remove.id}`, {
                        method: "DELETE",
                        body: jsonBody({ version: remove.version }),
                      }),
                    "计划已移入回收站",
                  )
                )
                  setRemove(null);
              }}
            >
              移入回收站
            </button>
          </div>
        </Modal>
      )}
      {showTrash && !purge && (
        <Modal
          title={`回收站${trash.length ? ` · ${trash.length}` : ""}`}
          wide
          onClose={() => {
            if (!busy) setShowTrash(false);
          }}
        >
          <p className="review-intro">
            已删除的计划会保留在这里，不会自动清理。恢复时保留原日期和完成状态，过期未完成的计划会回到“待重新安排”。永久删除后无法恢复。
          </p>
          <div className="review-list trash-list">
            {!currentBoard ? (
              <div className="review-empty">
                <p>
                  {sync === "offline"
                    ? "暂时无法读取回收站，请重新连接。"
                    : "正在读取回收站…"}
                </p>
                {sync === "offline" && (
                  <button
                    className="button secondary"
                    onClick={() => void loadBoard()}
                  >
                    重新连接
                  </button>
                )}
              </div>
            ) : trash.length ? (
              trash.map((task) => (
                <div className="review-item" key={task.id}>
                  <div>
                    <span className={`bucket-chip ${task.bucket}`}>
                      {definitions[task.bucket].title}
                    </span>
                    <small>
                      {task.date} · {task.done ? "已完成" : "未完成"}
                    </small>
                    <h3>{task.title}</h3>
                    {task.notes && <p className="trash-notes">{task.notes}</p>}
                    <p>
                      删除于{" "}
                      {new Date(task.deletedAt!).toLocaleString("zh-CN", {
                        timeZone: "Asia/Shanghai",
                        hour12: false,
                      })}
                    </p>
                  </div>
                  <div className="review-actions">
                    <button
                      className="button small secondary"
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          () =>
                            request(`/api/trash/${task.id}/restore`, {
                              method: "POST",
                              body: jsonBody({ version: task.version }),
                            }),
                          !task.done &&
                            task.date < currentBoard.periods[task.bucket].start
                            ? "已恢复，可在待重新安排中处理"
                            : "已恢复到原日期",
                        )
                      }
                    >
                      <RotateCcw size={14} />
                      恢复
                    </button>
                    <button
                      className="button small danger"
                      disabled={busy}
                      onClick={() => setPurge(task)}
                    >
                      永久删除
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="review-empty">
                <Trash2 size={35} />
                <h3>回收站是空的</h3>
                <p>移除的计划会出现在这里，随时可以恢复。</p>
              </div>
            )}
          </div>
        </Modal>
      )}
      {purge && (
        <Modal
          title="永久删除这项计划？"
          onClose={() => {
            if (!busy) setPurge(null);
          }}
        >
          <div className="delete-copy">
            <p>「{purge.title}」的标题、备注和计划记录将被永久删除。</p>
            <small>此操作无法撤销，删除后不能从回收站恢复。</small>
          </div>
          <div className="modal-footer">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setPurge(null)}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                if (
                  await mutate(
                    () =>
                      request(`/api/trash/${purge.id}`, {
                        method: "DELETE",
                        body: jsonBody({ version: purge.version }),
                      }),
                    "计划已永久删除",
                  )
                )
                  setPurge(null);
              }}
            >
              确认永久删除
            </button>
          </div>
        </Modal>
      )}
      {showSettings && (
        <Modal title="个人设置" onClose={() => setShowSettings(false)}>
          <div className="settings-panel">
            <div className="settings-profile">
              <span className="avatar">{username?.slice(0, 1)}</span>
              <div>
                <strong>{username}</strong>
                <small>个人计划空间</small>
              </div>
            </div>
            <div className="settings-row">
              <span>外观主题</span>
              {themeToggle()}
            </div>
            <label className="settings-row">
              <span>
                自动播放热力图波纹<small>每 10 秒一次</small>
              </span>
              <input
                type="checkbox"
                checked={autoRipple}
                onChange={(e) => setAutoRipple(e.target.checked)}
              />
            </label>
            <div className="settings-row">
              <span>
                鼓励语录<small>万象 · 每天一句</small>
              </span>
              <a
                href="https://api.vsaa.cn/detail/19"
                target="_blank"
                rel="noreferrer"
              >
                来源
              </a>
            </div>
            <ReminderSettingsPanel
              initialSettings={board?.reminderSettings}
              onSaved={(newSettings) => {
                boardUpdates.current.setReminderSettings(newSettings);
                displayBoard();
              }}
              onNotify={(msg) => notify(msg)}
            />
            <ResourcePanel />
          </div>
        </Modal>
      )}
      {showRules && (
        <Modal
          title="四格，怎么用更轻松"
          wide
          onClose={() => setShowRules(false)}
        >
          <div className="rules-grid">
            {order.map((bucket) => {
              const Icon = definitions[bucket].icon;
              return (
                <div key={bucket} className={`rule-item ${bucket}`}>
                  <Icon size={21} />
                  <h3>{definitions[bucket].title}</h3>
                  <p>
                    {bucket === "today"
                      ? "写可以立即开始的具体行动。选一件优先事项，再安排少量次要事项。"
                      : bucket === "three"
                        ? "覆盖所选日期、后一天和后两天。近期行动准备好了，就移入今天。"
                        : bucket === "week"
                          ? "周一至周日，记录 1–3 个阶段成果。可以保留成果，再拆出今日行动。"
                          : "按自然月，确定 1–3 个重点目标，给这一段时间一个方向。"}
                  </p>
                </div>
              );
            })}
          </div>
          <div className="rules-note">
            <strong>同一个行动，不用抄四遍。</strong>
            <p>
              计划可以拖到任意一格，移动会保留原来的内容和完成状态；周、月的目标也可以另行拆成今日行动。昨天未完成的事，每天重新选择。日期均按北京时间计算。
            </p>
          </div>
        </Modal>
      )}
      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`} role="status">
          {toast.error ? <CloudOff size={17} /> : <CircleCheck size={17} />}
          {toast.text}
          <button onClick={() => setToast(null)} aria-label="关闭提示">
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
