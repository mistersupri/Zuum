import { useEffect, useState } from "react";

export type ThemePref = "light" | "dark" | "system";

function read(): ThemePref {
  try {
    const v = localStorage.getItem("zuum-theme");
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function apply(pref: ThemePref) {
  const dark = pref === "dark" || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(read);
  useEffect(() => {
    apply(pref);
    try {
      if (pref === "system") localStorage.removeItem("zuum-theme");
      else localStorage.setItem("zuum-theme", pref);
    } catch {
      /* storage unavailable: theme still applies for this visit */
    }
    if (pref !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => apply("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [pref]);
  return [pref, setPref] as const;
}
