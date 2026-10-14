/**
 * PTYCAP-05 repair: a turn's assistant_message and its result (which becomes the usage_event)
 * carry the SAME turn_id, so the hub can correlate the ledger row to the message per turn.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ClaudeRunner } from "../src/runners/claude-runner";
import type { RunnerEvent } from "../src/runners/types";

function makeFakeSpawn(lines: string[]) {
  const chunks = lines.map((l) => new TextEncoder().encode(l + "\n"));
  let i = 0;
  return (_cmd: string[], _opts: any) =>
    ({
      pid: 4243,
      exited: new Promise(() => {}),
      stdin: { write: () => {}, flush: () => {} },
      stdout: {
        getReader: () => ({
          read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
        }),
      },
      stderr: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      kill: () => {},
    }) as any;
}

const assistant = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const result = () =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    result: "ok",
    duration_ms: 5,
    total_cost_usd: 0.01,
    usage: { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });

describe("ClaudeRunner turn_id", () => {
  test("assistant_message and result share one turn_id; two turns get distinct ids", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "remo-turn-"));
    try {
      const events: RunnerEvent[] = [];
      const runner = new ClaudeRunner(tmp, false);
      runner.spawnImpl = makeFakeSpawn([assistant("one"), result(), assistant("two"), result()]);
      runner.start((e) => events.push(e));
      await new Promise((r) => setTimeout(r, 50));
      const msgs = events.filter((e) => e.type === "assistant_message") as any[];
      const results = events.filter((e) => e.type === "result") as any[];
      expect(msgs).toHaveLength(2);
      expect(results).toHaveLength(2);
      expect(typeof msgs[0].turn_id).toBe("string");
      expect(msgs[0].turn_id).toBe(results[0].turn_id);
      expect(msgs[1].turn_id).toBe(results[1].turn_id);
      expect(msgs[0].turn_id).not.toBe(msgs[1].turn_id);
      runner.stop();
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  });
});
