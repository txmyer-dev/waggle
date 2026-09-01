import React from "react";
import { createRoot } from "react-dom/client";
import { store } from "./app/store.ts";
import { App } from "./ui/App.tsx";
import "./ui/styles.css";

void store.boot();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
