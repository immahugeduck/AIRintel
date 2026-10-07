import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode><QueryClientProvider client={client}><ErrorBoundary><App /></ErrorBoundary></QueryClientProvider></StrictMode>,
);
