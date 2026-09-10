/**
 * LIVE Bot-API render probe for the collapsible activity feed.
 *
 * Unit tests can only assert that our renderer emits the markup WE think is right —
 * they cannot prove Telegram accepts it. (That's exactly how a wrong MarkdownV2
 * blockquote shipped green.) This probe pushes the REAL `renderWorking` /
 * `renderFinal` output through the REAL `sendMessage` endpoint and prints
 * Telegram's status + response body, so acceptance is proven by the API, not by us.
 *
 * Usage (never commit the token):
 *   TELEGRAM_BOT_TOKEN=<token> TELEGRAM_PROBE_CHAT_ID=<chat> bun run tools/telegram-render-probe.ts
 *
 * Not wired into CI — it sends real messages to a real chat.
 */
import { renderWorking, renderFinal } from "../hub/src/telegram/bridge.ts";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_PROBE_CHAT_ID;
if (!token || !chatId) {
  console.error("set TELEGRAM_BOT_TOKEN and TELEGRAM_PROBE_CHAT_ID");
  process.exit(1);
}

async function send(label: string, html: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML" }),
  });
  const body = (await res.json()) as any;
  const entities = (body?.result?.entities ?? []).map((e: any) => e.type).join(",");
  console.log(
    `[${label}] HTTP ${res.status} ok=${body.ok} len=${html.length} entities=[${entities}] ${
      body.ok ? "" : JSON.stringify(body)
    }`,
  );
}

// Hostile content: every MarkdownV2 reserved char, plus literal HTML metachars.
const HOSTILE = "_ * [ ] ( ) ~ ` > # + - = | { } . ! and <script> & \"quotes\"";

const st = {
  lines: [
    "🔧 Bash ls -la | grep '*.ts'",
    "🔧 Edit hub/src/foo.ts",
    `🔧 Bash ${HOSTILE}`,
    "🔧 Read a.ts",
  ],
  toolCount: 4,
  startedAtMs: Date.now() - 12_400,
};

// 1. In-flight working message: summary outside, 4 tool lines collapsed inside.
await send("working+collapsed-activity", renderWorking(st));
// 2. Final: answer OUTSIDE the block, activity collapsed beneath it.
await send("final-answer+collapsed-activity", renderFinal(`Done. Result: 2 < 3 && "ok"`, st));
// 3. Hostile-char answer with hostile-char activity.
await send("hostile-chars", renderFinal(HOSTILE, st));
