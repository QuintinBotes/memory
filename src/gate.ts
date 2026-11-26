import { redact } from './redact/redact.ts';
import { codeFreeViolations, visibleText } from './codefree.ts';

/** Exit 1: refused, nothing was written. Exit 2: the command cannot run as given. */
export class Refusal extends Error {
  constructor(
    message: string,
    readonly code: 1 | 2 = 1,
  ) {
    super(message);
  }
}

export const MAX_STATEMENT = 300;
export const EMAIL = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![A-Za-z0-9])/;
export const HANDLE = /(?<![\w@/.])@[A-Za-z0-9][A-Za-z0-9-]*(?![\w-]*(?:\/|\(|\.\w))/;
/**
 * A model's special tokens and chat role markers: text that carries one may be read as a turn boundary. Backtick
 * code spans are ignored, and the bare `<s>` and `<system>` tags are not tokens.
 */
export const CONTROL_TOKEN = /<\|[^|>\n]{1,40}\|>|\[\/?INST\]|<<\/?SYS>>|<\/s>|<(?:start|end)_of_turn>/i;
/** A leading role prefix, refused from sources other than the owner. */
export const ROLE_PREFIX = /^\s*(?:system|assistant|human)\s*:/i;
/** A full chat-template sequence, the only control-token shape the owner's own text is refused for. */
export const CHAT_TEMPLATE = /<\|im_start\|>[^]*<\|im_end\|>|\[INST\][^]*\[\/INST\]|<<SYS>>[^]*<<\/SYS>>|<start_of_turn>[^]*<end_of_turn>/i;
export const WEBHOOK = /hooks\.slack\.com\/(?:services|workflows|triggers)\/\S*|discord(?:app)?\.com\/api\/webhooks\/\S*/i;

/** Whether `text` names one of `terms` of two or more characters, as a whole word. */
export function namesOrganisation(text: string, terms: readonly string[]): boolean {
  const visible = visibleText(text);
  return terms.some(
    (t) => t.length >= 2 && new RegExp(`(?<![\\p{L}\\p{N}_])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu').test(visible),
  );
}

/**
 * Why `text` must not be stored, or null when it may be. Reasons name the kind
 * of data only, never the matched text, so a refusal can be printed and logged
 * without repeating what it refused.
 *
 * `owner` is true for text the owner typed (`remember`): it is refused a control token only as a full chat-template
 * sequence, and a leading role prefix is allowed. Every other source gets the strict check.
 *
 * `organisationTerms` is given for person and global items, which follow the
 * owner into every organisation: they must carry no code, path or name.
 */
export function refusal(text: string, organisationTerms?: readonly string[], owner = false): string | null {
  if (text.trim().length === 0) return 'it is empty';
  // One item is one line: a newline could forge another item in the slice.
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text)) return 'it has a line break or a control character; one item is one line';
  const outsideCode = visibleText(text).replace(/`[^`]*`/g, ' ');
  if ((owner ? CHAT_TEMPLATE.test(outsideCode) : CONTROL_TOKEN.test(outsideCode) || ROLE_PREFIX.test(outsideCode))) return 'it carries a model control token or a chat role marker';
  if (text.length > MAX_STATEMENT) return `it is ${text.length} characters; at most ${MAX_STATEMENT}`;

  // Review Voice's patterns replace nothing for a key header with no footer,
  // so a header alone is refused here.
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return 'it carries a private key';
  const labels = Object.keys(redact(text).counts);
  if (labels.length > 0) return `it carries a secret (${labels.sort().join(', ')})`;
  if (WEBHOOK.test(text)) {
    return 'it carries a webhook URL, which is a credential';
  }
  if (EMAIL.test(text)) return 'it carries an email address';
  // An @handle in any case, in code spans too, but not a package scope
  // (@types/node), a decorator call or a dotted name. An annotation such as
  // @Override is refused as well: refusing is the safe direction.
  if (HANDLE.test(text)) {
    return "it carries a person's handle";
  }

  if (organisationTerms !== undefined) {
    // Terms are matched here rather than by the copied check, which skips names
    // shorter than three characters; a repository named "ui" is still a name.
    // shortcut: one-character names are not matched, as they would refuse most text.
    const reasons = codeFreeViolations(text);
    if (namesOrganisation(text, organisationTerms)) reasons.push('an organisation or repository name');
    // An owner/repo of an organisation memory has no tenant for is still a name. Refusing "and/or" is the safe direction.
    if (/(?<![\p{L}\p{N}_./-])[\p{L}\p{N}][\p{L}\p{N}-]*\/[\p{L}\p{N}._-]*[\p{L}\p{N}_-]/u.test(visibleText(text))) {
      reasons.push('a name shaped like owner/repo');
    }
    if (reasons.length > 0) return `a person or global item must be organisation-free, and this has: ${reasons.join(', ')}`;
  }
  return null;
}
