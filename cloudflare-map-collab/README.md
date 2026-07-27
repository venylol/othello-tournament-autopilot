# FTD/OQ 映射表协作页

这是独立 Cloudflare Pages 项目，不部署、不复用原来的本地签到页项目。

## 本地数据边界

- 云端只保存 `ftdPlayerAccountMapping`。
- 云端不读取微信、不处理签到表、不登记比分。
- 微信群昵称刷新和初步建表仍由本地 `agent_tournament_helper.cmd map-ftd-players --write-frontend` 完成。

## Cloudflare 资源

推荐新项目名：

```text
onlicheck-map
```

D1 数据库名：

```text
onlicheck_map_collab
```

首次部署流程：

```powershell
cd cloudflare-map-collab
npm install
npx wrangler login
npx wrangler d1 create onlicheck_map_collab
```

把返回的 `database_id` 写入 `wrangler.toml`，然后：

```powershell
npx wrangler d1 migrations apply onlicheck_map_collab --remote
npx wrangler pages deploy public --project-name onlicheck-map
```

## 发布本地映射表

```powershell
node .\cloudflare-map-collab\tools\publish-map-collab.js --endpoint https://onlicheck-map.pages.dev
```

输出里会给出：

- `editLink`：副裁编辑链接

## 拉回副裁修改

先建议只下载到文件审查：

```powershell
node .\cloudflare-map-collab\tools\pull-map-collab.js --url "编辑链接" --output .\agent_cache\remote-ftd-map.json
```

确认后再写入本地共享状态：

```powershell
node .\cloudflare-map-collab\tools\pull-map-collab.js --url "编辑链接" --write-state
```

`--write-state` 默认通过 `http://127.0.0.1:4174/api/state` 写入，避免浏览器缓存覆盖。
只有本地同步 API 不可用且你明确接受直接改文件时，才使用：

```powershell
node .\cloudflare-map-collab\tools\pull-map-collab.js --url "编辑链接" --write-state --direct-file
```
