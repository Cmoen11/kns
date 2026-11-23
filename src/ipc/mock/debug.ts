// Mock of DebugBackend (contract/debug.ts). Owner F. Writes are refused on `staging` (as canI says)
// and on read-only contexts (as debug.rs does). Snippet output is canned and already "redacted".
import type { DebugBackend, DebugPod, SnippetOutput } from "../types";
import { delay, fail, mockContextFlags, nowIso } from "./shared";

const pods: DebugPod[] = [];
const suffix = () => Math.random().toString(36).slice(2, 7).padEnd(5, "0");

const readOnly = (context: string): Promise<never> | null =>
  mockContextFlags(context).readOnly ? fail("ReadOnly", `${context} is read-only`) : null;

const CANNED: Record<string, string> = {
  "env | sort":
    "HOME=/root\nHOSTNAME=web-7d9f8-abcde\nKUBERNETES_SERVICE_HOST=10.43.0.1\nKUBERNETES_SERVICE_PORT=443\nLOG_LEVEL=info\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nDATABASE_URL=postgres://app:•••@db.kns-spike.svc:5432/app\nDB_PASSWORD=•••\n",
  "cat /etc/resolv.conf": "search default.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.43.0.10\noptions ndots:5\n",
  "ps aux 2>/dev/null || ps": "PID   USER     TIME  COMMAND\n    1 root      0:00 /app/server --port=8080\n   23 root      0:00 sh -c ps aux 2>/dev/null || ps\n   24 root      0:00 ps aux\n",
  "df -h": "Filesystem                Size      Used Available Use% Mounted on\noverlay                  77.4G     41.2G     32.6G  56% /\ntmpfs                    64.0M         0     64.0M   0% /dev\n",
};

function output(command: string): SnippetOutput {
  const text = CANNED[command];
  if (text !== undefined) {
    const masked = (text.match(/•••/g) ?? []).length;
    return { output: text, exitCode: 0, truncated: false, millis: 180, redactions: { count: masked, byRule: masked ? { key: masked - 1, url: 1 } : {} } };
  }
  return { output: "sh: psql: not found\n", exitCode: 127, truncated: false, millis: 95, redactions: { count: 0, byRule: {} } };
}

export const debugMock: DebugBackend = {
  debugContainer: (req) => {
    if (req.ref.context === "staging") return fail("Forbidden", "pods/ephemeralcontainers is forbidden for user dev", 403);
    const ro = readOnly(req.ref.context);
    if (ro) return ro;
    if (!req.image.trim() || /\s/.test(req.image)) return fail("Invalid", "not an image reference");
    const container = `kns-debug-${suffix()}`;
    pods.push({ context: req.ref.context, namespace: req.ref.namespace ?? "default", name: req.ref.name, source: req.ref.name, kind: "ephemeral", container, createdAt: nowIso() });
    return delay(container, 900);
  },
  debugCopy: (ref, image, target) => {
    if (ref.context === "staging") return fail("Forbidden", "pods is forbidden for user dev", 403);
    const ro = readOnly(ref.context);
    if (ro) return ro;
    const pod: DebugPod = {
      context: ref.context,
      namespace: ref.namespace ?? "default",
      name: `${ref.name.slice(0, 51)}-debug-${suffix()}`,
      source: ref.name,
      kind: "copy",
      container: image ? "kns-debug" : (target ?? "main"),
      createdAt: nowIso(),
    };
    pods.push(pod);
    return delay(pod, 400);
  },
  debugPodsList: (context) => delay(pods.filter((p) => p.context === context)),
  debugPodDelete: (ref) => {
    const ro = readOnly(ref.context);
    if (ro) return ro;
    const i = pods.findIndex((p) => p.kind === "copy" && p.context === ref.context && p.namespace === ref.namespace && p.name === ref.name);
    if (i < 0) return fail("Invalid", `${ref.name} is not a kns debug copy (no kns.dev/debug=true label)`);
    pods.splice(i, 1);
    return delay(undefined, 200);
  },
  snippetRun: (req) => {
    if (!req.command.trim()) return fail("Invalid", "snippet command is empty or too long");
    return delay(output(req.command), 250);
  },
};
