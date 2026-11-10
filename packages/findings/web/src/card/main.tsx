import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { connect } from "./bridge.ts";
import { Card } from "./Card.tsx";
import "./card.css";

const root = document.getElementById("root");
if (!root) throw new Error("no #root to mount the review card into");

// Connected before anything is drawn: the host answers ui/initialize and
// pushes the tool's result straight after, and a listener added once React
// had mounted could be a listener added too late.
const host = connect();

createRoot(root).render(
  <StrictMode>
    <Card host={host} />
  </StrictMode>,
);
