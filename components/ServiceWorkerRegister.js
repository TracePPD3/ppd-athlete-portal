"use client";

import { useEffect } from "react";

// Registers the service worker on the client so the app is installable
// ("Add to Home Screen") and opens standalone/full-screen. Renders nothing.
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    const register = () =>
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
