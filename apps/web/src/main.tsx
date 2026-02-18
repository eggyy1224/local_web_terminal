import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
import "xterm/css/xterm.css";

createRoot(document.getElementById("root")!).render(<App />);
