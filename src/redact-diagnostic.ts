import { isIP } from 'node:net';

// Strip complete URL and credential tokens before truncation so partial secrets never reach a diagnostic.
export function redactDiagnostic(text: string): string {
  return text.replace(/\b(?:https?|wss?|socks(?:4a?|5h?)?):\/\/[^\s<>"'`，。；（）]+/gi, '[URL]')
    .replace(/\bvr-token\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;,，。；）]+)/gi, 'vr-token=[隐藏]');
}

/** Free text returned by the read-only logs can contain a transport address in either IP family. */
export function redactClientAddresses(text: string): string {
  // Accept the brackets of a socket address, the scope of a link-local address and punctuation around log text.
  const ipv6 = text.replace(/\[?[a-f\d:.]+(?:%[\w.-]+)?\]?/gi, token => {
    if (!token.includes(':')) return token;
    const body = token.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (isIP(body) === 6) return '[IP]' + (token.endsWith('.') ? '.' : '');
    // A label may end in ':' immediately before the address.
    const colon = body.indexOf(':');
    if (colon >= 0 && isIP(body.slice(colon + 1)) === 6) return body.slice(0, colon + 1) + '[IP]';
    return token;
  });
  return ipv6.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, value => isIP(value) === 4 ? '[IP]' : value);
}
