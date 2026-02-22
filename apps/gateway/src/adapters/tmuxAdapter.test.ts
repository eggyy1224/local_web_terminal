import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => {
  const fn = vi.fn();
  const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");
  Object.defineProperty(fn, promisifyCustom, {
    value: (...args: unknown[]) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const callback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        };
        fn(...args, callback);
      })
  });
  return fn;
});

vi.mock("node:child_process", () => ({
  execFile: execFileMock
}));

import { TmuxAdapter, normalizeTmuxPaneTarget } from "./tmuxAdapter.js";

type ExecCallback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

function resolveCallback(optionsOrCallback: unknown, callback: unknown): ExecCallback {
  if (typeof optionsOrCallback === "function") {
    return optionsOrCallback as ExecCallback;
  }
  if (typeof callback === "function") {
    return callback as ExecCallback;
  }
  throw new Error("missing exec callback");
}

describe("normalizeTmuxPaneTarget", () => {
  it("keeps plain tmux pane id untouched", () => {
    expect(normalizeTmuxPaneTarget("%12")).toBe("%12");
    expect(normalizeTmuxPaneTarget("%250")).toBe("%250");
  });

  it("fails fast for non-raw pane target values", () => {
    expect(() => normalizeTmuxPaneTarget("%25\u001f1\u001f1\u001fhost\u001f/tmp\u001fcoding_agent")).toThrow(
      "rawTarget"
    );
    expect(() => normalizeTmuxPaneTarget("%30\\0371\\0371\\037host\\037/tmp\\037workspace")).toThrow("rawTarget");
  });
});

describe("TmuxAdapter capture target handling", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("uses normalized tmux pane target for capture-pane", async () => {
    let capturedTarget = "";
    execFileMock.mockImplementation((_: string, args: string[], optionsOrCallback: unknown, callback: unknown) => {
      const cb = resolveCallback(optionsOrCallback, callback);
      if (args[0] === "display-message" && args[args.length - 1] === "#{window_id}") {
        cb(null, "@1\n", "");
        return;
      }
      if (args[0] === "list-panes") {
        cb(null, "%30\\0370\\0371\\037\\037/tmp\\037zsh\n", "");
        return;
      }
      if (args[0] === "capture-pane") {
        capturedTarget = args[3] ?? "";
        cb(null, "line-one\n", "");
        return;
      }
      cb(new Error(`unexpected command: ${args.join(" ")}`) as NodeJS.ErrnoException, "", "");
    });

    const adapter = new TmuxAdapter("tmux");
    const panes = await adapter.listPanes("s_capture_target");
    expect(panes).toHaveLength(1);
    expect(panes[0]?.id).toBe("%30");
    expect(panes[0]?.active).toBe(true);
    expect(panes[0]?.currentPath).toBe("/tmp");
    expect(panes[0]?.currentCommand).toBe("zsh");

    const lines = await adapter.capturePaneLines("s_capture_target", "%25\\0371\\0371\\037host\\037/tmp\\037coding_agent", 200);
    expect(lines).toEqual(["line-one"]);
    expect(capturedTarget).toBe("%25");
  });

  it("fails fast when pane target cannot be normalized", async () => {
    const adapter = new TmuxAdapter("tmux");
    await expect(adapter.capturePaneLines("s_bad_target", "bad-pane-id\u001fmeta", 200)).rejects.toThrow(
      "rawTarget"
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("splits real field separators before unescaping escaped in-field separators", async () => {
    execFileMock.mockImplementation((_: string, args: string[], optionsOrCallback: unknown, callback: unknown) => {
      const cb = resolveCallback(optionsOrCallback, callback);
      if (args[0] === "display-message" && args[args.length - 1] === "#{window_id}") {
        cb(null, "@1\n", "");
        return;
      }
      if (args[0] === "list-panes") {
        cb(null, "%31\u001f0\u001f1\u001fshell\u001f/tmp\\037nested\u001fzsh\n", "");
        return;
      }
      cb(new Error(`unexpected command: ${args.join(" ")}`) as NodeJS.ErrnoException, "", "");
    });

    const adapter = new TmuxAdapter("tmux");
    const panes = await adapter.listPanes("s_split_order");
    expect(panes).toHaveLength(1);
    expect(panes[0]?.id).toBe("%31");
    expect(panes[0]?.currentPath).toBe("/tmp\u001fnested");
    expect(panes[0]?.currentCommand).toBe("zsh");
  });

  it("handles legacy escaped separators without shifting columns", async () => {
    execFileMock.mockImplementation((_: string, args: string[], optionsOrCallback: unknown, callback: unknown) => {
      const cb = resolveCallback(optionsOrCallback, callback);
      if (args[0] === "display-message" && args[args.length - 1] === "#{window_id}") {
        cb(null, "@1\n", "");
        return;
      }
      if (args[0] === "list-panes") {
        cb(null, "%31\\0370\\0371\\037shell\\037/tmp\\\\037nested\\037zsh\n", "");
        return;
      }
      cb(new Error(`unexpected command: ${args.join(" ")}`) as NodeJS.ErrnoException, "", "");
    });

    const adapter = new TmuxAdapter("tmux");
    const panes = await adapter.listPanes("s_split_order_legacy");
    expect(panes).toHaveLength(1);
    expect(panes[0]?.id).toBe("%31");
    expect(panes[0]?.currentPath).toBe("/tmp\u001fnested");
    expect(panes[0]?.currentCommand).toBe("zsh");
  });

  it("falls back to session target when probe target is invalid", async () => {
    execFileMock.mockImplementation((_: string, args: string[], optionsOrCallback: unknown, callback: unknown) => {
      const cb = resolveCallback(optionsOrCallback, callback);

      if (args[0] === "display-message" && args[args.length - 1]?.includes("#{client_session}")) {
        const target = args[3] ?? "";
        if (target === "/dev/ttys999") {
          cb(new Error("no such client") as NodeJS.ErrnoException, "", "no such client");
          return;
        }
        if (target === "s_probe_fallback") {
          cb(
            null,
            "s_other_client\\037s_probe_fallback\\0371\\037%31\\0370\\037/tmp\\037zsh\\037workspace\n",
            ""
          );
          return;
        }
      }

      if (args[0] === "git") {
        cb(new Error("not a git repo") as NodeJS.ErrnoException, "", "fatal");
        return;
      }

      cb(new Error(`unexpected command: ${args.join(" ")}`) as NodeJS.ErrnoException, "", "");
    });

    const adapter = new TmuxAdapter("tmux");
    const probe = await adapter.probeActiveEnvironment("s_probe_fallback", "/dev/ttys999");
    expect(probe.activePaneId).toBe("%31");
    expect(probe.tmux.session).toBe("s_probe_fallback");
    expect(probe.tmux.window).toBe("1");
    expect(probe.tmux.pane).toBe("0");
    expect(probe.paneCurrentPath).toBe("/tmp");
    expect(probe.paneCurrentCommand).toBe("zsh");
  });
});
