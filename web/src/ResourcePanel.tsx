import { useEffect, useState } from "react";
import { CloudOff, Cloud, Cpu, Database, RotateCw } from "lucide-react";
import { request } from "./api";
import "./resources.css";

type ResourceUsage = {
  memory: {
    usedBytes: number | null;
    source: "go_heap" | "worker_unavailable";
    limitBytes?: number;
  };
  storage: { usedBytes: number | null; source: "sqlite_files" | "d1" };
  cloudflareConnected: boolean;
  updatedAt: string;
};
function bytes(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  const units = ["B", "KiB", "MiB", "GiB"];
  const exponent = Math.min(
    3,
    value > 0 ? Math.floor(Math.log(value) / Math.log(1024)) : 0,
  );
  return `${(value / 1024 ** exponent).toFixed(exponent ? 1 : 0)} ${units[exponent]}`;
}

export default function ResourcePanel() {
  const [usage, setUsage] = useState<ResourceUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let pending = false;
    const load = async () => {
      if (pending || document.hidden) return;
      pending = true;
      setLoading(true);
      try {
        const result = await request<ResourceUsage>("/api/resources", {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(8000),
          ]),
        });
        if (active) {
          setUsage(result);
          setFailed(false);
        }
      } catch {
        if (active) setFailed(true);
      } finally {
        pending = false;
        if (active) setLoading(false);
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 30000);
    const visible = () => void load();
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      controller.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  return (
    <section className="resource-panel" aria-label="资源用量">
      <header>
        <strong>资源用量</strong>
        <span>{usage?.cloudflareConnected ? "Cloudflare" : "本地"}</span>
        <button
          type="button"
          disabled={loading}
          aria-label="刷新资源用量"
          title="刷新资源用量"
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RotateCw size={12} className={loading ? "spin" : undefined} />
        </button>
      </header>
      <dl>
        <div
          title={
            usage?.cloudflareConnected
              ? "Workers 无法直接读取当前内存占用；显示未知值。128 MiB 是实例上限，不是已用量。"
              : "当前 Go 进程已分配的堆内存，不代表容器总内存或 Cloudflare 配额。"
          }
        >
          <dt>
            <Cpu size={13} />
            运行内存
          </dt>
          <dd>{bytes(usage?.memory.usedBytes)}</dd>
          <small>
            {usage?.cloudflareConnected
              ? "Workers · 已用内存不可读取"
              : "Go 已分配堆"}
          </small>
          {usage?.memory.limitBytes && (
            <small>实例上限 {bytes(usage.memory.limitBytes)}</small>
          )}
        </div>
        <div
          title={
            usage?.cloudflareConnected
              ? "当前 Cloudflare D1 数据库实际大小，包含回收站和已分配的数据页。"
              : "当前 SQLite 数据库文件与 WAL 日志的实际大小，包含回收站和已分配的数据页。"
          }
        >
          <dt>
            <Database size={13} />
            数据库存储
          </dt>
          <dd>{bytes(usage?.storage.usedBytes)}</dd>
          <small>
            {usage?.cloudflareConnected
              ? "Cloudflare D1"
              : "SQLite · 数据库 + 日志"}
          </small>
        </div>
      </dl>
      <p className="resource-cloud-status">
        {usage?.cloudflareConnected ? (
          <Cloud size={12} />
        ) : (
          <CloudOff size={12} />
        )}
        {usage?.cloudflareConnected
          ? "Workers + D1 已连接"
          : "Cloudflare 未接入"}
      </p>
      <p className="resource-update" role="status">
        {loading
          ? "正在读取…"
          : failed
            ? "读取失败，可点击刷新"
            : "每 30 秒更新"}
      </p>
    </section>
  );
}
