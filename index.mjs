// magpie 供应商插件入口：DeepAI Code（直连上游）。
//
// 钩子清单（magpie 会调用的只有这些）：
//   config / auth(methods, loader, usage, checkin) / provider.models / chat.headers
// 导出纪律：入口只导出插件函数与 _internal；辅助函数不要从入口导出。

import {
  catalogFromDirect,
  createCatalogCache,
  fallbackModels,
  modelsFromCatalog,
} from "./src/catalog.mjs";
import { DEFAULT_OPTIONS, FALLBACK_SNAPSHOT_DATE, PROVIDER } from "./src/constants.mjs";
import { directBase, getDirectModels, getTheos as getDirectTheos, getUsageSummary, normalizeAllowance, resolveLaneVersion } from "./src/direct.mjs";
import { createLoader, normalizeIncomingUrl, guardResponse, loaderTargets, sessionAffinityHeaders } from "./src/fetch.mjs";
import { HttpError } from "./src/http.mjs";
import { ICON_DATA_URI } from "./src/icon.mjs";
import { resolveLang, t } from "./src/i18n.mjs";
import { findDesktopCredentials } from "./src/credentials.mjs";
import { createMethods, startCallbackServer } from "./src/login.mjs";
import { detectDeviceRaw, machineFingerprint, parseUuid, sha256Hex } from "./src/machine.mjs";
import { accountIdFor, resolveAccountSettings } from "./src/modes.mjs";
import { buildDirectCheckin, buildDirectUsage } from "./src/usage.mjs";
import { describeError, formatNumber, isZeroCost, parseResetTime, toNumber, trimSlash } from "./src/util.mjs";

/** 合并选项来源：函数第二参 + magpie 的 options/option。 */
export function resolveOptions(input, options) {
  const merged = {
    ...DEFAULT_OPTIONS,
    ...(options && typeof options === "object" ? options : {}),
    ...(input?.magpie?.options && typeof input.magpie.options === "object" ? input.magpie.options : {}),
    ...(input?.magpie?.option && typeof input.magpie.option === "object" ? input.magpie.option : {}),
  };
  return {
    ...merged,
    baseOrigin: String(merged.baseOrigin || DEFAULT_OPTIONS.baseOrigin).trim(),
    laneVersion: String(merged.laneVersion || DEFAULT_OPTIONS.laneVersion).trim(),
  };
}

export const DeepAICodePlugin = async (input = {}, options = {}) => {
  const opts = resolveOptions(input, options);
  const lang = resolveLang(opts);
  const catalogCache = createCatalogCache();
  const state = { lastRefreshAt: new Map() };
  const fetchImpl = globalThis.fetch;

  const log = async (level, message) => {
    try {
      await input?.client?.app?.log?.({ body: { service: "magpie-deepaicode", level, message } } );
    } catch {
      // 日志不可用时不影响主流程
    }
    if (opts.debug) console.error(`[magpie-deepaicode] ${level}: ${message}`);
  };

  /** 拉目录：上游 /deepai_code/models。 */
  async function loadCatalog(settings) {
    return catalogCache.get(settings.origin, async () => {
      const lane = await resolveLaneVersion(settings.origin, { explicit: settings.laneVersion, fetchImpl });
      const payload = await getDirectModels(settings.origin, {
        machineFp: settings.machineFp,
        laneVersion: lane,
        fetchImpl,
      });
      const list = catalogFromDirect(payload);
      if (list.length === 0) throw new Error("upstream model catalog is empty");
      return list;
    });
  }

  const provider = {
    id: PROVIDER,
    async models(p, ctx = {}) {
      const auth = ctx?.auth;
      // 还没有账号时 magpie 也会问一次：直接给声明里的模型，别白跑一次网络探测。
      if (!auth) return { ...(p?.models ?? fallbackModels({})) };
      const settings = resolveAccountSettings(auth, opts);
      try {
        const list = await loadCatalog(settings);
        return modelsFromCatalog(list, p?.models ?? {});
      } catch (err) {
        if (err instanceof HttpError && err.status === 401) {
          // 登录失效：让 magpie 标记账号，而不是把它当成“目录不可用”
          throw Object.assign(new Error(t(lang, "errSignInExpired")), { signIn: "expired" });
        }
        await log("warn", `catalog fallback: ${err?.status ?? ""} ${err?.message ?? err}`);
        const out = fallbackModels(p?.models ?? {});
        out[Symbol.for("magpie.fellBack")] = true;
        return out;
      }
    },
  };

  /** 额度：/theos + /get_usage_summary。 */
  async function usage(getAuth) {
    const auth = await getAuth();
    const settings = resolveAccountSettings(auth, opts);
    try {
      const lane = await resolveLaneVersion(settings.origin, { explicit: settings.laneVersion, fetchImpl });
      const [allowancePayload, summary] = await Promise.all([
        getDirectTheos(settings.origin, {
          key: settings.key,
          machineFp: settings.machineFp,
          laneVersion: lane,
          fetchImpl,
        }),
        getUsageSummary(settings.origin, {
          key: settings.key,
          machineFp: settings.machineFp,
          laneVersion: lane,
          fetchImpl,
        }).catch(() => null),
      ]);
      return buildDirectUsage({
        allowance: normalizeAllowance(allowancePayload),
        summary,
        username: settings.username,
        lang,
      });
    } catch (err) {
      return {
        error: describeError(err, { lang }),
        windows: [],
      };
    }
  }

  /** 签到：触发并锁定当日额度。 */
  async function checkin(getAuth) {
    const auth = await getAuth();
    const settings = resolveAccountSettings(auth, opts);
    try {
      const lane = await resolveLaneVersion(settings.origin, { explicit: settings.laneVersion, fetchImpl });
      const payload = await getDirectTheos(settings.origin, {
        key: settings.key,
        machineFp: settings.machineFp,
        laneVersion: lane,
        fetchImpl,
      });
      const allowance = normalizeAllowance(payload);
      const accountId = String(auth?.accountId ?? "").trim()
        || accountIdFor({ key: settings.key });
      const prev = state.lastRefreshAt.get(accountId) ?? "";
      const out = buildDirectCheckin({ allowance, prevRefreshAt: prev, lang });
      // 只有真正领到才推进基线；granted=0 时保留旧值，让当天稍后的重试能识别“刚领到”
      if (out.outcome !== "failed") {
        state.lastRefreshAt.set(accountId, String(allowance.rawRefreshAt ?? ""));
      }
      return out;
    } catch (err) {
      return { outcome: "failed", message: describeError(err, { lang }) };
    }
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: t(lang, "providerName"),
        npm: "@ai-sdk/openai-compatible",
        api: directBase(opts.baseOrigin),
        models: fallbackModels({}),
      };
    },

    auth: {
      provider: PROVIDER,
      methods: createMethods({ options: opts, deps: { fetchImpl } }),
      loader: async (getAuth) => createLoader(await getAuth(), opts, { fetchImpl }),
      usage,
      checkin,
    },

    provider,

    "chat.headers": async (hookInput, output) => {
      if (hookInput?.model?.providerID !== PROVIDER) return;
      Object.assign(output.headers, sessionAffinityHeaders(hookInput?.sessionID));
    },
  };
};

/** 单测与探针脚本用；不属于公开 API。 */
export const _internal = {
  resolveOptions,
  normalizeIncomingUrl,
  guardResponse,
  loaderTargets,
  resolveAccountSettings,
  accountIdFor,
  resolveLaneVersion,
  buildDirectUsage,
  buildDirectCheckin,
  catalogFromDirect,
  modelsFromCatalog,
  fallbackModels,
  createMethods,
  findDesktopCredentials,
  startCallbackServer,
  detectDeviceRaw,
  machineFingerprint,
  parseUuid,
  sha256Hex,
  describeError,
  formatNumber,
  isZeroCost,
  parseResetTime,
  toNumber,
  trimSlash,
  ICON_DATA_URI,
  FALLBACK_SNAPSHOT_DATE,
};
