import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Letta from "@letta-ai/letta-client";
import { getExtensionErrorDiagnostics } from "@/extensions/extension-diagnostics";
import {
  createExtensionEngine,
  type LettaExtensionFactory,
} from "@/extensions/extension-engine";
import {
  clearExtensionTools,
  getExtensionToolDefinition,
} from "@/extensions/tool-registry";
import {
  activate,
  buildChildEnv,
  buildGwsArgs,
  createDeps,
  createGoogleCalendarTool,
  expandHome,
  GOOGLE_CALENDAR_TOOL_NAME,
  type GoogleCalendarDeps,
  parseConfig,
  type Runner,
  type RunnerResult,
} from "./google-calendar";

/** Fixed clock so default time ranges are deterministic. */
const NOW = new Date("2026-01-01T00:00:00.000Z");

/** Recorded runner invocation. */
interface Call {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

/** Builds a gws-like events payload. */
function eventsJson(
  items: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ items, ...extra });
}

/** Creates deps with a scripted runner that records calls. */
function makeDeps(
  respond: (call: Call) => RunnerResult | Promise<RunnerResult>,
  config: unknown = undefined,
  env: Record<string, string | undefined> = {},
): { deps: GoogleCalendarDeps; calls: Call[] } {
  const calls: Call[] = [];
  const runner: Runner = async (command, args, options) => {
    const call = { command, args, env: options.env };
    calls.push(call);
    return respond(call);
  };
  return {
    calls,
    deps: createDeps({
      runner,
      readConfig: async () => config,
      now: () => NOW,
      env,
    }),
  };
}

/** Runs the tool with args and returns its result. */
async function run(
  deps: GoogleCalendarDeps,
  args: Record<string, unknown> = {},
) {
  return createGoogleCalendarTool(deps).run({
    args,
    signal: new AbortController().signal,
  });
}

/** Extracts the JSON passed via --params. */
function paramsOf(call: Call): Record<string, unknown> {
  return JSON.parse(call.args[call.args.indexOf("--params") + 1] as string);
}

const OK: RunnerResult = { stdout: eventsJson([]), stderr: "", exitCode: 0 };

describe("google-calendar extension", () => {
  test("builds gws args with a fixed read-only subcommand", async () => {
    const { deps, calls } = makeDeps(() => OK);
    const result = await run(deps, { query: "standup" });

    expect(result.status).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("gws");
    expect(calls[0]?.args.slice(0, 4)).toEqual([
      "calendar",
      "events",
      "list",
      "--params",
    ]);
    expect(paramsOf(calls[0] as Call)).toEqual({
      calendarId: "primary",
      timeMin: "2026-01-01T00:00:00.000Z",
      timeMax: "2026-01-08T00:00:00.000Z",
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50,
      q: "standup",
    });
    expect(calls[0]?.args).not.toContain("--format");
  });

  test("merges accounts and calendars chronologically", async () => {
    const { deps } = makeDeps(
      (call) => {
        const id = paramsOf(call).calendarId;
        const start =
          id === "a@x"
            ? "2026-01-02T10:00:00+09:00"
            : "2026-01-02T09:00:00+09:00";
        return {
          stdout: eventsJson([
            {
              summary: `ev-${id}`,
              start: { dateTime: start },
              end: { dateTime: start },
            },
          ]),
          stderr: "",
          exitCode: 0,
        };
      },
      {
        accounts: {
          work: { configDir: "/cfg/work", calendarIds: ["a@x"] },
          home: { configDir: "/cfg/home", calendarIds: ["b@x"] },
        },
      },
    );
    const result = await run(deps);

    expect(result.status).toBe("success");
    expect(result.content.indexOf("ev-b@x")).toBeLessThan(
      result.content.indexOf("ev-a@x"),
    );
    expect(result.content).toContain("source: work / a@x");
    expect(result.content).toContain("source: home / b@x");
  });

  test("isolates env per account and drops inherited token", async () => {
    const { deps, calls } = makeDeps(
      () => OK,
      {
        accounts: {
          work: { configDir: "/cfg/work" },
          home: { credentialsFile: "/cfg/home.json" },
        },
      },
      {
        GOOGLE_WORKSPACE_CLI_TOKEN: "parent-token",
        GOOGLE_WORKSPACE_CLI_CONFIG_DIR: "/parent",
        PATH: "/bin",
      },
    );
    await run(deps);

    const work = calls.find(
      (c) => c.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR === "/cfg/work",
    );
    const home = calls.find(
      (c) => c.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE === "/cfg/home.json",
    );
    expect(work?.env.GOOGLE_WORKSPACE_CLI_TOKEN).toBeUndefined();
    expect(work?.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE).toBeUndefined();
    expect(home?.env.GOOGLE_WORKSPACE_CLI_TOKEN).toBeUndefined();
    expect(home?.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR).toBeUndefined();
    expect(home?.env.PATH).toBe("/bin");
  });

  test("keeps parent env untouched for accounts without a location", () => {
    const env = buildChildEnv(
      { GOOGLE_WORKSPACE_CLI_TOKEN: "t" },
      { account: "default", calendarId: "primary" },
    );
    expect(env.GOOGLE_WORKSPACE_CLI_TOKEN).toBe("t");
  });

  test("returns partial results together with failures", async () => {
    const { deps } = makeDeps((call) =>
      paramsOf(call).calendarId === "bad"
        ? { stdout: "", stderr: "boom", exitCode: 1 }
        : {
            stdout: eventsJson([
              {
                summary: "Lunch",
                start: { date: "2026-01-03" },
                end: { date: "2026-01-04" },
              },
            ]),
            stderr: "",
            exitCode: 0,
          },
    );
    const result = await run(deps, { calendarIds: ["primary", "bad"] });

    expect(result.status).toBe("success");
    expect(result.content).toContain("Lunch");
    expect(result.content).toContain("(all-day)");
    expect(result.content).toContain("Failures:");
    expect(result.content).toContain("default / bad [api_error]");
    expect(result.content).toContain("boom");
  });

  test("reports error status when every fetch fails", async () => {
    const { deps } = makeDeps(() => ({ stdout: "", stderr: "", exitCode: 1 }));
    expect((await run(deps)).status).toBe("error");
  });

  test("classifies ENOENT as not installed", async () => {
    const { deps } = makeDeps(() => ({
      stdout: "",
      stderr: "",
      exitCode: null,
      errorCode: "ENOENT",
    }));
    const result = await run(deps);
    expect(result.status).toBe("error");
    expect(result.content).toContain("npm install -g @googleworkspace/cli");
    expect(result.content).toContain("not_installed");
  });

  test("classifies a thrown ENOENT from the runner", async () => {
    const deps = createDeps({
      runner: async () => {
        throw Object.assign(new Error("spawn gws ENOENT"), { code: "ENOENT" });
      },
      readConfig: async () => undefined,
      now: () => NOW,
      env: {},
    });
    expect((await run(deps)).content).toContain("not_installed");
  });

  test("classifies exit code 2 as not authenticated", async () => {
    const { deps } = makeDeps(() => ({ stdout: "", stderr: "", exitCode: 2 }), {
      accounts: { work: { configDir: "/cfg/work" } },
    });
    const result = await run(deps);
    expect(result.content).toContain("gws auth login -s calendar");
    expect(result.content).toContain("read-only");
    expect(result.content).toContain("/cfg/work");
  });

  test("classifies timeout, abort, and invalid JSON", async () => {
    const timeout = makeDeps(() => ({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: true,
    }));
    expect((await run(timeout.deps)).content).toContain("[timeout]");

    const aborted = makeDeps(() => ({
      stdout: "",
      stderr: "",
      exitCode: null,
      aborted: true,
    }));
    expect((await run(aborted.deps)).content).toContain("[aborted]");

    const invalid = makeDeps(() => ({
      stdout: "not json",
      stderr: "",
      exitCode: 0,
    }));
    expect((await run(invalid.deps)).content).toContain("[invalid_json]");
  });

  test("surfaces API error objects returned with exit 0", async () => {
    const { deps } = makeDeps(() => ({
      stdout: JSON.stringify({ error: { message: "Not Found" } }),
      stderr: "",
      exitCode: 0,
    }));
    const result = await run(deps);
    expect(result.content).toContain("Not Found");
  });

  test("rejects unknown account aliases without running gws", async () => {
    const { deps, calls } = makeDeps(() => OK, {
      accounts: { work: { configDir: "/cfg/work" } },
    });
    const result = await run(deps, { accounts: ["nope"] });
    expect(result.status).toBe("error");
    expect(result.content).toContain('Unknown account "nope"');
    expect(result.content).toContain("work");
    expect(calls).toHaveLength(0);
  });

  test("reports invalid config and unreadable config", async () => {
    const bad = makeDeps(() => OK, { accounts: [], bogus: 1 });
    const badResult = await run(bad.deps);
    expect(badResult.status).toBe("error");
    expect(badResult.content).toContain("Invalid google-calendar config");
    expect(bad.calls).toHaveLength(0);

    const relative = makeDeps(() => OK, {
      accounts: { a: { configDir: "relative/dir" } },
    });
    expect((await run(relative.deps)).content).toContain("absolute path");

    const unreadable = createDeps({
      runner: async () => OK,
      readConfig: async () => {
        throw new Error("bad json");
      },
    });
    expect((await run(unreadable)).content).toContain("Could not read config");
  });

  test("rejects inherited property names as account aliases", async () => {
    const { deps, calls } = makeDeps(
      () => OK,
      { accounts: { work: { configDir: "/cfg/work" } } },
      { GOOGLE_WORKSPACE_CLI_TOKEN: "parent-token" },
    );
    for (const alias of ["toString", "constructor", "hasOwnProperty"]) {
      const result = await run(deps, { accounts: [alias] });
      expect(result.status).toBe("error");
      expect(result.content).toContain("Unknown account");
    }
    expect(calls).toHaveLength(0);

    expect(() =>
      parseConfig({ accounts: {}, defaultAccounts: ["constructor"] }),
    ).toThrow("unknown account");
  });

  test("errors on a __proto__ account alias instead of dropping it", () => {
    const raw = JSON.parse('{"accounts":{"__proto__":{"configDir":"/x"}}}');
    expect(() => parseConfig(raw)).toThrow("__proto__");
  });

  test("clamps maxResults and validates time range", async () => {
    const { deps, calls } = makeDeps(() => OK);
    await run(deps, { maxResults: 100000 });
    await run(deps, { maxResults: -5 });
    expect(paramsOf(calls[0] as Call).maxResults).toBe(250);
    expect(paramsOf(calls[1] as Call).maxResults).toBe(1);

    const badTime = await run(deps, { timeMin: "tomorrow" });
    expect(badTime.content).toContain("RFC3339");
    const reversed = await run(deps, {
      timeMin: "2026-02-01T00:00:00Z",
      timeMax: "2026-01-01T00:00:00Z",
    });
    expect(reversed.content).toContain("earlier than timeMax");
  });

  test("reports truncation when nextPageToken is present", async () => {
    const { deps } = makeDeps(() => ({
      stdout: eventsJson([], { nextPageToken: "abc" }),
      stderr: "",
      exitCode: 0,
    }));
    expect((await run(deps)).content).toContain(
      "more exist for: default/primary",
    );
  });

  test("only ever runs calendar events list, even with hostile input", async () => {
    const { deps, calls } = makeDeps(() => OK, {
      accounts: { work: { configDir: "/cfg/work" } },
    });
    await run(deps, {
      calendarIds: ['primary" --evil', "events insert", "--params"],
      query: "delete; rm -rf / && gws calendar events delete",
      accounts: ["work"],
    });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.args.slice(0, 3)).toEqual(["calendar", "events", "list"]);
      expect(call.args).toHaveLength(5);
      expect(call.args[3]).toBe("--params");
    }
    expect(
      buildGwsArgs(
        { account: "a", calendarId: "x" },
        {
          targets: [],
          timeMin: "2026-01-01T00:00:00Z",
          timeMax: "2026-01-02T00:00:00Z",
          maxResults: 1,
        },
      ),
    ).toHaveLength(5);
  });

  test("expands ~ in paths", () => {
    expect(expandHome("~/x", "/home/u")).toBe("/home/u/x");
    expect(expandHome("~", "/home/u")).toBe("/home/u");
    expect(expandHome("/abs", "/home/u")).toBe("/abs");
  });

  test("activate registers a read-only parallel-safe tool and disposes", () => {
    const registered: Array<{
      name: string;
      requiresApproval: boolean;
      parallelSafe: boolean;
    }> = [];
    let disposed = false;
    const dispose = activate(
      {
        capabilities: { tools: true },
        tools: {
          register: (tool) => {
            registered.push(tool);
            return () => {
              disposed = true;
            };
          },
        },
      },
      { runner: async () => OK },
    );

    expect(registered[0]).toMatchObject({
      name: GOOGLE_CALENDAR_TOOL_NAME,
      requiresApproval: false,
      parallelSafe: true,
    });
    expect(GOOGLE_CALENDAR_TOOL_NAME).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    dispose?.();
    expect(disposed).toBe(true);
  });

  test("activate does nothing without the tools capability", () => {
    let called = false;
    const dispose = activate({
      capabilities: { tools: false },
      tools: {
        register: () => {
          called = true;
          return () => undefined;
        },
      },
    });
    expect(dispose).toBeUndefined();
    expect(called).toBe(false);
  });

  test("activate is assignable to the engine extension factory type", () => {
    const factory: LettaExtensionFactory = activate;
    expect(typeof factory).toBe("function");
  });
});

describe("google-calendar extension loading", () => {
  afterEach(() => {
    clearExtensionTools();
  });

  test("loads through the real extension engine and registers the tool", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "letta-gcal-"));
    try {
      const extensionDir = path.join(root, "global-extensions");
      mkdirSync(extensionDir, { recursive: true });
      copyFileSync(
        path.join(import.meta.dir, "google-calendar.ts"),
        path.join(extensionDir, "google-calendar.ts"),
      );
      const engine = createExtensionEngine({
        cacheDirectory: path.join(root, "extension-cache"),
        getClient: async () => ({}) as unknown as Letta,
        globalExtensionsDirectory: extensionDir,
      });

      await engine.reload();
      const snapshot = engine.getSnapshot();

      expect(getExtensionErrorDiagnostics(snapshot.diagnostics)).toEqual([]);
      expect(snapshot.tools[GOOGLE_CALENDAR_TOOL_NAME]).toMatchObject({
        requiresApproval: false,
        parallelSafe: true,
      });
      expect(
        getExtensionToolDefinition(GOOGLE_CALENDAR_TOOL_NAME),
      ).toBeDefined();

      engine.dispose();
      expect(
        getExtensionToolDefinition(GOOGLE_CALENDAR_TOOL_NAME),
      ).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
