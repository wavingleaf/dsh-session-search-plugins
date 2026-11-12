# dsh-session-search-background

Background entry points for DSH session search. It registers `session_search_background` and `session_event_search_background`, returns a receipt immediately, and delivers the official tool result as a follow-up message.

**Mount:** add the tarball as a profile dependency and list `dsh-session-search-background` in `dsh.profile.bundles`. It is a bundle; its patch inserts the host entry.

**License:** MIT, original work. See [the root LICENSE](../../LICENSE).

# dsh-session-search-background（后台会话搜索）

DSH 会话搜索的后台入口。它注册 `session_search_background` 与 `session_event_search_background`，前台立即返回回执，后台跑完后把官方工具结果作为后续消息投回。

**挂载：** 把 tgz 加为 profile 依赖，并把 `dsh-session-search-background` 登记到 `dsh.profile.bundles`。它是 bundle，由自带 patch 插入宿主条目。

**许可：** 自研，MIT。见[根 LICENSE](../../LICENSE)。
