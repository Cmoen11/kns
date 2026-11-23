// Action handlers of the shell feature (docs/ux.md §5.4): pod.shell/attach, terminal.*, COPY mode,
// port-forwards. Eager and small; xterm is reached only through the runtime ./sessions registers.
import {
  CORE_PODS, openInContext, flash, focusedPane, openView, paneView, registerActions, registerViewActions, tableView, toasts,
  type ActionContext,
} from "../../foundation";
import { stopSession } from "./end";
import { cursorForward, forwardMeta, getForwards, moveCursor, openForward, refreshForwards, setCursor, stopForward } from "./forwards";
import { openForwardDialog, openShell, reconnect, selectionTarget, switchContainer } from "./open";
import { forwardHost } from "./ports";
import { isShellView } from "./session-refs";
import { closeSearch, getQuery, getRuntime, getSession, isLive, openSearch } from "./state";

// ── shell ──

/** The focused pane's session id when it is live (the TERM scope). */
function liveId(): string | undefined {
  const v = paneView();
  return isShellView(v) && isLive(v.session) ? v.session : undefined;
}
/** The focused pane's session id, live or ended. */
function sessionId(): string | undefined {
  const v = paneView();
  return isShellView(v) && getSession(v.session) ? v.session : undefined;
}

const hasTarget = () => selectionTarget() !== null || "no row selected";

const openShellAction = (kind: "shell" | "attach") => ({
  enabled: hasTarget,
  run: (ctx: ActionContext) => {
    const t = selectionTarget();
    return t ? openShell(kind, t, ctx.newPane) : undefined;
  },
});

const copyActive = () => {
  const id = sessionId();
  return !!id && getSession(id)?.copy === true;
};

registerActions({
  "pod.shell": openShellAction("shell"),
  "pod.attach": openShellAction("attach"),

  "terminal.reconnect": { when: () => isShellView(paneView()) && !liveId(), run: () => reconnect() },
  "terminal.copy": {
    // also on an ended session: its terminal and scrollback are kept (term.placeholder scope)
    enabled: () => {
      const id = sessionId();
      return (!!id && getRuntime()?.hasSelection(id)) || "nothing is selected";
    },
    run: () => {
      const id = sessionId();
      if (id) getRuntime()?.copySelection(id);
    },
  },
  "terminal.paste": () => {
    const id = liveId();
    if (id) getRuntime()?.paste(id);
  },
  "terminal.scrollPageUp": () => {
    const id = liveId();
    if (id) getRuntime()?.scrollPages(id, -1);
  },
  "terminal.scrollPageDown": () => {
    const id = liveId();
    if (id) getRuntime()?.scrollPages(id, 1);
  },
  "terminal.search": () => {
    const id = liveId();
    if (id) openSearch(id);
  },
  "terminal.copyMode": () => {
    const id = liveId();
    if (id) getRuntime()?.enterCopy(id);
  },
  // the exec closes, the scrollback stays; Enter (terminal.reconnect) starts it again
  "terminal.end": {
    when: () => liveId() !== undefined,
    run: () => {
      const s = getSession(liveId());
      return s ? stopSession(s) : undefined;
    },
  },
  // another container of the same pod: a new session (beside a live shell, in place of an ended one)
  "terminal.container": {
    when: () => isShellView(paneView()),
    enabled: () => {
      const v = paneView();
      return (isShellView(v) && v.target.by === "object") || "no pod yet";
    },
    run: () => switchContainer(),
  },

  // COPY mode (a capturing layer pushed by enterCopy)
  "copy.down": { when: copyActive, run: () => getRuntime()?.copyMove("down") },
  "copy.up": { when: copyActive, run: () => getRuntime()?.copyMove("up") },
  "copy.top": { when: copyActive, run: () => getRuntime()?.copyMove("top") },
  "copy.bottom": { when: copyActive, run: () => getRuntime()?.copyMove("bottom") },
  "copy.select": { when: copyActive, run: () => getRuntime()?.copySelect() },
  "copy.yank": { when: copyActive, run: () => getRuntime()?.copyYank() },
  "copy.leave": { when: copyActive, run: () => getRuntime()?.leaveCopy() },
  "copy.search": {
    when: copyActive,
    run: () => {
      const id = sessionId();
      if (id) openSearch(id);
    },
  },
});

// Enter / Esc in the scrollback search bar. Shared ids: other views own them in their kinds.
const searchOpen = () => {
  const id = sessionId();
  return !!id && getSession(id)?.search === true;
};
registerViewActions(["shell", "attach"], {
  "filter.apply": {
    when: searchOpen,
    run: () => {
      const id = sessionId();
      if (id) getRuntime()?.search(id, getQuery(id));
    },
  },
  "filter.cancel": {
    when: searchOpen,
    run: () => {
      const id = sessionId();
      if (id) closeSearch(id);
    },
  },
});

// ── port-forwards ──

const openManager = (ctx: ActionContext) => {
  openView({ kind: "portforwards" }, { newPane: ctx.newPane });
};

const managerPane = () => {
  const pane = focusedPane();
  return pane && paneView(pane)?.kind === "portforwards" ? pane : null;
};
const cursorRow = () => {
  const pane = managerPane();
  return pane ? cursorForward(pane) : undefined;
};
const hasRow = () => cursorRow() !== undefined || "no port-forward selected";
const PAGE = 20;
const move = (delta: number) => () => {
  const pane = managerPane();
  if (pane) moveCursor(pane, delta);
};

registerActions({
  "pf.open": openManager,
  "pf.list": openManager,
  "pf.start": {
    enabled: hasTarget,
    run: () => {
      const t = selectionTarget();
      if (t) openForwardDialog(t);
    },
  },
  "pf.stop": {
    enabled: hasRow,
    run: () => {
      const f = cursorRow();
      return f ? stopForward(f) : undefined;
    },
  },
  "pf.openBrowser": {
    enabled: hasRow,
    run: () => {
      const f = cursorRow();
      return f ? openForward(f) : undefined;
    },
  },
  "pf.copyAddress": {
    enabled: hasRow,
    run: () => {
      const f = cursorRow();
      if (!f) return;
      const text = forwardHost(f);
      navigator.clipboard.writeText(text).then(
        () => flash(`copied ${text}`),
        () => toasts.error("Copy failed: the clipboard is not available"),
      );
    },
  },
});

registerViewActions(["portforwards"], {
  "nav.down": move(1),
  "nav.up": move(-1),
  "nav.pageDown": move(PAGE),
  "nav.pageUp": move(-PAGE),
  "nav.top": () => {
    const pane = managerPane();
    if (pane) setCursor(pane, 0);
  },
  "nav.bottom": () => {
    const pane = managerPane();
    if (pane) setCursor(pane, getForwards().length - 1);
  },
  // §4.3: a port-forward row opens the target's table (pods of its namespace)
  "nav.open": {
    enabled: hasRow,
    run: (ctx) => {
      const f = cursorRow();
      if (!f) return;
      // the cursor lands on the pod only when its uid is known (forward started from a pod row here);
      // a forward of another context opens beside, in that context (§8.3)
      openInContext(tableView(CORE_PODS, f.namespace, { cursorUid: forwardMeta(f.id)?.pod?.uid }), f.context, { newPane: ctx.newPane });
    },
  },
  "view.refresh": () => void refreshForwards(),
});
