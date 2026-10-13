import { createContext, useContext, useEffect, useMemo, useState } from "react";

const KEY = "nginx-theme";
const DEFAULTS = ["dark", "soft", "light"];

const ThemeContext = createContext({ theme: "soft", setTheme: () => {} });
export const useTheme = () => useContext(ThemeContext);

export default function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    const stored = localStorage.getItem(KEY);
    return DEFAULTS.includes(stored) ? stored : "soft";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    localStorage.setItem(KEY, theme);
  }, [theme]);

  const value = useMemo(() => ({ theme, setTheme: setThemeState }), [theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}