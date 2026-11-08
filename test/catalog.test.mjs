import test from "node:test";
import assert from "node:assert/strict";

import {
  catalogFromDirect,
  createCatalogCache,
  fallbackModels,
  modelsFromCatalog,
  normalizeRawModel,
  toMagpieModel,
} from "../src/catalog.mjs";
import { FALLBACK_MODELS } from "../src/constants.mjs";

const upstreamModel = {
  id: "glm-5.3-flash",
  name: "GLM 5.3 Flash",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 1048576,
  maxTokens: 131072,
  premier: false,
  theosPerRequest: "0",
};

const responsesModel = {
  id: "gpt-6-astra",
  name: "GPT-6 Astra",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 1048576,
  maxTokens: 131072,
  premier: true,
  theosPerRequest: "50",
  api: "openai-responses",
};

test("normalizeRawModel：上游形态", () => {
  const m = normalizeRawModel(upstreamModel);
  assert.equal(m.id, "glm-5.3-flash");
  assert.equal(m.free, true);
  assert.equal(m.rate, 0);
  assert.equal(m.responses, false);
  assert.deepEqual(m.input, ["text", "image"]);
});

test("normalizeRawModel：Responses 模型（api 字段）", () => {
  const m = normalizeRawModel(responsesModel);
  assert.equal(m.name, "GPT-6 Astra");
  assert.equal(m.free, false);
  assert.equal(m.rate, 50);
  assert.equal(m.responses, true);
  assert.equal(m.contextWindow, 1048576);
});

test("免费判定：theosPerRequest 的各种 0 写法", () => {
  for (const raw of ["0", "0.0", "0.00"]) {
    const m = normalizeRawModel({ id: `m-${raw}`, theosPerRequest: raw, premier: true });
    assert.equal(m.free, true, `theosPerRequest=${raw} 应判免费`);
    assert.equal(m.rate, 0);
  }
  // 没有 theosPerRequest：按 premier 推断
  assert.equal(normalizeRawModel({ id: "a", premier: true }).free, false);
  assert.equal(normalizeRawModel({ id: "b", premier: false }).free, true);
  // 明确收费
  const paid = normalizeRawModel({ id: "c", theosPerRequest: "3", premier: true });
  assert.equal(paid.free, false);
  assert.equal(paid.rate, 3);
});

test("normalizeRawModel：缺 id 返回 null", () => {
  assert.equal(normalizeRawModel({ name: "no id" }), null);
});

test("magpie 模型：免费用 free 而不是 rate:0", () => {
  const free = toMagpieModel(normalizeRawModel(upstreamModel));
  assert.equal(free.free, true);
  assert.equal(free.rate, undefined);
  assert.equal(free.limit.context, 1048576);
  assert.equal(free.capabilities.attachment, true);
  assert.deepEqual(free.modalities.input, ["text", "image"]);

  const paid = toMagpieModel(normalizeRawModel({ id: "glm-5.3", premier: true, theosPerRequest: "3" }));
  assert.equal(paid.rate, 3);
  assert.equal(paid.free, undefined);
});

test("Responses 模型带模型级 npm 覆盖", () => {
  const m = toMagpieModel(normalizeRawModel(responsesModel));
  assert.equal(m.provider.npm, "@ai-sdk/openai");
});

test("目录解析：上游 /models", () => {
  const direct = catalogFromDirect({ models: [upstreamModel, upstreamModel], default: "glm-5.3-flash" });
  assert.equal(direct.length, 1, "重复 id 应去重");

  assert.deepEqual(catalogFromDirect({}), []);
  assert.deepEqual(catalogFromDirect(null), []);
});

test("modelsFromCatalog：键为 id，并展开基础模型", () => {
  const out = modelsFromCatalog(catalogFromDirect({ models: [upstreamModel] }), {
    "glm-5.3-flash": { name: "Base", options: { temperature: 0.2 } },
  });
  assert.deepEqual(Object.keys(out), ["glm-5.3-flash"]);
  assert.equal(out["glm-5.3-flash"].options.temperature, 0.2);
  assert.equal(out["glm-5.3-flash"].name, "GLM 5.3 Flash");
});

test("兜底快照：18 个、9 免费、不含别名", () => {
  const list = fallbackModels({});
  assert.equal(Object.keys(list).length, FALLBACK_MODELS.length);
  assert.equal(FALLBACK_MODELS.length, 18);
  assert.equal(FALLBACK_MODELS.filter((m) => m.theosPerRequest === "0").length, 9);
  assert.equal(list["gpt-6-astra"].provider.npm, "@ai-sdk/openai");
});

test("目录缓存：TTL 内命中、TTL 外重取、失败不写入", async () => {
  let clock = 0;
  let calls = 0;
  const cache = createCatalogCache({ ttlMs: 100, now: () => clock });

  const value = await cache.get("k", async () => {
    calls += 1;
    return ["a"];
  });
  assert.deepEqual(value, ["a"]);
  assert.equal(calls, 1);

  clock = 50;
  assert.deepEqual(await cache.get("k", async () => ["b"]), ["a"]);

  clock = 200;
  assert.deepEqual(await cache.get("k", async () => ["c"]), ["c"]);
  assert.equal(calls, 1);

  const failing = createCatalogCache({ ttlMs: 100, now: () => clock });
  await assert.rejects(failing.get("k", async () => {
    throw new Error("boom");
  }));
  assert.equal(failing.peek("k"), undefined);
});
