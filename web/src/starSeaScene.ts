import {
  BufferAttribute,
  BufferGeometry,
  Color,
  OrthographicCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderer,
} from "three";

export interface StarSeaScene {
  setTheme(theme: "light" | "dark"): void;
  dispose(): void;
}

export function createStarSea(
  host: HTMLDivElement,
  theme: "light" | "dark",
): StarSeaScene | null {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    depth: false,
    powerPreference: "low-power",
  });
  if (!context) return null;
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, context, alpha: true, depth: false });
  } catch {
    return null;
  }
  renderer.setClearColor(0x000000, 0);
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 1;
  const geometry = new BufferGeometry();
  const count = 1800;
  const positions = new Float32Array(count * 3);
  const details = new Float32Array(count * 3);
  // Stable positions avoid a different sky on every theme change or remount.
  let seed = 4137;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const x = random();
    // Mix a soft, winding star band with widely scattered distant stars.
    const band = 0.5 + Math.sin(x * 7.5) * 0.2;
    const y = i % 3 === 0 ? random() : band + (random() - 0.5) * 0.55;
    positions.set([x, y, 0], i * 3);
    details.set([random(), random() * Math.PI * 2, random()], i * 3);
  }
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("aDetails", new BufferAttribute(details, 3));
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uResolution: { value: new Vector2(1, 1) },
      uColor: { value: new Color(theme === "dark" ? "#ffffff" : "#171717") },
    },
    vertexShader: `
      attribute vec3 aDetails;
      uniform float uTime;
      uniform float uPixelRatio;
      uniform vec2 uResolution;
      varying float vBrightness;
      varying float vGlow;
      void main() {
        float depth = aDetails.x;
        vec2 p = position.xy;
        p.x = fract(p.x + uTime * (0.0015 + depth * 0.003));
        p.y += sin(uTime * 0.12 + aDetails.y) * 0.012;
        float wave = 0.8 + 0.2 * sin(uTime * (0.25 + depth * 0.35) + aDetails.y);
        vBrightness = (0.3 + depth * 0.7) * wave;
        // Quiet areas protect text without hiding the sky at the edges.
        float quiet = smoothstep(0.02, 0.18, p.y) * (1.0 - smoothstep(0.80, 0.98, p.y));
        vBrightness *= mix(1.0, 0.6, quiet);
        // A denser distant field, with only a few larger foreground lights.
        vGlow = step(0.985, aDetails.z);
        float densityScale = clamp(uResolution.x / 600.0, 0.65, 1.0);
        gl_PointSize = (1.2 + depth * 1.6 + vGlow * 5.0) * uPixelRatio * densityScale;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p * 2.0 - 1.0, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vBrightness;
      varying float vGlow;
      void main() {
        float distanceToCenter = length(gl_PointCoord - 0.5);
        float core = 1.0 - smoothstep(0.08, 0.48, distanceToCenter);
        float halo = exp(-distanceToCenter * 7.0) * vGlow * 0.5;
        float alpha = (core + halo) * vBrightness;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(uColor, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const points = new Points(geometry, material);
  // Positions are normalized in the shader, so the CPU bounds do not describe them.
  points.frustumCulled = false;
  scene.add(points);
  host.append(canvas);
  let frame = 0;
  let elapsed = 0;
  let lastTime = 0;
  let visible = true;
  let contextLost = false;
  let disposed = false;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const render = () => {
    if (!contextLost && !disposed) renderer.render(scene, camera);
  };
  const canAnimate = () => !disposed && !contextLost && visible && !document.hidden && !reducedMotion.matches;
  const tick = (now: number) => {
    frame = 0;
    if (!canAnimate()) return;
    // 30 fps is enough for a slow decorative sky. Cap deltas after suspension.
    if (!lastTime || now - lastTime >= 1000 / 30) {
      if (lastTime) elapsed += Math.min(now - lastTime, 100) / 1000;
      lastTime = now;
      material.uniforms.uTime.value = elapsed;
      render();
    }
    frame = requestAnimationFrame(tick);
  };
  const syncAnimation = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
    render();
    if (canAnimate()) frame = requestAnimationFrame(tick);
  };
  const resize = () => {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    const ratio = Math.min(devicePixelRatio || 1, 1.5);
    // Keep the denser sky from crowding the much smaller mobile overview.
    geometry.setDrawRange(0, Math.min(count, Math.max(900, Math.round(width * height / 65))));
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    material.uniforms.uPixelRatio.value = ratio;
    material.uniforms.uResolution.value.set(width, height);
    render();
  };
  const onContextLost = (event: Event) => {
    event.preventDefault();
    contextLost = true;
    host.classList.remove("is-ready");
    cancelAnimationFrame(frame);
    frame = 0;
  };
  const onContextRestored = () => {
    contextLost = false;
    resize();
    host.classList.add("is-ready");
    syncAnimation();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  const intersectionObserver = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    syncAnimation();
  });
  intersectionObserver.observe(host);
  document.addEventListener("visibilitychange", syncAnimation);
  reducedMotion.addEventListener("change", syncAnimation);
  resize();
  host.classList.add("is-ready");
  syncAnimation();

  return {
    setTheme(nextTheme) {
      material.uniforms.uColor.value.set(nextTheme === "dark" ? "#ffffff" : "#171717");
      render();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", syncAnimation);
      reducedMotion.removeEventListener("change", syncAnimation);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      host.classList.remove("is-ready");
    },
  };
}
