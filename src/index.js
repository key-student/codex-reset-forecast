import "./style.css";
import { DEFAULT_HORIZON, HORIZONS } from "./preferences.js";
import { createRenderer } from "./renderer.js";

export const activate = createRenderer({ DEFAULT_HORIZON, HORIZONS });
