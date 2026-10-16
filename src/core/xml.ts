// Minimal namespace-agnostic XML parser (sufficient for Gating-ML / FlowJo-style documents).

export interface XNode {
  name: string; // local name (prefix stripped)
  qname: string; // qualified name
  attrs: Record<string, string>; // local attribute names -> value (also stored under qualified name)
  children: XNode[];
  text: string;
}

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      // String.fromCodePoint throws a bare RangeError ("Invalid code point") beyond U+10FFFF
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) throw new Error(`The XML file contains an invalid character reference "${m.length > 24 ? m.slice(0, 24) + '...' : m}".`);
      return String.fromCodePoint(code);
    }
    return ENT[e] ?? m;
  });
}

export function escapeXml(s: unknown): string {
  // tolerant of missing values (undefined / null become empty), so a damaged gate cannot break an export
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const local = (q: string) => {
  const i = q.indexOf(':');
  return i >= 0 ? q.slice(i + 1) : q;
};

/** Line number (1-based) of a character offset, for error messages. */
function lineAt(src: string, at: number): number {
  let n = 1;
  for (let i = src.indexOf('\n'); i >= 0 && i < at; i = src.indexOf('\n', i + 1)) n++;
  return n;
}

function truncated(src: string, at: number, what: string): Error {
  return new Error(`The XML file is truncated or damaged: ${what} (line ${lineAt(src, at)}). It may have been cut off while saving or downloading.`);
}

/**
 * Parse an XML document. Iterative (no recursion, so deeply nested documents do not overflow the stack); every step
 * advances through the text. Truncated documents (an unterminated tag, comment or CDATA section, or elements still open
 * at the end) are rejected with a clear message instead of being read in part.
 */
export function parseXml(src: string): XNode {
  const root: XNode = { name: '#document', qname: '#document', attrs: {}, children: [], text: '' };
  const stack: XNode[] = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const at = i;
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      stack[stack.length - 1].text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      if (e < 0) throw truncated(src, lt, 'a comment is not closed');
      i = e + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      if (e < 0) throw truncated(src, lt, 'a CDATA section is not closed');
      stack[stack.length - 1].text += src.slice(lt + 9, e);
      i = e + 3;
    } else if (src[lt + 1] === '?' || src[lt + 1] === '!') {
      const e = src.indexOf('>', lt);
      if (e < 0) throw truncated(src, lt, 'a declaration is not closed');
      i = e + 1;
    } else if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      if (e < 0) throw truncated(src, lt, 'an end tag is not closed');
      const qn = src.slice(lt + 2, e).trim();
      // pop until matching (an end tag without a matching open element is ignored)
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].qname === qn) {
          stack.length = k;
          break;
        }
      }
      i = e + 1;
    } else {
      // start tag
      let j = lt + 1;
      let quote: string | null = null;
      while (j < n) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
        j++;
      }
      if (j >= n) throw truncated(src, lt, 'a start tag is not closed');
      let body = src.slice(lt + 1, j);
      const selfClose = body.endsWith('/');
      if (selfClose) body = body.slice(0, -1);
      const m = /^([^\s/>]+)/.exec(body);
      const qname = m ? m[1] : '';
      const node: XNode = { name: local(qname), qname, attrs: {}, children: [], text: '' };
      const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let am: RegExpExecArray | null;
      const rest = body.slice(qname.length);
      while ((am = attrRe.exec(rest))) {
        const v = decodeEntities(am[3] ?? am[4] ?? '');
        node.attrs[am[1]] = v;
        node.attrs[local(am[1])] = v;
      }
      stack[stack.length - 1].children.push(node);
      if (!selfClose) stack.push(node);
      i = j + 1;
    }
    if (i <= at) throw truncated(src, at, 'the parser could not read on'); // never loop in place
  }
  if (stack.length > 1) throw truncated(src, n, `the element <${stack[stack.length - 1].qname}> is not closed`);
  return root;
}

export function child(n: XNode, name: string): XNode | undefined {
  return n.children.find((c) => c.name === name);
}

export function childrenNamed(n: XNode, name: string): XNode[] {
  return n.children.filter((c) => c.name === name);
}

/** All descendants named `name`, in document order (iterative: deeply nested documents do not overflow the stack). */
export function descendants(n: XNode, name: string, out: XNode[] = []): XNode[] {
  const stack: { node: XNode; next: number }[] = [{ node: n, next: 0 }];
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top.next >= top.node.children.length) {
      stack.pop();
      continue;
    }
    const c = top.node.children[top.next++];
    if (c.name === name) out.push(c);
    if (c.children.length) stack.push({ node: c, next: 0 });
  }
  return out;
}
