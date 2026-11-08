// 中英文案。默认中文，options.lang = "en" 切英文。
//
// 只放“用户能看到的字符串”：登录标签/提问、错误、额度窗口名。
// 上游的原话永远原样透出，不进这里（那是厂商的话，翻译会丢信息）。

const MESSAGES = {
  zh: {
    providerName: "DeepAI Code",

    loginDesktop: "读取本机 DeepAI Code 凭据",
    loginPaste: "粘贴 DeepAI API Key",
    loginBrowser: "浏览器登录 DeepAI（推荐）",

    promptSecretDir: "桌面端数据目录（留空自动探测）",
    promptDesktopKey: "输入 auto 读取本机凭据；或直接粘贴 Key",
    promptUsername: "账号名（可选，显示用）",
    promptApiKey: "DeepAI API Key",

    errKeyMissing: "缺少 DeepAI API Key。",
    errNoCredentials: "没有找到桌面端凭据。已尝试：{tried}。请先在 DeepAI Code 桌面端登录一次。",
    errBadCredentials: "凭据文件解析失败：{path}（{reason}）",
    errSignInExpired: "登录已失效，请重新登录。",
    errLane: "上游不接受当前车道版本（426）。把选项 laneVersion 调成上游要求的值，或更新插件。",
    errTimeout: "操作超时，请重试。",
    errRedirect: "上游把请求重定向到了登录页（鉴权失败）。请重新登录。",

    usageTodayName: "今日 Theos",
    usagePending: "今日额度待发放",
    usageLeftDisplay: "剩 {balance} / {granted} theos",
    usageCredits: "{n} credits",
    usageCheckinLocked: "今日签到次数已达上游上限，额度窗口明日恢复",

    checkinGranted: "今日额度已领取",
    checkinAlready: "今天已经领过",
    checkinPending: "今日额度尚未发放",
    checkinIneligible: "该账号不参与每日额度",
    checkinLocked: "今日签到次数已达上游上限，明日自动恢复",

    browserInstructions: "在浏览器里登录 DeepAI，完成后会自动跳回本机。若页面显示无法访问，把地址栏里的 code 复制进来即可。",
    browserDoneTitle: "登录完成",
    browserDoneBody: "可以回到 magpie 了。",
    browserFailedTitle: "登录失败",

    fallbackNote: "（模型目录拉取失败，显示内置快照）",
  },
  en: {
    providerName: "DeepAI Code",

    loginDesktop: "Read DeepAI Code desktop credentials",
    loginPaste: "Paste DeepAI API key",
    loginBrowser: "Sign in with DeepAI (recommended)",

    promptSecretDir: "Desktop data dir (empty = auto-detect)",
    promptDesktopKey: "Type auto to read the desktop credentials, or paste a key",
    promptUsername: "Account name (optional, for display)",
    promptApiKey: "DeepAI API key",

    errKeyMissing: "DeepAI API key is missing.",
    errNoCredentials: "Desktop credentials not found. Tried: {tried}. Sign in to the DeepAI Code desktop app first.",
    errBadCredentials: "Cannot parse credentials: {path} ({reason})",
    errSignInExpired: "Sign-in expired. Please sign in again.",
    errLane: "Upstream rejected the lane version (426). Set the laneVersion option to the expected value.",
    errTimeout: "Timed out. Please retry.",
    errRedirect: "Upstream redirected to the sign-in page (auth failed). Please sign in again.",

    usageTodayName: "Today's theos",
    usagePending: "Today's grant not issued yet",
    usageLeftDisplay: "{balance} / {granted} theos left",
    usageCredits: "{n} credits",
    usageCheckinLocked: "Daily check-in limit reached upstream; quota window returns tomorrow",

    checkinGranted: "Today's quota claimed",
    checkinAlready: "Already claimed today",
    checkinPending: "Today's grant is not issued yet",
    checkinIneligible: "This account has no daily grant",
    checkinLocked: "Daily check-in limit reached upstream; resumes tomorrow",

    browserInstructions: "Sign in to DeepAI in the browser; you'll be sent back to this machine automatically. If the page can't open, paste the code param from the address bar.",
    browserDoneTitle: "Signed in",
    browserDoneBody: "You can go back to magpie now.",
    browserFailedTitle: "Sign-in failed",

    fallbackNote: "(model catalog fetch failed; showing built-in snapshot)",
  },
};

export function resolveLang(options = {}) {
  const lang = String(options.lang ?? "zh").toLowerCase();
  return lang.startsWith("en") ? "en" : "zh";
}

export function t(lang, key, vars = {}) {
  const dict = MESSAGES[lang] ?? MESSAGES.zh;
  const raw = dict[key] ?? MESSAGES.zh[key] ?? key;
  return String(raw).replace(/\{(\w+)\}/g, (_, name) => (vars[name] ?? `{${name}}`));
}

export const MESSAGES_ALL = MESSAGES;
