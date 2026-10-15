import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { physicsReady } from "./game/sim.js";
import { loadModels } from "./game/models.js";
import "./styles.css";

// The physics engine (WebAssembly) and the models load before the game can start
// (without the models the castle is built from blocks).
const models = loadModels(path => fetch(path).then(r => {
  if (!r.ok) throw new Error(path);
  return r.arrayBuffer();
})).catch(() => {});
Promise.allSettled([physicsReady, models]).then(() => createRoot(document.getElementById("root")).render(<App />));
