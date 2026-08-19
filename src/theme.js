import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

// 顺序即胶囊控件的左右顺序：亮 → 自动 → 暗，读起来是一条明暗光谱。
export const THEME_OPTIONS = [
  { value: "light", label: "浅色" },
  { value: "system", label: "跟随系统" },
  { value: "dark", label: "深色" },
];

export function readThemePreference() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function matchDark() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(DARK_QUERY)
    : null;
}

export function resolveTheme(preference) {
  if (preference === "light" || preference === "dark") return preference;
  return matchDark()?.matches ? "dark" : "light";
}

export function applyTheme(preference) {
  const resolved = resolveTheme(preference);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = resolved;
  // 让原生控件（select / checkbox / 滚动条）也跟着换色。
  root.style.colorScheme = resolved;
  return resolved;
}

export function useTheme() {
  const [preference, setPreferenceState] = useState(readThemePreference);

  useEffect(() => {
    applyTheme(preference);
    // 只有"跟随系统"时才订阅系统变化，用户显式选过就不再被系统覆盖。
    if (preference !== "system") return undefined;
    const mql = matchDark();
    if (!mql) return undefined;

    const onChange = () => applyTheme("system");
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    // Safari < 14 只有旧版 API。
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [preference]);

  // 多标签页之间保持一致。
  useEffect(() => {
    function onStorage(e) {
      if (e.key === STORAGE_KEY || e.key === null) setPreferenceState(readThemePreference());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPreference = useCallback((next) => {
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 隐私模式下写不了 localStorage，仅本次会话生效。
    }
    setPreferenceState(next);
  }, []);

  return { preference, setPreference };
}
