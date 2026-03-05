import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./App.css";
import "./styles/settings.css";
import "./styles/voice.css";
import "./styles/action-stream.css";
import "./styles/text-tab.css";
import "./styles/agents-tab.css";
import "./styles/inspector.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
