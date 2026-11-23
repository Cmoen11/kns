// Tauri mapping of EventsBackend (contract/events.ts): one Tauri event, `kns://event` (events.rs).
import { listen } from "@tauri-apps/api/event";
import { BACKEND_EVENT, type BackendEvent, type EventsBackend } from "../types";

export const eventsTauri: EventsBackend = {
  onEvent: (cb) => {
    let stopped = false;
    const unlisten = listen<BackendEvent>(BACKEND_EVENT, (e) => {
      if (!stopped) cb(e.payload);
    });
    return () => {
      if (stopped) return;
      stopped = true;
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  },
};
