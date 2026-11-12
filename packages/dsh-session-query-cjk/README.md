# dsh-session-query-cjk

A session-search provider for DSH with per-character CJK tokenization. It forks `@deepseek-ai/dsh-session-query-sqlite` so Chinese substrings match, reconciliation stays incremental, and search no longer reconciles inline.

**Mount:** add the tarball as a profile dependency and reference it by name from the `optional-session-search` group in `profiles/<name>/cordis.patch.yml`. It is a plain plugin, not a bundle.

**License:** MIT fork of `@deepseek-ai/dsh-session-query-sqlite` (Copyright (c) 2026 DeepSeek). The upstream license text is kept in [`LICENSE`](LICENSE); the repository-wide license is in [the root LICENSE](../../LICENSE).

# dsh-session-query-cjk（中文检索 provider）

DSH 会话检索的中文分词 provider。它 fork 自 `@deepseek-ai/dsh-session-query-sqlite`，把中文按字切 token，使中文子串可以命中；对账改为按会话增量，搜索不再内联对账。

**挂载：** 把 tgz 加为 profile 依赖，并在 `profiles/<name>/cordis.patch.yml` 的 `optional-session-search` 组里按名字引用。它是普通插件，不是 bundle。

**许可：** `@deepseek-ai/dsh-session-query-sqlite` 的 MIT fork（Copyright (c) 2026 DeepSeek）。上游许可原文保留在 [`LICENSE`](LICENSE)，仓库整体许可见[根 LICENSE](../../LICENSE)。
