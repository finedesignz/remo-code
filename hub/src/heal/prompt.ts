// hub/src/heal/prompt.ts
//
// PTYCAP-07-05 (D-10): idempotent scope-contract helper and an ASCII punctuation normalizer
// for outbound text. Pure.

import { SCOPE_CONTRACT } from '../dispatch/untrusted.ts';

/** Append the scope contract exactly once, however many times a prompt is prepared. */
export function withScopeContract(prompt: string): string {
  return prompt.includes(SCOPE_CONTRACT) ? prompt : `${prompt}\n\n${SCOPE_CONTRACT}`;
}

/** Curly quotes, en/em dashes and the ellipsis character become plain ASCII. */
export function asciiPunctuation(text: string): string {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/–/g, '-')
    .replace(/—/g, '--')
    .replace(/…/g, '...');
}
