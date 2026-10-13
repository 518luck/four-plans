import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "motion/react";
import App from "./App";
import "./styles.css";

// Reuse the root when Vite replaces the entry module during local previews.
const appRoot =
  import.meta.hot?.data.appRoot ??
  ReactDOM.createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.appRoot = appRoot;

appRoot.render(
  <React.StrictMode>
    <MotionConfig
      reducedMotion="user"
      transition={{ type: "spring", stiffness: 320, damping: 32, mass: 0.9 }}
    >
      <App />
    </MotionConfig>
  </React.StrictMode>,
);
