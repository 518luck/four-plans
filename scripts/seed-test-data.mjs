import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "..", ".data", "plans.db");
const db = new DatabaseSync(dbPath);

const userId = 1;
const todayStr = "2026-10-17";
const nowStamp = "2026-10-17 19:40:00";

function randomId() {
  return crypto.randomBytes(12).toString("hex");
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const isClean = process.argv.includes("--clean");

if (isClean) {
  console.log("正在清理自动生成的测试数据...");
  // 保留用户原本的英语学习计划，删除带 [TEST] 标记的数据
  db.prepare(
    "DELETE FROM tasks WHERE notes LIKE '%[TEST]%' OR title LIKE '%[测试]%'",
  ).run();
  db.prepare(
    "DELETE FROM recurring_revisions WHERE plan_id IN (SELECT id FROM recurring_plans WHERE notes LIKE '%[TEST]%')",
  ).run();
  db.prepare(
    "DELETE FROM recurring_occurrences WHERE plan_id IN (SELECT id FROM recurring_plans WHERE notes LIKE '%[TEST]%')",
  ).run();
  db.prepare("DELETE FROM recurring_plans WHERE notes LIKE '%[TEST]%'").run();
  console.log("测试数据清理完成！");
  process.exit(0);
}

console.log("正在注入多数据测试集...");

// ----------------------------------------------------
// 1. 注入 5 个不同场景的持久计划
// ----------------------------------------------------

const recurringSeeds = [
  {
    title: "每日晨读 30 分钟",
    notes: "[TEST] 高达成率与长连续打卡示例，每日保持好习惯",
    start: "2026-10-01",
    end: "2026-10-31",
    status: "active",
    // 过去16天中，10-05 漏卡，其余全打卡，当前已连续打卡 11 天
    pattern: (date) => {
      if (date > todayStr) return false;
      if (date === "2026-10-05") return false;
      return true;
    },
  },
  {
    title: "夜跑 5 公里",
    notes: "[TEST] 60天中长周期，大量漏打卡待补卡示例",
    start: "2026-09-15",
    end: "2026-11-13",
    status: "active",
    // 跑一休二，有明显的红绿交替与遗漏
    pattern: (date, idx) => {
      if (date > todayStr) return false;
      return idx % 3 === 0;
    },
  },
  {
    title: "全栈架构进阶精读",
    notes:
      "[TEST] 120天长周期目标，跨 8/9/10/11 四个月份，测试横向滚动与多月份标尺",
    start: "2026-08-01",
    end: "2026-11-28",
    status: "active",
    // 每周工作日打卡，周末休息
    pattern: (date) => {
      if (date > todayStr) return false;
      const day = new Date(date + "T12:00:00Z").getUTCDay();
      return day >= 1 && day <= 5;
    },
  },
  {
    title: "正念冥想 15 分钟",
    notes: "[TEST] 目标暂停状态示例，测试暂停灰色与斑马条纹色块",
    start: "2026-10-05",
    end: "2026-11-03",
    status: "paused",
    effectiveDate: "2026-10-15",
    pattern: (date) => {
      // 10-05 到 10-14 期间打卡，15 号起暂停
      if (date >= "2026-10-05" && date <= "2026-10-14") {
        return date !== "2026-10-08";
      }
      return false;
    },
  },
  {
    title: "吉他基础指法训练",
    notes: "[TEST] 已到期历史目标示例，用于测试历史目标的展示与归档",
    start: "2026-09-01",
    end: "2026-09-30",
    status: "active",
    pattern: (date, idx) => {
      return idx % 2 === 0;
    },
  },
];

const insertRecurring = db.prepare(`
  INSERT INTO recurring_plans (
    id, user_id, title, notes, start_date, end_date,
    status, effective_date, generated_until, version, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertRevision = db.prepare(`
  INSERT INTO recurring_revisions (
    plan_id, effective_date, title, notes, end_date, status
  ) VALUES (?, ?, ?, ?, ?, ?)
`);

const insertTask = db.prepare(`
  INSERT INTO tasks (
    id, user_id, title, notes, bucket, scheduled_date,
    done, priority, version, created_at, updated_at,
    completed_at, recurring_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

db.exec("BEGIN");
try {
  for (const seed of recurringSeeds) {
    const planId = randomId();
    const effDate = seed.effectiveDate || seed.start;
    insertRecurring.run(
      planId,
      userId,
      seed.title,
      seed.notes,
      seed.start,
      seed.end,
      seed.status,
      effDate,
      todayStr,
      1,
      nowStamp,
      nowStamp,
    );

    insertRevision.run(
      planId,
      effDate,
      seed.title,
      seed.notes,
      seed.end,
      seed.status,
    );

    // 为该计划生成各日期的打卡 task
    let cur = seed.start;
    let idx = 0;
    while (cur <= seed.end) {
      if (cur <= todayStr) {
        const isDone = seed.pattern(cur, idx);
        const taskId = randomId();
        insertTask.run(
          taskId,
          userId,
          seed.title,
          `[TEST] 打卡记录: ${cur}`,
          "today",
          cur,
          isDone ? 1 : 0,
          0,
          1,
          `${cur} 08:00:00`,
          `${cur} 08:00:00`,
          isDone ? `${cur} 09:30:00` : null,
          planId,
        );
      }
      cur = addDays(cur, 1);
      idx++;
    }
  }

  // ----------------------------------------------------
  // 2. 注入丰富的四象限普通任务（今天、三天、周计划、月计划）
  // ----------------------------------------------------

  const todayTasks = [
    {
      title: "核心功能上线验收与冒烟测试",
      priority: 1,
      done: 0,
      notes: "[TEST] 今日首要核心焦点任务",
    },
    {
      title: "编写 API 变更与架构评审说明书",
      priority: 0,
      done: 0,
      notes: "[TEST] 文档梳理",
    },
    {
      title: "全站前端性能 Profiling 优化",
      priority: 0,
      done: 0,
      notes: "[TEST]",
    },
    {
      title: "升级 Core 依赖包并修复 deprecation 告警",
      priority: 0,
      done: 0,
      notes: "[TEST]",
    },
    {
      title: "回复社区 Issue 并整理需求建议",
      priority: 0,
      done: 0,
      notes: "[TEST]",
    },
    {
      title: "早会技术进度对齐与卡点同步",
      priority: 0,
      done: 1,
      notes: "[TEST] 09:30 已完成",
    },
    {
      title: "修复热力图网格像素级对齐问题",
      priority: 0,
      done: 1,
      notes: "[TEST] 14:20 已完成",
    },
    {
      title: "更新全套回归测试用例套件",
      priority: 0,
      done: 1,
      notes: "[TEST] 16:45 已完成",
    },
  ];

  for (const t of todayTasks) {
    insertTask.run(
      randomId(),
      userId,
      t.title,
      t.notes,
      "today",
      todayStr,
      t.done,
      t.priority,
      1,
      nowStamp,
      nowStamp,
      t.done ? `${todayStr} 15:00:00` : null,
      "",
    );
  }

  const threeTasks = [
    {
      title: "重构持久任务进度计算中间层",
      date: todayStr,
      notes: "[TEST] 第 1 天，刚进入候选",
    },
    {
      title: "排查数据库并发写锁与连接池压力",
      date: addDays(todayStr, -1),
      notes: "[TEST] 第 2 天，进行中",
    },
    {
      title: "制定客户端离线离线缓存与同步规范",
      date: addDays(todayStr, -2),
      notes: "[TEST] 第 3 天，今天将流转至今日任务",
    },
    {
      title: "设计四象限看板自定义配色主题机制",
      date: todayStr,
      notes: "[TEST] 第 1 天",
    },
    {
      title: "梳理多用户权限模型与工作区隔离方案",
      date: addDays(todayStr, -1),
      notes: "[TEST] 第 2 天",
    },
  ];

  for (const t of threeTasks) {
    insertTask.run(
      randomId(),
      userId,
      t.title,
      t.notes,
      "three",
      t.date,
      0,
      0,
      1,
      nowStamp,
      nowStamp,
      null,
      "",
    );
  }

  const weekTasks = [
    {
      title: "完成数据备份策略与多地域容灾预案",
      notes: "[TEST] 周计划关键事项",
    },
    {
      title: "完善全平台无障碍可访问性（A11y）合规审计",
      notes: "[TEST] 键盘焦点与阅读器",
    },
    { title: "整理持久任务打卡行为分析漏斗", notes: "[TEST] 指标统计" },
    {
      title: "优化 StarSeaScene 星海背景性能与功耗",
      notes: "[TEST] Three.js Shader",
    },
    { title: "编写端到端自动化验收用例", notes: "[TEST] CI/CD 集成" },
  ];

  for (const t of weekTasks) {
    insertTask.run(
      randomId(),
      userId,
      t.title,
      t.notes,
      "week",
      todayStr,
      0,
      0,
      1,
      nowStamp,
      nowStamp,
      null,
      "",
    );
  }

  const monthTasks = [
    { title: "四格计划 2.0 架构升级方案落地", notes: "[TEST] 月度战略里程碑" },
    { title: "设计移动端 PWA 离线打卡支持", notes: "[TEST] 移动端体验" },
    {
      title: "全面引入数据分析图表与导出报告",
      notes: "[TEST] PDF / Excel 导出",
    },
    {
      title: "完成高可用集群与全球边缘节点部署",
      notes: "[TEST] Cloudflare Workers & D1",
    },
  ];

  for (const t of monthTasks) {
    insertTask.run(
      randomId(),
      userId,
      t.title,
      t.notes,
      "month",
      todayStr,
      0,
      0,
      1,
      nowStamp,
      nowStamp,
      null,
      "",
    );
  }
  db.exec("COMMIT");
  console.log("测试数据注入成功！");
} catch (err) {
  db.exec("ROLLBACK");
  console.error("注入失败，已回滚：", err);
  process.exit(1);
}
