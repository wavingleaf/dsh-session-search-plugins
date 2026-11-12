# DSH Session Search Plugins

Two DSH plugins that close the two gaps in session search: Chinese text is not searchable in the official SQLite index, and search blocks the conversation while it runs.

## `dsh-session-query-cjk`

**What it is.** A session-search provider that makes Chinese-language history searchable, replacing the official `@deepseek-ai/dsh-session-query-sqlite` provider.

**How it works**

- **Per-character CJK tokenization.** Every CJK character is indexed as its own token, so a contiguous run of Han characters matches as a substring instead of requiring an exact whole-phrase token.
- **Per-session incremental reconciliation.** Only changed sessions are read; each read is re-checked, and sessions written during a read are picked up next round.
- **No reconciliation in the search path.** Search reads the existing index; refresh runs on a background timer (10 minutes by default).
- **Separate index database.** The official index is left untouched, and switching back is a one-line configuration change.

**Install.** Add the tarball as a `file:` dependency in `$DSH_HOME/profiles/<name>/package.json`:

```json
"dependencies": {
  "dsh-session-query-cjk": "file:<path-to-tgz>/dsh-session-query-cjk-0.1.0-local.5-021.tgz"
}
```

Then replace the provider row of the `optional-session-search` group in `profiles/<name>/cordis.patch.yml`:

```yaml
- id: optional-session-search
  config:
    - id: optional-session-query-cjk
      name: 'dsh-session-query-cjk'
      config:
        path: !!js dshHomePath('storages/session-search-cjk.db')
        openAt: startup
        refreshInitialDelaySeconds: 5
        refreshIntervalMinutes: 10
    - id: optional-tool-session-query
      name: '@deepseek-ai/dsh-tool-session-query'
      config:
        searchTimeoutMs: 120000
```

The group config is replaced wholesale, so both child entries must be restated. Run `pnpm install` in the profile and restart DSH.

## `dsh-session-search-background`

**What it is.** A bundle that adds background entry points for session search: `session_search_background` and `session_event_search_background`.

**How it works**

- Validates arguments and returns a receipt immediately; the search itself continues in the background.
- Calls the official tool's own `execute`, so authorization, filters, paging and formatting are unchanged.
- Delivers the official rendered output as a notice message: `steer` while the agent is running, `followup` when idle.
- Delivers failures too, with the error code, so the model never waits forever.
- De-duplicates identical searches per agent and caps concurrent background searches (3 per agent by default).

**Install.** Add the tarball as a `file:` dependency and register the bundle in `$DSH_HOME/profiles/<name>/package.json`:

```json
{
  "dependencies": {
    "dsh-session-search-background": "file:<path-to-tgz>/dsh-session-search-background-0.1.0-local.10-021.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-session-search-background"]
    }
  }
}
```

Run `pnpm install` in the profile and restart DSH.

## Evidence

Measured on this machine: 622 sessions and 638 log files. The official index and the plugin index were built from the same corpus.

| Item | Official index | This provider |
|---|---:|---:|
| Sessions | 604 | 626 |
| Documents | 185,022 | 210,222 |

Chinese query hits (documents):

| Query | Official (`unicode61`) | This provider |
|---|---:|---:|
| `会话插件` | 0 | 113 docs / 19 sessions |
| `异步搜索` | 0 | 98 docs / 1 session |
| `固件升级` | 0 | 51 docs / 3 sessions |

Response time:

| Scenario | Result |
|---|---|
| Synchronous search, official provider | blocked for the full 600 s, then tool timeout |
| Synchronous search, with the CJK provider | returned within the turn |
| Background tool, official provider | immediate receipt; failure delivered after 6 min 15 s |
| Background tool, with the CJK provider | immediate receipt; result delivered in 1 s |

Index build and coverage:

| Metric | Result |
|---|---:|
| First build (452 sessions) | 72.9 s |
| Incremental reconciliation after restart | 60.4 s |
| Full rebuild (626 sessions, incl. legacy v3 logs) | 465.7 s |
| Coverage | 626 / 622 sessions, 0 skipped |

## Compatibility

- DSH 0.2.1-rc.5 (cordis 4.0.5).
- Node.js `^22.19.0` or `>=24.0.0`.
- The official provider in DSH 0.2.2-rc.1 is identical to the rc.5 one; neither upstream issue is mitigated there.

## License

- `dsh-session-query-cjk` is an MIT fork of `@deepseek-ai/dsh-session-query-sqlite` (Copyright (c) 2026 DeepSeek). The upstream license text is retained at `packages/dsh-session-query-cjk/LICENSE`.
- `dsh-session-search-background` is original MIT work.
- Repository-wide license: MIT, see `LICENSE`.

## Known limitations

### `dsh-session-query-cjk`

- **Substring semantics.** The query must appear contiguously; separate multiple terms with spaces.
- **Broad single-character hits.** One-character queries match any occurrence of that character, by design.
- **Index lag.** The newest sessions can lag up to one refresh interval (10 minutes by default).
- **Fork maintenance.** Upstream changes must be diffed and ported on DSH upgrades.

### `dsh-session-search-background`

- **Blocking only.** It does not make a slow provider faster.
- **Delayed result.** The model sees the result on a later step, after one background execution.
- **Prompt coexistence.** The official prompt still recommends the synchronous tools; `syncTools: 'deny'` hides those tools but cannot remove the official prompt line.
- **Owning agent required.** Calls without an agent return an explanation because there is nowhere to deliver the result.

---

# DSH 会话搜索插件

两个 DSH 插件，分别解决会话搜索的两个问题：官方 SQLite 索引搜不到中文，以及搜索过程阻塞对话。

## `dsh-session-query-cjk`

**是什么。** 一个会话检索 provider，让中文历史会话可以被搜到，用来替换官方的 `@deepseek-ai/dsh-session-query-sqlite`。

**怎么工作**

- **中文按字切词。** 每个 CJK 字符单独成为一个 token，连续汉字因此可以按子串命中，而不再要求整段完全相同的短语。
- **按会话增量对账。** 只读取发生变化的会话；每次读取后再复核，读取期间被写入的会话留到下一轮补。
- **搜索路径不再对账。** 搜索只读现成索引，对账交给后台定时器（默认 10 分钟一轮）。
- **独立索引库。** 官方索引原样保留，换回官方 provider 只需改一行配置。

**安装。** 在 `$DSH_HOME/profiles/<name>/package.json` 里把 tgz 加为 `file:` 依赖：

```json
"dependencies": {
  "dsh-session-query-cjk": "file:<path-to-tgz>/dsh-session-query-cjk-0.1.0-local.5-021.tgz"
}
```

然后在 `profiles/<name>/cordis.patch.yml` 里替换 `optional-session-search` 组的 provider 行：

```yaml
- id: optional-session-search
  config:
    - id: optional-session-query-cjk
      name: 'dsh-session-query-cjk'
      config:
        path: !!js dshHomePath('storages/session-search-cjk.db')
        openAt: startup
        refreshInitialDelaySeconds: 5
        refreshIntervalMinutes: 10
    - id: optional-tool-session-query
      name: '@deepseek-ai/dsh-tool-session-query'
      config:
        searchTimeoutMs: 120000
```

组 config 是整体替换，两个子条目都要完整重述。在 profile 里执行 `pnpm install`，然后重启 DSH。

## `dsh-session-search-background`

**是什么。** 一个 bundle，为会话搜索增加后台入口：`session_search_background` 与 `session_event_search_background`。

**怎么工作**

- 校验参数后立即返回回执，真正的搜索在后台继续执行。
- 调用官方工具自己的 `execute`，授权、过滤、翻页和排版都保持不变。
- 把官方渲染结果作为一条 notice 消息投回：运行中 `steer`，空闲时 `followup`。
- 失败也会投回，并带上错误码，模型不会无限等待。
- 同一 agent 的相同搜索只跑一份，并限制并发（默认每 agent 3 个）。

**安装。** 在 `$DSH_HOME/profiles/<name>/package.json` 里把 tgz 加为 `file:` 依赖，并登记 bundle：

```json
{
  "dependencies": {
    "dsh-session-search-background": "file:<path-to-tgz>/dsh-session-search-background-0.1.0-local.10-021.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-session-search-background"]
    }
  }
}
```

在 profile 里执行 `pnpm install`，然后重启 DSH。

## 证据

本机 622 个会话、638 个日志文件；官方索引与插件索引使用同一批数据。

| 项 | 官方索引 | 本插件 |
|---|---:|---:|
| 会话 | 604 | 626 |
| 文档 | 185,022 | 210,222 |

中文查询命中（文档数）：

| 查询 | 官方（`unicode61`） | 本插件 |
|---|---:|---:|
| `会话插件` | 0 | 113 文档 / 19 会话 |
| `异步搜索` | 0 | 98 文档 / 1 会话 |
| `固件升级` | 0 | 51 文档 / 3 会话 |

响应耗时：

| 场景 | 结果 |
|---|---|
| 同步搜索，官方 provider | 卡满 600 秒后工具超时 |
| 同步搜索，配合中文 provider | 当轮返回 |
| 后台工具，官方 provider | 立即返回回执；6 分 15 秒后回投失败 |
| 后台工具，配合中文 provider | 立即返回回执；1 秒后回投结果 |

建索引与覆盖：

| 指标 | 结果 |
|---|---:|
| 首次建索引（452 会话） | 72.9 秒 |
| 重启后增量对账 | 60.4 秒 |
| 全量重建（626 会话，含 v3 旧日志） | 465.7 秒 |
| 索引覆盖 | 626 / 622 会话，跳过 0 |

## 兼容性

- DSH 0.2.1-rc.5（cordis 4.0.5）。
- Node.js `^22.19.0` 或 `>=24.0.0`。
- DSH 0.2.2-rc.1 中的官方 provider 与 rc.5 一致，上述两个问题在上游均未缓解。

## 许可

- `dsh-session-query-cjk` 是 `@deepseek-ai/dsh-session-query-sqlite` 的 MIT fork（Copyright (c) 2026 DeepSeek），上游许可原文保留在 `packages/dsh-session-query-cjk/LICENSE`。
- `dsh-session-search-background` 为自研，MIT。
- 仓库整体采用 MIT，见 `LICENSE`。

## 已知限制

### `dsh-session-query-cjk`

- **子串语义。** 查询必须连续出现；多个词用空格分开。
- **单字命中过宽。** 单字查询会命中该字的所有出现，这是刻意的取舍。
- **索引滞后。** 最新会话最多滞后一个刷新周期（默认 10 分钟）。
- **fork 维护。** DSH 升级时需要对照上游 diff 并移植改动。

### `dsh-session-search-background`

- **只负责不阻塞。** 它不会让慢的 provider 变快。
- **结果滞后。** 模型要到下一步才能看到结果，中间隔一次后台执行。
- **提示并存。** 官方提示仍推荐同步工具；`syncTools: 'deny'` 会屏蔽这些工具，但删不掉官方提示里的那一行。
- **需要归属 agent。** 没有 agent 的调用会直接返回说明，因为没有地方回投结果。
