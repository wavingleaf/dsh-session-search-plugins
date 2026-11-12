/**
 * dsh-session-query-cjk —— 会中文的会话全文检索 provider。
 *
 * fork 自 `@deepseek-ai/dsh-session-query-sqlite@0.2.1-rc.5`（MIT，Copyright (c) 2026 DeepSeek）。
 * 与上游的差异只有四处，其余逻辑逐行保留，方便对照升级：
 *
 * 1. **中文可检索**：FTS5 的 `unicode61` 把连续汉字当成一个 token，中文短语只能整段复现才
 *    命中（本机实测：`"异步"` 命中 77 条，`"异步搜索"`/`"固件升级"`/`"会话插件"` 全是 0）。
 *    这里在入库前把每个 CJK 字符用私有区分隔符单独切成 token（等价于「按字切词」），
 *    查询侧做同样变换再包成短语，于是中文走的是**子串**语义：`"搜索插件"` 能命中
 *    「……搜索插件……」里的连续四字。界面上看到的仍是原文（分隔符在渲染时抹掉）。
 * 2. **按会话增量对账**：上游要求两遍全量清单完全一致（期间任何会话在写就失败），实测在
 *    有活动会话的机器上几乎永远失败（本机 `lastSuccessAt` 从 11-09 起一直是 null）。这里
 *    只列一遍清单，逐个读变化的会话，读完再 `stat` 复核该会话自己的 revision；读期间被写
 *    的会话跳过、下一轮补，**不再要求整库静默**。
 * 3. **搜索不再内联对账**：上游每次搜索都先跑一遍全量对账（实测 140 秒起，工具每翻一页
 *    还要再来一遍）。这里搜索只读现成索引，对账交给后台定时器；只有索引从未建立（空库）
 *    时，首次搜索才同步建一次。
 * 4. **独立索引库**：application id、schema 版本、库文件都与上游区分开，官方索引原样保留；
 *    回滚只需把 patch 里的 provider 行换回官方包。
 *
 * 保留的上游语义：会话/事件过滤器、排序规则、游标代数、snippet 截断、只读派生索引、
 * 单进程单所有者、`openAt` 生命周期。所有写路径仍走 `_serialized` 队列。
 *
 * @module dsh-session-query-cjk
 */
import { createHash, randomUUID } from "node:crypto";
import { SESSION_FORMAT_VERSION, SessionSeq } from "@deepseek-ai/dsh-session";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import SessionQueryEngine, { SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY, SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE, SESSION_QUERY_READ_WINDOW_MAX, SessionQueryError, SessionSearchCursor, assertSessionHeadersCompatible, buildSessionEventSearchDocuments, materializeSessionEventResultFilters, materializeSessionResultFilters, readColdSessionLog } from "@deepseek-ai/dsh-session-query";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
//#region lib/types/schema.js
/** SQLite schema for the disposable session full-text read model. */
/** Current derived-index schema version. Incompatible versions reset in place. */
const SESSION_QUERY_CJK_SCHEMA_VERSION = 1;
/**
 * 本 provider 自己的 application id。
 *
 * 与上游的 1146308689 分开：两个库各自独立，互不 reset；同时保留「认库」能力——
 * 打开时只接受本 id 或空库，别的应用的库直接拒绝。
 */
const SESSION_QUERY_CJK_APPLICATION_ID = 1146308691;
const DERIVED_USER_TABLES = new Set([
	"search_state",
	"persisted_sessions",
	"persisted_docs",
	"persisted_docs_data",
	"persisted_docs_idx",
	"persisted_docs_content",
	"persisted_docs_docsize",
	"persisted_docs_config"
]);
/**
* Exclusively create a missing database file with owner-only permissions.
* Existing files retain their modes, and errors other than `EEXIST` propagate.
*/
async function createDatabaseFile(path) {
	try {
		await (await open(path, "wx", 384)).close();
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
}
/**
* Open, validate, and initialize persistent and connection-local schemas.
* @param path - dedicated derived-index path or `:memory:`; missing filesystem paths are created owner-only.
* @param journalMode - validated SQLite journal mode.
* @returns initialized database handle owned by the search service.
*/
async function openSearchDatabase(path, journalMode) {
	const actual = path === ":memory:" ? path : resolve(path);
	if (actual !== ":memory:") {
		await mkdir(dirname(actual), {
			recursive: true,
			mode: 448
		});
		await createDatabaseFile(actual);
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(actual);
	try {
		const { application_id: applicationId } = db.prepare("PRAGMA application_id").get();
		const { user_version: version } = db.prepare("PRAGMA user_version").get();
		const userTables = listUserTables(db);
		if (applicationId !== 0 && applicationId !== SESSION_QUERY_CJK_APPLICATION_ID) throw new Error(`session-search database at "${actual}" belongs to another application`);
		if (applicationId === 0 && userTables.length > 0) throw new Error(`session-search database at "${actual}" is not an empty or recognized derived index`);
		if (applicationId === SESSION_QUERY_CJK_APPLICATION_ID) {
			assertDerivedUserTables(actual, userTables);
			if (version !== SESSION_QUERY_CJK_SCHEMA_VERSION) resetDerivedSchema(db, userTables);
		}
		db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`);
		ensurePersistentSchema(db);
		ensureTemporarySchema(db);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}
function listUserTables(db) {
	return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map((row) => row.name);
}
function assertDerivedUserTables(path, userTables) {
	const unknownTables = userTables.filter((name) => !DERIVED_USER_TABLES.has(name));
	if (unknownTables.length > 0) throw new Error(`session-search database at "${path}" has unrecognized user tables: ${unknownTables.join(", ")}`);
}
function resetDerivedSchema(db, userTables) {
	for (const name of userTables) db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`);
	db.exec("PRAGMA user_version = 0");
}
function ensurePersistentSchema(db) {
	db.exec(`PRAGMA application_id = ${SESSION_QUERY_CJK_APPLICATION_ID}`);
	db.exec(`
    CREATE TABLE IF NOT EXISTS search_state (
      singleton         INTEGER PRIMARY KEY CHECK (singleton = 1),
      global_generation INTEGER NOT NULL
    ) STRICT
  `);
	db.exec("INSERT OR IGNORE INTO search_state (singleton, global_generation) VALUES (1, 0)");
	db.exec(`
    CREATE TABLE IF NOT EXISTS persisted_sessions (
      id             TEXT PRIMARY KEY,
      version        INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      cwd            TEXT,
      parent_session TEXT,
      seed_length    INTEGER,
      delegation_depth INTEGER,
      agent_preset  TEXT,
      revision       TEXT NOT NULL,
      generation     INTEGER NOT NULL
    ) STRICT
  `);
	db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS persisted_docs USING fts5(
      text,
      session_id UNINDEXED,
      seq UNINDEXED,
      type UNINDEXED,
      time UNINDEXED,
      surface UNINDEXED,
      codepoint_length UNINDEXED,
      tokenize = 'unicode61'
    )
  `);
	db.exec(`PRAGMA user_version = ${SESSION_QUERY_CJK_SCHEMA_VERSION}`);
}
function ensureTemporarySchema(db) {
	db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS live_sessions (
      id             TEXT PRIMARY KEY,
      version        INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      cwd            TEXT,
      parent_session TEXT,
      seed_length    INTEGER,
      delegation_depth INTEGER,
      agent_preset  TEXT,
      fingerprint    TEXT NOT NULL,
      persisted      INTEGER NOT NULL CHECK (persisted IN (0, 1)),
      generation     INTEGER NOT NULL
    ) STRICT
  `);
	db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS temp.live_docs USING fts5(
      text,
      session_id UNINDEXED,
      seq UNINDEXED,
      type UNINDEXED,
      time UNINDEXED,
      surface UNINDEXED,
      codepoint_length UNINDEXED,
      tokenize = 'unicode61'
    )
  `);
}
function quoteIdentifier(value) {
	return `"${value.replaceAll("\"", "\"\"")}"`;
}
/** Largest page size whose internal lookahead remains an exact SQLite integer binding. */
const SQLITE_MAX_PAGE_LIMIT = Number.MAX_SAFE_INTEGER - 1;
/** Portable host-parameter ceiling shared by predicate and statement builders. */
const SQLITE_PORTABLE_VARIABLE_LIMIT = 32766;
/**
* Reject prospective SQLite binding growth beyond the portable ceiling.
* @param count - binding count at the current construction boundary.
*/
function assertPortableBindingCount(count) {
	if (count > 32766) throw new SessionQueryError(`session-search request exceeds SQLite's portable ${SQLITE_PORTABLE_VARIABLE_LIMIT}-variable limit; reduce filter values`, "SESSION_QUERY_INVALID_FILTER");
}
/**
* Reject compiled outer predicates beyond the supported FTS5 planner budget.
* @param count - predicate count including fixed statement predicates.
*/
function assertFts5OuterPredicateCount(count) {
	if (count > 14) throw new SessionQueryError(`session-search request exceeds the supported SQLite FTS5 outer-predicate budget of 14; reduce filters`, "SESSION_QUERY_INVALID_FILTER");
}
/**
* Validate and canonicalize a cross-session request.
* @param request - caller-provided query, filters, limit, and cursor.
* @param limits - configured default and maximum page sizes.
* @returns normalized request with explicit arrays and limit.
*/
function normalizeSessionRequest(request, limits) {
	const sessionFilters = materializeSessionResultFilters(request.sessionFilters ?? []);
	const eventFilters = materializeMetadataFilters(request.eventFilters ?? []);
	const cursor = materializeCursor(request.cursor);
	return {
		query: normalizeQuery(request.query),
		sessionFilters,
		eventFilters,
		limit: normalizeLimit(request.limit, limits),
		...cursor === void 0 ? {} : { cursor }
	};
}
/**
* Validate and canonicalize a within-session request.
* @param request - caller-provided target, query, filters, limit, and cursor.
* @param limits - configured default and maximum page sizes.
* @returns normalized request with an explicit filter array and limit.
*/
function normalizeEventRequest(request, limits) {
	if (typeof request.sessionId !== "string") throw new SessionQueryError("session-search session id must be text", "SESSION_QUERY_INVALID_FILTER");
	const filters = materializeMetadataFilters(request.filters ?? []);
	const cursor = materializeCursor(request.cursor);
	return {
		sessionId: request.sessionId,
		query: normalizeQuery(request.query),
		filters,
		limit: normalizeLimit(request.limit, limits),
		...cursor === void 0 ? {} : { cursor }
	};
}
/**
* Compile logical-session predicates against selected-document columns.
* @param filters - validated ANDed logical-session clauses.
* @returns parameterized SQL fragment and ordered bindings.
*/
function buildSessionWhere(filters) {
	const clauses = [];
	const params = [];
	for (const filter of filters) switch (filter.kind) {
		case "id":
			addList(clauses, params, "session_id", filter.values);
			break;
		case "cwd":
			addNullableList(clauses, params, "cwd", filter.values);
			break;
		case "created-at":
			addRange(clauses, params, "created_at", filter);
			break;
		case "parent":
			addNullableList(clauses, params, "parent_session", filter.values);
			break;
		case "availability": {
			const availability = [...new Set(filter.values)];
			if (availability.length === 0) clauses.push("0");
			else if (availability.length === 1) {
				const value = availability[0];
				switch (value) {
					case "live":
						clauses.push("live = 1");
						break;
					case "persisted":
						clauses.push("persisted = 1");
						break;
					default: unknownAvailability(value);
				}
			}
			break;
		}
		default: unknownFilter(filter);
	}
	assertFts5OuterPredicateCount(clauses.length);
	return {
		sql: clauses.join(" AND "),
		params,
		predicateCount: clauses.length
	};
}
/**
* Compile event metadata predicates against selected-document columns.
* @param filters - validated ANDed event metadata clauses.
* @returns parameterized SQL fragment and ordered bindings.
*/
function buildEventWhere(filters) {
	const clauses = [];
	const params = [];
	for (const filter of filters) switch (filter.kind) {
		case "seq":
			addRange(clauses, params, "seq", filter);
			break;
		case "time":
			addRange(clauses, params, "time", filter);
			break;
		case "type":
			addList(clauses, params, "type", filter.values);
			break;
		case "surface":
			addList(clauses, params, "surface", filter.values);
			break;
		default: unknownFilter(filter);
	}
	assertFts5OuterPredicateCount(clauses.length);
	return {
		sql: clauses.join(" AND "),
		params,
		predicateCount: clauses.length
	};
}
/**
* CJK 字符范围：汉字（基本区/扩展 A/兼容区）、日文假名、谚文音节。
* 只影响「是否单独切 token」，不影响 unicode61 对拉丁文/数字的切分。
*/
const CJK_CHARACTER = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/u;
/**
* CJK 单字 token 的两侧分隔符（U+200B 零宽空格）。
*
* 选它有两个硬约束，别换：
* 1. unicode61 必须把它当**分隔符**——私有区字符 U+E000 就不行（实测它被当成 token
*    字符，"异<E000>步" 仍是一个 token，中文照样搜不到）；
* 2. 它**不能是空白**——`makeSnippet` 会把连续空白折叠成空格，那样片段里会出现
*    「异 步 搜 索」；U+200B 在 JS 的 `\s` 里不成立，渲染时再整体抹掉即可。
*/
const CJK_TOKEN_SEPARATOR = "\u200B";
/**
* 把文本里的每个 CJK 字符切成独立 token（两侧加分隔符），其余字符原样保留。
*
* 为什么按「字」而不是按「词」：这里没有词典/分词器；按字切 + FTS5 短语查询等价于
* **子串匹配**（查询「搜索插件」变成短语 `"搜 索 插 件"`，要求四字连续），这正是中文
* 用户对全文检索的预期。按 bigram 反而会漏掉「异步的搜索」这类中间插字的短语。
* @param text - 原始文档文本或查询词。
* @returns 每个 CJK 字符单独成 token 的文本。
*/
function segmentCjk(text) {
	let out = "";
	for (const character of text) {
		if (CJK_CHARACTER.test(character)) out += `${CJK_TOKEN_SEPARATOR}${character}${CJK_TOKEN_SEPARATOR}`;
		else out += character;
	}
	return out;
}
/**
* 把调用方查询编译成 FTS5 表达式。
*
* - 空白切分出的每个 term 各自是一个**短语**（沿上游语义：查询词是字面短语，不是语法）；
* - CJK 先按字切开，短语里就成了「连续单字」的序列，等价于子串匹配；
* - 多个 term 之间用 AND 连接——上游把整串当一个短语，用户输入「异步 搜索」时要求两词
*   紧邻，过于严格；这里让每个词独立命中，符合「用多个关键词找」的习惯。
* - 引号全部转义成双写，FTS5 语法（OR/NEAR/*）保持惰性数据。
* @param query - 已规范化的查询词。
* @returns FTS5 MATCH 表达式。
*/
function buildMatchExpression(query) {
	const terms = query.split(/\s+/u).filter((term) => term.length > 0);
	const phrases = [];
	for (const term of terms) {
		// 纯标点/符号的 term 切不出 token，跳过而不是拼出一个空短语（FTS5 对空短语会报语法错）。
		if (!/[\p{L}\p{N}]/u.test(term)) continue;
		const segmented = segmentCjk(term).replaceAll("\"", "\"\"");
		phrases.push(`"${segmented}"`);
	}
	if (phrases.length === 0) throw new SessionQueryError("session-search query must contain at least one searchable character", "SESSION_QUERY_INVALID_QUERY");
	return phrases.join(" AND ");
}
/**
* Remove reserved marker collisions before text enters FTS5 or MATCH.
* @param text - extracted document text or normalized caller query.
* @returns text with reserved noncharacters mapped to replacement characters.
*/
function sanitizeFtsText(text) {
	return text.replaceAll("\0", "�").replaceAll("﷐", "�").replaceAll("﷑", "�");
}
/**
* Build the stable normalized request identity stored in opaque cursors.
* @param request - normalized request whose filter ordering is canonicalized.
* @returns deterministic JSON identity for cursor binding.
*/
function requestFingerprint(request) {
	if ("sessionId" in request) return JSON.stringify({
		scope: "events",
		sessionId: request.sessionId,
		query: request.query,
		filters: canonicalFilters(request.filters),
		limit: request.limit
	});
	return JSON.stringify({
		scope: "sessions",
		query: request.query,
		sessionFilters: canonicalFilters(request.sessionFilters),
		eventFilters: canonicalFilters(request.eventFilters),
		limit: request.limit
	});
}
/**
* Build a whitespace-normalized excerpt no longer than `maxChars`.
* @param markedText - complete document with FTS5 `highlight()` markers.
* @param maxChars - maximum result length in Unicode code points.
* @returns bounded plain-text snippet.
*/
function makeSnippet(markedText, maxChars) {
	const { text: clean, matchStart } = normalizeMarkedText(markedText);
	const characters = Array.from(clean);
	if (characters.length <= maxChars) return clean;
	if (maxChars === 1) return "…";
	const matchedIndex = Math.min(matchStart, characters.length - 1);
	let start = Math.max(0, matchedIndex - Math.floor(maxChars / 3));
	const prefix = start > 0 ? "…" : "";
	let suffix = "…";
	let contentLength = maxChars - prefix.length - suffix.length;
	if (contentLength < 1) {
		start = matchedIndex;
		suffix = "";
		contentLength = maxChars - prefix.length - suffix.length;
	} else if (matchedIndex >= start + contentLength) start = matchedIndex - contentLength + 1;
	let end = Math.min(characters.length, start + contentLength);
	if (end === characters.length) {
		suffix = "";
		contentLength = maxChars - prefix.length;
		start = Math.max(0, end - contentLength);
	}
	end = Math.min(characters.length, start + contentLength);
	return `${prefix}${characters.slice(start, end).join("")}${suffix}`;
}
function normalizeMarkedText(markedText) {
	const characters = [];
	let matchStart;
	for (const character of markedText) {
		if (character === "﷐") {
			matchStart ??= characters.length;
			continue;
		}
		if (character === "﷑") continue;
		// 入库时插在 CJK 单字两侧的分隔符：只服务于 FTS 切词，渲染给模型/界面前抹掉。
		if (character === CJK_TOKEN_SEPARATOR) continue;
		if (/\s/u.test(character)) {
			if (characters.length > 0 && characters.at(-1) !== " ") characters.push(" ");
		} else characters.push(character);
	}
	if (characters.at(-1) === " ") characters.pop();
	return {
		text: characters.join(""),
		matchStart: matchStart ?? 0
	};
}
function normalizeQuery(value) {
	if (typeof value !== "string") throw new SessionQueryError("session-search query must be text", "SESSION_QUERY_INVALID_QUERY");
	const query = value.trim().replace(/\s+/gu, " ");
	if (query.length === 0) throw new SessionQueryError("session-search query must contain non-whitespace text", "SESSION_QUERY_INVALID_QUERY");
	if (query.includes("\0")) throw new SessionQueryError("session-search query must not contain NUL", "SESSION_QUERY_INVALID_QUERY");
	return sanitizeFtsText(query);
}
function materializeCursor(cursor) {
	if (cursor === void 0) return void 0;
	if (typeof cursor !== "string") throw new SessionQueryError("session-search cursor must be text", "SESSION_QUERY_INVALID_CURSOR");
	return cursor;
}
function materializeMetadataFilters(filters) {
	const candidates = filters;
	for (const filter of candidates) switch (filter.kind) {
		case "seq":
		case "time":
		case "type":
		case "surface": break;
		case "text": throw new SessionQueryError("session-search metadata filters do not accept text clauses", "SESSION_QUERY_INVALID_FILTER");
		default: unknownFilter(filter);
	}
	return materializeSessionEventResultFilters(filters);
}
function normalizeLimit(value, limits) {
	const limit = value ?? limits.defaultLimit;
	const maxLimit = Math.min(limits.maxLimit, SQLITE_MAX_PAGE_LIMIT);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) throw new SessionQueryError(`session-search limit must be an integer between 1 and ${maxLimit}`, "SESSION_QUERY_INVALID_LIMIT");
	return limit;
}
function addList(clauses, params, column, values) {
	if (values.length === 0) {
		clauses.push("0");
		return;
	}
	clauses.push(`${column} IN (${appendListBindings(params, values)})`);
}
function addNullableList(clauses, params, column, values) {
	if (values.length === 0) {
		clauses.push("0");
		return;
	}
	const concrete = values.filter((value) => value !== null);
	const parts = [];
	if (concrete.length > 0) parts.push(`${column} IN (${appendListBindings(params, concrete)})`);
	if (values.includes(null)) parts.push(`${column} IS NULL`);
	clauses.push(`(${parts.join(" OR ")})`);
}
function addRange(clauses, params, column, range) {
	if (range.from !== void 0) {
		assertPortableBindingCount(params.length + 1);
		clauses.push(`CAST(${column} AS INTEGER) >= ?`);
		params.push(range.from);
	}
	if (range.to !== void 0) {
		assertPortableBindingCount(params.length + 1);
		clauses.push(`CAST(${column} AS INTEGER) <= ?`);
		params.push(range.to);
	}
}
function appendListBindings(params, values) {
	assertPortableBindingCount(params.length + values.length);
	for (const value of values) params.push(value);
	return values.map(() => "?").join(", ");
}
function canonicalFilters(filters) {
	return filters.map((filter) => {
		if ("values" in filter) return {
			...filter,
			values: [...filter.values].sort(compareNullable)
		};
		return {
			kind: filter.kind,
			from: filter.from ?? null,
			to: filter.to ?? null
		};
	}).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function compareNullable(a, b) {
	if (a === b) return 0;
	if (a === null) return -1;
	if (b === null) return 1;
	return a.localeCompare(b);
}
function unknownAvailability(value) {
	throw new SessionQueryError(`session availability filter contains unknown value "${String(value)}"`, "SESSION_QUERY_INVALID_FILTER");
}
function unknownFilter(filter) {
	const kind = filter.kind;
	throw new SessionQueryError(`session filter contains unknown kind ${typeof kind === "string" ? `"${kind}"` : "(missing)"}`, "SESSION_QUERY_INVALID_FILTER");
}
//#endregion
//#region lib/types/index.js
/**
* Concrete session-query service with SQLite FTS5 over the live-preferred corpus.
*
* @module @deepseek-ai/dsh-session-query-sqlite
*/
/** Boot-context slot for a launcher-owned absolute path to this process's derived query index. */
const SESSION_QUERY_SQLITE_PATH_KEY = "launcherSessionQueryPath";
/** Default result page size. */
const SESSION_QUERY_SQLITE_DEFAULT_LIMIT = 20;
/** Maximum accepted result page size. */
const SESSION_QUERY_SQLITE_MAX_LIMIT = 100;
/** Default maximum snippet length in Unicode code points. */
const SESSION_QUERY_SQLITE_SNIPPET_CHARS = 240;
/** Concrete SQLite owner of the combined `ctx.sessionQuery` service. */
var SqliteSessionQueryEngine = class extends SessionQueryEngine {
	static inject = ["sessions"];
	static Config = z.object({
		path: z.string().required(),
		openAt: z.union([
			"startup",
			"first-search",
			"never"
		]).default("startup"),
		journalMode: z.union([
			"wal",
			"delete",
			"truncate",
			"persist"
		]).default("wal"),
		defaultLimit: z.number().step(1).min(1).max(SQLITE_MAX_PAGE_LIMIT).default(20),
		maxLimit: z.number().step(1).min(1).max(SQLITE_MAX_PAGE_LIMIT).default(100),
		snippetChars: z.number().step(1).min(1).default(240),
		readWindowMax: z.number().step(1).min(0).default(SESSION_QUERY_READ_WINDOW_MAX),
		persistedReadConcurrency: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY),
		preparedSessionCacheSize: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE),
		/** 后台对账开关；关掉后索引只在首次搜索（空库）时建一次。 */
		refreshEnabled: z.boolean().default(true),
		/** 后台对账间隔（分钟）；0 表示不做周期对账。 */
		refreshIntervalMinutes: z.number().min(0).default(10),
		/** 启动后多久跑第一次后台对账（秒）。 */
		refreshInitialDelaySeconds: z.number().min(0).default(30)
	});
	/** Validated and defaulted backend configuration. */
	config;
	_instance = randomUUID();
	_ready;
	_db;
	_persistenceBinding = { identity: Symbol() };
	_lastPersistenceIdentity;
	_persistenceEpoch = 0;
	_globalGeneration = 0;
	_localGeneration = 0;
	_tail = Promise.resolve();
	_closed = false;
	_closePromise;
	/** 索引是否已经建立过（空库时第一次搜索要同步建一次）。 */
	_seeded = false;
	/** 后台对账定时器；unref 过，不阻止进程退出。 */
	_refreshTimer;
	_optionalPersistenceFiber;
	constructor(ctx, config) {
		super(ctx, config = resolveConfig(config));
		this.config = config;
		this._optionalPersistenceFiber = ctx.inject(["sessionPersistence"], (childCtx) => {
			const service = childCtx.sessionPersistence;
			const binding = {
				identity: Symbol(),
				service
			};
			this._persistenceBinding = binding;
			childCtx.effect(() => () => {
				/* v8 ignore next -- a stale optional-service disposer cannot clear a replacement */
				if (this._persistenceBinding !== binding) return;
				this._persistenceBinding = { identity: Symbol() };
			}, "sessionQuerySqlite.persistenceBinding");
		});
		ctx.effect(() => {
			return () => this._optionalPersistenceFiber.dispose();
		}, "sessionQuerySqlite.optionalPersistence");
		ctx.effect(() => async () => this.close(), "sessionQuerySqlite.close");
	}
	/** Open eagerly only when activation owns the configured readiness boundary. */
	async [Service.init]() {
		if (this.config.openAt === "startup") await this._ensureReady(void 0);
		this._startRefresher();
	}
	async searchSessions(request, exec) {
		this._assertSearchEnabled();
		const normalized = normalizeSessionRequest(request, this.config);
		const signal = exec?.signal;
		return this._serialized(signal, async () => {
			await this._ensureReady(signal);
			// 与上游的关键差异：搜索只读现成索引，不再每次先跑全量对账（那是 140 秒起的大头）。
			const persistenceBinding = await this._ensureSeeded(signal);
			assertNotAborted(signal);
			const generation = String(this._globalGeneration);
			const fingerprint = requestFingerprint(normalized);
			const offset = normalized.cursor === void 0 ? 0 : decodeCursor(normalized.cursor, this._instance, "sessions", fingerprint, generation);
			return page(this._querySessions(normalized, offset, persistenceBinding), normalized.limit, (row) => this._sessionHit(row), (cursorOffset) => encodeCursor({
				version: 1,
				instance: this._instance,
				scope: "sessions",
				fingerprint,
				generation,
				offset: cursorOffset
			}), offset);
		});
	}
	async searchEvents(request, exec) {
		this._assertSearchEnabled();
		const normalized = normalizeEventRequest(request, this.config);
		const signal = exec?.signal;
		return this._serialized(signal, async () => {
			await this._ensureReady(signal);
			const persistenceBinding = await this._ensureSeeded(signal);
			assertNotAborted(signal);
			const target = this._targetObservation(normalized.sessionId, persistenceBinding);
			const fingerprint = requestFingerprint(normalized);
			const offset = normalized.cursor === void 0 ? 0 : decodeCursor(normalized.cursor, this._instance, "events", fingerprint, target.generation);
			const rows = this._queryEvents(normalized, offset, persistenceBinding);
			return {
				session: target.header,
				...page(rows, normalized.limit, (row) => this._eventHit(row), (cursorOffset) => encodeCursor({
					version: 1,
					instance: this._instance,
					scope: "events",
					fingerprint,
					generation: target.generation,
					offset: cursorOffset
				}), offset)
			};
		});
	}
	/** Close the database after every accepted operation reaches quiescence. */
	close() {
		this._closePromise ??= this._close();
		return this._closePromise;
	}
	/**
	* Refuse full-text calls under `openAt: 'never'` before any request
	* normalization or SQLite work, so a disabled deployment never imports
	* node:sqlite, opens the index, or observes sources.
	*/
	_assertSearchEnabled() {
		if (this.config.openAt !== "never") return;
		throw new SessionQueryError("session search is disabled: this deployment configures the session-query index with openAt \"never\"", "SESSION_QUERY_SEARCH_DISABLED");
	}
	async _close() {
		this._closed = true;
		if (this._refreshTimer !== void 0) {
			clearTimeout(this._refreshTimer);
			this._refreshTimer = void 0;
		}
		await this._tail;
		if (this._ready !== void 0) try {
			await this._ready;
		} catch {}
		this._db?.close();
		this._db = void 0;
	}
	async _open() {
		this._db = await openSearchDatabase(this.config.path, this.config.journalMode);
		const state = this._db.prepare("SELECT global_generation FROM search_state WHERE singleton = 1").get();
		this._globalGeneration = state.global_generation;
		this._localGeneration = state.global_generation;
		// 库里有会话行 = 索引建过；空库（首次安装/换库）由第一次搜索兜底同步建一次。
		const row = this._db.prepare("SELECT COUNT(*) AS count FROM persisted_sessions").get();
		this._seeded = Number(row.count) > 0;
	}
	async _ensureReady(signal) {
		this._ready ??= this._open();
		try {
			await waitWithAbort(this._ready, signal);
		} catch (error) {
			if (isAbort(error)) throw error;
			throw new SessionQueryError(`session-search SQLite index failed to open: ${errorMessage(error)}`, "SESSION_QUERY_INDEX_FAILED", { cause: error });
		}
	}
	/**
	* 保证索引至少建立过一次。
	*
	* 正常情况下后台对账已经把索引建好（`_open` 里按行数判断）；只有全新库（刚装/换库/
	* 首次启动还没到第一次后台对账）才会在这里同步建一次——这是唯一一处搜索会等对账的
	* 地方，代价是首搜慢一次，换来「第一次搜索就有结果」，比返回空结果更不误导。
	*/
	async _ensureSeeded(signal) {
		if (this._seeded) return this._persistenceBinding;
		const binding = await this._reconcile(signal);
		this._seeded = true;
		return binding;
	}
	/**
	* 启动后台对账定时器。
	*
	* 定时器用 `unref()`：它只服务于索引新鲜度，绝不能把宿主进程钉在事件循环上；
	* 关闭时由 `_close` 清理。失败不重排特殊间隔——按固定周期重试，日志与状态文件
	* 记录每次结果（`storages/session-search-cjk-status.json`）。
	*/
	_startRefresher() {
		if (this.config.refreshEnabled === false) return;
		const intervalMs = Math.round(this.config.refreshIntervalMinutes * 60000);
		if (intervalMs <= 0) return;
		const schedule = (delayMs) => {
			if (this._closed) return;
			this._refreshTimer = setTimeout(async () => {
				await this._refreshOnce();
				schedule(intervalMs);
			}, delayMs);
			this._refreshTimer.unref?.();
		};
		schedule(Math.round(this.config.refreshInitialDelaySeconds * 1000));
	}
	/** 跑一轮后台对账；任何失败都只记录，不影响搜索与宿主。 */
	async _refreshOnce() {
		const startedAt = Date.now();
		try {
			await this._ensureReady(void 0);
			// 走串行队列：与正在进行的搜索/建索引互斥，写路径永远只有一个。
			await this._serialized(void 0, () => this._reconcile(void 0));
			this._seeded = true;
			const db = this._requireDb();
			const indexedSessions = Number(db.prepare("SELECT COUNT(*) AS c FROM persisted_sessions").get()?.c ?? 0);
			await this._writeStatus({
				outcome: "ok",
				durationMs: Date.now() - startedAt,
				indexedSessions,
				skippedCount: this._skipped?.length ?? 0,
				changedDuringRead: this._changedDuringRead ?? 0,
				skippedSample: this._skipped ?? []
			});
		} catch (error) {
			await this._writeStatus({
				outcome: "failed",
				error: errorMessage(error),
				durationMs: Date.now() - startedAt
			});
			this.ctx.logger?.warn?.(`session-query-cjk: 后台对账失败：${errorMessage(error)}`);
		}
	}
	/**
	* 写一份人可读的状态文件，回答「后台对账到底有没有在跑」。
	* `:memory:` 库不写；写失败也只是少一份探针，不影响检索。
	* @param entry - 本轮结果。
	*/
	async _writeStatus(entry) {
		if (this.config.path === ":memory:") return;
		try {
			const file = resolve(dirname(this.config.path), "session-search-cjk-status.json");
			await writeFile(file, JSON.stringify({
				at: new Date().toISOString(),
				...entry
			}, null, 2), "utf8");
		} catch {
			// 状态文件是可选探针：没有它不影响功能。
		}
	}
	async _serialized(signal, operation) {
		if (this._isClosed()) throw indexClosed();
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const prior = this._tail;
		this._tail = prior.then(() => gate);
		try {
			await waitWithAbort(prior, signal);
		} catch (error) {
			release();
			throw error;
		}
		if (this._isClosed()) {
			release();
			throw indexClosed();
		}
		try {
			assertNotAborted(signal);
			return await operation();
		} finally {
			release();
		}
	}
	async _reconcile(signal) {
		assertNotAborted(signal);
		const db = this._requireDb();
		const persistedRows = db.prepare("SELECT id, revision, generation FROM persisted_sessions").all();
		const liveRows = db.prepare("SELECT id, fingerprint, persisted, generation FROM temp.live_sessions").all();
		const persistedById = new Map(persistedRows.map((row) => [row.id, row]));
		const liveById = new Map(liveRows.map((row) => [row.id, row]));
		const observation = await this._observeStable(persistedById, signal);
		assertNotAborted(signal);
		const persistentChanges = observation.persistenceBinding.service === void 0 ? [] : [...observation.persisted.values()].filter((entry) => entry.loaded !== void 0);
		const persistentDeletes = observation.persistenceBinding.service === void 0 ? [] : persistedRows.filter((row) => !observation.persisted.has(row.id));
		const liveChanges = [...observation.live.values()].filter((entry) => {
			const indexed = liveById.get(entry.header.id);
			const persisted = observation.persisted.has(entry.header.id) ? 1 : 0;
			return indexed?.fingerprint !== entry.fingerprint || indexed.persisted !== persisted;
		});
		const liveDeletes = liveRows.filter((row) => !observation.live.has(row.id));
		const pointerChanged = this._lastPersistenceIdentity !== void 0 && this._lastPersistenceIdentity !== observation.persistenceBinding.identity;
		const hasWrites = persistentChanges.length > 0 || persistentDeletes.length > 0 || liveChanges.length > 0 || liveDeletes.length > 0;
		let nextMainGeneration = this._mainGeneration();
		let nextLocalGeneration = this._localGeneration;
		if (persistentChanges.length > 0 || persistentDeletes.length > 0) nextMainGeneration += 1;
		const liveReplacements = liveChanges.map((entry) => {
			nextLocalGeneration = Math.max(nextLocalGeneration, nextMainGeneration) + 1;
			return {
				entry,
				generation: nextLocalGeneration,
				persisted: observation.persisted.has(entry.header.id)
			};
		});
		if (hasWrites) {
			let began = false;
			try {
				db.exec("BEGIN IMMEDIATE");
				began = true;
				for (const row of persistentDeletes) this._deleteSession("persisted", row.id);
				for (const entry of persistentChanges) {
					/* v8 ignore next -- observation loads every entry whose revision differs */
					if (entry.loaded === void 0) throw new Error(`missing loaded revision for session "${entry.header.id}"`);
					this._replacePersistedSession(entry.loaded, entry.revision, nextMainGeneration);
				}
				if (persistentChanges.length > 0 || persistentDeletes.length > 0) db.prepare("UPDATE search_state SET global_generation = ? WHERE singleton = 1").run(nextMainGeneration);
				for (const row of liveDeletes) this._deleteSession("live", row.id);
				for (const { entry, generation, persisted } of liveReplacements) this._replaceLiveSession(entry, generation, persisted);
				db.exec("COMMIT");
			} catch (error) {
				/* v8 ignore next -- a BEGIN failure has no transaction to roll back; the common wrapper still reports it. */
				if (began)
 /* v8 ignore next 5 -- ROLLBACK failure requires a SQLite double fault; the original failure remains actionable. */
				try {
					db.exec("ROLLBACK");
				} catch {}
				throw new SessionQueryError(`session-search reconciliation failed: ${errorMessage(error)}`, "SESSION_QUERY_INDEX_FAILED", { cause: error });
			}
		}
		if (hasWrites || pointerChanged) this._globalGeneration += 1;
		if (pointerChanged) this._persistenceEpoch += 1;
		this._localGeneration = nextLocalGeneration;
		this._lastPersistenceIdentity = observation.persistenceBinding.identity;
		return observation.persistenceBinding;
	}
	/**
	* 观察当前语料（替代上游的「两遍全量清单必须一致」）。
	*
	* 上游的稳定性判据是整库静默：两遍 `list()` 的 revision 全等才算数。只要有任何一个
	* 会话在这 85 秒里写过（本机 619 个会话，几乎必然发生），对账就失败——这正是
	* 「后台刷新自 11-09 起一次都没成功」的根因。这里换成**按会话**的判据：
	*
	* 1. 只列一遍清单；
	* 2. 变化的会话并发读日志，读完对该会话 `stat()` 复核 revision；
	* 3. 读期间被写的会话跳过本轮（`loaded` 留空，`_reconcile` 不会写它），下一轮再补；
	* 4. 单个会话读失败也只跳过该会话，不再让整库对账失败。
	*
	* 代价：某一次对账可能少几个刚写过的会话，下一次周期就补上；派生索引本来就不是
	* 事务性快照，这比「永远对不上、从不更新」好。
	*/
	async _observeStable(indexed, signal) {
		assertNotAborted(signal);
		const persistenceBinding = this._persistenceBinding;
		const persistence = persistenceBinding.service;
		const liveSessions = this.ctx.sessions.list();
		const liveIds = new Set(liveSessions.map((session) => session.id));
		let persisted = /* @__PURE__ */ new Map();
		if (persistence !== void 0) {
			const listOptions = signal === void 0 ? void 0 : { signal };
			let snapshots;
			try {
				snapshots = await persistence.list(listOptions);
			} catch (error) {
				if (isAbort(error) || signal?.aborted) throw new SessionQueryError("session-search aborted", "SESSION_QUERY_ABORTED", { cause: error });
				throw new SessionQueryError(`session-search persistence listing failed: ${errorMessage(error)}`, "SESSION_QUERY_PERSISTENCE_FAILED", { cause: error });
			}
			assertNotAborted(signal);
			persisted = materializePersistenceSnapshots(snapshots);
			const canReuseIndexed = this._lastPersistenceIdentity === void 0 || this._lastPersistenceIdentity === persistenceBinding.identity;
			const changed = [];
			for (const entry of persisted.values()) {
				if (canReuseIndexed && indexed.get(entry.header.id)?.revision === entry.revision) continue;
				if (liveIds.has(entry.header.id) || this.ctx.sessions.get(entry.header.id) !== void 0) continue;
				changed.push(entry);
			}
			// 诊断：记录本轮被跳过的会话（读失败 / 读期间又被写），写进状态文件，便于回答
			// 「为什么库里有 622 个会话、索引里只有 455 个」。上限 20 条，避免状态文件膨胀。
			this._skipped = [];
			this._changedDuringRead = 0;
			const concurrency = Math.max(1, Math.min(changed.length, this.config.persistedReadConcurrency));
			let cursor = 0;
			const worker = async () => {
				while (cursor < changed.length) {
					const entry = changed[cursor];
					cursor += 1;
					assertNotAborted(signal);
					try {
						const loaded = await readColdSessionLog(persistence, entry.header.id, signal);
						assertNotAborted(signal);
						assertSessionHeadersCompatible(entry.header, loaded.header);
						// 逐会话复核：读日志期间被追加过就放弃这一份，下一轮按新 revision 重读。
						// 但对**旧格式（v3）日志**跳过复核：v3 的 revision 里含“历史语料修订”，
						// 这个值会随**其它**会话的迁移而变——并行迁移时，A 的迁移会让 B 的复核
						// 当场作废，整轮互相否决（实测并发 4 时卡在 455/622，串行才慢慢补齐）。
						// v3 日志本身不可追加（新事件只会写到迁移后的 v4），读到的就是一致快照，
						// 所以这里只对当前格式的日志做复核。
						const legacyLog = Number(entry.header.version) < SESSION_FORMAT_VERSION;
						if (!legacyLog && typeof persistence.stat === "function") {
							const after = await persistence.stat(entry.header.id, listOptions);
							if (after === void 0 || after.revision !== entry.revision) {
								this._changedDuringRead += 1;
								if (this._skipped.length < 20) this._skipped.push({ id: entry.header.id, why: "revision-changed-during-read", revision: entry.revision });
								continue;
							}
						}
						entry.loaded = observeSession(loaded.header, loaded.inheritedEventCount, loaded.events);
					} catch (error) {
						if (isAbort(error) || signal?.aborted) throw new SessionQueryError("session-search aborted", "SESSION_QUERY_ABORTED", { cause: error });
						// 单个会话读坏（半写、格式迁移中等）只跳过它，不让整库对账失败。
						const reason = `${error instanceof Error ? error.code ?? "" : ""}${errorMessage(error)}`;
						if (this._skipped.length < 20) this._skipped.push({ id: entry.header.id, why: "read-failed", error: reason });
						this.ctx.logger?.warn?.(`session-query-cjk: 读取会话 ${entry.header.id} 失败，本轮跳过：${reason}`);
					}
				}
			};
			await Promise.all(Array.from({ length: concurrency }, () => worker()));
			assertNotAborted(signal);
			if (this._persistenceBinding !== persistenceBinding) throw new SessionQueryError("session-search persistence provider changed during observation", "SESSION_QUERY_PERSISTENCE_FAILED");
		}
		const live = /* @__PURE__ */ new Map();
		for (const session of liveSessions) {
			const observed = observeLive(session);
			const durable = persisted.get(session.id);
			if (durable !== void 0) assertSessionHeadersCompatible(observed.header, durable.header);
			live.set(session.id, observed);
		}
		return {
			persistenceBinding,
			persisted,
			live
		};
	}
	_mainGeneration() {
		return this._requireDb().prepare("SELECT global_generation FROM search_state WHERE singleton = 1").get().global_generation;
	}
	_deleteSession(source, id) {
		const db = this._requireDb();
		if (source === "persisted") {
			db.prepare("DELETE FROM persisted_docs WHERE session_id = ?").run(id);
			db.prepare("DELETE FROM persisted_sessions WHERE id = ?").run(id);
		} else {
			db.prepare("DELETE FROM temp.live_docs WHERE session_id = ?").run(id);
			db.prepare("DELETE FROM temp.live_sessions WHERE id = ?").run(id);
		}
	}
	_replacePersistedSession(entry, revision, generation) {
		this._deleteSession("persisted", entry.header.id);
		const db = this._requireDb();
		db.prepare(`
      INSERT INTO persisted_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, revision, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...headerBindings(entry.header, entry.inheritedEventCount), revision, generation);
		const insert = db.prepare(`
      INSERT INTO persisted_docs (text, session_id, seq, type, time, surface, codepoint_length)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
		for (const document of entry.documents) {
			const text = sanitizeFtsText(document.text);
			// 入库用「CJK 按字切开」的版本；codepoint_length 仍按原文长度记，
			// 否则排序里的 document_length 会被分隔符撑大，长文档反而排前面。
			insert.run(segmentCjk(text), document.sessionId, document.seq, document.type, document.time, document.surface, Array.from(text).length);
		}
	}
	_replaceLiveSession(entry, generation, persisted) {
		this._deleteSession("live", entry.header.id);
		const db = this._requireDb();
		db.prepare(`
      INSERT INTO temp.live_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, fingerprint, persisted, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...headerBindings(entry.header, entry.inheritedEventCount), entry.fingerprint, persisted ? 1 : 0, generation);
		const insert = db.prepare(`
      INSERT INTO temp.live_docs (text, session_id, seq, type, time, surface, codepoint_length)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
		for (const document of entry.documents) {
			const text = sanitizeFtsText(document.text);
			// 入库用「CJK 按字切开」的版本；codepoint_length 仍按原文长度记，
			// 否则排序里的 document_length 会被分隔符撑大，长文档反而排前面。
			insert.run(segmentCjk(text), document.sessionId, document.seq, document.type, document.time, document.surface, Array.from(text).length);
		}
	}
	_querySessions(request, offset, persistenceBinding) {
		const selected = selectedDocumentsSql();
		const sessionWhere = buildSessionWhere(request.sessionFilters);
		const eventWhere = buildEventWhere(request.eventFilters);
		assertFts5OuterPredicateCount(sessionWhere.predicateCount + eventWhere.predicateCount);
		const where = [sessionWhere.sql, eventWhere.sql].filter(Boolean).join(" AND ");
		const bindings = [
			...selectedDocumentsParams(request.query, persistenceBinding.service !== void 0),
			...sessionWhere.params,
			...eventWhere.params,
			request.limit + 1,
			offset
		];
		assertPortableBindingCount(bindings.length);
		return this._requireDb().prepare(`
      ${selected.sql},
      filtered AS (
        SELECT * FROM matched ${where.length === 0 ? "" : `WHERE ${where}`}
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY session_id
          ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
        ) AS event_rank
        FROM filtered
      )
      SELECT * FROM ranked
      WHERE event_rank = 1
      ORDER BY match_count DESC, document_length ASC, time DESC, session_id ASC, seq DESC
      LIMIT ? OFFSET ?
    `).all(...bindings);
	}
	_queryEvents(request, offset, persistenceBinding) {
		const selected = selectedDocumentsSql();
		const eventWhere = buildEventWhere(request.filters);
		assertFts5OuterPredicateCount(1 + eventWhere.predicateCount);
		const where = ["session_id = ?", eventWhere.sql].filter(Boolean).join(" AND ");
		const bindings = [
			...selectedDocumentsParams(request.query, persistenceBinding.service !== void 0),
			request.sessionId,
			...eventWhere.params,
			request.limit + 1,
			offset
		];
		assertPortableBindingCount(bindings.length);
		return this._requireDb().prepare(`
      ${selected.sql}
      SELECT * FROM matched
      WHERE ${where}
      ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
      LIMIT ? OFFSET ?
    `).all(...bindings);
	}
	_targetObservation(sessionId, persistenceBinding) {
		const db = this._requireDb();
		const live = db.prepare(`SELECT
        id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation
      FROM temp.live_sessions
      WHERE id = ?`).get(sessionId);
		if (live !== void 0) return {
			header: rowHeader(live),
			generation: `live:${live.generation}`
		};
		if (persistenceBinding.service !== void 0) {
			const persisted = db.prepare(`SELECT
          id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation
        FROM persisted_sessions
        WHERE id = ?`).get(sessionId);
			if (persisted !== void 0) return {
				header: rowHeader(persisted),
				generation: `persisted:${this._persistenceEpoch}:${persisted.generation}`
			};
		}
		throw new SessionQueryError(`session "${sessionId}" not found`, "SESSION_QUERY_SESSION_NOT_FOUND");
	}
	_sessionHit(row) {
		return {
			header: rowHeader(row),
			live: row.live === 1,
			persisted: row.persisted === 1,
			bestMatch: this._eventHit(row)
		};
	}
	_eventHit(row) {
		return {
			sessionId: row.session_id,
			seq: SessionSeq(row.seq),
			type: row.type,
			time: row.time,
			surface: row.surface,
			snippet: makeSnippet(row.marked_text, this.config.snippetChars)
		};
	}
	_requireDb() {
		/* v8 ignore next -- callers await `_ready`; this guards lifecycle misuse */
		if (this._db === void 0) throw indexClosed();
		return this._db;
	}
	_isClosed() {
		return this._closed;
	}
};
/**
* The header columns both session upserts bind, in the order their INSERT
* lists them. The two statements differ only in what they append after these.
* @param header - the session header being written.
* @returns one bound value per header column.
*/
function headerBindings(header, inheritedEventCount) {
	return [
		header.id,
		header.version,
		header.createdAt,
		header.cwd ?? null,
		header.parentSession ?? null,
		header.isSeeded ? inheritedEventCount : null,
		header.delegationDepth ?? null,
		header.agentPreset ?? null
	];
}
function selectedDocumentsSql() {
	return { sql: `WITH candidates AS (
      SELECT
        pd.session_id AS session_id,
        ps.version AS version,
        ps.created_at AS created_at,
        ps.cwd AS cwd,
        ps.parent_session AS parent_session,
        ps.seed_length AS seed_length,
        ps.delegation_depth AS delegation_depth,
        ps.agent_preset AS agent_preset,
        0 AS live,
        1 AS persisted,
        CAST(pd.seq AS INTEGER) AS seq,
        pd.type AS type,
        CAST(pd.time AS INTEGER) AS time,
        pd.surface AS surface,
        highlight(persisted_docs, 0, ?, ?) AS marked_text,
        CAST(pd.codepoint_length AS INTEGER) AS document_length
      FROM persisted_docs AS pd
      JOIN persisted_sessions AS ps ON ps.id = pd.session_id
      WHERE persisted_docs MATCH ?
        AND ? = 1
        AND NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = pd.session_id)
      UNION ALL
      SELECT
        ld.session_id AS session_id,
        ls.version AS version,
        ls.created_at AS created_at,
        ls.cwd AS cwd,
        ls.parent_session AS parent_session,
        ls.seed_length AS seed_length,
        ls.delegation_depth AS delegation_depth,
        ls.agent_preset AS agent_preset,
        1 AS live,
        CASE WHEN ? = 1 THEN ls.persisted ELSE 0 END AS persisted,
        CAST(ld.seq AS INTEGER) AS seq,
        ld.type AS type,
        CAST(ld.time AS INTEGER) AS time,
        ld.surface AS surface,
        highlight(live_docs, 0, ?, ?) AS marked_text,
        CAST(ld.codepoint_length AS INTEGER) AS document_length
      FROM temp.live_docs AS ld
      JOIN temp.live_sessions AS ls ON ls.id = ld.session_id
      WHERE live_docs MATCH ?
    ), matched AS (
      SELECT *,
        (
          length(CAST(marked_text AS BLOB))
          - length(CAST(replace(marked_text, ?, '') AS BLOB))
        ) / ? AS match_count
      FROM candidates
    )` };
}
function selectedDocumentsParams(query, persistenceVisible) {
	const expression = buildMatchExpression(query);
	const visible = persistenceVisible ? 1 : 0;
	return [
		"﷐",
		"﷑",
		expression,
		visible,
		visible,
		"﷐",
		"﷑",
		expression,
		"﷐",
		Buffer.byteLength("﷐", "utf8")
	];
}
function observeLive(session) {
	return observeSession(session.header, session.inheritedEventCount, session.snapshotEvents());
}
function observeSession(header, inheritedEventCount, events) {
	const detachedHeader = structuredClone(header);
	const detachedEvents = events.map((event) => structuredClone(event));
	return {
		header: detachedHeader,
		inheritedEventCount,
		documents: buildSessionEventSearchDocuments(detachedHeader.id, detachedEvents),
		fingerprint: createHash("sha256").update(JSON.stringify({
			header: detachedHeader,
			inheritedEventCount,
			events: detachedEvents
		})).digest("base64url")
	};
}
function materializePersistenceSnapshots(snapshots) {
	if (!isRuntimeArray(snapshots)) throw new Error("persistence snapshots must be an array");
	const result = /* @__PURE__ */ new Map();
	for (const snapshot of snapshots) {
		if (typeof snapshot.revision !== "string") throw new Error("persistence snapshot revision must be a string");
		const header = structuredClone(snapshot.header);
		if (result.has(header.id)) throw new Error(`persistence listed duplicate session "${header.id}"`);
		result.set(header.id, {
			header,
			revision: snapshot.revision
		});
	}
	return result;
}
function rowHeader(row) {
	return {
		version: SESSION_FORMAT_VERSION,
		id: row.session_id,
		createdAt: row.created_at,
		...row.cwd === null ? {} : { cwd: row.cwd },
		...row.parent_session === null ? {} : { parentSession: row.parent_session },
		isSeeded: row.seed_length !== null,
		...row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth },
		...row.agent_preset === null ? {} : { agentPreset: row.agent_preset }
	};
}
function page(rows, limit, convert, nextCursor, offset) {
	const hasMore = rows.length > limit;
	return {
		items: rows.slice(0, limit).map(convert),
		...hasMore ? { nextCursor: nextCursor(offset + limit) } : {}
	};
}
function encodeCursor(payload) {
	return SessionSearchCursor(Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"));
}
function decodeCursor(cursor, instance, scope, fingerprint, generation) {
	let decoded;
	try {
		decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch (error) {
		throw invalidCursor(error);
	}
	if (decoded.version !== 1 || decoded.instance !== instance || decoded.scope !== scope || decoded.fingerprint !== fingerprint || !Number.isSafeInteger(decoded.offset) || decoded.offset === void 0 || decoded.offset < 0) throw invalidCursor(/* @__PURE__ */ new Error("cursor does not belong to this normalized request"));
	if (decoded.generation !== generation) throw new SessionQueryError("session-search cursor is stale because its relevant corpus changed", "SESSION_QUERY_STALE_CURSOR");
	return decoded.offset;
}
function invalidCursor(cause) {
	return new SessionQueryError("session-search cursor is invalid", "SESSION_QUERY_INVALID_CURSOR", { cause });
}
function resolveConfig(config) {
	const resolved = {
		path: config.path,
		openAt: config.openAt ?? "startup",
		journalMode: config.journalMode ?? "wal",
		defaultLimit: config.defaultLimit ?? 20,
		maxLimit: config.maxLimit ?? 100,
		snippetChars: config.snippetChars ?? 240,
		readWindowMax: config.readWindowMax ?? SESSION_QUERY_READ_WINDOW_MAX,
		persistedReadConcurrency: config.persistedReadConcurrency ?? SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
		preparedSessionCacheSize: config.preparedSessionCacheSize ?? SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
		refreshEnabled: config.refreshEnabled ?? true,
		refreshIntervalMinutes: config.refreshIntervalMinutes ?? 10,
		refreshInitialDelaySeconds: config.refreshInitialDelaySeconds ?? 30
	};
	if (typeof resolved.path !== "string" || resolved.path.trim().length === 0) throw invalidConfig("path must not be blank");
	if (![
		"startup",
		"first-search",
		"never"
	].includes(resolved.openAt)) throw invalidConfig("openAt is not supported");
	assertPageLimit("defaultLimit", resolved.defaultLimit);
	assertPageLimit("maxLimit", resolved.maxLimit);
	assertPositiveInteger("snippetChars", resolved.snippetChars);
	if (!Number.isInteger(resolved.readWindowMax) || resolved.readWindowMax < 0) throw invalidConfig("readWindowMax must be a non-negative integer");
	if (!Number.isSafeInteger(resolved.persistedReadConcurrency) || resolved.persistedReadConcurrency < 1) throw invalidConfig("persistedReadConcurrency must be a positive safe integer");
	if (!Number.isSafeInteger(resolved.preparedSessionCacheSize) || resolved.preparedSessionCacheSize < 1) throw invalidConfig("preparedSessionCacheSize must be a positive safe integer");
	if (typeof resolved.refreshEnabled !== "boolean") throw invalidConfig("refreshEnabled must be a boolean");
	if (!Number.isFinite(resolved.refreshIntervalMinutes) || resolved.refreshIntervalMinutes < 0) throw invalidConfig("refreshIntervalMinutes must be a non-negative number");
	if (!Number.isFinite(resolved.refreshInitialDelaySeconds) || resolved.refreshInitialDelaySeconds < 0) throw invalidConfig("refreshInitialDelaySeconds must be a non-negative number");
	if (resolved.defaultLimit > resolved.maxLimit) throw invalidConfig("defaultLimit must be less than or equal to maxLimit");
	if (![
		"wal",
		"delete",
		"truncate",
		"persist"
	].includes(resolved.journalMode)) throw invalidConfig("journalMode is not supported");
	return resolved;
}
function assertPositiveInteger(name, value) {
	if (!Number.isInteger(value) || value < 1) throw invalidConfig(`${name} must be a positive integer`);
}
function assertPageLimit(name, value) {
	if (!Number.isSafeInteger(value) || value < 1 || value > SQLITE_MAX_PAGE_LIMIT) throw invalidConfig(`${name} must be an integer between 1 and ${SQLITE_MAX_PAGE_LIMIT}`);
}
function invalidConfig(detail) {
	return new SessionQueryError(`session-search SQLite config: ${detail}`, "SESSION_QUERY_INVALID_CONFIG");
}
function indexClosed() {
	return new SessionQueryError("session-search SQLite index is closed", "SESSION_QUERY_INDEX_FAILED");
}
function assertNotAborted(signal) {
	if (signal?.aborted) throw new SessionQueryError("session-search aborted", "SESSION_QUERY_ABORTED");
}
function waitWithAbort(promise, signal) {
	if (signal === void 0) return promise;
	if (signal.aborted) return Promise.reject(new SessionQueryError("session-search aborted", "SESSION_QUERY_ABORTED"));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(new SessionQueryError("session-search aborted", "SESSION_QUERY_ABORTED"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(asError(error));
		});
	});
}
function isAbort(error) {
	return error instanceof SessionQueryError && error.code === "SESSION_QUERY_ABORTED";
}
function asError(error) {
	return error instanceof Error ? error : new Error("session-search dependency rejected with a non-Error value", { cause: error });
}
function errorMessage(error) {
	return error instanceof Error ? error.message : "unknown error";
}
function isRuntimeArray(value) {
	return Array.isArray(value);
}
//#endregion
export { SESSION_QUERY_CJK_APPLICATION_ID, SESSION_QUERY_CJK_SCHEMA_VERSION, SESSION_QUERY_SQLITE_DEFAULT_LIMIT, SESSION_QUERY_SQLITE_MAX_LIMIT, SESSION_QUERY_SQLITE_PATH_KEY, SESSION_QUERY_SQLITE_SNIPPET_CHARS, SqliteSessionQueryEngine, SqliteSessionQueryEngine as default, buildMatchExpression, makeSnippet, segmentCjk };
