// Minimal emails4agents sender (global rule #7). Pulled out of post-run/email.ts
// because Phase 07-C needs it from auth too. Returns true on 2xx, false otherwise
// (never throws — magic-link path tolerates email outages, see request-link
// always-200 enumeration policy).

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  const apiKey = process.env.E4A_API_KEY;
  const baseUrl = process.env.E4A_BASE_URL || 'https://api.emails4agents.com';
  const inboxId = process.env.E4A_INBOX_ID;
  if (!apiKey || !inboxId) {
    console.warn(`[email] E4A env not configured; would have emailed ${input.to} subject=${JSON.stringify(input.subject)}`);
    return false;
  }
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ from_inbox_id: inboxId, to: input.to, subject: input.subject, html: input.html, text: input.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[email] send failed ${res.status}: ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error('[email] threw', err?.message);
    return false;
  }
}
