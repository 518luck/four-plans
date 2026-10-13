(() => {
  let saved;
  try {
    saved = localStorage.getItem("four-plans-theme");
  } catch {
    // Theme switching still works when browser storage is unavailable.
  }
  const theme =
    saved === "light" || saved === "dark"
      ? saved
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0a0a0a" : "#fafafa");
})();
