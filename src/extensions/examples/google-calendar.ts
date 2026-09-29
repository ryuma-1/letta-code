/**
 * Google Calendar (read-only) extension for Letta Code.
 *
 * Install by copying this file to `~/.letta/extensions/google-calendar.ts`.
 * The loader copies extensions into a cache directory and imports them
 * standalone, so this file must only depend on `node:*` builtins and must not
 * use `@/` or relative imports.
 *
 * It shells out to `gws` (github.com/googleworkspace/cli) and only ever runs
 * `gws calendar events list`. Pre-verification was done against the official
 * README only; it was not possible to verify against a real `gws` install.
 *
 * Setup:
 *   npm install -g @googleworkspace/cli   (or: brew install googleworkspace-cli)
 *   gws auth login -s calendar            (prefer a read-only Calendar scope)
 *
 * Optional config: `~/.letta/extensions/google-calendar.config.json`
 * (override the path with LETTA_GOOGLE_CALENDAR_CONFIG). Do not put tokens in it.
 * Example:
 *   {
 *     "accounts": {
 *       "work": {
 *         "configDir": "~/.config/gws-work",
 *         "calendarIds": ["primary", "team@example.com"]
 *       },
 *       "personal": { "configDir": "~/.config/gws-personal" }
 *     },
 *     "defaultAccounts": ["work"],
 *     "defaultCalendarIds": ["primary"],
 *     "gwsPath": "gws",
 *     "timeoutMs": 30000,
 *     "maxEventsPerCalendar": 50,
 *     "timeZone": "Asia/Tokyo"
 *   }
 *
 * Multiple accounts: gws has no native account flag, so each account is
 * isolated by pointing GOOGLE_WORKSPACE_CLI_CONFIG_DIR and/or
 * GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE at its own location in the child env.
 * Log in per account with e.g.
 *   GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws-work gws auth login -s calendar
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Tool name exposed to the model; must not collide with built-in tools. */
export const GOOGLE_CALENDAR_TOOL_NAME = "google_calendar_list_events";

/** Env var that overrides the config file location. */
export const CONFIG_PATH_ENV = "LETTA_GOOGLE_CALENDAR_CONFIG";

/** gws env var selecting the config directory (credentials, OAuth client). */
const GWS_CONFIG_DIR_ENV = "GOOGLE_WORKSPACE_CLI_CONFIG_DIR";
/** gws env var selecting an explicit credentials file. */
const GWS_CREDENTIALS_FILE_ENV = "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE";
/** gws env var carrying a raw token; must never leak across accounts. */
const GWS_TOKEN_ENV = "GOOGLE_WORKSPACE_CLI_TOKEN";

/** Alias used when no accounts are configured (gws default credentials). */
const IMPLICIT_ACCOUNT_ALIAS = "default";

/** Default per-gws-call timeout; keeps a hung gws from stalling the agent. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Upper bound for a configured timeout. */
const MAX_TIMEOUT_MS = 120_000;
/** Default events fetched per calendar. */
const DEFAULT_MAX_RESULTS = 50;
/** Upper bound for events per calendar, matching the Calendar API cap. */
const MAX_RESULTS_LIMIT = 250;
/** Default look-ahead window when no time range is given. */
const DEFAULT_RANGE_DAYS = 7;
/** Caps account x calendar fan-out so one call cannot spawn unbounded gws runs. */
const MAX_TARGETS = 20;
/** Max parallel gws processes. */
const CONCURRENCY = 4;
/** Caps gws stdout so a huge response cannot exhaust memory. */
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
/** Caps stderr text echoed into error messages. */
const MAX_STDERR_CHARS = 500;
/** Caps event descriptions to keep tool output compact. */
const MAX_DESCRIPTION_CHARS = 300;
/** Caps total tool output size returned to the model. */
const MAX_OUTPUT_CHARS = 40_000;

/** Config keys that are accepted; anything else is reported to catch typos. */
const CONFIG_KEYS = new Set([
  "accounts",
  "defaultAccounts",
  "defaultCalendarIds",
  "gwsPath",
  "timeoutMs",
  "maxEventsPerCalendar",
  "timeZone",
]);

/** RFC3339 timestamp with a mandatory offset, as the Calendar API requires. */
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Per-account settings in the config file. */
export interface AccountConfig {
  configDir?: string;
  credentialsFile?: string;
  calendarIds?: string[];
}

/** Validated config with defaults applied. */
export interface CalendarConfig {
  accounts: Record<string, AccountConfig>;
  defaultAccounts?: string[];
  defaultCalendarIds?: string[];
  gwsPath: string;
  timeoutMs: number;
  maxEventsPerCalendar: number;
  timeZone?: string;
}

/** One (account, calendar) pair to query. */
export interface Target {
  account: string;
  calendarId: string;
  configDir?: string;
  credentialsFile?: string;
}

/** Normalized request derived from model input plus config. */
export interface ListRequest {
  targets: Target[];
  timeMin: string;
  timeMax: string;
  maxResults: number;
  query?: string;
  timeZone?: string;
}

/** Categories used to give the model (and user) actionable errors. */
export type FailureKind =
  | "not_installed"
  | "not_authenticated"
  | "timeout"
  | "aborted"
  | "api_error"
  | "invalid_json"
  | "unknown";

/** Result of one child process run; the runner never needs to throw. */
export interface RunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  errorCode?: string;
  timedOut?: boolean;
  aborted?: boolean;
}

/** Options passed to the runner; injectable so tests avoid real processes. */
export interface RunnerOptions {
  env: Record<string, string | undefined>;
  timeoutMs: number;
  signal?: AbortSignal;
  maxBuffer: number;
}

/** Process runner abstraction (command, args, options). */
export type Runner = (
  command: string,
  args: string[],
  options: RunnerOptions,
) => Promise<RunnerResult>;

/** Injectable dependencies. */
export interface GoogleCalendarDeps {
  runner: Runner;
  readConfig: () => Promise<unknown>;
  now: () => Date;
  env: Record<string, string | undefined>;
}

/** A normalized calendar event for merging and formatting. */
export interface CalendarEvent {
  account: string;
  calendarId: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  sortKey: number;
  location?: string;
  status?: string;
  htmlLink?: string;
  description?: string;
}

/** A failed (account, calendar) fetch. */
export interface FetchFailure {
  account: string;
  calendarId: string;
  kind: FailureKind;
  message: string;
}

/** Per-target outcome. */
export type FetchOutcome =
  | { ok: true; events: CalendarEvent[]; truncated: boolean }
  | { ok: false; failure: FetchFailure };

/** Tool result shape accepted by the extension engine. */
export interface ToolResult {
  status: "success" | "error";
  content: string;
}

/** Minimal structural view of the tool registration API. */
export interface GoogleCalendarToolRegistration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  requiresApproval: boolean;
  parallelSafe: boolean;
  run: (ctx: {
    args: Record<string, unknown>;
    signal: AbortSignal;
  }) => Promise<ToolResult>;
}

/**
 * Minimal structural view of the extension API. Declared locally because the
 * cached extension cannot import engine types at runtime.
 */
export interface GoogleCalendarExtensionApi {
  capabilities: { tools: boolean };
  tools: {
    register: (tool: GoogleCalendarToolRegistration) => () => void;
  };
}

/** Error carrying a user-actionable message; surfaced as a tool error. */
export class CalendarToolError extends Error {
  readonly kind: "config" | "input";

  constructor(kind: "config" | "input", message: string) {
    super(message);
    this.name = "CalendarToolError";
    this.kind = kind;
  }
}

/** Type guard for plain objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Expands a leading `~` since config paths are user-written. */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/** Validates a string array field, rejecting empty or oversized entries. */
function readStringArray(
  value: unknown,
  field: string,
  kind: "config" | "input",
): string[] {
  if (!Array.isArray(value)) {
    throw new CalendarToolError(kind, `${field} must be an array of strings`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "" || item.length > 256) {
      throw new CalendarToolError(
        kind,
        `${field} must contain only non-empty strings (max 256 chars)`,
      );
    }
    out.push(item.trim());
  }
  return out;
}

/** Validates an optional path setting and expands `~`. */
function readPath(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new CalendarToolError("config", `${field} must be a non-empty path`);
  }
  const expanded = expandHome(value.trim());
  // A relative path would depend on the agent cwd, which is a confusing failure mode.
  if (!path.isAbsolute(expanded)) {
    throw new CalendarToolError(
      "config",
      `${field} must be an absolute path (or start with ~)`,
    );
  }
  return expanded;
}

/**
 * Validates gwsPath. A bare command name is resolved via PATH, so only values
 * containing a separator or `~` must be absolute paths.
 */
function readGwsPath(value: unknown): string {
  if (value === undefined) return "gws";
  if (typeof value !== "string" || value.trim() === "") {
    throw new CalendarToolError("config", "gwsPath must be a non-empty string");
  }
  const trimmed = value.trim();
  if (!trimmed.includes("/") && !trimmed.startsWith("~")) return trimmed;
  return readPath(trimmed, "gwsPath") as string;
}

/** Validates an integer setting within bounds. */
function readInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new CalendarToolError(
      "config",
      `${field} must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}

/** Checks an IANA time zone name without pulling in dependencies. */
function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates raw config JSON by hand (no schema dependency). Invalid config is
 * reported at tool run time so activation never fails the whole extension.
 */
export function parseConfig(raw: unknown): CalendarConfig {
  if (raw === undefined || raw === null) {
    return {
      accounts: {},
      gwsPath: "gws",
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxEventsPerCalendar: DEFAULT_MAX_RESULTS,
    };
  }
  if (!isRecord(raw)) {
    throw new CalendarToolError("config", "config must be a JSON object");
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new CalendarToolError("config", `unknown config key "${key}"`);
    }
  }

  // Null prototype so inherited names (toString, constructor) never resolve.
  const accounts: Record<string, AccountConfig> = Object.create(null);
  if (raw.accounts !== undefined) {
    if (!isRecord(raw.accounts)) {
      throw new CalendarToolError("config", "accounts must be an object");
    }
    for (const [alias, value] of Object.entries(raw.accounts)) {
      // Assigning "__proto__" would silently drop the account, so fail loudly.
      if (alias === "__proto__") {
        throw new CalendarToolError(
          "config",
          'accounts alias "__proto__" is not allowed',
        );
      }
      if (!isRecord(value)) {
        throw new CalendarToolError(
          "config",
          `accounts.${alias} must be an object`,
        );
      }
      const account: AccountConfig = {};
      const configDir = readPath(
        value.configDir,
        `accounts.${alias}.configDir`,
      );
      const credentialsFile = readPath(
        value.credentialsFile,
        `accounts.${alias}.credentialsFile`,
      );
      if (configDir) account.configDir = configDir;
      if (credentialsFile) account.credentialsFile = credentialsFile;
      if (value.calendarIds !== undefined) {
        account.calendarIds = readStringArray(
          value.calendarIds,
          `accounts.${alias}.calendarIds`,
          "config",
        );
      }
      accounts[alias] = account;
    }
  }

  const config: CalendarConfig = {
    accounts,
    gwsPath: readGwsPath(raw.gwsPath),
    timeoutMs: readInteger(
      raw.timeoutMs,
      "timeoutMs",
      1000,
      MAX_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
    maxEventsPerCalendar: readInteger(
      raw.maxEventsPerCalendar,
      "maxEventsPerCalendar",
      1,
      MAX_RESULTS_LIMIT,
      DEFAULT_MAX_RESULTS,
    ),
  };
  if (raw.defaultAccounts !== undefined) {
    config.defaultAccounts = readStringArray(
      raw.defaultAccounts,
      "defaultAccounts",
      "config",
    );
    for (const alias of config.defaultAccounts) {
      if (!Object.hasOwn(accounts, alias)) {
        throw new CalendarToolError(
          "config",
          `defaultAccounts references unknown account "${alias}"`,
        );
      }
    }
  }
  if (raw.defaultCalendarIds !== undefined) {
    config.defaultCalendarIds = readStringArray(
      raw.defaultCalendarIds,
      "defaultCalendarIds",
      "config",
    );
  }
  if (raw.timeZone !== undefined) {
    if (typeof raw.timeZone !== "string" || !isValidTimeZone(raw.timeZone)) {
      throw new CalendarToolError(
        "config",
        "timeZone must be a valid IANA time zone name",
      );
    }
    config.timeZone = raw.timeZone;
  }
  return config;
}

/** Validates an optional RFC3339 argument. */
function readTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !RFC3339_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new CalendarToolError(
      "input",
      `${field} must be an RFC3339 timestamp with offset, e.g. 2026-01-31T09:00:00+09:00`,
    );
  }
  return value;
}

/**
 * Turns model input and config into a normalized request. Accounts are
 * accepted only as configured aliases so the model cannot inject paths or env.
 */
export function resolveRequest(
  args: Record<string, unknown>,
  config: CalendarConfig,
  now: Date,
): ListRequest {
  const configuredAliases = Object.keys(config.accounts);

  let aliases: string[];
  if (args.accounts !== undefined) {
    aliases = readStringArray(args.accounts, "accounts", "input");
    for (const alias of aliases) {
      const known =
        Object.hasOwn(config.accounts, alias) ||
        (configuredAliases.length === 0 && alias === IMPLICIT_ACCOUNT_ALIAS);
      if (!known) {
        const available =
          configuredAliases.length > 0
            ? configuredAliases.join(", ")
            : IMPLICIT_ACCOUNT_ALIAS;
        throw new CalendarToolError(
          "input",
          `Unknown account "${alias}". Available accounts: ${available}`,
        );
      }
    }
  } else if (config.defaultAccounts) {
    aliases = config.defaultAccounts;
  } else if (configuredAliases.length > 0) {
    aliases = configuredAliases;
  } else {
    aliases = [IMPLICIT_ACCOUNT_ALIAS];
  }
  aliases = [...new Set(aliases)];

  const explicitCalendarIds =
    args.calendarIds !== undefined
      ? [...new Set(readStringArray(args.calendarIds, "calendarIds", "input"))]
      : undefined;

  const targets: Target[] = [];
  for (const alias of aliases) {
    const account = Object.hasOwn(config.accounts, alias)
      ? config.accounts[alias]
      : undefined;
    const calendarIds = explicitCalendarIds ??
      account?.calendarIds ??
      config.defaultCalendarIds ?? ["primary"];
    for (const calendarId of calendarIds) {
      const target: Target = { account: alias, calendarId };
      if (account?.configDir) target.configDir = account.configDir;
      if (account?.credentialsFile) {
        target.credentialsFile = account.credentialsFile;
      }
      targets.push(target);
    }
  }
  if (targets.length === 0) {
    throw new CalendarToolError("input", "No calendars to query");
  }
  if (targets.length > MAX_TARGETS) {
    throw new CalendarToolError(
      "input",
      `Too many account/calendar combinations (${targets.length}, max ${MAX_TARGETS})`,
    );
  }

  const timeMin = readTimestamp(args.timeMin, "timeMin") ?? now.toISOString();
  const timeMax =
    readTimestamp(args.timeMax, "timeMax") ??
    new Date(
      Date.parse(timeMin) + DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
  if (Date.parse(timeMin) >= Date.parse(timeMax)) {
    throw new CalendarToolError(
      "input",
      "timeMin must be earlier than timeMax",
    );
  }

  let maxResults = config.maxEventsPerCalendar;
  if (args.maxResults !== undefined) {
    if (typeof args.maxResults !== "number" || Number.isNaN(args.maxResults)) {
      throw new CalendarToolError("input", "maxResults must be a number");
    }
    // Clamping instead of rejecting keeps a slightly-off model call useful.
    maxResults = Math.min(
      MAX_RESULTS_LIMIT,
      Math.max(1, Math.trunc(args.maxResults)),
    );
  }

  const request: ListRequest = { targets, timeMin, timeMax, maxResults };
  if (args.query !== undefined) {
    if (typeof args.query !== "string") {
      throw new CalendarToolError("input", "query must be a string");
    }
    if (args.query.trim() !== "") request.query = args.query.trim();
  }
  if (config.timeZone) request.timeZone = config.timeZone;
  return request;
}

/**
 * Builds the gws argv. The subcommand is a fixed literal and the only
 * model-influenced data is inside a JSON string, so no write-capable
 * subcommand is reachable.
 */
export function buildGwsArgs(target: Target, request: ListRequest): string[] {
  const params: Record<string, unknown> = {
    calendarId: target.calendarId,
    timeMin: request.timeMin,
    timeMax: request.timeMax,
    // orderBy=startTime is only valid when recurring events are expanded.
    singleEvents: true,
    orderBy: "startTime",
    maxResults: request.maxResults,
  };
  if (request.query) params.q = request.query;
  if (request.timeZone) params.timeZone = request.timeZone;
  return ["calendar", "events", "list", "--params", JSON.stringify(params)];
}

/**
 * Builds the child env. An account that names its own credentials location
 * drops every inherited gws credential var, because an ambient
 * GOOGLE_WORKSPACE_CLI_TOKEN would otherwise override it and leak the parent
 * account into another account's request.
 */
export function buildChildEnv(
  parentEnv: Record<string, string | undefined>,
  target: Target,
): Record<string, string | undefined> {
  const env = { ...parentEnv };
  if (!target.configDir && !target.credentialsFile) return env;
  delete env[GWS_CONFIG_DIR_ENV];
  delete env[GWS_CREDENTIALS_FILE_ENV];
  delete env[GWS_TOKEN_ENV];
  if (target.configDir) env[GWS_CONFIG_DIR_ENV] = target.configDir;
  if (target.credentialsFile) {
    env[GWS_CREDENTIALS_FILE_ENV] = target.credentialsFile;
  }
  return env;
}

/** Truncates text so error output stays short. */
function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

/** Default runner: execFile without a shell, always resolving. */
export function defaultRunner(
  command: string,
  args: string[],
  options: RunnerOptions,
): Promise<RunnerResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        env: options.env as NodeJS.ProcessEnv,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        ...(options.signal ? { signal: options.signal } : {}),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        const err = error as NodeJS.ErrnoException & {
          killed?: boolean;
          code?: string | number;
        };
        const aborted =
          err.name === "AbortError" || options.signal?.aborted === true;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: typeof err.code === "number" ? err.code : null,
          ...(typeof err.code === "string" ? { errorCode: err.code } : {}),
          timedOut: err.killed === true && !aborted,
          aborted,
        });
      },
    );
  });
}

/**
 * Maps a failed run to a category using the documented gws exit codes
 * (2 = auth error) plus process-level signals.
 */
export function classifyFailure(
  result: RunnerResult,
  target: Target,
  gwsPath: string,
): { kind: FailureKind; message: string } {
  if (result.errorCode === "ENOENT") {
    return {
      kind: "not_installed",
      message: `\`${gwsPath}\` was not found. Install it with \`npm install -g @googleworkspace/cli\` or \`brew install googleworkspace-cli\`, or set gwsPath in the config.`,
    };
  }
  if (result.aborted) {
    return { kind: "aborted", message: "Cancelled before completion." };
  }
  if (result.timedOut) {
    return { kind: "timeout", message: "gws timed out." };
  }
  if (result.exitCode === 2) {
    const where = target.configDir
      ? ` with ${GWS_CONFIG_DIR_ENV}=${target.configDir}`
      : "";
    return {
      kind: "not_authenticated",
      message: `gws is not authenticated for account "${target.account}". Run \`gws auth login -s calendar\`${where} (choose a read-only Calendar scope such as calendar.readonly).`,
    };
  }
  const detail =
    extractApiErrorMessage(result.stdout) ??
    truncate(result.stderr, MAX_STDERR_CHARS);
  return {
    kind: result.exitCode === 1 ? "api_error" : "unknown",
    message: `gws failed (exit ${result.exitCode ?? "unknown"})${detail ? `: ${detail}` : ""}`,
  };
}

/** Extracts `error.message` from gws JSON error output when present. */
function extractApiErrorMessage(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message = parsed.error.message;
      if (typeof message === "string") {
        return truncate(message, MAX_STDERR_CHARS);
      }
    }
  } catch {
    // Non-JSON output falls back to stderr in the caller.
  }
  return undefined;
}

/** Reads an optional string field. */
function optString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Parses gws stdout for one calendar into normalized events. Throws on
 * malformed JSON so the caller can classify it as invalid_json.
 */
export function parseEventsResponse(
  stdout: string,
  target: Target,
): { events: CalendarEvent[]; truncated: boolean } {
  const parsed: unknown = JSON.parse(stdout);
  if (!isRecord(parsed)) throw new Error("response is not a JSON object");
  if (isRecord(parsed.error)) {
    throw new CalendarApiResponseError(
      optString(parsed.error.message) ?? "unknown API error",
    );
  }
  const items = parsed.items === undefined ? [] : parsed.items;
  if (!Array.isArray(items)) throw new Error("items is not an array");

  const events: CalendarEvent[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const start = isRecord(item.start) ? item.start : {};
    const end = isRecord(item.end) ? item.end : {};
    const startText = optString(start.dateTime) ?? optString(start.date);
    const endText = optString(end.dateTime) ?? optString(end.date);
    if (!startText) continue;
    const event: CalendarEvent = {
      account: target.account,
      calendarId: target.calendarId,
      summary: optString(item.summary) ?? "(no title)",
      start: startText,
      end: endText ?? startText,
      allDay: optString(start.dateTime) === undefined,
      sortKey: Date.parse(startText),
    };
    const location = optString(item.location);
    const status = optString(item.status);
    const htmlLink = optString(item.htmlLink);
    const description = optString(item.description);
    if (location) event.location = location;
    if (status) event.status = status;
    if (htmlLink) event.htmlLink = htmlLink;
    if (description) {
      event.description = truncate(description, MAX_DESCRIPTION_CHARS);
    }
    events.push(event);
  }
  return { events, truncated: optString(parsed.nextPageToken) !== undefined };
}

/** Error for an API error object embedded in a successful exit. */
export class CalendarApiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarApiResponseError";
  }
}

/** Fetches one (account, calendar) pair and never throws. */
export async function fetchTarget(
  target: Target,
  request: ListRequest,
  config: CalendarConfig,
  deps: GoogleCalendarDeps,
  signal: AbortSignal | undefined,
): Promise<FetchOutcome> {
  const fail = (kind: FailureKind, message: string): FetchOutcome => ({
    ok: false,
    failure: {
      account: target.account,
      calendarId: target.calendarId,
      kind,
      message,
    },
  });

  let result: RunnerResult;
  try {
    result = await deps.runner(config.gwsPath, buildGwsArgs(target, request), {
      env: buildChildEnv(deps.env, target),
      timeoutMs: config.timeoutMs,
      maxBuffer: MAX_STDOUT_BYTES,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const classified = classifyFailure(
      {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: null,
        ...(typeof code === "string" ? { errorCode: code } : {}),
      },
      target,
      config.gwsPath,
    );
    return fail(classified.kind, classified.message);
  }

  if (
    result.errorCode ||
    result.timedOut ||
    result.aborted ||
    result.exitCode !== 0
  ) {
    const classified = classifyFailure(result, target, config.gwsPath);
    return fail(classified.kind, classified.message);
  }

  try {
    const { events, truncated } = parseEventsResponse(result.stdout, target);
    return { ok: true, events, truncated };
  } catch (error) {
    if (error instanceof CalendarApiResponseError) {
      return fail("api_error", `Calendar API error: ${error.message}`);
    }
    return fail(
      "invalid_json",
      `Could not parse gws output as JSON (${error instanceof Error ? error.message : "unknown error"}). The gws version may be incompatible.`,
    );
  }
}

/** Runs async work with a concurrency cap, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Formats merged events and failures as model-facing text. */
export function formatResult(
  outcomes: FetchOutcome[],
  request: ListRequest,
): ToolResult {
  const events: CalendarEvent[] = [];
  const failures: FetchFailure[] = [];
  const truncatedSources: string[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.ok) {
      events.push(...outcome.events);
      const target = request.targets[index];
      if (outcome.truncated && target) {
        truncatedSources.push(`${target.account}/${target.calendarId}`);
      }
    } else {
      failures.push(outcome.failure);
    }
  });

  events.sort(
    (a, b) => a.sortKey - b.sortKey || a.summary.localeCompare(b.summary),
  );

  const lines: string[] = [
    `Google Calendar events from ${request.timeMin} to ${request.timeMax} (${events.length} found)`,
  ];
  events.forEach((event, i) => {
    lines.push("");
    lines.push(`${i + 1}. ${event.summary}`);
    lines.push(
      `   when: ${event.start} -> ${event.end}${event.allDay ? " (all-day)" : ""}`,
    );
    lines.push(`   source: ${event.account} / ${event.calendarId}`);
    if (event.location) lines.push(`   location: ${event.location}`);
    if (event.status) lines.push(`   status: ${event.status}`);
    if (event.htmlLink) lines.push(`   link: ${event.htmlLink}`);
    if (event.description) {
      lines.push(`   description: ${event.description.replace(/\s+/g, " ")}`);
    }
  });
  if (events.length === 0) lines.push("", "No events in this range.");

  if (truncatedSources.length > 0) {
    lines.push(
      "",
      `Note: results were limited to ${request.maxResults} events per calendar; more exist for: ${truncatedSources.join(", ")}. Narrow the time range or raise maxResults.`,
    );
  }
  if (failures.length > 0) {
    lines.push("", "Failures:");
    for (const f of failures) {
      lines.push(`- ${f.account} / ${f.calendarId} [${f.kind}]: ${f.message}`);
    }
  }

  let content = lines.join("\n");
  if (content.length > MAX_OUTPUT_CHARS) {
    content = `${content.slice(0, MAX_OUTPUT_CHARS)}\n... (output truncated; narrow the time range)`;
  }
  const allFailed = failures.length > 0 && failures.length === outcomes.length;
  return { status: allFailed ? "error" : "success", content };
}

/** Runs the whole list operation: config, input, fetch, format. */
export async function listEvents(
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
  deps: GoogleCalendarDeps,
): Promise<ToolResult> {
  try {
    let rawConfig: unknown;
    try {
      rawConfig = await deps.readConfig();
    } catch (error) {
      throw new CalendarToolError(
        "config",
        `Could not read config: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const config = parseConfig(rawConfig);
    const request = resolveRequest(args, config, deps.now());
    const outcomes = await mapWithConcurrency(
      request.targets,
      CONCURRENCY,
      (target) => fetchTarget(target, request, config, deps, signal),
    );
    return formatResult(outcomes, request);
  } catch (error) {
    if (error instanceof CalendarToolError) {
      return {
        status: "error",
        content:
          error.kind === "config"
            ? `Invalid google-calendar config: ${error.message}`
            : `Invalid input: ${error.message}`,
      };
    }
    return {
      status: "error",
      content: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Reads the config file; a missing file means "use defaults". */
export async function readConfigFile(
  env: Record<string, string | undefined>,
): Promise<unknown> {
  const configured = env[CONFIG_PATH_ENV];
  const file = configured
    ? expandHome(configured)
    : path.join(
        homedir(),
        ".letta",
        "extensions",
        "google-calendar.config.json",
      );
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !configured) {
      return undefined;
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON (${error instanceof Error ? error.message : "parse error"})`,
    );
  }
}

/** Builds default dependencies, overridden piecewise by tests. */
export function createDeps(
  overrides: Partial<GoogleCalendarDeps> = {},
): GoogleCalendarDeps {
  const env = overrides.env ?? process.env;
  return {
    runner: overrides.runner ?? defaultRunner,
    readConfig: overrides.readConfig ?? (() => readConfigFile(env)),
    now: overrides.now ?? (() => new Date()),
    env,
  };
}

/** Builds the tool registration; exported so tests can call run directly. */
export function createGoogleCalendarTool(
  deps: GoogleCalendarDeps,
): GoogleCalendarToolRegistration {
  return {
    name: GOOGLE_CALENDAR_TOOL_NAME,
    description:
      "List Google Calendar events (read-only) across one or more configured Google accounts and calendar IDs, merged chronologically. Defaults to the next 7 days.",
    parameters: {
      type: "object",
      properties: {
        accounts: {
          type: "array",
          items: { type: "string" },
          description:
            "Configured account aliases to query. Defaults to the configured default accounts.",
        },
        calendarIds: {
          type: "array",
          items: { type: "string" },
          description:
            'Calendar IDs to query, e.g. "primary". Defaults to the account or default calendars.',
        },
        timeMin: {
          type: "string",
          description: "Start of range, RFC3339 with offset. Defaults to now.",
        },
        timeMax: {
          type: "string",
          description:
            "End of range, RFC3339 with offset. Defaults to 7 days after timeMin.",
        },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: MAX_RESULTS_LIMIT,
          description: "Maximum events per calendar (default 50).",
        },
        query: {
          type: "string",
          description: "Free-text filter matched against event fields.",
        },
      },
      additionalProperties: false,
    },
    // Read-only and low risk, so no approval prompt and safe to run in parallel.
    requiresApproval: false,
    parallelSafe: true,
    run: (ctx) => listEvents(ctx.args, ctx.signal, deps),
  };
}

/**
 * Extension entry point. Exported as a named `activate` (which the loader
 * accepts) because the repo bans default exports.
 */
export function activate(
  letta: GoogleCalendarExtensionApi,
  deps: Partial<GoogleCalendarDeps> = {},
): (() => void) | undefined {
  if (!letta.capabilities.tools) return undefined;
  return letta.tools.register(createGoogleCalendarTool(createDeps(deps)));
}
