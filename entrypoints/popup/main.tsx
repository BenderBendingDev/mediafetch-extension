import React from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "../../src/i18n";
import App from "./App.tsx";
import "./style.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
