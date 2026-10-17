import { useEffect, useRef, useState } from "react";
import type { BufferAttribute } from "three";
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

  return (
    <>
      {/* Three.js canvas (StarSea): active in dark mode */}
      <div ref={hostRef} className="star-sea" aria-hidden="true" />

      {/* 3D 空间波形场 (Three.js Wave Field): active in light mode */}
      {theme === "light" && <WaveField3D />}
    </>
  );
}

/** 3D 空间波形场 (Three.js Wave Field) - 纯数学驱动的全景浮动网格曲面与引力波阵列 */
function WaveField3D() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let disposed = false;
    let animId = 0;
    let disposeScene: (() => void) | undefined;

    const loadingScene = import("three").then((THREE) => {
      if (disposed || !mount) return;

      const width = mount.clientWidth || 1000;
      const height = mount.clientHeight || 140;
      const aspect = width / height;

      const scene = new THREE.Scene();
      // Push fog so the entire foreground and midground are crisp,
      // and the far horizon gracefully dissolves into the white card
      scene.fog = new THREE.Fog(0xffffff, 7.5, 15.0);

      // Camera placed in front and slightly elevated for an immersive full-bleed perspective
      const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 100);
      camera.position.set(0, 2.1, 5.0);
      camera.lookAt(0, -0.2, -0.5);

      const renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
      });
      disposeScene = () => {
        renderer.dispose();
        renderer.forceContextLoss();
      };
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      mount.appendChild(renderer.domElement);

      // Dense, architectural grid covering the entire card boundaries
      const cols = 90;
      const rows = 38;
      const count = rows * cols;

      // Full-bleed coverage bounds:
      // x covers well beyond the left and right borders of the container
      // z covers from just below the camera down to the horizon
      const calcTotalWidth = (asp: number) => Math.max(48, asp * 12.5);
      let totalWidth = calcTotalWidth(aspect);
      const zNear = 4.2;
      const zFar = -9.0;
      const totalDepth = zNear - zFar;

      const positions = new Float32Array(count * 3);
      const baseX = new Float32Array(count);
      const baseZ = new Float32Array(count);

      const computeBaseGrid = (w: number) => {
        let idx = 0;
        for (let r = 0; r < rows; r++) {
          const z = zNear - (r / (rows - 1)) * totalDepth;
          for (let c = 0; c < cols; c++) {
            const x = (c / (cols - 1) - 0.5) * w;
            baseX[idx] = x;
            baseZ[idx] = z;
            positions[idx * 3] = x;
            positions[idx * 3 + 1] = 0;
            positions[idx * 3 + 2] = z;
            idx++;
          }
        }
      };

      computeBaseGrid(totalWidth);

      const geometry = new THREE.BufferGeometry();
      const posAttr = new THREE.BufferAttribute(positions, 3);
      geometry.setAttribute("position", posAttr);

      // Wireframe line segments (connecting every node along rows & columns)
      const lineIndices: number[] = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          if (c < cols - 1) {
            lineIndices.push(i, i + 1); // Row wave-crest line
          }
          if (r < rows - 1) {
            lineIndices.push(i, i + cols); // Column perspective depth line
          }
        }
      }

      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute("position", posAttr);
      lineGeometry.setIndex(lineIndices);

      const lineMaterial = new THREE.LineBasicMaterial({
        color: 0x94a3b8, // Slate-400 modern architectural gray
        transparent: true,
        opacity: 0.32,
        fog: true,
      });

      const wireframeLines = new THREE.LineSegments(lineGeometry, lineMaterial);
      scene.add(wireframeLines);

      // Crisp high-DPI point texture (sharp circular core with subtle anti-aliasing)
      const pCanvas = document.createElement("canvas");
      pCanvas.width = 64;
      pCanvas.height = 64;
      const ctx = pCanvas.getContext("2d");
      if (ctx) {
        const rad = ctx.createRadialGradient(32, 32, 14, 32, 32, 28);
        rad.addColorStop(0, "rgba(51, 65, 85, 1.0)"); // Solid slate-700
        rad.addColorStop(0.75, "rgba(71, 85, 105, 0.95)"); // Slate-600
        rad.addColorStop(1, "rgba(71, 85, 105, 0)"); // Clean anti-aliased edge
        ctx.fillStyle = rad;
        ctx.beginPath();
        ctx.arc(32, 32, 28, 0, Math.PI * 2);
        ctx.fill();
      }
      const texture = new THREE.CanvasTexture(pCanvas);

      const material = new THREE.PointsMaterial({
        size: 0.13,
        map: texture,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        blending: THREE.NormalBlending,
        fog: true,
      });

      const points = new THREE.Points(geometry, material);
      scene.add(points);

      let mouseX = 0;
      let targetMouseX = 0;
      let mouseY = 0;
      let targetMouseY = 0;
      let mouseHover = 0;
      let targetMouseHover = 0;

      const onPointerMove = (e: MouseEvent) => {
        const rect = mount.getBoundingClientRect();
        targetMouseX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        targetMouseY = ((e.clientY - rect.top) / rect.height) * 2 - 1;
        targetMouseHover = 1;
      };

      const onPointerLeave = () => {
        targetMouseX = 0;
        targetMouseY = 0;
        targetMouseHover = 0;
      };

      const parentCard = mount.closest(".day-overview");
      if (parentCard) {
        parentCard.addEventListener(
          "mousemove",
          onPointerMove as EventListener,
        );
        parentCard.addEventListener(
          "mouseleave",
          onPointerLeave as EventListener,
        );
      }

      const startTime = performance.now();
      let firstFrameRendered = false;

      const animate = () => {
        if (disposed) return;
        const now = performance.now();
        const elapsed = now - startTime;
        const t = elapsed * 0.0016;

        // Smooth intro ease: wave swells gently from 0 to full amplitude
        const introProgress = Math.min(1, elapsed / 900);
        const waveEase =
          introProgress * introProgress * (3 - 2 * introProgress);

        mouseX += (targetMouseX - mouseX) * 0.06;
        mouseY += (targetMouseY - mouseY) * 0.06;
        mouseHover += (targetMouseHover - mouseHover) * 0.08;

        // Enhanced 3D camera parallax perspective
        camera.position.x = mouseX * 1.6;
        camera.position.y = 2.1 - mouseY * 0.45;
        camera.lookAt(mouseX * 0.5, -0.2, -0.5);

        // Map cursor position to 3D world coordinates on the wave field
        const cursorWorldX = mouseX * (totalWidth * 0.45);
        const cursorWorldZ = 2.5 - (mouseY + 1.0) * 4.5;

        const array = posAttr.array as Float32Array;

        for (let i = 0; i < count; i++) {
          const x = baseX[i];
          const z = baseZ[i];
          array[i * 3] = x;

          // Natural background fluid wave
          let y =
            (Math.sin(x * 0.38 + t * 1.8) * 0.32 +
              Math.cos(z * 0.52 + t * 1.4) * 0.22 +
              Math.sin(x * 0.22 + z * 0.32 + t * 1.0) * 0.12) *
            waveEase;

          // Interactive magnetic cursor ripple & wave swell
          if (mouseHover > 0.01) {
            const dx = x - cursorWorldX;
            const dz = z - cursorWorldZ;
            const distSq = dx * dx + dz * dz;
            if (distSq < 48.0) {
              const dist = Math.sqrt(distSq);
              const falloff = Math.exp(-distSq / 18.0) * mouseHover;
              const ripple =
                (Math.cos(dist * 1.8 - t * 4.0) * 0.26 + 0.36) * falloff;
              y += ripple;
            }
          }

          array[i * 3 + 1] = y;
          array[i * 3 + 2] = z;
        }
        posAttr.needsUpdate = true;

        renderer.render(scene, camera);

        if (!firstFrameRendered) {
          firstFrameRendered = true;
          requestAnimationFrame(() => {
            if (!disposed) setLoaded(true);
          });
        }

        animId = requestAnimationFrame(animate);
      };

      const onResize = () => {
        if (!mount) return;
        const w = mount.clientWidth;
        const h = mount.clientHeight;
        const newAspect = w / h;
        camera.aspect = newAspect;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);

        totalWidth = calcTotalWidth(newAspect);
        computeBaseGrid(totalWidth);
      };

      window.addEventListener("resize", onResize);

      disposeScene = () => {
        window.removeEventListener("resize", onResize);
        if (parentCard) {
          parentCard.removeEventListener(
            "mousemove",
            onPointerMove as EventListener,
          );
          parentCard.removeEventListener(
            "mouseleave",
            onPointerLeave as EventListener,
          );
        }
        geometry.dispose();
        material.dispose();
        lineGeometry.dispose();
        lineMaterial.dispose();
        texture.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
      };
      animate();
    });
    void loadingScene.catch(() => {
      // Keep the static background if the optional WebGL scene is unavailable.
      disposed = true;
      cancelAnimationFrame(animId);
      disposeScene?.();
      disposeScene = undefined;
      mount.replaceChildren();
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(animId);
      disposeScene?.();
      mount.replaceChildren();
    };
  }, []);

  return (
    <div
      className={`wavefield-container ${loaded ? "is-loaded" : ""}`}
      aria-hidden="true"
    >
      <div className="wavefield-ambient" />
      <div ref={mountRef} className="wavefield-mount" />
    </div>
  );
}
