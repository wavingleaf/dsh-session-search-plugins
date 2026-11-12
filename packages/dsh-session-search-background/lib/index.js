/**
 * dsh-session-search-background —— 会话搜索的「后台入口」。
 *
 * 官方 `@deepseek-ai/dsh-tool-session-query` 的 `session_search` /
 * `session_event_search` 是**同步**执行：一次调用要等索引对账、翻页跑完才返回，
 * 期间整轮对话被卡住。本插件不改官方包，而是**另注册两个新名字的工具**：
 *
 *   session_search_background / session_event_search_background
 *
 * - 名字以官方工具名为基础，加 `_background` 后缀，避免与全局工具重名——
 *   也就不用走「agent 作用域同名遮蔽」那条没被官方用过的注册路径；
 * - 描述沿用官方原文，末尾补一句「后台执行、立即返回、结果稍后以消息送达」；
 * - 参数 schema、输出 schema、presentCall 全部从 `ctx.tools.get(<官方名>)` 取官方定义后复用；
 * - execute 在前台只做参数校验，立刻返回回执；真正的检索在后台调用**官方工具自己的
 *   execute**（授权、过滤、翻页、排版零复制），完成后把官方 `output.render()` 的结果
 *   作为一条 notice 消息投回该 agent 的会话（运行中 steer、空闲 followup，与子代理
 *   结算通知同一套投递语义）；
 * - 另加一小段系统提示，告诉模型优先用后台版；可选（`syncTools: 'deny'`）把两个同步
 *   工具从每个 agent 的工具集里屏蔽，彻底取代旧入口。
 *
 * @module dsh-session-search-background
 */
import z from '@deepseek-ai/schemastery';
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import { ToolArgsError, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Loader 诊断里显示的插件名。 */
export const name = 'session-search-background';

/** 需要工具注册表、agent 注册表与系统提示；都由宿主提供。 */
export const inject = ['tools', 'agents', 'systemPrompt'];

/** 官方工具名 → 后台版工具名（异步名 = 官方名 + 后缀）。 */
const TOOL_VARIANTS = [
  { base: 'session_search', asyncName: 'session_search_background' },
  { base: 'session_event_search', asyncName: 'session_event_search_background' },
];

/** 追加到官方描述末尾的一句差异说明（保持简短，不重写官方描述）。 */
const DESCRIPTION_SUFFIX = ' Runs in the background and returns immediately; the results arrive later as a follow-up message.';

/**
 * 后台搜索的默认上限。
 *
 * 不能用官方工具默认的 30 秒：官方 provider 每次搜索前要做一遍全量对账（实测 514 个
 * 会话约 140 秒，工具内部最多翻 5 页），后台跑正是为了熬过这段时间。
 */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** 同一 agent 同时允许几个后台搜索；超过就婉拒，避免把 provider 的串行队列塞满。 */
const DEFAULT_MAX_INFLIGHT = 3;

/** 系统提示章节名：与官方 `tool:session-query` 区分开，避免同名遮蔽。 */
const PROMPT_SECTION = 'tool:session-query-background';

/** 全可选：缺省值在 apply 里兜底，避免 schemastery 的必填语义影响加载顺序。 */
export const Config = z.object({
  timeoutMs: z.number(),
  maxInflightPerAgent: z.number(),
  syncTools: z.union(['keep', 'deny']),
});

/**
 * 把参数序列化成稳定的去重键。
 * @param toolName - 工具名。
 * @param args - 模型给的参数。
 * @returns 去重键。
 */
function inflightKey(toolName, args) {
  try {
    const keys = args !== null && typeof args === 'object' ? Object.keys(args).sort() : [];
    return `${toolName}:${JSON.stringify(args, keys)}`;
  } catch {
    // 参数里出现循环引用等极端情况时退化成字符串键：宁可少去重，也不让搜索失败。
    return `${toolName}:${String(args)}`;
  }
}

/**
 * 渲染耗时，给人看。
 * @param ms - 毫秒。
 * @returns 例如 `42 秒`、`2 分 14 秒`。
 */
function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

/**
 * 从异常里取出可读的一句话。
 * @param error - 捕获到的任意异常。
 * @returns 错误文本；SessionQueryError 自带稳定 code，这里连同 code 一起保留。
 */
function describeError(error) {
  if (error instanceof Error) {
    const code = typeof error.code === 'string' && error.code.length > 0 ? `${error.code}: ` : '';
    return `${code}${error.message}`;
  }
  return String(error);
}

/**
 * 查询词在标题里的展示；没有就返回空串。
 * @param args - 模型参数。
 * @returns 例如 `（"会话插件"）`。
 */
function queryLabel(args) {
  return typeof args?.query === 'string' && args.query.length > 0 ? `（"${args.query}"）` : '';
}

/**
 * 前台回执：告诉模型「还没结果、结果会以消息形式回来、别再重复调用」。
 * @param toolName - 被调用的工具名（后台版）。
 * @param query - 模型给的查询词（可能为空）。
 * @returns 工具结果文本（官方该工具的输出 schema 就是 string）。
 */
function startedText(toolName, query) {
  const subject = typeof query === 'string' && query.length > 0 ? `「${query}」` : '';
  return [
    `Background search started: ${toolName}${subject} is running in the background (this call returned immediately).`,
    'Its results will be delivered to this conversation as a follow-up message tagged 会话搜索结果 when the search finishes.',
    'Do not call the same search again while it is running; continue with other work or end your turn.',
  ].join('\n');
}

/**
 * 注册插件。
 * @param ctx - 插件上下文。
 * @param config - 可选配置。
 */
export function apply(ctx, config = {}) {
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxInflight = Number.isInteger(config.maxInflightPerAgent) && config.maxInflightPerAgent > 0
    ? config.maxInflightPerAgent
    : DEFAULT_MAX_INFLIGHT;
  const syncTools = config.syncTools === 'deny' ? 'deny' : 'keep';

  /** 正在跑的后台搜索：dedupe 键 → agent id。 */
  const inflight = new Map();
  /** 每个 agent 正在跑的数量。 */
  const inflightByAgent = new Map();

  /**
   * 把一条后台结果投回 agent 的会话。
   *
   * 走 `steer` / `followup` 而不是 `inject`：搜索完成后要**唤醒** agent 继续处理，
   * 这与子代理结算通知（`dsh-subagent` 的 `notifySettlement`）一致；`inject` 只挂到
   * 下一步、空闲时不会被消费。agent 已消失就丢弃（会话已经没了）。
   * @param agent - 发起调用的 agent。
   * @param message - 已构造好的 user 消息。
   */
  function deliver(agent, message) {
    const live = ctx.agents.get(agent.id);
    if (live === undefined) {
      ctx.logger?.warn?.(`session-search-background: agent ${agent.id} 已不在注册表，丢弃一条后台搜索结果`);
      return;
    }
    try {
      if (live.status === 'running') live.steer(message);
      else live.followup(message);
    } catch (error) {
      // 投递失败只可能是 agent 正在收尾；结果丢掉也不能让后台任务抛到宿主。
      ctx.logger?.warn?.(`session-search-background: 后台搜索结果投递失败（${agent.id}）：${describeError(error)}`);
    }
  }

  /**
   * 用官方工具的 output.render 渲染结果；渲染本身失败时退化成 JSON 文本，绝不吞掉结果。
   * @param definition - 官方工具定义。
   * @param args - 模型参数。
   * @param value - 官方 execute 的返回值。
   * @returns 内容块数组。
   */
  function renderResult(definition, args, value) {
    try {
      const rendered = definition.output?.render?.(args, value);
      if (Array.isArray(rendered) && rendered.length > 0) return rendered;
    } catch (error) {
      ctx.logger?.warn?.(`session-search-background: 官方工具结果渲染失败，回退 JSON：${describeError(error)}`);
    }
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value) }];
  }

  /**
   * 构造投回会话的 notice 消息。
   *
   * source.kind 用生产者自有 kind（`plugin:<包名>`）：0.2.1 的 V4 会话格式在原生
   * 写盘准入处**硬拒** `kind: 'plugin'`（见 `dsh-session-format-v3-to-v4` 的
   * `source()`），只有带包名的自有 kind 才允许落盘。
   * @param toolName - 后台版工具名。
   * @param args - 模型参数。
   * @param blocks - 结果内容块。
   * @param outcome - `ok` / `error`。
   * @param elapsedMs - 后台耗时。
   * @returns user 消息。
   */
  function createResultMessage(toolName, args, blocks, outcome, elapsedMs) {
    const label = outcome === 'ok' ? '会话搜索结果' : '会话搜索失败';
    const header = `[${label}] ${toolName}${queryLabel(args)} — ${outcome === 'ok' ? '完成' : '失败'}，耗时 ${formatDuration(elapsedMs)}`;
    return createUserMessage({
      content: [{ type: 'text', text: header }, ...blocks],
      source: {
        kind: 'plugin:dsh-session-search-background',
        form: 'notice',
        summary: boundContextSummary(header),
        tool: toolName,
        outcome,
        ...typeof args?.query === 'string' ? { query: args.query } : {},
      },
    });
  }

  /**
   * 执行一次后台搜索并把结果投回会话。
   * @param definition - 官方工具定义（只借它的 execute 与 output.render）。
   * @param asyncName - 后台版工具名（只用于文案与日志）。
   * @param args - 模型参数（冻结快照）。
   * @param exec - 原执行上下文；只借其中的调用者身份。
   * @param agent - 发起调用的 agent。
   * @param key - 去重键。
   */
  async function runInBackground(definition, asyncName, args, exec, agent, key) {
    const controller = new AbortController();
    let timer;
    // 超时要**两条腿走路**：signal 让配合的工具提前退出；Promise.race 保证即使工具
    // 完全不看 signal（官方 provider 在同步 SQLite 调用之间才检查取消），也能按时收尾。
    // timer.unref()：后台任务不能把宿主的事件循环钉住。
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`后台搜索超过 ${formatDuration(timeoutMs)} 上限`));
        reject(new Error(`后台搜索超过 ${formatDuration(timeoutMs)} 上限`));
      }, timeoutMs);
      timer.unref?.();
    });
    const startedAt = Date.now();
    // 竞速的失败分支要自己吞掉 rejection，否则超时后原 promise 再失败会变成未处理拒绝。
    const running = Promise.resolve().then(() => definition.execute(args, { ...exec, signal: controller.signal }));
    running.catch(() => {});
    try {
      // 关键：复用官方 execute。授权（cwd 严格相等）、过滤条件、翻页、结果排版
      // 全部由官方实现负责；这里只换一个不会随前台调用结束而取消的 signal。
      const value = await Promise.race([running, timeout]);
      const blocks = renderResult(definition, args, value);
      deliver(agent, createResultMessage(asyncName, args, blocks, 'ok', Date.now() - startedAt));
    } catch (error) {
      // 标题由 createResultMessage 统一生成，这里只放正文——第一版重复拼了一次标题，
      // 实测回投消息里出现两行「[会话搜索失败] …」。
      const text = [
        describeError(error),
        '检索本身没有返回结果。如果是索引对账失败，稍后重试同一查询即可（后台索引会继续推进）。',
      ].join('\n');
      deliver(agent, createResultMessage(asyncName, args, [{ type: 'text', text }], 'error', Date.now() - startedAt));
    } finally {
      clearTimeout(timer);
      inflight.delete(key);
      const count = (inflightByAgent.get(agent.id) ?? 1) - 1;
      if (count > 0) inflightByAgent.set(agent.id, count);
      else inflightByAgent.delete(agent.id);
    }
  }

  /**
   * 用官方定义造一枚后台版工具定义。
   *
   * 为什么只 spread + 覆盖 execute：name/description/parameters/output/presentCall/
   * timeoutMs 都是官方维护的，复制一份必然与上游漂移；这里只在描述末尾追加一句差异。
   * @param base - 官方工具名。
   * @param asyncName - 后台版工具名。
   * @param definition - 官方工具定义。
   * @returns 可注册的工具定义。
   */
  function makeAsyncDefinition(base, asyncName, definition) {
    const description = typeof definition.description === 'string' && definition.description.length > 0
      ? `${definition.description}${DESCRIPTION_SUFFIX}`
      : `Background variant of ${base}.${DESCRIPTION_SUFFIX}`;
    return {
      ...definition,
      name: asyncName,
      description,
      async execute(args, exec) {
        // 参数校验必须在**前台**做：否则模型会先拿到「已开始」，再收到一条参数错误。
        const live = ctx.tools.get(base) ?? definition;
        const violations = validateJsonSchemaValue(live.parameters, args, '');
        if (violations.length > 0) throw new ToolArgsError(violations);
        const agent = exec.agent;
        // 没有归属 agent 就没有可回投的会话：直接说明，别起一个送不回去的后台任务。
        if (agent === undefined || agent === null) {
          return `${asyncName} needs an owning agent session to deliver its results; this call has none. Use the synchronous ${base} instead.`;
        }
        const key = inflightKey(asyncName, args);
        if (inflight.has(key)) {
          return `${asyncName} with these arguments is already running in the background; its result will arrive as a follow-up message. Wait for it instead of re-issuing the same search.`;
        }
        if ((inflightByAgent.get(agent.id) ?? 0) >= maxInflight) {
          return `Too many background searches are already running for this agent (limit ${maxInflight}). Wait for one of them to finish before starting another.`;
        }
        inflight.set(key, agent.id);
        inflightByAgent.set(agent.id, (inflightByAgent.get(agent.id) ?? 0) + 1);
        // 不 await：前台立即返回，后台继续跑，结果走消息通道。
        void runInBackground(live, asyncName, args, exec, agent, key);
        return startedText(asyncName, args?.query);
      },
    };
  }

  /**
   * 写一份状态探针（可选）：回答「插件到底有没有 apply、工具注册成没成」。
   *
   * 宿主控制台不一定有人看，所以把关键节点落成文件；路径取 launcher 设置的
   * `DSH_HOME`（没有就跳过）。写不进去不影响功能。
   * @param entry - 本次记录（phase + 细节）。
   */
  /** 状态写入的串行队列：并发 writeFile 会交错成坏 JSON，必须排队 + 原子替换。 */
  let statusChain = Promise.resolve();
  function writeStatus(entry) {
    const home = process.env.DSH_HOME;
    if (!home) return statusChain;
    statusChain = statusChain.then(async () => {
      try {
        const file = join(home, 'storages', 'session-search-background-status.json');
        const temp = `${file}.tmp`;
        await mkdir(dirname(file), { recursive: true });
        await writeFile(temp, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }, null, 2)}\n`, 'utf8');
        await rename(temp, file);
      } catch {
        // 状态文件只是探针，写不进去不影响功能。
      }
    });
    return statusChain;
  }

  /**
   * 尝试注册两个后台工具；官方工具还没就绪就等下一次机会。
   *
   * 为什么要等：本插件是 bundle 的一条宿主条目，而官方工具挂在 session-search 组的
   * **子条目**里，组的装载是异步的——实测重启后 apply 时 `ctx.tools.get('session_search')`
   * 可能还是 undefined。写死「apply 时取定义」会静默跳过（第一版就踩了这个坑）；
   * 这里改成「注册成功一次即定稿，之前每次 tools/change、agent 创建都重试」。
   */
  let finalized = false;
  /** 已注册的后台工具名（避免重复注册）。 */
  const done = new Set();
  /** 上一次「等待」状态的 missing 列表：轮询每 2 秒跑一次，内容不变就不重复写探针。 */
  let lastMissingKey = '';
  /** 系统提示章节的 disposer：工具集合变化时先撤再挂，避免同层同名冲突。 */
  let promptDisposer;
  function tryRegister() {
    let changed = false;
    for (const variant of TOOL_VARIANTS) {
      if (done.has(variant.asyncName)) continue;
      const definition = ctx.tools.get(variant.base);
      if (definition === undefined) continue;
      try {
        ctx.tools.register(makeAsyncDefinition(variant.base, variant.asyncName, definition));
        done.add(variant.asyncName);
        changed = true;
      } catch (error) {
        ctx.logger?.warn?.(`session-search-background: 注册 ${variant.asyncName} 失败：${describeError(error)}`);
      }
    }
    if (done.size === 0) {
      const missing = TOOL_VARIANTS.filter((variant) => !done.has(variant.asyncName)).map((variant) => variant.base);
      const key = missing.join(',');
      if (key !== lastMissingKey) {
        lastMissingKey = key;
        void writeStatus({ phase: 'waiting-for-official-tools', missing });
      }
      return;
    }
    if (!changed && finalized) return;
    finalized = true;
    const names = [...done];
    ctx.logger?.info?.(`session-search-background: 已注册 ${names.join(', ')}`);
    void writeStatus({ phase: 'registered', tools: names });
    addPromptSection(names);
  }

  /**
   * 加一段系统提示：优先用后台版，并说明结果以消息形式返回。
   * @param registered - 实际注册成功的后台工具名。
   */
  function addPromptSection(registered) {
    if (registered.length === 0) return;
    const prompt = ctx.get?.('systemPrompt');
    if (prompt === undefined) return;
    const names = registered.join(' / ');
    const text = syncTools === 'deny'
      ? `Session history search: use ${names}. They start in the background and return immediately; the results arrive later as a follow-up message (tagged 会话搜索结果) — do not re-issue the same query while it runs. The synchronous session_search / session_event_search are disabled; session_trace / session_event_trace / session_event_read stay available for lineage and exact reads.`
      : `Session history search: prefer ${names} over the synchronous session_search / session_event_search. They start in the background and return immediately; the results arrive later as a follow-up message (tagged 会话搜索结果) — do not re-issue the same query while it runs. The synchronous versions block until the whole search finishes. session_trace / session_event_trace / session_event_read stay available for lineage and exact reads.`;
    try {
      let order = 0;
      try {
        order = prompt.getSectionOrder('TOOL_SESSION_QUERY') + 1;
      } catch {
        // 未知的命名（上游改名）时退化为 0：位置靠前但内容不受影响。
      }
      // 工具集合变化时重挂：同一层里同名 section 会冲突，先撤旧的再挂新的。
      try {
        promptDisposer?.();
      } catch {
        // 旧 section 已被别的原因撤掉时忽略。
      }
      promptDisposer = prompt.section({ name: PROMPT_SECTION, order, text });
    } catch (error) {
      ctx.logger?.warn?.(`session-search-background: 系统提示章节注册失败：${describeError(error)}`);
    }
  }

  /**
   * 按配置屏蔽两个同步工具（只对指定 agent 生效）。
   *
   * 用 `tools.restrict({deny})` 而不是同名遮蔽：这是 dsh 里给 agent 裁剪工具集的公开
   * 机制（agent 预设/子代理在用），语义是「这个 agent 看不到这个名字」，不涉及定义替换。
   * @param agent - 目标 agent。
   */
  const masked = new WeakSet();
  function maskSyncTools(agent) {
    if (syncTools !== 'deny' || agent === undefined || masked.has(agent)) return;
    const agentTools = agent.ctx?.tools;
    if (agentTools === undefined || typeof agentTools.restrict !== 'function') return;
    try {
      agentTools.restrict({ deny: TOOL_VARIANTS.map((variant) => variant.base) });
      masked.add(agent);
    } catch (error) {
      ctx.logger?.warn?.(`session-search-background: 为 agent ${agent.id} 屏蔽同步工具失败：${describeError(error)}`);
    }
  }

  // 官方工具可能在本插件 apply 之后才注册（组的子条目异步装载）：事件三个时机都试，
  // 再加一条有界轮询兜底（事件在某些派发路径上可能收不到）；注册成功即定稿。
  // 状态文件里能看到最终落在哪个阶段。
  ctx.on('tools/change', () => tryRegister());
  ctx.on('agent/created', () => tryRegister());
  ctx.on('api-session/added', () => tryRegister(), { global: true });
  void writeStatus({ phase: 'applied', variants: TOOL_VARIANTS.map((variant) => variant.asyncName) });
  tryRegister();

  // 兜底轮询：每 2 秒试一次，最多 5 分钟；unref 不阻止进程退出，注册完自行停表。
  let pollTimer = setInterval(() => {
    if (done.size >= TOOL_VARIANTS.length) {
      clearInterval(pollTimer);
      pollTimer = undefined;
      return;
    }
    tryRegister();
  }, 2000);
  pollTimer.unref?.();
  ctx.effect(() => () => {
    if (pollTimer !== undefined) clearInterval(pollTimer);
  }, 'session-search-background.poll');

  // 仅在 syncTools === 'deny' 时需要逐个 agent 挂限制；keep 模式不做任何作用域操作。
  if (syncTools === 'deny') {
    for (const agent of ctx.agents.list?.() ?? []) maskSyncTools(agent);
    ctx.on('agent/created', ({ agent }) => maskSyncTools(agent));
    ctx.on('api-session/added', () => {
      for (const agent of ctx.agents.list?.() ?? []) maskSyncTools(agent);
    }, { global: true });
  }
}
