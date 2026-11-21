// 额度窗口：Magpie 只有在拿到 used 时才认为窗口有读数。
// amount = 0 会被当成“没给计数”，满额窗口会退化成 text-only、路由显示额度未知。
import test from "node:test";
import assert from "node:assert/strict";

import { buildDirectUsage } from "../src/usage.mjs";

test("满额窗口（78/78 Theos）给出 used=0，避免被 Magpie 当成 text-only", () => {
  const usage = buildDirectUsage({
    allowance: { balance: "78", granted: "78", refreshAt: "2026-11-21T19:17:13Z" },
    summary: { credits_remaining: 0 },
    lang: "zh",
  });

  const window = usage.windows[0];
  assert.equal(window.amount, 0);
  assert.equal(window.used, 0);
  assert.equal(window.limit, 78);
  assert.equal(window.display, "剩 78 / 78 theos");
  assert.equal(window.resetsAt, "2026-11-21T19:17:13Z");
});

test("部分使用的窗口给出对应百分比", () => {
  const usage = buildDirectUsage({
    allowance: { balance: "39", granted: "78" },
    summary: { credits_remaining: 0 },
    lang: "zh",
  });

  const window = usage.windows[0];
  assert.equal(window.amount, 39);
  assert.equal(window.used, 50);
  assert.equal(window.limit, 78);
});
