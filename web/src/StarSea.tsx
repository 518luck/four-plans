import { useEffect, useRef } from "react";
import type { StarSeaScene } from "./starSeaScene";

/** Decorative only: the overview remains usable while WebGL loads or is unavailable. */
export default function StarSea({ theme }: { theme: "light" | "dark" }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<StarSeaScene | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    // Keep the renderer out of the initial application bundle.
    void import("./starSeaScene")
      .then(({ createStarSea }) => {
        if (disposed) return;
        sceneRef.current = createStarSea(host, themeRef.current);
      })
      .catch(() => {
        // The CSS star field stays visible if the optional renderer cannot load.
      });
    return () => {
      disposed = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setTheme(theme);
  }, [theme]);

  return <div ref={hostRef} className="star-sea" aria-hidden="true" />;
}
