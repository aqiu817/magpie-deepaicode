// 推理请求链路：loader 的 fetch。
//
// magpie 的网关已经把任意 Agent 协议转成了 Chat Completions / Responses，
// 并决定基地址（loader.baseURL）。插件要做的只有五件事：
//   1. 注入上游要求的头（UA / Api-Key / Theos 车道 / 实例 id / 机器指纹）；
//   2. 把路径归一到目标端点（不依赖 magpie 拼接行为的“保险丝”）；
//   3. 整形请求体（上游校验“请求必须像桌面端发出的”，缺 system/instructions 时补最简值）；
//   4. 错误语义映射（409 → 429、403 email_unverified → 标记登录失效、302 → 401）；
//   5. 原样流式透传（不缓冲，不改内容）。

import {
  DEFAULT_LANE_VERSION,
  HEADER_AFFINITY,
  HEADER_LANE,
  HEADER_MACHINE,
  RETRY_AFTER_CAP_S,
  SHAPE_SYSTEM_MESSAGE,
} from "./constants.mjs";
import { directBase, directHeaders, resolveLaneVersion } from "./direct.mjs";
import { t, resolveLang } from "./i18n.mjs";
import { resolveAccountSettings } from "./modes.mjs";

const CHAT_SUFFIX = "/chat/completions";
const RESPONSES_SUFFIX = "/responses";

/** 目标基地址（magpie 会拼 /chat/completions 或 /responses，但我们自己重写）。 */
export function loaderTargets(settings) {
  return { baseURL: directBase(settings.origin), chatSuffix: CHAT_SUFFIX, responsesSuffix: RESPONSES_SUFFIX };
}

/**
 * 把 magpie 给的 URL 归一到目标端点。
 *
 * magpie 传给插件时通常已是 {baseURL}/chat/completions；但不同版本/不同 npm 包
 * 的拼接方式不一定一致（也可能重复带 /deepai_code）。这里只认路径尾巴：
 *   .../responses  → Responses 端点
 *   其它           → Chat Completions 端点
 * 查询串原样保留（例如 ?alt=sse）。
 */
export function normalizeIncomingUrl(input, settings) {
  const raw = typeof input === "string" ? input : input?.url ?? String(input ?? "");
  let pathname = "";
  let search = "";
  try {
    const url = new URL(raw);
    pathname = url.pathname;
    search = url.search;
  } catch {
    pathname = raw;
  }
  const suffix = /\/responses\s*$/i.test(pathname) ? RESPONSES_SUFFIX : CHAT_SUFFIX;
  const base = loaderTargets(settings).baseURL;
  return `${base}${suffix}${search}`;
}

/** 每个请求要带的头（其余交给 magpie 的 init.headers）。 */
export function modeHeaders(settings) {
  return directHeaders({
    key: settings.key,
    machineFp: settings.machineFp,
    laneVersion: settings.laneVersion === "auto" ? DEFAULT_LANE_VERSION : settings.laneVersion,
  });
}

/**
 * 上游 2026-11-07 起校验“请求必须是 DeepAI Code 发出的样子”：
 * chat/completions 的 messages 首条必须是 system（或 developer），
 * responses 必须带非空 instructions；缺失时上游回
 * 400 "This request is not one DeepAI Code sends."。
 * 只在缺的时候补一条最简 system / instructions，不改已有内容。
 *
 * 另一个上游约束（2026-11-26 对照 DeepAICode2API/桌面端实锤，issue #8）：
 * chat 的 user content **不接受图与文字混在同一段**——混合段直接
 * 400 "provider rejected"（或更早的另类失败表现）。桌面端 pi runtime
 * 从不发混合段：带图消息的 content 只有图，文字在相邻消息里。
 * 见到混合段时拆成两条 user 消息（图在前、文字在后），实测上游 200 且真识图。
 *
 * 返回重写后的 JSON 字符串；没动返回 null。
 */
export function shapeRequestBody(target, body) {
  if (typeof body !== "string" || body.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  let changed = false;
  const pathname = new URL(target).pathname;
  if (pathname.endsWith(CHAT_SUFFIX) && Array.isArray(parsed.messages) && parsed.messages.length > 0) {
    const first = parsed.messages[0];
    const role = first && typeof first === "object" ? String(first.role ?? "") : "";
    if (role !== "system" && role !== "developer") {
      parsed.messages = [{ role: "system", content: SHAPE_SYSTEM_MESSAGE }, ...parsed.messages];
      changed = true;
    }
    // 图与文字混在同一段 content：拆成 图 一条、文字 一条（顺序保持图在前）。
    // 上游对混合段 400；拆分形态实测 200 且模型真收到图。
    if (splitMixedImageMessages(parsed.messages)) changed = true;
  } else if (pathname.endsWith(RESPONSES_SUFFIX)) {
    if (typeof parsed.instructions !== "string" || parsed.instructions.trim() === "") {
      parsed.instructions = SHAPE_SYSTEM_MESSAGE;
      changed = true;
    }
    // responses 的 input 数组同样可能带混合段
    if (splitMixedImageMessages(parsed.input)) changed = true;
  }
  return changed ? JSON.stringify(parsed) : null;
}

/**
 * 就地拆分 messages/input 数组里的"图+文字混合段"。
 * 一段 content 数组同时含文字（text/input_text 对象或裸字符串）与图
 * （image_url/input_image）时，重写为两条同 role 消息：
 * 第一条只含全部图，第二条只含全部文字（裸字符串归一为 text 对象）。
 * 返回是否有改动。
 */
export function splitMixedImageMessages(messages) {
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object" || !Array.isArray(msg.content)) continue;
    const isImage = (p) => p && typeof p === "object" && (p.type === "image_url" || p.type === "input_image");
    const isText = (p) => (typeof p === "string" && p.length > 0) || (p && typeof p === "object" && (p.type === "text" || p.type === "input_text"));
    const images = msg.content.filter(isImage);
    const texts = msg.content.filter(isText);
    if (images.length === 0 || texts.length === 0) continue;
    // 其余未知部分（若存在）跟随图段，保持信息不丢
    const others = msg.content.filter((p) => !isImage(p) && !isText(p));
    messages.splice(i, 1,
      { ...msg, content: [...images, ...others] },
      { ...msg, content: texts.map((p) => typeof p === "string" ? { type: "text", text: p } : p) },
    );
    changed = true;
    i += 1; // 跳过刚插入的第二条
  }
  return changed;
}

function clampRetryAfter(headers) {
  const raw = headers.get("retry-after");
  if (!raw) return;
  const secs = Number(String(raw).trim());
  if (!Number.isFinite(secs) || secs <= 0) return;
  if (secs > RETRY_AFTER_CAP_S) headers.set("retry-after", String(RETRY_AFTER_CAP_S));
}

/** 重建响应：改状态/加头时必须去掉与会话体相关的长度与编码头。 */
function rebuildResponse(res, { status = res.status, body = null, extraHeaders = {} } = {}) {
  const headers = new Headers(res.headers);
  for (const name of ["content-length", "content-encoding", "transfer-encoding"]) headers.delete(name);
  clampRetryAfter(headers);
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  return new Response(body, { status, statusText: res.statusText || "", headers });
}

function jsonError(status, message, type = "invalid_request_error", code = status) {
  return new Response(JSON.stringify({ error: { message, type, code } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * SSE 截断检测：上游（或中间链路，如代理重置）可能以 200 开始流式响应却在
 * 收尾前断流（无 `data: [DONE]`、无 finish_reason）。不设防的话调用方会把
 * 半截流当成完整回合（"200 + unexpected EOF"，issue #9）。
 *
 * 做法：在响应体上包一层 TransformStream——主流逐字节原样透传（不缓冲、
 * 延迟不增加），只保留**尾部窗口**；流正常关闭时检查窗口内是否有终止标记
 * （`[DONE]` 或任一 finish_reason）。缺失则在流尾注入一条 `error` SSE 事件
 * 再关闭，让严格客户端把该回合判为失败而不是吞下半截回复。
 * 响应不是 text/event-stream 时原样返回，不做检查。
 */
const SSE_TAIL_WINDOW = 4096;

export function guardStreamTruncation(res) {
  const ct = String(res.headers.get("content-type") ?? "");
  if (!ct.includes("text/event-stream") || !res.body) return res;

  let tail = "";
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const check = new TransformStream({
    transform(chunk, controller) {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      tail = (tail + text).slice(-SSE_TAIL_WINDOW);
      controller.enqueue(chunk);
    },
    flush(controller) {
      const done = /\[DONE\]|"finish_reason"\s*:\s*"[a-z_]+"|'finish_reason'\s*:\s*'[a-z_]+'/i.test(tail);
      if (!done) {
        const frame = 'data: {"error":{"message":"upstream closed the SSE stream before [DONE] (truncated)","type":"upstream_error","code":"unexpected_eof"}}\n\n';
        controller.enqueue(encoder.encode(frame));
      }
    },
  });

  const watched = res.body.pipeThrough(check, { highWaterMark: 0 });
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(watched, { status: res.status, statusText: res.statusText, headers });
}

/**
 * 错误语义映射（见 PROTOCOL.md）。
 * 2xx 交由 guardStreamTruncation 检查流式截断；非 2xx 做语义映射。
 */
export async function guardResponse(res) {
  if (res.ok) return guardStreamTruncation(res);
  // 容量拒绝：magpie 只对 429/5xx 做账号故障转移，409（session_busy）会直接落到 agent。
  if (res.status === 409) {
    const body = await res.text();
    return rebuildResponse(res, { status: 429, body });
  }

  if (res.status === 403) {
    const body = await res.text();
    const unverified = /email_unverified|邮箱未验证/i.test(body);
    return rebuildResponse(res, {
      body,
      extraHeaders: unverified ? { "X-Magpie-Sign-In": "expired" } : {},
    });
  }

  return res;
}

/**
 * 构造 loader。
 *
 * 本函数只做“准备”，真正的请求在 loader.fetch 里发。
 * 所有请求的 URL 都从配置的基地址重建，凭据只可能发往配置的上游。
 */
export function createLoader(auth, options = {}, { fetchImpl = globalThis.fetch } = {}) {
  const settings = resolveAccountSettings(auth, options);
  const targets = loaderTargets(settings);
  const headers = modeHeaders(settings);
  const lang = resolveLang(options);
  // 车道探测改为惰性：首次 fetch 时才发起（显式值直接兑现；auto 探测每 origin
  // 进程内缓存一次，带 key）。护栏拒绝发生得更早，不应为被拒的请求去打上游。
  let laneP;

  const loader = {
    baseURL: targets.baseURL,
    // 直连上游只认 Api-Key 头，这里不设置 apiKey，避免多带一个 Authorization。
    headers,
    async fetch(input, init = {}) {
      // URL 一律从配置的基地址重建：magpie 传进来的主机/路径只用来判断
      // 是 chat 还是 responses，凭据永远不会被发往别的主机。
      const target = normalizeIncomingUrl(input, settings);

      // 可选护栏 maxInputBytes（issue #11 的本机防线，QingLong-C 方案）：
      // 按整形后的实际外发 JSON 计 UTF-8 字节，超限在本地拒绝
      // （400 context_length_exceeded），不截断、不打上游、不触发车道探测。
      // 字节数不是 token 数：护栏只是防超长输入静默丢上下文的保守闸门，
      // 不修复上游、不压缩会话。关闭（0）时零开销。
      const maxInputBytes = Number(options.maxInputBytes);
      const guarded = Number.isSafeInteger(maxInputBytes) && maxInputBytes > 0;
      if (guarded && ((init?.body != null && typeof init.body !== "string") || (input instanceof Request && init.body == null && input.body))) {
        return jsonError(400, t(lang, "errGuardNeedsString"));
      }

      // 上游校验请求形状：缺 system / instructions 时补最简值；
      // 图+文混合段拆成两条（上游不接受混合段）。
      const shaped = shapeRequestBody(target, init?.body);
      const outgoing = shaped === null ? init : { ...init, body: shaped };
      if (guarded && typeof outgoing.body === "string") {
        const inputBytes = new TextEncoder().encode(outgoing.body).byteLength;
        if (inputBytes > maxInputBytes) {
          return jsonError(400, t(lang, "errGuardOverLimit", { bytes: String(inputBytes), limit: String(maxInputBytes) }), "invalid_request_error", "context_length_exceeded");
        }
      }

      laneP ??= resolveLaneVersion(settings.origin, { explicit: settings.laneVersion, fetchImpl, key: settings.key });
      const lane = await laneP;

      const merged = new Headers(init?.headers ?? {});
      for (const [key, value] of Object.entries(headers)) merged.set(key, value);
      merged.set(HEADER_LANE, lane);
      if (settings.machineFp) {
        merged.set(HEADER_MACHINE, settings.machineFp);
      }

      let res;
      try {
        res = await fetchImpl(target, {
          ...outgoing,
          headers: merged,
          redirect: "error", // 无效 Key 会 302 到登录页：绝不跟随
        });
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        const msg = String(err?.message ?? err);
        if (/redirect/i.test(msg)) return jsonError(401, t(lang, "errRedirect"));
        throw err; // 交给 magpie 的故障转移
      }

      return guardResponse(res);
    },
  };

  return loader;
}

/** chat.headers 钩子用：给请求带上会话粘性。 */
export function sessionAffinityHeaders(sessionId) {
  const value = String(sessionId ?? "").trim();
  return value ? { [HEADER_AFFINITY]: value } : {};
}
