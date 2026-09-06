import React from "react";
import { createRoot } from "react-dom/client";

function App(): React.JSX.Element {
  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>MEEPO Console</h1>
      <p>Multi-worker Execution Engine for Project-isolated Orchestration</p>
    </div>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
