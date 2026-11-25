import test from "node:test";
import assert from "node:assert/strict";

import { VERSION } from "../src/constants.mjs";
import { createLoader, guardResponse, normalizeIncomingUrl, shapeRequestBody, splitMixedImageMessages } from "../src/fetch.mjs";
import { resolveAccountSettings } from "../src/modes.mjs";

const CHAT = "/chat/completions";
const FAKE_KEY = "fake-deepai-key-0001";

function directAuth(options = {}) {
  return { type: "api", key: FAKE_KEY, metadata: { mode: "direct", ...options } };
}

// 测试里显式给 lane，避免触发 auto 探测
const LANE_OPTS = { laneVersion: "4" };

test("normalizeIncomingUrl：直连模式归一到 /deepai_code/{chat,responses}", () => {
  const settings = resolveAccountSettings(directAuth(), { baseOrigin: "https://api.deepai.org", ...LANE_OPTS });
  assert.equal(
    normalizeIncomingUrl("https://api.deepai.org/deepai_code" + CHAT, settings),
    "https://api.deepai.org/deepai_code" + CHAT,
  );
  // 重复的 /deepai_code（不同版本拼接行为不同的保险丝）
  assert.equal(
    normalizeIncomingUrl("https://api.deepai.org/deepai_code/deepai_code" + CHAT, settings),
    "https://api.deepai.org/deepai_code" + CHAT,
  );
  assert.equal(
    normalizeIncomingUrl("https://api.deepai.org/responses?beta=1", settings),
    "https://api.deepai.org/deepai_code/responses?beta=1",
  );
});

test("createLoader：直连头含 UA / Api-Key / 车道 / 实例 id / 机器指纹", () => {
  const direct = createLoader(directAuth(), { ...LANE_OPTS });
  assert.equal(direct.baseURL, "https://api.deepai.org/deepai_code");
  assert.equal(direct.apiKey, undefined);
  assert.equal(direct.headers["Api-Key"], directAuth().key);
  assert.equal(direct.headers["X-DeepAI-Code-Theos"], "4");
  assert.equal(direct.headers["User-Agent"], `magpie-deepaicode/${VERSION}`);
  assert.match(direct.headers["X-DeepAI-Code-Instance"], /^[0-9a-f]{32}$/);
  assert.ok(direct.headers["X-DeepAI-Code-Machine"]);
  assert.equal(direct.headers.Authorization, undefined);
});

test("loader.fetch：直连注入 Api-Key / 车道 / 机器指纹", async () => {
  let captured = null;
  const loader = createLoader(directAuth(), { ...LANE_OPTS }, {
    fetchImpl: async (url, init) => {
      captured = { url, headers: init.headers };
      return new Response("{}", { status: 200 });
    },
  });
  await loader.fetch("https://api.deepai.org/deepai_code/responses", { method: "POST" });
  assert.equal(captured.url, "https://api.deepai.org/deepai_code/responses");
  assert.equal(captured.headers.get("api-key"), directAuth().key);
  assert.equal(captured.headers.get("x-deepai-code-theos"), "4");
  assert.equal(captured.headers.get("authorization"), null);
  assert.ok(captured.headers.get("x-deepai-code-machine"));
});

test("loader.fetch：目标 URL 一律从配置基地址重建（凭据不发往外域）", async () => {
  let captured = null;
  const loader = createLoader(directAuth(), { baseOrigin: "https://api.deepai.org", ...LANE_OPTS }, {
    fetchImpl: async (url, init) => {
      captured = { url, headers: init.headers, redirect: init.redirect };
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await loader.fetch("https://evil.example.com/v1" + CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  assert.equal(captured.url, "https://api.deepai.org/deepai_code" + CHAT);
  assert.equal(captured.headers.get("api-key"), directAuth().key);
  assert.equal(captured.redirect, "error");
});

test("loader.fetch：messages 缺 system 时自动补最简 system", async () => {
  let captured = null;
  const loader = createLoader(directAuth(), { ...LANE_OPTS }, {
    fetchImpl: async (url, init) => {
      captured = { url, body: init.body };
      return new Response("{}", { status: 200 });
    },
  });
  const body = JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] });
  await loader.fetch("https://api.deepai.org/deepai_code" + CHAT, { method: "POST", body });

  const sent = JSON.parse(captured.body);
  assert.equal(sent.messages[0].role, "system");
  assert.ok(sent.messages[0].content.length > 0);
  assert.equal(sent.messages[1].role, "user");
  assert.equal(sent.messages[1].content, "hi");
});

test("loader.fetch：已有 system 时原样透传", async () => {
  let captured = null;
  const loader = createLoader(directAuth(), { ...LANE_OPTS }, {
    fetchImpl: async (url, init) => {
      captured = { body: init.body };
      return new Response("{}", { status: 200 });
    },
  });
  const body = JSON.stringify({ messages: [{ role: "system", content: "be nice" }, { role: "user", content: "hi" }] });
  await loader.fetch("https://api.deepai.org/deepai_code" + CHAT, { method: "POST", body });
  assert.equal(captured.body, body, "不应改动请求体");
});

test("shapeRequestBody：chat / responses / 非 JSON 的分支", () => {
  // chat 缺 system → 补
  const chat = shapeRequestBody(
    "https://x/deepai_code" + CHAT,
    JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  );
  const chatParsed = JSON.parse(chat);
  assert.equal(chatParsed.messages[0].role, "system");
  assert.equal(chatParsed.messages[1].content, "hi");

  // developer 开头也算合格
  assert.equal(
    shapeRequestBody("https://x/deepai_code" + CHAT, JSON.stringify({ messages: [{ role: "developer", content: "x" }] })),
    null,
  );
  // 已有 system → 不动
  assert.equal(
    shapeRequestBody("https://x/deepai_code" + CHAT, JSON.stringify({ messages: [{ role: "system", content: "x" }] })),
    null,
  );
  // 空 messages → 不动（上游的校验对象是“有内容的首条”）
  assert.equal(shapeRequestBody("https://x/deepai_code" + CHAT, JSON.stringify({ messages: [] })), null);
  // responses 缺 instructions → 补
  const resp = shapeRequestBody("https://x/deepai_code/responses", JSON.stringify({ model: "gpt-6-astra", input: [] }));
  assert.ok(JSON.parse(resp).instructions.length > 0);
  // responses 已有 instructions → 不动
  assert.equal(
    shapeRequestBody("https://x/deepai_code/responses", JSON.stringify({ instructions: "x" })),
    null,
  );
  // 非 JSON / 非 POST 体 → 不动
  assert.equal(shapeRequestBody("https://x/deepai_code" + CHAT, "not-json"), null);
  assert.equal(shapeRequestBody("https://x/deepai_code" + CHAT, ""), null);
});

test("splitMixedImageMessages：图+文混合段拆成 图一条/文字一条（图在前）", () => {
  const img = { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } };
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: [{ type: "text", text: "look" }, img, { type: "text", text: "carefully" }] },
  ];
  assert.equal(splitMixedImageMessages(messages), true);
  assert.equal(messages.length, 3);
  // 第一条 user：只剩图（顺序保持）
  assert.deepEqual(messages[1].content, [img]);
  // 第二条 user：只剩文字
  assert.deepEqual(messages[2].content, [
    { type: "text", text: "look" },
    { type: "text", text: "carefully" },
  ]);
});

test("splitMixedImageMessages：纯图段 / 纯文本段 / 字符串 content 不动", () => {
  const img = { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } };
  // 纯图段：不拆
  const onlyImg = [{ role: "user", content: [img] }];
  assert.equal(splitMixedImageMessages(onlyImg), false);
  assert.deepEqual(onlyImg[0].content, [img]);
  // 纯文本段：不拆
  const onlyText = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
  assert.equal(splitMixedImageMessages(onlyText), false);
  // 字符串 content：不拆
  const strContent = [{ role: "user", content: "plain" }];
  assert.equal(splitMixedImageMessages(strContent), false);
  // 非数组 messages：安全返回 false
  assert.equal(splitMixedImageMessages(undefined), false);
});

test("splitMixedImageMessages：裸字符串文字也算文本段（magpie 实际形态）", () => {
  const img = { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } };
  const messages = [
    { role: "user", content: ["question text", img] },
  ];
  assert.equal(splitMixedImageMessages(messages), true);
  assert.deepEqual(messages[0].content, [img]);
  assert.deepEqual(messages[1].content, [{ type: "text", text: "question text" }]);
});

test("shapeRequestBody：chat 混合段在补 system 的同时被拆分", () => {
  const img = { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } };
  const out = shapeRequestBody(
    "https://x/deepai_code" + CHAT,
    JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "look" }, img] }] }),
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.messages.length, 3); // 补的 system + 图条 + 文字条
  assert.equal(parsed.messages[0].role, "system");
  assert.deepEqual(parsed.messages[1].content, [img]);
  assert.deepEqual(parsed.messages[2].content, [{ type: "text", text: "look" }]);
  // responses 的 input 混合段同样拆分
  const outResp = shapeRequestBody(
    "https://x/deepai_code/responses",
    JSON.stringify({ input: [{ role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,AAA" }] }] }),
  );
  const parsedResp = JSON.parse(outResp);
  assert.equal(parsedResp.input.length, 2);
  assert.deepEqual(parsedResp.input[0].content, [{ type: "input_image", image_url: "data:image/png;base64,AAA" }]);
  assert.deepEqual(parsedResp.input[1].content, [{ type: "input_text", text: "look" }]);
});

test("loader.fetch：maxInputBytes 超限本地 400，不截断不打上游", async () => {
  let calls = 0;
  const loader = createLoader(directAuth(), { ...LANE_OPTS, maxInputBytes: 1000 }, {
    fetchImpl: async () => {
      calls += 1;
      return new Response("{}");
    },
  });
  const response = await loader.fetch("https://api.deepai.org/deepai_code" + CHAT, {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "system", content: "中文".repeat(200) }] }),
  });
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
  const payload = await response.json();
  assert.equal(payload.error.code, "context_length_exceeded");
  assert.match(payload.error.message, /1000/);
});

test("loader.fetch：maxInputBytes 计数含 instructions/历史/tools，小请求原样透传", async () => {
  const forwarded = [];
  const loader = createLoader(directAuth(), { ...LANE_OPTS, maxInputBytes: 1000 }, {
    fetchImpl: async (url, init) => {
      forwarded.push(init.body);
      return new Response("{}");
    },
  });
  const small = JSON.stringify({ instructions: "只用中文", input: [{ role: "user", content: "你好" }] });
  assert.equal((await loader.fetch("https://x/responses", { body: small })).status, 200);
  assert.equal(forwarded[0], small);
  const large = JSON.stringify({ instructions: "中文", input: [], tools: [{ description: "文".repeat(500) }] });
  const refused = await loader.fetch("https://x/responses?beta=1", { body: large });
  assert.equal(refused.status, 400);
  assert.equal(forwarded.length, 1);
});

test("loader.fetch：maxInputBytes 默认关闭（0）不设限", async () => {
  const loader = createLoader(directAuth(), LANE_OPTS, { fetchImpl: async () => new Response("{}") });
  const body = JSON.stringify({ instructions: "x".repeat(2000), input: [] });
  assert.equal((await loader.fetch("https://x/responses", { body })).status, 200);
});

test("loader.fetch：上限按整形后实发字节计（含补的 system），边界值恰好放行", async () => {
  let calls = 0;
  const original = JSON.stringify({ messages: [{ role: "user", content: "你好" }] });
  const shaped = shapeRequestBody("https://x" + CHAT, original);
  const bytes = new TextEncoder().encode(shaped).byteLength;
  const upstream = async () => { calls += 1; return new Response("{}"); };
  const strict = createLoader(directAuth(), { ...LANE_OPTS, maxInputBytes: bytes - 1 }, { fetchImpl: upstream });
  assert.equal((await strict.fetch("https://x" + CHAT, { body: original })).status, 400);
  assert.equal(calls, 0);
  const exact = createLoader(directAuth(), { ...LANE_OPTS, maxInputBytes: bytes }, { fetchImpl: upstream });
  assert.equal((await exact.fetch("https://x" + CHAT, { body: original })).status, 200);
  assert.equal(calls, 1);
});

test("loader.fetch：超限拒绝不触发车道探测（auto 也不探测）", async () => {
  let calls = 0;
  const loader = createLoader(directAuth(), { maxInputBytes: 100 }, {
    fetchImpl: async () => { calls += 1; return new Response("{}"); },
  });
  await loader.fetch("https://x" + CHAT, { body: "x".repeat(101) });
  assert.equal(calls, 0);
});

test("loader.fetch：启用护栏后非字符串 body 无法绕过", async () => {
  let calls = 0;
  const loader = createLoader(directAuth(), { ...LANE_OPTS, maxInputBytes: 100 }, {
    fetchImpl: async () => { calls += 1; return new Response("{}"); },
  });
  const response = await loader.fetch("https://x" + CHAT, { body: new Uint8Array(101) });
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
  const request = new Request("https://x" + CHAT, { method: "POST", body: "x".repeat(101) });
  assert.equal((await loader.fetch(request)).status, 400);
  assert.equal(calls, 0);
});

test("shapeRequestBody：带 query string 的端点同样整形", () => {
  const chat = JSON.parse(shapeRequestBody("https://x" + CHAT + "?beta=1", JSON.stringify({ messages: [{ role: "user", content: "你好" }] })));
  assert.equal(chat.messages[0].role, "system");
  const responses = JSON.parse(shapeRequestBody("https://x/responses?beta=1", JSON.stringify({ input: [] })));
  assert.ok(responses.instructions);
});

test("guardResponse：409 session_busy → 429，Retry-After 夹到 30s", async () => {
  const res = await guardResponse(
    new Response('{"error":{"code":"session_busy"}}', {
      status: 409,
      headers: { "content-type": "application/json", "retry-after": "120" },
    }),
  );
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "30");
  assert.match(await res.text(), /session_busy/);
});

test("guardResponse：403 email_unverified 标记登录失效", async () => {
  const res = await guardResponse(
    new Response('{"error":{"code":"email_unverified"}}', {
      status: 403,
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("x-magpie-sign-in"), "expired");
});

test("guardResponse：SSE 正常收尾（[DONE]）逐字节透传，不注入错误帧", async () => {
  const raw = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
  const res = await guardResponse(
    new Response(raw, { status: 200, headers: { "content-type": "text/event-stream" } }),
  );
  const text = await res.text();
  assert.equal(text, raw, "完整流必须一字不差");
  assert.doesNotMatch(text, /unexpected_eof/);
});

test("guardResponse：SSE 以 finish_reason 收尾也不注入", async () => {
  const raw = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
  const res = await guardResponse(
    new Response(raw, { status: 200, headers: { "content-type": "text/event-stream" } }),
  );
  const text = await res.text();
  assert.equal(text, raw);
});

test("guardResponse：SSE 截断（无 [DONE]/finish_reason）→ 流尾注入 unexpected_eof 错误帧", async () => {
  const raw = 'data: {"choices":[{"delta":{"content":"half of a long reply…"}}]}\n\n';
  const res = await guardResponse(
    new Response(raw, { status: 200, headers: { "content-type": "text/event-stream" } }),
  );
  assert.equal(res.status, 200);
  const text = await res.text();
  // 原始内容保留，且追加了显式的截断错误帧
  assert.match(text, /half of a long reply/);
  assert.match(text, /unexpected_eof/);
  assert.match(text, /truncated/);
});

test("guardResponse：非 SSE 的 200 原样返回，不做截断检查", async () => {
  const raw = '{"choices":[{"message":{"content":"ok"}}]}';
  const res = await guardResponse(
    new Response(raw, { status: 200, headers: { "content-type": "application/json" } }),
  );
  assert.equal(await res.text(), raw);
});

test("loader.fetch：302（redirect:error）→ 401 且文案可读", async () => {
  const loader = createLoader(directAuth(), { ...LANE_OPTS }, {
    fetchImpl: async () => {
      throw new TypeError("fetch failed: unexpected redirect");
    },
  });
  const res = await loader.fetch("https://api.deepai.org/deepai_code" + CHAT, { method: "POST" });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.ok(body.error.message.length > 0);
});
