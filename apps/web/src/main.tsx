import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { applyTheme } from "./app/prefs";

import "prosemirror-gapcursor/style/gapcursor.css";
import "prosemirror-tables/style/tables.css";
import "./styles/app.css";
import "./styles/document.css";

/**
 * No `StrictMode`. ProseMirror owns real DOM that it constructs in an effect; React 18's
 * deliberate double-invoke of effects in development would tear that view down and rebuild it
 * on every mount, which is exactly the class of remounting the latency budget exists to
 * prevent, and it makes the development build behave unlike the one that ships.
 */

applyTheme();

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");
createRoot(container).render(<App />);
