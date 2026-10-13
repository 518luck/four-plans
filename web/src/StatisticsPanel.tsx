import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type CSSProperties,
} from "react";
import { ChevronLeft, LoaderCircle } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { request, addDays, type ActivityDay, type PlanStatistics } from "./api";
import "./statistics.css";

type Mode = "daily" | "weekly" | "cumulative";
const RIPPLE_DURATION = 1000;
const RIPPLE_STEP = 32;
type Week = {
  start: string;
  end: string;
  count: number;
  days: (ActivityDay | null)[];
};
const modes: { value: Mode; label: string }[] = [
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "cumulative", label: "累计总量" },
];
const number = new Intl.NumberFormat("zh-CN");
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "UTC",
  year: "numeric",
  month: "long",
  day: "numeric",
});
function longDate(date: string) {
  return dateFormatter.format(new Date(`${date}T12:00:00Z`));
}
function level(value: number, maximum: number) {
  return value <= 0
    ? 0
    : Math.max(1, Math.min(4, Math.ceil((value / Math.max(maximum, 1)) * 4)));
}
function makeWeeks(days: ActivityDay[]): Week[] {
  if (!days.length) return [];
  const offset = (new Date(`${days[0].date}T12:00:00Z`).getUTCDay() + 6) % 7;
  const first = addDays(days[0].date, -offset);
  return Array.from(
    { length: Math.ceil((offset + days.length) / 7) },
    (_, column) => {
      const values = Array.from(
        { length: 7 },
        (_, row) => days[column * 7 + row - offset] || null,
      );
      const valid = values.filter((day): day is ActivityDay => !!day);
      return {
        start: valid[0]?.date || addDays(first, column * 7),
        end: valid.at(-1)?.date || addDays(first, column * 7 + 6),
        count: valid.reduce((sum, day) => sum + day.count, 0),
        days: values,
      };
    },
  );
}

export default function StatisticsPanel({
  statistics,
  autoRipple,
  loading,
  onRetry,
  onBack,
}: {
  statistics?: PlanStatistics;
  autoRipple: boolean;
  loading: boolean;
  onRetry: () => void;
  onBack: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [year, setYear] = useState("recent");
  const [historical, setHistorical] = useState<{
    year: string;
    data: PlanStatistics;
  } | null>(null);
  const [yearError, setYearError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (year === "recent") {
      setYearError("");
      return;
    }
    const controller = new AbortController();
    let active = true;
    setYearError("");
    void request<PlanStatistics>(`/api/statistics?year=${year}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
    })
      .then((data) => {
        if (active) setHistorical({ year, data });
      })
      .catch((error) => {
        if (active) setYearError((error as Error).message);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [year, statistics, retry]);
  const data =
    year === "recent"
      ? statistics
      : historical?.year === year
        ? historical.data
        : undefined;
  const yearControl = (
    <select
      className="activity-year"
      aria-label="活动年份"
      value={year}
      onChange={(e) => {
        setYear(e.target.value);
        setHistorical(null);
        setYearError("");
      }}
    >
      <option value="recent">最近 365 天</option>
      {statistics?.years?.map((y) => (
        <option key={y} value={String(y)}>
          {y} 年
        </option>
      ))}
    </select>
  );
  return (
    <motion.section
      className="statistics-page"
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, type: "tween" }}
      aria-label="计划统计"
    >
      <button className="statistics-back" onClick={onBack}>
        <ChevronLeft size={14} />
        返回计划
      </button>
      <div className="statistics-heading">
        <h1>计划统计</h1>
        <p>每一份完成，都在积累进步。</p>
      </div>
      {!data ? (
        <div className="statistics-unavailable" role="status">
          {yearControl}
          {loading || (year !== "recent" && !yearError) ? (
            <>
              <LoaderCircle size={22} className="spin" />
              <p>正在读取统计…</p>
            </>
          ) : (
            <>
              <p>{yearError || "暂时无法读取统计数据。"}</p>
              <button
                className="button secondary"
                onClick={() =>
                  year === "recent" ? onRetry() : setRetry((n) => n + 1)
                }
              >
                重新读取
              </button>
            </>
          )}
        </div>
      ) : (
        <StatisticsContent
          key={year}
          statistics={data}
          autoRipple={autoRipple}
          yearControl={yearControl}
          rangeLabel={year === "recent" ? "最近 365 天" : `${year} 年`}
        />
      )}
    </motion.section>
  );
}

function StatisticsContent({
  statistics,
  autoRipple,
  yearControl,
  rangeLabel,
}: {
  statistics: PlanStatistics;
  autoRipple: boolean;
  yearControl: React.ReactNode;
  rangeLabel: string;
}) {
  const reduceMotion = useReducedMotion();
  const [mode, setMode] = useState<Mode>("daily");
  const [ripple, setRipple] = useState<{
    column: number;
    row: number;
    serial: number;
  } | null>(null);
  const rippleSerial = useRef(0);
  const lastInteraction = useRef(0);
  const [activeIndex, setActiveIndex] = useState(statistics.days.length - 1);
  const [tooltip, setTooltip] = useState<{
    kind: "day" | "week";
    index: number;
    x: number;
    y: number;
  } | null>(null);
  const card = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const cells = useRef<(HTMLButtonElement | null)[]>([]);
  const tooltipId = useId();
  const weeks = useMemo(() => makeWeeks(statistics.days), [statistics.days]);
  const maxDaily = Math.max(
    1,
    ...statistics.days.map((day) =>
      mode === "cumulative" ? day.cumulative : day.count,
    ),
  );
  const maxWeekly = Math.max(1, ...weeks.map((week) => week.count));
  const inRangeCount = statistics.days.reduce((sum, day) => sum + day.count, 0);
  const activeDays = statistics.days.filter((day) => day.count > 0).length;
  const months = weeks.flatMap((week, index) => {
    const day =
      week.days.find((day) => day?.date.endsWith("-01")) ||
      week.days.find((day) => day?.date === statistics.start);
    return day ? [{ index, label: `${Number(day.date.slice(5, 7))}月` }] : [];
  });
  useEffect(() => {
    setActiveIndex(
      mode === "weekly" ? weeks.length - 1 : statistics.days.length - 1,
    );
    setTooltip(null);
    const element = scroller.current;
    if (element)
      element.scrollLeft = Math.max(
        0,
        element.scrollWidth - element.clientWidth,
      );
  }, [statistics.end, mode, weeks.length, statistics.days.length]);
  useEffect(() => {
    setRipple(null);
  }, [mode, statistics.end, reduceMotion]);
  useEffect(() => {
    if (reduceMotion || !weeks.length) return;
    // Start inside the visible chart, including the latest dates on mobile.
    const element = scroller.current;
    const column = element
      ? Math.max(
          0,
          Math.min(
            weeks.length - 1,
            Math.floor(
              (element.scrollLeft + element.clientWidth / 2) /
                (element.scrollWidth / weeks.length),
            ),
          ),
        )
      : Math.floor(weeks.length / 2);
    setRipple({ column, row: 3, serial: ++rippleSerial.current });
  }, [statistics.end, weeks.length, reduceMotion]);
  useEffect(() => {
    if (!autoRipple || reduceMotion || !weeks.length) return;
    const play = () => {
      const element = scroller.current;
      if (
        !element ||
        document.hidden ||
        Date.now() - lastInteraction.current < 10000
      )
        return;
      const bounds = element.getBoundingClientRect();
      if (bounds.bottom <= 0 || bounds.top >= window.innerHeight) return;
      const column = Math.max(
        0,
        Math.min(
          weeks.length - 1,
          Math.floor(
            (element.scrollLeft + element.clientWidth / 2) /
              (element.scrollWidth / weeks.length),
          ),
        ),
      );
      setRipple({ column, row: 3, serial: ++rippleSerial.current });
    };
    let timer: number | undefined;
    const visibility = () => {
      window.clearInterval(timer);
      if (document.hidden) {
        setRipple(null);
        return;
      }
      timer = window.setInterval(play, 10000);
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [autoRipple, reduceMotion, weeks.length, statistics.end, mode]);
  useEffect(() => {
    if (!ripple) return;
    const farthest = Math.hypot(
      Math.max(ripple.column, weeks.length - 1 - ripple.column),
      Math.max(ripple.row, 6 - ripple.row),
    );
    const timeout = window.setTimeout(
      () => setRipple(null),
      RIPPLE_DURATION + farthest * RIPPLE_STEP + 50,
    );
    return () => window.clearTimeout(timeout);
  }, [ripple, weeks.length]);
  useEffect(() => {
    const hide = () => setTooltip(null);
    window.addEventListener("resize", hide);
    return () => window.removeEventListener("resize", hide);
  }, []);
  function showTooltip(
    button: HTMLButtonElement,
    kind: "day" | "week",
    index: number,
  ) {
    const parent = card.current?.getBoundingClientRect();
    if (!parent) return;
    const bounds = button.getBoundingClientRect();
    setTooltip({
      kind,
      index,
      x: Math.max(
        112,
        Math.min(
          parent.width - 112,
          bounds.left + bounds.width / 2 - parent.left,
        ),
      ),
      y: bounds.top - parent.top - 8,
    });
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const total = mode === "weekly" ? weeks.length : statistics.days.length;
    const steps: Record<string, number> = {
      ArrowLeft: mode === "weekly" ? -1 : -7,
      ArrowRight: mode === "weekly" ? 1 : 7,
      ArrowUp: -1,
      ArrowDown: 1,
    };
    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? total - 1
          : event.key in steps
            ? index + steps[event.key]
            : null;
    if (event.key === "Escape") {
      setTooltip(null);
      return;
    }
    if (target === null) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(total - 1, target));
    setActiveIndex(next);
    cells.current[next]?.focus();
  }
  function activate(
    button: HTMLButtonElement,
    kind: "day" | "week",
    index: number,
    column: number,
    row: number,
  ) {
    lastInteraction.current = Date.now();
    setActiveIndex(index);
    showTooltip(button, kind, index);
    if (!reduceMotion)
      setRipple({ column, row, serial: ++rippleSerial.current });
  }
  function rippleRing(column: number, row: number) {
    if (!ripple || reduceMotion) return null;
    return (
      <span
        key={ripple.serial}
        className="activity-cell-ripple"
        aria-hidden="true"
        style={{
          animationDelay: `${Math.hypot(column - ripple.column, row - ripple.row) * RIPPLE_STEP}ms`,
        }}
      />
    );
  }
  const tooltipDay =
    tooltip?.kind === "day" ? statistics.days[tooltip.index] : null;
  const tooltipWeek = tooltip?.kind === "week" ? weeks[tooltip.index] : null;
  const metrics = [
    {
      value: number.format(statistics.totalPlans),
      label: "计划总数",
      hint: "所有日期的现有计划，不包含回收站。",
    },
    {
      value: number.format(statistics.completedPlans),
      label: "已完成计划",
      hint: `当前已完成且未删除的计划。${statistics.estimatedCompletions > 0 ? `其中 ${statistics.estimatedCompletions} 项旧记录的完成日期按最后修改时间估算。` : ""}`,
    },
    {
      value: `${statistics.completionRate}%`,
      label: "完成率",
      hint: "已完成计划占现有计划的比例。",
    },
    {
      value: `${statistics.longestStreak} 天`,
      label: "最长连续完成",
      hint: "按实际完成日期计算，连续每天至少完成一项计划。",
    },
    {
      value: `${statistics.currentStreak} 天`,
      label: "当前连续完成",
      hint: "今天尚未完成时沿用截至昨天的连续记录；中断一天后归零。",
    },
  ];
  return (
    <>
      <dl className="statistics-metrics" aria-label="计划统计指标">
        {metrics.map((metric) => (
          <div key={metric.label} title={metric.hint}>
            <dt>{metric.label}</dt>
            <dd>{metric.value}</dd>
          </div>
        ))}
      </dl>
      <section className="activity-card" ref={card} aria-label="完成活动">
        <header className="activity-heading">
          <div>
            <h2>完成活动</h2>
            <p>
              {rangeLabel} · {number.format(inRangeCount)} 项完成，
              {number.format(activeDays)} 个活跃日
            </p>
          </div>
          <div className="activity-controls">
            {yearControl}
            <div
              className="activity-modes"
              role="group"
              aria-label="活动统计方式"
            >
              {modes.map((item) => (
                <button
                  key={item.value}
                  aria-pressed={mode === item.value}
                  onClick={() => {
                    setMode(item.value);
                    setTooltip(null);
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </header>
        <div
          className="activity-scroller"
          ref={scroller}
          onScroll={() => {
            const element = document.activeElement;
            if (
              element instanceof HTMLButtonElement &&
              element.dataset.activityKind &&
              scroller.current?.contains(element)
            )
              showTooltip(
                element,
                element.dataset.activityKind as "day" | "week",
                Number(element.dataset.activityIndex),
              );
            else setTooltip(null);
          }}
        >
          <div
            className="activity-calendar"
            style={
              {
                "--activity-weeks": weeks.length,
                "--activity-ripple-duration": `${RIPPLE_DURATION}ms`,
              } as CSSProperties
            }
          >
            <div
              className="heatmap-columns"
              role="group"
              aria-label={
                mode === "weekly"
                  ? "按周完成活动，可用方向键查看"
                  : "按天完成热力图，左右方向键切换周，上下方向键切换天"
              }
            >
              {weeks.map((week, column) => (
                <div className="heatmap-week" key={week.start}>
                  {mode === "weekly" ? (
                    <button
                      className="heatmap-week-bar"
                      ref={(element) => {
                        cells.current[column] = element;
                      }}
                      tabIndex={activeIndex === column ? 0 : -1}
                      data-activity-kind="week"
                      data-activity-index={column}
                      aria-label={`${longDate(week.start)}至${longDate(week.end)}，完成${week.count}项计划`}
                      aria-describedby={
                        tooltip?.kind === "week" && tooltip.index === column
                          ? tooltipId
                          : undefined
                      }
                      onPointerEnter={(event) =>
                        showTooltip(event.currentTarget, "week", column)
                      }
                      onPointerLeave={(event) => {
                        if (document.activeElement !== event.currentTarget)
                          setTooltip(null);
                      }}
                      onFocus={(event) => {
                        setActiveIndex(column);
                        showTooltip(event.currentTarget, "week", column);
                      }}
                      onBlur={() => setTooltip(null)}
                      onKeyDown={(event) => keyboard(event, column)}
                      onClick={(event) => {
                        const bounds =
                          event.currentTarget.getBoundingClientRect();
                        const row =
                          event.detail === 0
                            ? 3
                            : Math.max(
                                0,
                                Math.min(
                                  6,
                                  Math.floor(
                                    (event.clientY - bounds.top) /
                                      (bounds.height / 7),
                                  ),
                                ),
                              );
                        activate(
                          event.currentTarget,
                          "week",
                          column,
                          column,
                          row,
                        );
                      }}
                    >
                      {Array.from({ length: 7 }, (_, row) => (
                        <span
                          key={row}
                          className="heatmap-cell"
                          data-level={
                            row >= 7 - Math.ceil((week.count / maxWeekly) * 7)
                              ? level(week.count, maxWeekly)
                              : 0
                          }
                        >
                          {rippleRing(column, row)}
                        </span>
                      ))}
                    </button>
                  ) : (
                    week.days.map((day, row) => {
                      if (!day)
                        return (
                          <span
                            key={row}
                            className="heatmap-cell outside-range"
                            aria-hidden="true"
                          />
                        );
                      const index =
                        column * 7 +
                        row -
                        ((new Date(
                          `${statistics.start}T12:00:00Z`,
                        ).getUTCDay() +
                          6) %
                          7);
                      const value =
                        mode === "cumulative" ? day.cumulative : day.count;
                      return (
                        <button
                          key={day.date}
                          className="heatmap-cell"
                          data-level={level(value, maxDaily)}
                          ref={(element) => {
                            cells.current[index] = element;
                          }}
                          tabIndex={activeIndex === index ? 0 : -1}
                          data-activity-kind="day"
                          data-activity-index={index}
                          aria-label={`${longDate(day.date)}，${mode === "cumulative" ? "截至当天累计完成" : "完成"}${value}项计划`}
                          aria-describedby={
                            tooltip?.kind === "day" && tooltip.index === index
                              ? tooltipId
                              : undefined
                          }
                          onPointerEnter={(event) =>
                            showTooltip(event.currentTarget, "day", index)
                          }
                          onPointerLeave={(event) => {
                            if (document.activeElement !== event.currentTarget)
                              setTooltip(null);
                          }}
                          onFocus={(event) => {
                            setActiveIndex(index);
                            showTooltip(event.currentTarget, "day", index);
                          }}
                          onBlur={() => setTooltip(null)}
                          onKeyDown={(event) => keyboard(event, index)}
                          onClick={(event) =>
                            activate(
                              event.currentTarget,
                              "day",
                              index,
                              column,
                              row,
                            )
                          }
                        >
                          {rippleRing(column, row)}
                        </button>
                      );
                    })
                  )}
                </div>
              ))}
            </div>
            <div className="heatmap-months" aria-hidden="true">
              {months.map((month) => (
                <span
                  key={month.index}
                  style={{
                    gridColumn: `${month.index + 1} / span ${Math.min(2, weeks.length - month.index)}`,
                  }}
                >
                  {month.label}
                </span>
              ))}
            </div>
          </div>
        </div>
        {tooltip && (tooltipDay || tooltipWeek) && (
          <div
            className="activity-tooltip"
            role="tooltip"
            id={tooltipId}
            style={{ left: tooltip.x, top: tooltip.y }}
          >
            <strong>
              {tooltipDay
                ? longDate(tooltipDay.date)
                : `${longDate(tooltipWeek!.start)} — ${longDate(tooltipWeek!.end)}`}
            </strong>
            <span>
              {mode === "cumulative" ? "截至当天累计完成" : "完成"}{" "}
              {number.format(
                tooltipDay
                  ? mode === "cumulative"
                    ? tooltipDay.cumulative
                    : tooltipDay.count
                  : tooltipWeek!.count,
              )}{" "}
              项计划
            </span>
          </div>
        )}
        <footer className="activity-footer">
          <span>
            {statistics.start} — {statistics.end}
          </span>
        </footer>
      </section>
    </>
  );
}
