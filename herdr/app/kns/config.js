// Where kns-tui and kns's TCP info file are. `kns-tui herdr install` replaces this file with the
// exact paths of the installed kns; these defaults are for a mod copied by hand. Functions, not
// constants: host calls (home()) belong in a running view, not in module scope.
import { home } from "herdr";

const mac = () => process.platform === "macos" || process.platform === "darwin";

/** The kns-tui binary: logs and shells run it in terminal panes; it also starts kns. */
export function knsTui() {
  return mac() ? "/Applications/kns.app/Contents/MacOS/kns-tui" : "kns-tui";
}

/** kns's `rpc-tcp.json` ({port, token, pid, protocol}), written while its TCP endpoint is on. */
export function tcpInfo() {
  const data = mac() ? `${home()}/Library/Application Support` : `${home()}/.local/share`;
  return `${data}/no.sixm.kns/rpc-tcp.json`;
}
