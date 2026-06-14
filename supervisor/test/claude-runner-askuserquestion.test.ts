/**
 * AskUserQuestion mapping (Part 2 of the TG multiple-choice feature).
 *
 * AskUserQuestion is a built-in tool that arrives over stream-json as a
 * `control_request` with subtype `can_use_tool` and `tool_name='AskUserQuestion'`.
 * The runner must surface it as a `user_question` (with parsed options), NOT a
 * bare permission_request — otherwise the multiple-choice options are hidden
 * behind Approve/Deny. The answer must go back as a tool-allow control_response.
 *
 * We also cover the existing elicitation path to prove it still answers inline.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ClaudeRunner } from "../src/runners/claude-runner";
import type { RunnerEvent } from "../src/runners/types";

let TMP: string;
beforeEach(() => { TMP = mkdtempSync(join(tmpdir(), "remo-auq-")); });
afterEach(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

/**
 * Fake subprocess that streams the given stdout lines once, captures every
 * stdin write, and never exits.
 */
function makeFakeSpawn(lines: string[], stdinWrites: string[]) {
  const chunks = lines.map((l) => new TextEncoder().encode(l + "\n"));
  let i = 0;
  return (_cmd: string[], _opts: any) =>
    ({
      pid: 4242,
      exited: new Promise(() => {}),
      stdin: { write: (s: string) => { stdinWrites.push(s); }, flush: () => {} },
      stdout: {
        getReader: () => ({
          read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
        }),
      },
      stderr: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      kill: () => {},
    }) as any;
}

async function flush() { await new Promise((r) => setTimeout(r, 20)); }

describe("ClaudeRunner — AskUserQuestion mapping", () => {
  test("can_use_tool AskUserQuestion → user_question with options + is_multi_select", async () => {
    const events: RunnerEvent[] = [];
    const stdinWrites: string[] = [];
    const auqLine = JSON.stringify({
      type: "control_request",
      subtype: "can_use_tool",
      request_id: "req-auq-1",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Which database?",
            header: "DB",
            multiSelect: true,
            options: [
              { label: "Postgres", description: "relational" },
              { label: "SQLite" },
            ],
          },
        ],
      },
    });
    const runner = new ClaudeRunner(TMP, false);
    runner.spawnImpl = makeFakeSpawn([auqLine], stdinWrites);
    runner.start((e) => events.push(e));
    await flush();

    const q = events.find((e) => e.type === "user_question") as any;
    expect(q).toBeTruthy();
    expect(q.request_id).toBe("req-auq-1");
    expect(q.question).toBe("Which database?");
    expect(q.is_multi_select).toBe(true);
    expect(q.options.map((o: any) => o.label)).toEqual(["Postgres", "SQLite"]);
    // Must NOT have been routed as a bare permission prompt.
    expect(events.find((e) => e.type === "permission_request")).toBeUndefined();

    // Answering an AskUserQuestion → tool-allow control_response carrying the choice.
    runner.respondToQuestion("req-auq-1", "Postgres");
    const sent = stdinWrites.map((l) => JSON.parse(l));
    const resp = sent.find((m) => m.request_id === "req-auq-1");
    expect(resp.type).toBe("control_response");
    expect(resp.behavior).toBe("allow");
    expect(resp.updatedInput).toEqual({ answer: "Postgres" });
    runner.stop();
  });

  test("elicitation question still answers inline with response.answer", async () => {
    const events: RunnerEvent[] = [];
    const stdinWrites: string[] = [];
    const elicLine = JSON.stringify({
      type: "control_request",
      request_id: "req-elic-1",
      request: {
        subtype: "elicitation",
        message: "Pick a color",
        requested_schema: { enum: ["red", "blue"] },
      },
    });
    const runner = new ClaudeRunner(TMP, false);
    runner.spawnImpl = makeFakeSpawn([elicLine], stdinWrites);
    runner.start((e) => events.push(e));
    await flush();

    const q = events.find((e) => e.type === "user_question") as any;
    expect(q?.request_id).toBe("req-elic-1");
    expect(q.options.map((o: any) => o.label)).toEqual(["red", "blue"]);

    runner.respondToQuestion("req-elic-1", "blue");
    const resp = stdinWrites.map((l) => JSON.parse(l)).find((m) => m.request_id === "req-elic-1");
    expect(resp.type).toBe("control_response");
    expect(resp.response).toEqual({ answer: "blue" });
    expect(resp.behavior).toBeUndefined();
    runner.stop();
  });

  test("real permission (non-AskUserQuestion can_use_tool) still routes to permission_request", async () => {
    const events: RunnerEvent[] = [];
    const line = JSON.stringify({
      type: "control_request",
      subtype: "can_use_tool",
      request_id: "req-perm-1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const runner = new ClaudeRunner(TMP, false);
    runner.spawnImpl = makeFakeSpawn([line], []);
    runner.start((e) => events.push(e));
    await flush();

    expect(events.find((e) => e.type === "permission_request")).toBeTruthy();
    expect(events.find((e) => e.type === "user_question")).toBeUndefined();
    runner.stop();
  });
});
