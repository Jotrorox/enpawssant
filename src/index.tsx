/* @refresh reload */
import { render } from "solid-js/web";

// Fonts are bundled locally so the app works offline.
import "@fontsource/fredoka/600.css";
import "@fontsource/nunito/400.css";
import "@fontsource/nunito/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "./styles.css";

import App from "./App";

render(() => <App />, document.getElementById("root") as HTMLElement);
