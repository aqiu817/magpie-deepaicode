// 账号设置解析：一个 magpie 账号 → 用哪个地址、哪份凭据（直连上游）。

import { DEFAULT_BASE_ORIGIN } from "./constants.mjs";
import { resolveMachineFingerprint, sha256Hex } from "./machine.mjs";
import { trimSlash } from "./util.mjs";

/**
 * 解析一个账号的最终设置（直连上游）。
 *
 * 优先级：auth.metadata（登录时写入） > options（插件选项） > 默认值。
 */
export function resolveAccountSettings(auth, options = {}) {
  const metadata = auth?.metadata ?? {};

  const origin = trimSlash(options.baseOrigin || DEFAULT_BASE_ORIGIN);
  const key = String(auth?.key ?? "").trim();
  const laneVersion = String(metadata.laneVersion ?? options.laneVersion ?? "auto").trim() || "auto";
  const machineFp = resolveMachineFingerprint();
  const username = String(metadata.username ?? "").trim();

  return { mode: "direct", origin, key, laneVersion, machineFp, username };
}

/** 稳定账号 id：同 Key 重登 = 替换而不是新增。 */
export function accountIdFor({ key = "" } = {}) {
  return `deepai:${sha256Hex(String(key ?? "")).slice(0, 16)}`;
}
