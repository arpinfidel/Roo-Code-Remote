// import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App"

// Load codicons in both dev and prod
import("@vscode/codicons/dist/codicon.css")

createRoot(document.getElementById("root")!).render(
	// <StrictMode>
	<App />,
	// </StrictMode>,
)
