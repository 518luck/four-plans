# Cloudflare 部署

项目使用一个 Worker 同时提供前端静态资源和 `/api/*` 接口，D1 保存数据。本地 Go/SQLite 后端仍可独立运行。云端创建了新的数据库，没有导入本地测试账号和计划。

## 自动部署

仓库 `518luck/four-plans` 的 `main` 分支推送触发 `.github/workflows/cloudflare.yml`。检查通过后才会部署；Pull Request 不部署、不读取部署令牌。部署按顺序执行 D1 新增迁移和 Worker 发布，随后检查首页、健康接口、匿名会话，以及未登录访问计划、语录和资源接口均被拒绝。

仓库配置：

| 类型             | 名称                    | 内容                                         |
| ---------------- | ----------------------- | -------------------------------------------- |
| Actions Secret   | `CLOUDFLARE_API_TOKEN`  | 限定部署账号的 Workers 脚本编辑、D1 编辑令牌 |
| Actions Variable | `CLOUDFLARE_ACCOUNT_ID` | `wrangler.jsonc` 中的部署账号                |
| Worker Secret    | `BOOTSTRAP_TOKEN`       | 首次创建个人账号的私密初始化密钥             |

Worker Secret 保存在 Cloudflare，常规发布会保留，无需放进 Actions。`BOOTSTRAP_TOKEN` 只在账号尚未创建时使用；创建后初始化接口关闭。生产工作流使用的 GitHub Actions 固定到具体提交版本。令牌过期或撤销后，需要更新 Actions Secret 才能继续部署。

部署位置由 `cloudflare/wrangler.jsonc` 确定。复用到其他账号时，先创建自己的 D1 并替换账号 ID、数据库 ID、部署地址，再配置自己的凭据。不要直接部署到本仓库的资源。

## 首次手动部署

```sh
pnpm install --frozen-lockfile
pnpm --dir cloudflare exec wrangler login
pnpm check
pnpm test
pnpm --dir web build
pnpm test:cloudflare
pnpm --dir cloudflare deploy
pnpm --dir cloudflare exec wrangler secret put BOOTSTRAP_TOKEN
node scripts/verify-cloudflare.mjs
```

最后一个 Wrangler 命令交互输入随机初始化密钥，不要使用账号密码作为初始化密钥。访问线上页面，输入初始化密钥、昵称和自行设置的密码，创建自己的空间。不要把初始化密钥写入代码、提交记录、工单或截图。

`pnpm deploy:cloudflare` 可用于后续手动发布，复用 D1，不清空历史数据。迁移文件已执行后不要修改，应添加新的迁移文件。对生产数据做变更前可使用 D1 导出，并将备份保存在仓库之外；应用内 JSON 导出不含回收站，也不提供整库恢复。

## 云端行为与验证

- 日期按北京时间自然日计算；每日任务读取时事务补齐已到来的日期，不依赖页面一直开启。未来日期不提前计入统计。
- D1 唯一约束、事务和触发器避免并发生成重复任务；永久删除的每日任务保留生成标记，不会复活。任务编辑使用版本号拒绝过期写入。
- 会话 Cookie 使用 HTTPS Secure、HttpOnly、SameSite=Strict；跨站写入拒绝。密码使用随机盐的 Web Crypto PBKDF2；登录失败限流保存在 D1，不依赖单个 Worker 内存。
- 接口类型位于 `shared/contracts.ts`，前端和云端共用。`cloudflare/test/api.test.mjs` 通过 Miniflare 在 Workers/SQLite 运行时测试初始化、登录、任务生命周期、并发、持久目标、历史统计、语录缓存和导出。
- 资源面板的 D1 存储来自数据库返回的实际大小；Worker 已用内存无法读取，明确标记未知。128 MiB 是运行上限，不是实时使用量。
- 公开的是前端和登录页；计划、统计、资源、导出和语录接口都要求登录。没有公开注册、多人空间、密码找回或本地数据自动迁移。

参考：[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)、[Workers 静态资源](https://developers.cloudflare.com/workers/static-assets/)。本项目没有启用付费套餐。
