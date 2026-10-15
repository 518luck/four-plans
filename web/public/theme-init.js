(() => {
  let saved;
  try {
    saved = localStorage.getItem("four-plans-theme");
  } catch {
    // Theme switching still works when browser storage is unavailable.
  }
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme =
    saved === "light" || saved === "dark"
      ? saved
      : isDark
        ? "dark"
        : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeMode = saved || "system";
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0a0a0a" : "#fafafa");
})();
