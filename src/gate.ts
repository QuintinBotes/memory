import { redact } from './redact/redact.ts';
import { codeFreeViolations, visibleText } from './codefree.ts';

export const MAX_STATEMENT = 300;
export const EMAIL = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![A-Za-z0-9])/;
export const HANDLE = /(?<![\w@/.])@[A-Za-z0-9][A-Za-z0-9-]*(?![\w-]*(?:\/|\(|\.\w))/;
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
 * `organisationTerms` is given for person and global items, which follow the
 * owner into every organisation: they must carry no code, path or name.
 */
export function refusal(text: string, organisationTerms?: readonly string[]): string | null {
  if (text.trim().length === 0) return 'it is empty';
  // One item is one line: a newline could forge another item in the slice.
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text)) return 'it has a line break or a control character; one item is one line';
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
